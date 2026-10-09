import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeSearchQueries, runSearchBatch } from "../search.mjs";
import { PROVIDERS, MODEL_CATALOG, providerFor } from "../models.mjs";

test("search accepts either one query or up to six, deduplicating exact repeats", () => {
  assert.deepEqual(normalizeSearchQueries({queries:[" a ","b","a"]}),["a","b"]);
  assert.deepEqual(normalizeSearchQueries({query:"a"}),["a"]);
  for(const input of [{},{queries:[]},{queries:Array(7).fill("a")},{query:"a",queries:["b"]},{queries:[null]},{queries:["x".repeat(501)]}])assert.throws(()=>normalizeSearchQueries(input));
});
test("batch runs three queries concurrently, preserves partial success and merges duplicate URLs", async () => {
  let active=0,peak=0;
  const result=await runSearchBatch(["a","b","c","d","e","f"],async query=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;
    if(query==="b")throw new Error("private backend error");
    return {results:query==="c"?[]:[{title:query,url:"https://example.com/shared"}],errors:[]};
  });
  assert.equal(peak,3);assert.equal(result.searches.length,6);assert.equal(result.ok,true);
  assert.equal(result.searches[1].ok,false);assert.equal(result.searches[2].results.length,0);
  assert.equal(result.count,1);assert.deepEqual(result.results[0].matched_queries,["a","d","e","f"]);
  assert.ok(result.recovery_hint);assert.doesNotMatch(JSON.stringify(result),/private backend/);
  const failed=await runSearchBatch(["a","b"],async()=>{throw new Error("down")});
  assert.equal(failed.ok,false);assert.equal(failed.count,0);assert.equal(failed.searches.length,2);
});

const server=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
const adapter=server.slice(server.indexOf("function adaptProviderBody("),server.indexOf("async function providerFetch("));
const adapt=runInNewContext(adapter+";adaptProviderBody");
test("Gemini adapter translates reasoning, keeps tool choice and tool signatures, strips paid/native extras",()=>{
  const model=MODEL_CATALOG.find(m=>m.provider==="gemini");assert.ok(model.vision);
  const signature={google:{thought_signature:"sample-signature"}};
  const body={model:model.id,reasoning:{enabled:true},tools:[{type:"function",function:{name:"web_search"}},{type:"openrouter:web_search"}],tool_choice:{type:"function",function:{name:"web_search"}},plugins:[{id:"web"}],service_tier:"priority",messages:[{role:"assistant",reasoning:"summary",tool_calls:[{extra_content:signature}]}]};
  const result=adapt(PROVIDERS.gemini,body,model);
  assert.equal(result.reasoning_effort,"low");assert.equal(result.reasoning,undefined);assert.equal(result.tools.length,1);
  assert.equal(result.tool_choice.function.name,"web_search");assert.equal(result.service_tier,undefined);assert.equal(result.plugins,undefined);
  assert.equal(result.extra_body.google.thinking_config.include_thoughts,true);
  assert.equal(result.messages[0].reasoning,undefined);assert.equal(result.messages[0].tool_calls[0].extra_content,signature);
  assert.equal(body.tools.length,2);
});
test("billing guards block XPL even with a key, and Gemini until free-project confirmation",()=>{
  const accessSource=server.slice(server.indexOf("function providerAccess("),server.indexOf("function redactSecrets("));
  const env={EXPERIENTIAL_LABS_API_KEY:"test",GEMINI_API_KEY:"test"};
  const access=runInNewContext(accessSource+";providerAccess",{providerFor,process:{env},normalizeApiKey:v=>v||""});
  assert.equal(access("experientiallabs").reason,"billing_safety");
  assert.equal(access("gemini").reason,"free_tier_unconfirmed");
  env.GEMINI_FREE_TIER_CONFIRMED="true";assert.equal(access("gemini").ok,true);
});

test("Gemini streaming tool signatures survive fragmented arguments", async()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const source=html.slice(html.indexOf("async function performStreamRequest("),html.indexOf("async function retryWithClientWebTools("));
  const chunks=[{choices:[{delta:{tool_calls:[{index:0,id:"call",function:{name:"web_search",arguments:'{"queries":'},extra_content:{google:{thought_signature:"signed"}}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'["a","b"]}'}}]},finish_reason:"tool_calls"}]}];
  const request=runInNewContext(source+";performStreamRequest",{getApiKey:()=>"test",API_URL:"/api/chat",proxyHeaders:()=>({}),abortController:new AbortController(),TextDecoder,fetch:async()=>new Response(chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n")});
  const result=await request({},()=>{});
  assert.equal(result.msg.tool_calls[0].extra_content.google.thought_signature,"signed");
  assert.deepEqual(JSON.parse(result.msg.tool_calls[0].function.arguments),{queries:["a","b"]});
});
