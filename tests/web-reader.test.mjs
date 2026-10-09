import test from "node:test";
import assert from "node:assert/strict";
import { readWebPage } from "../web-reader.mjs";

test("web reader retries transient HTTP/network failures once and records recovery",async()=>{
  for(const first of [()=>new Response("busy",{status:503}),()=>{throw Object.assign(new Error("fetch failed"),{cause:{code:"ECONNRESET"}})}]){
    let calls=0;
    const result=await readWebPage("https://example.com",{fetchImpl:async()=>++calls===1?first():new Response("success"),retryDelay:async()=>{}});
    assert.equal(calls,2);assert.equal(result.attempts,2);assert.equal(result.raw,"success");
  }
});
test("permanent HTTP failures are not retried and retain status/action",async()=>{
  let calls=0;
  await assert.rejects(readWebPage("https://example.com",{fetchImpl:async()=>{calls++;return new Response("denied",{status:403})}}),error=>error.upstream_status===403&&error.retryable===false&&error.attempts===1&&Boolean(error.next_action));
  assert.equal(calls,1);
});
test("rate limits are retryable later but not retried immediately",async()=>{
  let calls=0;
  await assert.rejects(readWebPage("https://example.com",{fetchImpl:async()=>{calls++;return new Response("limited",{status:429})}}),error=>error.upstream_status===429&&error.retryable===true&&error.attempts===1);
  assert.equal(calls,1);
});
test("exhausted retries retain DNS/network codes and attempt count",async()=>{
  await assert.rejects(readWebPage("https://example.com",{fetchImpl:async()=>{throw Object.assign(new Error("fetch failed"),{cause:{code:"EAI_AGAIN"}})},retryDelay:async()=>{}}),error=>error.network_code==="EAI_AGAIN"&&error.attempts===2&&error.retryable===true);
});
test("redirect destinations are checked before a new request and the final URL is returned",async()=>{
  const checked=[],fetched=[];
  const result=await readWebPage("https://example.com/a",{validateUrl:url=>checked.push(url),fetchImpl:async url=>{fetched.push(url);return fetched.length===1?new Response(null,{status:302,headers:{location:"/b"}}):new Response("page");}});
  assert.deepEqual(checked,fetched);assert.equal(result.final_url,"https://example.com/b");
  let calls=0;
  await assert.rejects(readWebPage("https://example.com",{validateUrl:url=>{if(url.includes("127.0.0.1"))throw new Error("blocked")},fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:"http://127.0.0.1/"}})}}),/blocked/);
  assert.equal(calls,1);
});
test("oversized bodies are cancelled rather than parsed",async()=>{
  await assert.rejects(readWebPage("https://example.com",{fetchImpl:async()=>new Response("x".repeat(2000001))}),error=>error.code==="web_fetch_too_large"&&error.attempts===1);
});
