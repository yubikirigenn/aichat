import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {PROVIDERS,MODEL_CATALOG} from "../models.mjs";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const harness=readFileSync(new URL("../public/harness.js",import.meta.url),"utf8");
const ui=readFileSync(new URL("../public/chat-ui.js",import.meta.url),"utf8");
const server=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
const plain=value=>JSON.parse(JSON.stringify(value));
function promptHarness(webSearchProvider="legacy"){
  let omitted=0;
  const fn=runInNewContext(html.slice(html.indexOf("function buildSystemPrompt("),html.indexOf("function makeLegacyWebPlugin("))+";({apiMessages,buildTools})",{
    settings:{web:true,webResults:5,webMaxCalls:4,systemPrompt:"追加の固定指示"},
    functionTools:[{type:"function",function:{name:"current_datetime"}}],webFunctionTools:[{type:"function",function:{name:"web_search"}}],
    selectedModel:()=>({provider:"openrouter"}),clamp:(x,min,max)=>Math.min(max,Math.max(min,x)),
    webSearchProvider,
    resumeContext:()=>"",
    conversationWindow:messages=>({messages,omitted,over_budget:false}),safeImageDataUrl:()=>false,
  });
  return {...fn,setOmitted:value=>omitted=value};
}
test("tool rounds and volatile recovery state preserve the static system/history prefix",()=>{
  const p=promptHarness(),chat={messages:[{role:"user",content:"調べて"}]};
  const first=plain(p.apiMessages(chat));
  chat.messages.push({role:"assistant",content:"検索します",tool_calls:[{id:"t",type:"function",function:{name:"web_search",arguments:'{"query":"test"}'}}]},{role:"tool",tool_call_id:"t",name:"web_search",content:'{"ok":false}'});
  const original=JSON.stringify(chat),retry=plain(p.apiMessages(chat,"別の検索語を試してください"));
  assert.deepEqual(retry.slice(0,first.length),first);
  assert.equal(retry.at(-1).role,"user");assert.match(retry.at(-1).content,/別の検索語/);
  p.setOmitted(4);const trimmed=plain(p.apiMessages(chat,"復旧"));
  assert.equal(trimmed[0].content,first[0].content);assert.match(trimmed.at(-1).content,/0〜3/);
  assert.equal(JSON.stringify(chat),original);
});
test("native search and client fallback share ordered function definitions without mutation",()=>{
  const p=promptHarness(),native=plain(p.buildTools()),fallback=plain(p.buildTools(false));
  assert.deepEqual(native.slice(0,fallback.length),fallback);
  assert.deepEqual(plain(p.buildTools()),native);assert.deepEqual(fallback.map(t=>t.function.name),["current_datetime","web_search"]);
});
test("Tavily selection keeps function search and disables OpenRouter native search",()=>{
  const tools=plain(promptHarness("tavily").buildTools());
  assert.deepEqual(tools.map(t=>t.function.name),["current_datetime","web_search"]);
  assert.ok(!tools.some(t=>t.type.startsWith("openrouter:")));
});
test("OpenRouter gets a validated conversation session; other providers get no unsupported hint",()=>{
  const adapt=runInNewContext(server.slice(server.indexOf("function adaptProviderBody("),server.indexOf("async function providerFetch("))+";adaptProviderBody");
  for(const provider of Object.values(PROVIDERS)){
    const model=MODEL_CATALOG.find(m=>m.provider===provider.id);
    const body={model:model.id,messages:[],cache_session_id:"chat-123",session_id:"injected"};
    const result=adapt(provider,body,model);
    assert.equal(result.cache_session_id,undefined);assert.equal(result.session_id,provider.id==="openrouter"?"chat-123":undefined);
    assert.equal(body.session_id,"injected");
  }
  for(const id of [null,"","x".repeat(129),"line\nbreak"]){
    assert.equal(adapt(PROVIDERS.openrouter,{cache_session_id:id}).session_id,undefined);
  }
});
test("cache usage distinguishes an actual zero hit from missing or partial metrics",()=>{
  const {readCacheUsage}=runInNewContext(harness+";({readCacheUsage})",{});
  const label=runInNewContext(ui+";cacheUsageLabel",{});
  assert.equal(readCacheUsage({prompt_tokens:2000}),null);
  assert.equal(readCacheUsage({prompt_tokens:100,cached_tokens:80}),null);
  assert.equal(readCacheUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:101}}),null);
  assert.equal(readCacheUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:-1}}),null);
  assert.deepEqual(plain(readCacheUsage({prompt_tokens:2000,prompt_tokens_details:{cached_tokens:1500,cache_write_tokens:100}})),{prompt_tokens:2000,cached_tokens:1500,cache_write_tokens:100});
  assert.equal(readCacheUsage({prompt_tokens:100,prompt_cache_hit_tokens:0}).cached_tokens,0);
  assert.match(label({reported_rounds:0}),/未報告/);
  assert.match(label({prompt_tokens:2000,cached_tokens:1500,reported_rounds:1,total_rounds:2}),/75.0%.*1\/2 rounds/);
});
test("web fallback retries append instructions without rewriting prior messages",async()=>{
  const requests=[];
  const fn=runInNewContext(html.slice(html.indexOf("async function retryWithClientWebTools("),html.indexOf("async function streamRound("))+";retryWithClientWebTools",{
    abortController:new AbortController(),DOMException,buildTools:()=>[],setStatus:()=>{},toast:()=>{},
    performStreamRequest:async body=>{requests.push(plain(body));return {msg:{tool_calls:requests.length===1?[]:[{function:{name:"web_search"}}]}}},
  });
  const body={messages:[{role:"system",content:"固定"},{role:"user",content:"質問"}]},original=JSON.stringify(body);
  const result=await fn(body);assert.equal(result.webFallback,true);assert.equal(requests.length,2);
  for(const request of requests)assert.deepEqual(request.messages.slice(0,2),body.messages);
  assert.deepEqual(requests[1].messages.slice(0,3),requests[0].messages);assert.equal(JSON.stringify(body),original);
});
test("non-streaming title response stays valid JSON instead of receiving an SSE prefix",async()=>{
  let handler,headers={},sent,writes=0;
  runInNewContext(server.slice(server.indexOf('app.post("/api/chat"'),server.indexOf("function providerCheckEndpoint(")),{
    app:{post:(_path,fn)=>handler=fn},authorizeRequest:()=>({ok:true}),requestedModel:()=>({provider:"groq",id:"test"}),
    providerAccess:()=>({ok:true,provider:{label:"Groq"},apiKey:"mock"}),removeAccessPassword:body=>body,adaptProviderBody:(_provider,body)=>body,
    providerFetch:async()=>Response.json({choices:[{message:{content:"自動タイトル"}}]}),
  });
  const res={status(){return this},setHeader(key,value){headers[key]=value},send(text){sent=text;return this},write(){writes++}};
  await handler({body:{provider:"groq",model:"test",stream:false,messages:[]}},res);
  assert.equal(JSON.parse(sent).choices[0].message.content,"自動タイトル");assert.equal(writes,0);assert.match(headers["Content-Type"],/application\/json/);
});
