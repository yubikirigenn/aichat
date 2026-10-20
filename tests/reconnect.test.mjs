import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {createDetachedChat} from "../detached-chat.mjs";

const id="a".repeat(64),other="b".repeat(64);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function response(){return {code:200,status(code){this.code=code;return this},json(data){this.data=data;return this}}}
async function invoke(handler,delivery,body={}){const res=response();await handler({body:{access_password:"test",...body,delivery:{version:2,...delivery}}},res);return res}
const decode=data=>Buffer.concat(data.chunks.map(chunk=>Buffer.from(chunk,data.encoding==="base64"?"base64":"utf8"))).toString("utf8");
test("detached disk generation survives disconnection and replays split UTF-8 by byte cursor",async t=>{
  let sink,calls=0,ready;
  const handler=createDetachedChat({authorize:()=>({ok:true}),handleChat:async(req,res)=>{
    calls++;sink=res;res.write(Buffer.from("data: "));const bytes=Buffer.from("日本語");res.write(bytes.subarray(0,2));ready=new Promise(resolve=>res.write(bytes.subarray(2),resolve));
  }});t.after(()=>handler.close());
  assert.deepEqual((await invoke(handler,{id,action:"start"},{model:"test"})).data,{delivery:true});await ready;
  await invoke(handler,{id,action:"start"},{model:"test"});assert.equal(calls,1);
  const first=(await invoke(handler,{id,action:"read",cursor:0})).data;
  assert.equal(decode(first),"data: 日本語");assert.equal(first.done,false);
  await new Promise(resolve=>sink.end("\n\ndata: [DONE]\n\n",resolve));
  const rest=(await invoke(handler,{id,action:"read",cursor:first.cursor})).data;
  assert.equal(decode(rest),"\n\ndata: [DONE]\n\n");assert.equal(rest.done,true);
  assert.equal((await invoke(handler,{id:other,action:"read"})).code,410);
  assert.equal((await invoke(handler,{id,action:"read",cursor:100})).code,400);
  assert.equal((await invoke(handler,{id,action:"start"},{model:"different"})).code,409);
  await invoke(handler,{id,action:"release"});assert.equal((await invoke(handler,{id,action:"read"})).code,410);
});
test("spooling exceeds 8 MiB per job, 64 MiB total, 32 jobs and five minutes without stopping",async t=>{
  let clock=0;const ready=new Map(),signals=new Map(),large=Buffer.alloc(9*1024*1024,120);
  const handler=createDetachedChat({authorize:()=>({ok:true}),now:()=>clock,handleChat:async(req,res)=>{
    signals.set(req.body.model,req.detachedSignal);ready.set(req.body.model,new Promise(resolve=>res.write(req.body.large?large:Buffer.from("open"),resolve)));
  }});t.after(()=>handler.close());
  const ids=Array.from({length:34},(_,i)=>(i+1).toString(16).padStart(64,"0"));
  for(let i=0;i<ids.length;i++){assert.equal((await invoke(handler,{id:ids[i],action:"start"},{model:String(i),large:i<8})).code,200);await ready.get(String(i))}
  clock=6*60*1000;
  for(let i=0;i<ids.length;i++){const data=(await invoke(handler,{id:ids[i],action:"read"})).data;assert.equal(data.status,200);assert.equal(data.done,false);assert.equal(signals.get(String(i)).aborted,false)}
  let cursor=0;
  while(cursor<large.length){const data=(await invoke(handler,{id:ids[0],action:"read",cursor})).data;assert.ok(data.cursor>cursor);cursor=data.cursor}
  assert.equal(cursor,large.length);
});
test("authentication, explicit cancellation, completed-result expiry and real disk failures remain enforced",async t=>{
  let clock=0,sink,signal;
  const handler=createDetachedChat({authorize:req=>({ok:req.body.access_password==="test"}),ttlMs:10,now:()=>clock,handleChat:async(req,res)=>{
    if(req.body.access_password!=="test")return res.status(401).json({error:"unauthorized"});sink=res;signal=req.detachedSignal;
  }});t.after(()=>handler.close());
  const denied=response();await handler({body:{access_password:"wrong",delivery:{id,action:"read"}}},denied);assert.equal(denied.code,401);
  await invoke(handler,{id,action:"start"});await invoke(handler,{id,action:"cancel"});assert.equal(signal.aborted,true);assert.equal((await invoke(handler,{id,action:"read"})).data.status,499);
  clock=11;assert.equal((await invoke(handler,{id,action:"read"})).code,410);
  let invoked=false;
  const bad=createDetachedChat({authorize:()=>({ok:true}),spoolParent:"/private/tmp/nemotron-nonexistent-parent-for-test/subdirectory",handleChat:async()=>{invoked=true}});t.after(()=>bad.close());
  assert.equal((await invoke(bad,{id,action:"start"})).data.error.code,"delivery_storage_error");assert.equal(invoked,false);
});
test("upstream errors remain structured in the disk spool",async t=>{
  let ready;
  const handler=createDetachedChat({authorize:()=>({ok:true}),handleChat:async(req,res)=>{ready=new Promise(resolve=>res.on("finish",resolve));res.status(400).json({error:{message:"bad model arguments",code:"invalid_parameter"}})}});t.after(()=>handler.close());
  await invoke(handler,{id,action:"start"});await ready;
  const data=(await invoke(handler,{id,action:"read"})).data;assert.equal(data.status,400);assert.equal(data.done,true);assert.match(decode(data),/bad model arguments/);
});

