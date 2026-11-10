import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {MODEL_CATALOG,DEFAULT_MODEL} from "../models.mjs";
import {MODEL_SOURCES,createAutoModelCatalog,modelRefreshInterval,parseOpenRouterCatalog,parseTokenHarborCatalog,parseGroqCatalog,parseGeminiFreeIds,parseGeminiModel} from "../model-refresh.mjs";

const at=Date.parse("2026-11-10T00:00:00Z");
const orRow=(id="test/new:free",extra={})=>({id,name:"New model",pricing:{prompt:"0",completion:"0"},context_length:262144,architecture:{input_modalities:["text","image"],output_modalities:["text"]},supported_parameters:["tools","reasoning","temperature"],top_provider:{max_completion_tokens:32768},...extra});
const thRow=(extra={})=>({surface:"new-chat:free",label:"New chat",isFree:true,priceIn:0,priceOut:0,inputModalities:["text","image"],contextWindow:131072,maxOutput:8192,...extra});
const td=rows=>"<table>"+rows.map(row=>"<tr>"+row.map(cell=>"<td>"+cell+"</td>").join("")+"</tr>").join("")+"</table>";
const freeHeader='<table><tr><th><button class="bg-black">Free Plan Limits</button><button>Developer Plan Limits</button></th></tr><tr><th>MODEL ID</th></tr></table>';
const freeBody=td([["openai/gpt-oss-120b",30,1000,8000,200000,"-","-"]]);
const groqModels=td([["MODEL ID","SPEED","PRICE","RATE","CONTEXT","MAX OUTPUT"],["openai/gpt-oss-120b",1,1,1,"131,072","65,536"]]);
const pricing=(ids=["gemini-4-flash"])=>"# Pricing\nFree Tier\n"+ids.map(id=>`\n## ${id}\n\`${id}\`\n* Input price\n* Free of charge\n* $1\n* Output price (including thinking tokens)\n* Free of charge\n* $2\n`).join("");
const geminiPage=(id="gemini-4-flash")=>`${id}\nInputs\nText, Image\nOutput\nText\nInput token limit\n1,048,576\nOutput token limit\n65,536\nFunction calling {% badge type="supported" /%}\nThinking {% badge type="supported" /%}`;
function fixtureFetch(overrides={}){
  const sources={
    [MODEL_SOURCES.openrouter]:JSON.stringify({data:[orRow()]}),
    [MODEL_SOURCES.tokenharbor]:JSON.stringify({freeRows:[thRow()]}),
    [MODEL_SOURCES.groq]:freeHeader+freeBody,
    "https://console.groq.com/docs/models":groqModels,
    [MODEL_SOURCES.gemini]:pricing(),
    "https://ai.google.dev/gemini-api/docs/models/gemini-4-flash":geminiPage(),
    ...overrides,
  };
  const calls=[];
  const fetch=async(url,options)=>{
    calls.push({url,options});if(options.signal.aborted)throw options.signal.reason;
    const result=sources[url];if(result instanceof Error)throw result;if(result instanceof Response)return result;
    assert.equal(typeof result,"string",url);return new Response(result);
  };
  return {fetch,calls,sources};
}
test("OpenRouter accepts only explicit zero-priced free text routes with verified capabilities",()=>{
  const result=parseOpenRouterCatalog({data:[orRow(),orRow("paid/base",{pricing:{prompt:0,completion:0}}),orRow("costly:free",{pricing:{prompt:0,completion:1}}),orRow("missing:free",{pricing:{prompt:null,completion:0}}),orRow("audio:free",{architecture:{output_modalities:["audio"]}})]});
  assert.equal(result.length,1);assert.equal(result[0].id,"test/new:free");assert.equal(result[0].vision,true);assert.equal(result[0].supportsTools,true);
  assert.throws(()=>parseOpenRouterCatalog({data:[]}));assert.throws(()=>parseOpenRouterCatalog({data:[orRow("bad:free",{context_length:null})]}));
  assert.throws(()=>parseOpenRouterCatalog({data:[orRow(),orRow()]}));
});
test("Token Harbor reads JSON or Next flight data without evaluating script, and rejects paid IDs",()=>{
  const data=JSON.stringify({freeRows:[thRow()]});
  const next='<script>self.__next_f.push('+JSON.stringify([1,"component:"+data])+')</script><script>throw new Error("never execute")</script>';
  assert.equal(parseTokenHarborCatalog(next)[0].id,"new-chat:free");assert.equal(parseTokenHarborCatalog(data)[0].supportsTools,false);
  for(const row of [thRow({surface:"paid-base"}),thRow({priceIn:.1}),thRow({isFree:false})])assert.deepEqual(parseTokenHarborCatalog(JSON.stringify({freeRows:[row]})),[]);
  assert.throws(()=>parseTokenHarborCatalog(JSON.stringify({freeRows:[thRow({priceOut:null})]})));
  assert.throws(()=>parseTokenHarborCatalog("changed page"));assert.deepEqual(parseTokenHarborCatalog('{"freeRows":[]}'),[]);
});
test("Groq distinguishes the selected free-plan table, including split sticky headers",()=>{
  const models=parseGroqCatalog(freeHeader+freeBody,groqModels);assert.equal(models.length,1);assert.equal(models[0].contextLength,131072);assert.equal(models[0].supportsTools,true);
  const combined=freeHeader.replace("</table>",freeBody.replace(/<\/?table>/g,"")+"</table>");assert.equal(parseGroqCatalog(combined,groqModels).length,1);
  assert.throws(()=>parseGroqCatalog(freeHeader.replace('class="bg-black"',""),groqModels));
  assert.throws(()=>parseGroqCatalog(freeHeader,groqModels));assert.throws(()=>parseGroqCatalog(freeHeader+freeBody,"changed page"));
});
test("Gemini verifies free input AND output, text modality, limits and supported capabilities",()=>{
  const price=pricing(["gemini-4-flash","gemini-4-flash-tts","gemini-4-pro"]).replace(/\* Output price \(including thinking tokens\)\n\* Free of charge\n\* \$2\n$/,"* Output price\n* Not available\n* $2\n");
  assert.deepEqual(parseGeminiFreeIds(price),["gemini-4-flash"]);
  assert.deepEqual(parseGeminiFreeIds(pricing().replaceAll("Free of charge","Not available")),[]);
  const model=parseGeminiModel("gemini-4-flash",geminiPage());assert.equal(model.vision,true);assert.equal(model.supportsTools,true);assert.equal(model.contextLength,1048576);
  assert.equal(parseGeminiModel("gemini-4-flash",geminiPage().replace('Function calling {% badge type="supported"','Function calling {% badge type="not-supported"')).supportsTools,false);
  assert.throws(()=>parseGeminiModel("gemini-4-flash",geminiPage().replace("Output\nText","Output\nAudio")));assert.throws(()=>parseGeminiFreeIds("changed page"));
});
test("refresh publishes new allowlist/default atomically per provider, expires routes and retains billing guards",async()=>{
  let time=at;const f=fixtureFetch({[MODEL_SOURCES.openrouter]:JSON.stringify({data:[orRow("test/new:free",{expiration_date:"2026-11-10"})]})});
  const catalog=createAutoModelCatalog({fetchImpl:f.fetch,now:()=>time});
  assert.ok(catalog.find(DEFAULT_MODEL.provider,DEFAULT_MODEL.id));await catalog.refresh();
  assert.ok(catalog.find("openrouter","test/new:free"));assert.equal(catalog.find(DEFAULT_MODEL.provider,DEFAULT_MODEL.id),null);assert.equal(catalog.defaultModel().id,"test/new:free");
  assert.ok(catalog.find("experientiallabs","qwen3.8-flash-next-uncensored"));assert.equal(catalog.find("bai","anything"),null);
  assert.ok(catalog.status().sources.gemini.updatedAt);assert.equal(catalog.status().sources.groq.error,null);
  time+=86400000;assert.equal(catalog.find("openrouter","test/new:free"),null);assert.notEqual(catalog.defaultModel().provider,"experientiallabs");
  assert.ok(f.calls.every(call=>!call.options.headers.Authorization));catalog.close();
});
test("source failures preserve last good provider independently, with safe status only",async()=>{
  const f=fixtureFetch(),catalog=createAutoModelCatalog({fetchImpl:f.fetch,now:()=>at});await catalog.refresh();
  f.sources[MODEL_SOURCES.openrouter]='{"data":[]}';f.sources[MODEL_SOURCES.tokenharbor]=new Error("secret upstream details");f.sources[MODEL_SOURCES.gemini]="schema changed";
  f.sources[MODEL_SOURCES.groq]="schema changed";await catalog.refresh();
  assert.ok(catalog.find("openrouter","test/new:free"));assert.ok(catalog.find("tokenharbor","new-chat:free"));assert.ok(catalog.find("gemini","gemini-4-flash"));assert.ok(catalog.find("groq","openai/gpt-oss-120b"));
  assert.doesNotMatch(JSON.stringify(catalog.status()),/secret upstream/);assert.ok(catalog.status().sources.openrouter.error);catalog.close();
});
test("scheduler coalesces startup, timer and browser requests; interval is configurable and close cancels",async()=>{
  let time=at,callback,period,cleared=false,release;const f=fixtureFetch();
  const gate=new Promise(resolve=>{release=resolve});const catalog=createAutoModelCatalog({fetchImpl:async(...args)=>{await gate;return f.fetch(...args)},now:()=>time,setIntervalImpl:(fn,ms)=>{callback=fn;period=ms;return {unref(){}}},clearIntervalImpl:()=>{cleared=true}});
  catalog.start();const a=catalog.refreshIfDue(),b=catalog.refresh();assert.equal(a,b);release();await a;
  assert.equal(period,6*3600000);const count=f.calls.length;await catalog.refreshIfDue();assert.equal(f.calls.length,count);
  time+=period;callback();await catalog.refreshIfDue();assert.ok(f.calls.length>count);catalog.close();assert.equal(cleared,true);const done=f.calls.length;await catalog.refresh();assert.equal(f.calls.length,done);
  assert.equal(modelRefreshInterval("12"),12*3600000);for(const value of ["0","nope","999"])assert.equal(modelRefreshInterval(value),6*3600000);
  const disabled=createAutoModelCatalog({enabled:false,fetchImpl:()=>{throw new Error("must not fetch")}});disabled.start();await disabled.refreshIfDue();assert.equal(disabled.status().enabled,false);disabled.close();
});
test("unsafe redirects and oversized catalog bodies do not replace a good snapshot",async()=>{
  const f=fixtureFetch({[MODEL_SOURCES.openrouter]:new Response(null,{status:302,headers:{location:"https://attacker.invalid/steal"}}),[MODEL_SOURCES.tokenharbor]:new Response("bad",{headers:{"content-length":"99999999"}})});
  const catalog=createAutoModelCatalog({fetchImpl:f.fetch});await catalog.refresh();assert.ok(catalog.find(DEFAULT_MODEL.provider,DEFAULT_MODEL.id));assert.ok(catalog.status().sources.openrouter.error);assert.ok(catalog.status().sources.tokenharbor.error);assert.equal(f.calls.some(c=>c.url.includes("attacker")),false);catalog.close();
});
test("shutdown aborts in-flight source reads, and known paid routes are removed rather than preserved",async()=>{
  let cancelled=0;
  const pending=createAutoModelCatalog({fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>{cancelled++;reject(signal.reason)},{once:true}))});
  const refreshing=pending.refresh();pending.close();await refreshing;assert.equal(cancelled,4);
  const f=fixtureFetch(),catalog=createAutoModelCatalog({fetchImpl:f.fetch});await catalog.refresh();
  f.sources[MODEL_SOURCES.openrouter]=JSON.stringify({data:[orRow("test/new:free",{pricing:{prompt:0,completion:1}})]});
  f.sources[MODEL_SOURCES.tokenharbor]=JSON.stringify({freeRows:[thRow({priceIn:1})]});
  f.sources[MODEL_SOURCES.gemini]=pricing().replaceAll("Free of charge","Not available");await catalog.refresh();
  assert.equal(catalog.find("openrouter","test/new:free"),null);assert.equal(catalog.find("tokenharbor","new-chat:free"),null);assert.equal(catalog.find("gemini","gemini-4-flash"),null);catalog.close();
});
test("server request validation uses the same live allowlist as the browser catalog",async()=>{
  const f=fixtureFetch(),catalog=createAutoModelCatalog({fetchImpl:f.fetch});await catalog.refresh();
  const server=readFileSync(new URL("../server.mjs",import.meta.url),"utf8"),source=server.slice(server.indexOf("function requestedModel("),server.indexOf("function providerAccess("));
  const requested=runInNewContext(source+";requestedModel",{automaticModels:catalog});assert.ok(requested({provider:"openrouter",model:"test/new:free"}));assert.equal(requested({provider:"openrouter",model:"paid/base"}),null);assert.equal(requested({}).id,"test/new:free");assert.match(server,/models: automaticModels.models\(\)/);catalog.close();
});
test("client polling defers catalog changes while a turn runs, coalesces reads and preserves current selection",async()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8"),source=html.slice(html.indexOf("function applyPendingModelCatalog("),html.indexOf("function renderEditMode("));
  const old={id:"old",key:"openrouter:old",provider:"openrouter"},next={id:"new",key:"openrouter:new",provider:"openrouter"};let reads=0,rendered=0;
  const context={running:true,modelCatalog:[old],providerCatalog:[],webSearchProvider:"legacy",settings:{model:"old",provider:"openrouter"},renderModelControls:()=>{rendered++},syncChips:()=>{},fetch:async()=>{reads++;return new Response(JSON.stringify({models:[old,next],providers:[{id:"openrouter"}]}))},AbortSignal,console,Date};
  const api=runInNewContext('let pendingModelCatalog=null,modelCatalogRequest=null,lastModelCatalogCheck=0;'+source+';({loadModelCatalog,applyPendingModelCatalog})',context);
  await Promise.all([api.loadModelCatalog(),api.loadModelCatalog()]);assert.equal(reads,1);assert.equal(context.modelCatalog.length,1);assert.equal(rendered,0);assert.equal(context.settings.model,"old");
  context.running=false;api.applyPendingModelCatalog();assert.equal(context.modelCatalog.length,2);assert.equal(rendered,1);assert.equal(context.settings.model,"old");
});
