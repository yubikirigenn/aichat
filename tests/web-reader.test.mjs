import test from "node:test";
import assert from "node:assert/strict";
import { readWebPage, webPageByteLimit } from "../web-reader.mjs";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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
  await assert.rejects(readWebPage("https://example.com",{maxBytes:2000000,fetchImpl:async()=>new Response("x".repeat(2000001))}),error=>error.code==="web_fetch_too_large"&&error.attempts===1);
});
test("page size defaults to 20 MB and accepts a validated administrator override",async()=>{
  assert.equal(webPageByteLimit(""),20000000); assert.equal(webPageByteLimit("30000000"),30000000);
  for(const value of ["bad","0","-1","1.5","Infinity","100000001"])assert.throws(()=>webPageByteLimit(value));
  const result=await readWebPage("https://example.com",{maxBytes:webPageByteLimit(""),fetchImpl:async()=>new Response("x".repeat(2000001))});
  assert.equal(result.raw.length,2000001);assert.equal(result.bytes,2000001);
});
test("byte limit is inclusive and counts UTF-8 bytes, not characters",async()=>{
  const result=await readWebPage("https://example.com",{maxBytes:6,fetchImpl:async()=>new Response("あい")});
  assert.equal(result.bytes,6);
  await assert.rejects(readWebPage("https://example.com",{maxBytes:5,fetchImpl:async()=>new Response("あい")}),e=>e.code==="web_fetch_too_large");
  await assert.rejects(readWebPage("https://example.com",{maxBytes:5,fetchImpl:async()=>new Response("x",{headers:{"content-length":"6"}})}),e=>e.code==="web_fetch_too_large"&&e.attempts===1);
});
test("web-fetch route keeps the document beyond 50000 characters while bounding the excerpt",async()=>{
  const source=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  const extractReadableText=runInNewContext(source.slice(source.indexOf("function extractReadableText("),source.indexOf('app.post("/api/web-search"'))+";extractReadableText",{
    stripHtml:value=>value.replace(/<[^>]+>/g,""),decodeHtmlEntities:value=>value,
  });
  let handler;
  const raw="<html><title>Large page</title><article>"+"x".repeat(2000001)+"TAIL_NEEDLE</article><script>HIDDEN_SCRIPT</script></html>";
  runInNewContext(source.slice(source.indexOf('app.post("/api/web-fetch"'),source.indexOf("app.use(express.static")),{
    app:{post:(_path,fn)=>{handler=fn}},authorizeRequest:()=>({ok:true}),
    isPrivateOrLocalUrl:()=>false,parseXPostUrl:()=>{throw new Error("not X")},SEARCH_UA:"test",extractReadableText,
    readWebPage:async()=>({raw,bytes:raw.length,contentType:"text/html",status:200,final_url:"https://example.com",attempts:1}),
  });
  let result;const res={json:value=>{result=value},status:()=>res};
  await handler({body:{url:"https://example.com",max_chars:500,include_full_content:true}},res);
  assert.equal(result.content.length,500);assert.ok(result.full_content.length>2000000);
  assert.match(result.full_content,/TAIL_NEEDLE/);assert.doesNotMatch(result.full_content,/HIDDEN_SCRIPT/);
  assert.equal(result.full_content_truncated,false);assert.equal(result.truncated,true);
  assert.equal(result.stored_chars,result.full_content.length);
  await handler({body:{url:"https://example.com",max_chars:500}},res);
  assert.equal(result.full_content,undefined);assert.equal(result.content.length,500);assert.ok(result.total_chars>2000000);
});
