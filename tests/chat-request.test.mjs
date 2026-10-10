import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const server=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
const {fetchChatResponse,chatRequestError}=runInNewContext(html.slice(html.indexOf("function chatRequestError("),html.indexOf("async function performStreamRequest("))+";({fetchChatResponse,chatRequestError})",{
  API_URL:"/api/chat",proxyHeaders:()=>({}),getApiKey:()=>"test",selectedModel:()=>({provider:"gemini",providerLabel:"Gemini"}),
  safeJSON:(text,fallback)=>{try{return JSON.parse(text)}catch{return fallback}},serverToolFailure:()=>false,hasOpenRouterWebSearch:()=>false,
  DOMException,setTimeout,clearTimeout,
});
test("gateway HTML does not masquerade as a Gemini API error or leak markup",()=>{
  const error=chatRequestError('<!DOCTYPE html><html><style>data:font/woff2;base64,PRIVATE</style>',502,{providerLabel:"Gemini"});
  assert.equal(error.code,"chat_gateway_error");assert.equal(error.retryable,true);
  assert.doesNotMatch(error.message,/DOCTYPE|base64|PRIVATE/);assert.match(error.message,/中継/);assert.equal(error.rawDetail,"");
});
test("Gemini retries one pre-stream gateway failure with the same request",async()=>{
  let calls=0,waits=0;const bodies=[];
  const result=await fetchChatResponse({provider:"gemini",messages:[]},{fetchImpl:async(_url,init)=>{
    calls++;bodies.push(init.body);return calls===1?new Response("<!DOCTYPE html><html>502",{status:502}):new Response("data: [DONE]\n\n");
  },wait:async()=>{waits++}});
  assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(waits,1);assert.equal(bodies[0],bodies[1]);
});
test("retry remains bounded and never retries auth, quota or configuration errors",async()=>{
  for(const [status,retryable,expected] of [[502,true,2],[503,true,2],[504,true,2],[400,true,1],[401,true,1],[429,true,1],[503,false,1]]){
    let calls=0;
    await assert.rejects(fetchChatResponse({provider:"gemini"},{fetchImpl:async()=>{calls++;return Response.json({error:{message:"safe error",retryable}},{status})},wait:async()=>{}}));
    assert.equal(calls,expected);
  }
  let calls=0;
  await assert.rejects(fetchChatResponse({provider:"openrouter"},{fetchImpl:async()=>{calls++;return new Response("bad gateway",{status:502})}}));
  assert.equal(calls,1);
});
test("cancellation during retry delay starts no second request",async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(fetchChatResponse({provider:"gemini"},{signal:controller.signal,fetchImpl:async()=>{calls++;controller.abort();return new Response("bad gateway",{status:502})}}),e=>e.name==="AbortError");
  assert.equal(calls,1);
});
test("upstream HTML is normalized but structured provider messages survive",()=>{
  const parse=runInNewContext(server.slice(server.indexOf("function parseErrorBody("),server.indexOf("function authFailureMessage("))+";parseErrorBody",{redactSecrets:String});
  assert.doesNotMatch(parse("<!DOCTYPE html><html>PRIVATE_FONT",502,"Gemini").message,/DOCTYPE|PRIVATE/);
  assert.equal(parse('{"error":{"message":"Invalid API key"}}',401,"Gemini").message,"Invalid API key");
});
