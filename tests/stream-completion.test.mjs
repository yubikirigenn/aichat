import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const source=html.slice(html.indexOf("async function performStreamRequest("),html.indexOf("async function retryWithClientWebTools("));
const event=data=>"data: "+JSON.stringify(data)+"\n\n";
const choice=(delta,finish_reason)=>({choices:[{delta,finish_reason}]});
function request(body,extra={}){
  return runInNewContext(source+";performStreamRequest",{setTimeout,clearTimeout,TextDecoder,getApiKey:()=>"test",abortController:new AbortController(),fetchChatResponse:async()=>new Response(body),serverToolFailure:()=>false,hasOpenRouterWebSearch:()=>false,...extra});
}
test("SSE flushes the final unterminated data line and accepts explicit stop without DONE",async()=>{
  const r=await request(event(choice({content:"one"}))+"data: "+JSON.stringify(choice({content:"two"},"stop")))({});
  assert.equal(r.msg.content,"onetwo");assert.equal(r.finish,"stop");
});
test("EOF without finish/DONE is an interruption, preserving live Thinking",async()=>{
  let live;
  await assert.rejects(request(event(choice({reasoning:"still working"})))({},m=>{live=m.reasoning}),e=>e.message.includes("終了通知なし")&&e.partialMessage.reasoning==="still working");
  assert.equal(live,"still working");
});
test("output limit and content filtering cannot silently become completed answers",async()=>{
  for(const reason of ["length","content_filter"]){
    await assert.rejects(request(event(choice({reasoning:"partial"},reason))+"data: [DONE]\n\n")({}),e=>e.partialMessage.reasoning==="partial"&&/上限|停止/.test(e.message));
  }
});
test("DONE-only termination remains compatible and the caller can recover an empty answer",async()=>{
  const result=await request(event(choice({reasoning:"thought"}))+"data: [DONE]\n\n")({});
  assert.equal(result.msg.reasoning,"thought");assert.equal(result.msg.content,"");
});
test("corrupt payloads and upstream error events fail explicitly",async()=>{
  await assert.rejects(request("data: {bad}\n\n")({}),/破損/);
  await assert.rejects(request(event({error:{code:"upstream_stream_interrupted",message:"stream interrupted"}}))({}),/stream interrupted/);
});
test("a stalled reader is cancelled and an idle timeout is surfaced",async()=>{
  let cancelled=false;
  const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){cancelled=true}});
  await assert.rejects(request(stream,{setTimeout:fn=>setTimeout(fn,5)})({}),/90秒/);
  assert.equal(cancelled,true);
});
test("proxy heartbeat comments do not reset the model's idle deadline",async()=>{
  let clock=0,reads=0,cancelled=false;const delays=[];
  const reader={read:async()=>{
    if(++reads<4){clock+=30000;return {value:new TextEncoder().encode(": keep-alive\n\n"),done:false}}
    return new Promise(()=>{});
  },cancel:async()=>{cancelled=true},releaseLock(){}};
  const run=request("",{Date:{now:()=>clock},fetchChatResponse:async()=>({body:{getReader:()=>reader}}),setTimeout:(fn,delay)=>{delays.push(delay);return setTimeout(fn,Math.min(delay,5))}});
  await assert.rejects(run({}),/90秒/);
  assert.deepEqual(delays,[90000,60000,30000,1]);assert.equal(cancelled,true);
});
