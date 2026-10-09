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
  assert.equal(result.reasoning_effort,undefined);assert.equal(result.reasoning,undefined);assert.equal(result.tools.length,1);
  assert.equal(result.tool_choice.function.name,"web_search");assert.equal(result.service_tier,undefined);assert.equal(result.plugins,undefined);
  assert.equal(result.extra_body.google.thinking_config.include_thoughts,true);
  assert.equal(result.extra_body.google.thinking_config.thinking_level,"low");
  assert.equal(result.messages[0].reasoning,undefined);assert.equal(result.messages[0].tool_calls[0].extra_content,signature);
  assert.equal(body.tools.length,2);
});
test("every Gemini model uses only thinking_config for ON, OFF and diagnostics",()=>{
  for(const model of MODEL_CATALOG.filter(m=>m.provider==="gemini"))for(const reasoning of [{enabled:true},{enabled:false},undefined]){
    const body={model:model.id,messages:[],reasoning,reasoning_effort:"high",extra_body:{google:{thinking_config:{thinking_budget:999}}}};
    const result=adapt(PROVIDERS.gemini,body,model),config=result.extra_body.google.thinking_config;
    assert.equal(result.reasoning_effort,undefined,model.id);
    assert.equal(config.include_thoughts,reasoning?.enabled===true);
    if(model.id.startsWith("gemini-2.5-")){
      assert.equal(config.thinking_level,undefined);
      assert.equal(config.thinking_budget,reasoning?.enabled!==true&&/^gemini-2\.5-(?:flash|flash-lite)$/.test(model.id)?0:1024);
    }else{assert.equal(config.thinking_level,"low");assert.equal(config.thinking_budget,undefined)}
    assert.equal(body.reasoning_effort,"high");assert.equal(body.extra_body.google.thinking_config.thinking_budget,999);
  }
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

async function streamTools(deltas,onUpdate){
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const source=html.slice(html.indexOf("async function performStreamRequest("),html.indexOf("async function retryWithClientWebTools("));
  const chunks=deltas.map(tool_calls=>({choices:[{delta:{tool_calls}}]}));
  const request=runInNewContext(source+";performStreamRequest",{
    getApiKey:()=>"test",API_URL:"/api/chat",proxyHeaders:()=>({}),abortController:new AbortController(),TextDecoder,
    fetch:async()=>new Response(chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n")
  });
  return (await request({},onUpdate)).msg.tool_calls;
}

test("unindexed Gemini calls stay separate and retain their IDs and signatures",async()=>{
  const snapshots=[];
  const calls=await streamTools([
    [{id:"time",function:{name:"current_datetime",arguments:"{}"},extra_content:{google:{thought_signature:"time-sig"}}}],
    [{id:"search",function:{name:"web_search",arguments:'{"query":'},extra_content:{google:{thought_signature:"search-sig"}}}],
    [{id:"search",function:{name:"web_search",arguments:'"Gemini"}'}}],
  ],msg=>snapshots.push(JSON.parse(JSON.stringify(msg))));
  assert.equal(calls.length,2);
  assert.equal(calls[0].id,"time");assert.equal(calls[0].function.name,"current_datetime");
  assert.deepEqual(JSON.parse(calls[0].function.arguments),{});
  assert.equal(calls[1].id,"search");assert.equal(calls[1].function.name,"web_search");
  assert.deepEqual(JSON.parse(calls[1].function.arguments),{query:"Gemini"});
  assert.equal(calls[0].extra_content.google.thought_signature,"time-sig");
  assert.equal(calls[1].extra_content.google.thought_signature,"search-sig");
  assert.equal(snapshots[0].tool_calls.length,1);
  assert.equal(snapshots[1].tool_calls[1].function.arguments,'{"query":');
});

test("parallel indexed calls support interleaved fragments and split names",async()=>{
  const calls=await streamTools([
    [{index:0,id:"a",function:{name:"web_",arguments:'{"query":'}},{index:1,id:"b",function:{name:"current_datetime",arguments:"{"}}],
    [{index:1,function:{arguments:"}"}},{index:0,function:{name:"search",arguments:'"Gemini"}'}}],
  ]);
  assert.equal(calls.length,2);assert.equal(calls[0].function.name,"web_search");
  assert.deepEqual(JSON.parse(calls[0].function.arguments),{query:"Gemini"});
  assert.deepEqual(JSON.parse(calls[1].function.arguments),{});
});

test("distinct IDs never merge even when the upstream reuses index zero",async()=>{
  const calls=await streamTools([
    [{index:0,id:"a",function:{name:"current_datetime",arguments:"{}"}}],
    [{index:0,id:"b",function:{name:"web_search",arguments:'{"query":'}}],
    [{index:0,function:{arguments:'"Gemini"}'}}],
  ]);
  assert.equal(calls.length,2);assert.equal(calls[0].function.name,"current_datetime");
  assert.equal(calls[1].function.name,"web_search");
  assert.deepEqual(JSON.parse(calls[1].function.arguments),{query:"Gemini"});
});

test("anonymous continuation is accepted only when there is one possible call",async()=>{
  const calls=await streamTools([[{id:"a",function:{name:"web_search",arguments:'{"query":'}}],[{function:{arguments:'"Gemini"}'}}]]);
  assert.deepEqual(JSON.parse(calls[0].function.arguments),{query:"Gemini"});
  await assert.rejects(streamTools([
    [{id:"a",function:{name:"current_datetime",arguments:"{}"}},{id:"b",function:{name:"web_search",arguments:'{"query":'}}],
    [{function:{arguments:'"Gemini"}'}}],
  ]),/ID・index/);
});