const source=readFileSync(new URL("../public/reconnect.js",import.meta.url),"utf8");
function client(){return runInNewContext(source+";reconnectDelay=async(ms,signal)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError')};openReconnectStream",{ReadableStream,Response,TextEncoder,TextDecoder,Uint8Array,atob,AbortSignal,DOMException,TypeError,Error})}
const json=data=>new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}});
test("base64 disk replay preserves UTF-8 across byte boundaries",async()=>{
  const bytes=Buffer.from("日本語の途中再接続");let reads=0;
  const result=await client()({}, {id,recover:true,signal:new AbortController().signal,request:async body=>{
    assert.equal(body.delivery.version,2);reads++;const start=body.delivery.cursor,end=reads===1?2:bytes.length;
    return json({encoding:"base64",chunks:[bytes.subarray(start,end).toString("base64")],cursor:end,done:end===bytes.length,status:200});
  }});
  assert.equal(await result.text(),"日本語の途中再接続");assert.equal(reads,2);
});
test("client retries dropped reads using the same cursor, without duplicate tokens or requests",async()=>{
  const calls=[],states=[];let dropped=false;
  const result=await client()({model:"test"},{id,signal:new AbortController().signal,onState:s=>states.push(s),request:async body=>{
    calls.push(body.delivery);
    if(body.delivery.action==="start")return json({delivery:true});
    if(body.delivery.cursor===0)return json({cursor:1,chunks:["first"],done:false,status:200});
    if(!dropped){dropped=true;throw new TypeError("offline")}
    return json({cursor:2,chunks:["second"],done:true,status:200});
  }});
  assert.equal(await result.text(),"firstsecond");assert.equal(calls.filter(c=>c.action==="start").length,1);
  assert.deepEqual(calls.filter(c=>c.action==="read").map(c=>c.cursor),[0,1,1]);assert.ok(states.includes("reconnecting"));
});
test("ambiguous start probes only; reload recovers without start; lost jobs never regenerate",async()=>{
  const calls=[];
  const result=await client()({}, {id,signal:new AbortController().signal,request:async body=>{
    calls.push(body.delivery.action);if(body.delivery.action==="start")throw new TypeError("response lost");return json({chunks:["saved"],cursor:1,done:true,status:200});
  }});
  assert.equal(await result.text(),"saved");assert.deepEqual(calls,["start","read","read"]);
  const recoveryCalls=[];
  const recovered=await client()({}, {id,recover:true,signal:new AbortController().signal,request:async body=>{recoveryCalls.push(body.delivery.action);return json({chunks:["retained"],cursor:1,done:true,status:200})}});
  assert.equal(await recovered.text(),"retained");assert.deepEqual(recoveryCalls,["read"]);
  const lost=await client()({}, {id,recover:true,signal:new AbortController().signal,request:async body=>{assert.equal(body.delivery.action,"read");return new Response(JSON.stringify({error:{message:"record lost",code:"delivery_lost"}}),{status:410})}});
  await assert.rejects(lost.text(),/record lost/);
});
test("aborted clients stop polling rather than reconnect or submit a new request",async()=>{
  const controller=new AbortController();let calls=0;
  const result=await client()({}, {id,recover:true,signal:controller.signal,request:async()=>{calls++;controller.abort();throw new TypeError("offline")}});
  await assert.rejects(result.text(),e=>e.name==="AbortError");assert.equal(calls,1);
});
