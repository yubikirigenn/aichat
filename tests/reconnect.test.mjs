import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {createDetachedChat} from "../detached-chat.mjs";

const id="a".repeat(64),other="b".repeat(64);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function response(){return {code:200,status(code){this.code=code;return this},json(data){this.data=data;return this}}}
async function invoke(handler,delivery,body={}){const res=response();await handler({body:{access_password:"test",...body,delivery}},res);return res}
test("detached generation survives the start connection, replays UTF-8 by cursor and starts only once",async()=>{
  let sink,calls=0;
  const handler=createDetachedChat({authorize:()=>({ok:true}),handleChat:async(req,res)=>{calls++;sink=res;res.write(Buffer.from("data: "));const bytes=Buffer.from("日本語");res.write(bytes.subarray(0,2));res.write(bytes.subarray(2));}});
  assert.deepEqual((await invoke(handler,{id,action:"start"},{model:"test"})).data,{delivery:true});await settle();
  await invoke(handler,{id,action:"start"},{model:"test"});assert.equal(calls,1);
  const first=(await invoke(handler,{id,action:"read",cursor:0})).data;
  assert.equal(first.chunks.join(""),"data: 日本語");assert.equal(first.done,false);
  sink.end("\n\ndata: [DONE]\n\n");await settle();
  const rest=(await invoke(handler,{id,action:"read",cursor:first.cursor})).data;
  assert.equal(rest.chunks.join(""),"\n\ndata: [DONE]\n\n");assert.equal(rest.done,true);
  assert.equal((await invoke(handler,{id:other,action:"read"})).code,410);
  assert.equal((await invoke(handler,{id,action:"read",cursor:100})).code,400);
  assert.equal((await invoke(handler,{id,action:"start"},{model:"different"})).code,409);
  await invoke(handler,{id,action:"release"});assert.equal((await invoke(handler,{id,action:"read"})).code,410);
});
test("auth, cancellation, timeouts, expiry and memory limits remain bounded",async()=>{
  let clock=0,signal;
  const handler=createDetachedChat({authorize:req=>({ok:req.body.access_password==="test"}),ttlMs:10,now:()=>clock,maxJobs:1,maxBytes:8,handleChat:async(req,res)=>{if(req.body.access_password!=="test")return res.status(401).json({error:"unauthorized"});signal=req.detachedSignal;res.write("123456789")}});
  const denied=response();await handler({body:{access_password:"wrong",delivery:{id,action:"read"}}},denied);
  await settle(); // Unauthorized requests are delegated to the normal auth handler.
  assert.equal(denied.code,401);
  await invoke(handler,{id,action:"start"});await settle();
  const data=(await invoke(handler,{id,action:"read"})).data;
  assert.equal(data.status,507);assert.equal(signal.aborted,true);
  assert.equal((await invoke(handler,{id:other,action:"start"})).code,503);
  clock=11;assert.equal((await invoke(handler,{id,action:"read"})).code,410);
  let cancelled;
  const cancelHandler=createDetachedChat({authorize:()=>({ok:true}),handleChat:async(req)=>{cancelled=req.detachedSignal}});
  await invoke(cancelHandler,{id,action:"start"});await settle();await invoke(cancelHandler,{id,action:"cancel"});
  assert.equal(cancelled.aborted,true);assert.equal((await invoke(cancelHandler,{id,action:"read"})).data.status,499);
  const timeoutHandler=createDetachedChat({authorize:()=>({ok:true}),timeoutMs:5,handleChat:async()=>{}});
  await invoke(timeoutHandler,{id,action:"start"});await new Promise(r=>setTimeout(r,15));assert.equal((await invoke(timeoutHandler,{id,action:"read"})).data.status,504);
});
test("upstream errors remain structured and browser reattachment does not start again",async()=>{
  const handler=createDetachedChat({authorize:()=>({ok:true}),handleChat:async(req,res)=>res.status(400).json({error:{message:"bad model arguments",code:"invalid_parameter"}})});
  await invoke(handler,{id,action:"start"});await settle();
  const data=(await invoke(handler,{id,action:"read"})).data;assert.equal(data.status,400);assert.equal(data.done,true);assert.match(data.chunks.join(""),/bad model arguments/);
});

const source=readFileSync(new URL("../public/reconnect.js",import.meta.url),"utf8");
function client(){return runInNewContext(source+";reconnectDelay=async(ms,signal)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError')};openReconnectStream",{ReadableStream,Response,TextEncoder,AbortSignal,DOMException,TypeError,Error})}
const json=data=>new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}});
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
