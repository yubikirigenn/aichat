import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const continuation=readFileSync(new URL("../public/continuation.js",import.meta.url),"utf8");
const harness=readFileSync(new URL("../public/harness.js",import.meta.url),"utf8");
const history=readFileSync(new URL("../public/history.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const pure=runInNewContext(history+harness+continuation+";({summarizeContextText,parseSupervisorDecision,supervisorDue,usableContextSummary,rateLimitDelay,waitForRateLimit})",{DOMException,setTimeout,clearTimeout});
test("AI compaction processes every fragment in order with three concurrent requests",async()=>{
  let active=0,peak=0;const parts=[];
  const result=await pure.summarizeContextText("a".repeat(103),async({purpose,input})=>{assert.equal(purpose,"compression");active++;peak=Math.max(peak,active);const data=JSON.parse(input);parts.push(data);await new Promise(r=>setImmediate(r));active--;return String(data.part)},{chunkChars:20,targetChars:100});
  assert.equal(peak,3);assert.equal(parts.length,6);assert.equal(parts.map(p=>p.fragment).join(""),"a".repeat(103));assert.equal(result,"1\n\n2\n\n3\n\n4\n\n5\n\n6");
});
test("hierarchical compaction never silently truncates a summary or invents one on failure",async()=>{
  let calls=0;
  const result=await pure.summarizeContextText("x".repeat(100),async()=>{calls++;return "fact"},{chunkChars:25,targetChars:10});
  assert.equal(result,"fact");assert.ok(calls>4);
  await assert.rejects(pure.summarizeContextText("source",async()=>""),/要約を返しません/);
  await assert.rejects(pure.summarizeContextText("source",async()=>"source",{chunkChars:10,targetChars:2}),/短縮できません/);
  const controller=new AbortController();controller.abort();await assert.rejects(pure.summarizeContextText("source",async()=>"never",{signal:controller.signal}),e=>e.name==="AbortError");
});
test("supervisor scheduling is not a stop decision and decisions must be model-produced JSON",()=>{
  const state={round:0,at:1000};assert.equal(pure.supervisorDue(state,2,2000),false);assert.equal(pure.supervisorDue(state,3,2000),true);assert.equal(pure.supervisorDue(state,1,62000),true);
  assert.equal(pure.parseSupervisorDecision('{"action":"revise","reason":"証拠が不足","guidance":"実行ログを確認"}').action,"revise");
  assert.throws(()=>pure.parseSupervisorDecision('{"action":"delete_files","reason":"x","guidance":"x"}'));
  assert.throws(()=>pure.parseSupervisorDecision("勝手に停止"));assert.throws(()=>pure.parseSupervisorDecision('{"action":"ask_user"}'));
  assert.throws(()=>pure.parseSupervisorDecision('{"action":"ask_user","reason":"","guidance":""}'));
});
test("rate waits honor Retry-After and can be cancelled without submitting more requests",async()=>{
  assert.equal(pure.rateLimitDelay("10"),10000);assert.equal(pure.rateLimitDelay(null),30000);
  assert.equal(pure.rateLimitDelay("Thu, 01 Jan 1970 00:01:00 GMT",0),60000);
  const controller=new AbortController();const waiting=pure.waitForRateLimit("300",controller.signal);controller.abort();await assert.rejects(waiting,e=>e.name==="AbortError");
});
function integration(chat,testRequest,model={key:"test:large",contextLength:131072,maxOutputTokens:8192}){
  const controller=new AbortController();
  const source=html.slice(html.indexOf("async function requestAuxiliaryAI("),html.indexOf("function buildTools("));
  const api=runInNewContext(history+harness+continuation+source+";requestAuxiliaryAI=(_chat,args)=>testRequest(args);({prepareApiMessages,compressChatContext,apiMessages,reviewRunWithAI})",{
    DOMException,AbortController,Date,abortController:controller,testRequest,settings:{systemPrompt:"",maxTokens:8192},selectedModel:()=>model,activeChat:()=>chat,buildSystemPrompt:()=>"system stays intact",buildTools:()=>[],persistChats:async()=>{},nowISO:()=>"now",upsertActivity:()=>{},setStatus:()=>{},safeImageDataUrl:()=>true,
  });
  return {...api,controller};
}
function researchChat(){
  const messages=[{role:"user",content:"previous request"},{role:"assistant",content:"prior observations"},{role:"user",content:"latest exact request",images:[{name:"image",dataUrl:"data:image/png;base64,untouched"}]}];
  for(let i=0;i<8;i++)messages.push({role:"assistant",internal:true,content:"work "+i,tool_calls:[{id:"c"+i,function:{name:"workspace_read_file",arguments:JSON.stringify({path:"game.js"})}}]},{role:"tool",internal:true,tool_call_id:"c"+i,name:"workspace_read_file",content:(i<5?"old data ".repeat(12000):"recent result "+i)});
  return {messages};
}
test("large-model current input and huge archived UI metadata do not trigger early compression",async()=>{
  const chat={messages:[{role:"user",content:"exact request "+"x".repeat(300000)}]};let calls=0;
  const api=integration(chat,async()=>{calls++;return "unexpected"},{key:"test:million",contextLength:1000000,maxOutputTokens:65536});
  const messages=await api.prepareApiMessages(chat);
  assert.equal(calls,0);assert.equal(messages[1].content,chat.messages[0].content);assert.equal(chat.contextSummary,undefined);
  chat.messages.push({role:"assistant",content:"short reply",toolEvents:[{name:"read",detail:{result:{content:"z".repeat(1000000)}}}]});
  await api.prepareApiMessages(chat);assert.equal(calls,0);
});
test("compaction replaces only an old complete prefix, preserving request, images, system and recent tool protocols",async()=>{
  const chat=researchChat(),original=JSON.stringify(chat.messages);let calls=0,source="";
  const api=integration(chat,async({purpose,input})=>{assert.equal(purpose,"compression");calls++;source+=JSON.parse(input).fragment;return "Observed old source facts; game.js was read. Raw history indices remain available."});
  const messages=await api.prepareApiMessages(chat);
  assert.ok(calls>1);assert.equal(JSON.stringify(chat.messages),original);assert.equal(chat.contextSummary.version,2);
  assert.equal(messages[0].content,"system stays intact");assert.doesNotMatch(messages[0].content,/引継|要約/);
  assert.match(source,/workspace_read_file/);assert.doesNotMatch(source,/latest exact request/);
  const memory=messages.find(m=>m.role==="assistant"&&m.content?.includes('"type":"compressed_history"'));assert.ok(memory);
  const latest=messages.find(m=>m.role==="user");assert.equal(latest.content[0].text,"latest exact request");assert.equal(latest.content[1].image_url.url,chat.messages[2].images[0].dataUrl);
  for(let i=5;i<8;i++){assert.ok(messages.some(m=>m.tool_calls?.[0]?.id==="c"+i));assert.ok(messages.some(m=>m.tool_call_id==="c"+i&&m.content==="recent result "+i))}
  assert.equal(messages.some(m=>m.tool_call_id==="c0"),false);
  assert.equal(pure.usableContextSummary(chat).text,chat.contextSummary.text);
  const before=calls;await api.prepareApiMessages(chat);assert.equal(calls,before);
  chat.messages[0].content="edited";assert.equal(pure.usableContextSummary(chat),null);
  await api.prepareApiMessages(chat);assert.ok(calls>before);
});
test("failed proactive compression cancels only its child requests and keeps the main run alive",async()=>{
  const chat=researchChat(),original=JSON.stringify(chat.messages);
  const api=integration(chat,async()=>{throw new DOMException("aux transport interrupted","AbortError")},{key:"test:fits",contextLength:190000,maxOutputTokens:8192});
  const messages=await api.prepareApiMessages(chat);
  assert.equal(api.controller.signal.aborted,false);assert.equal(chat.contextSummary,undefined);assert.ok(chat.compactionRetryAt>Date.now());assert.equal(JSON.stringify(chat.messages),original);assert.ok(messages.some(m=>m.tool_call_id==="c0"));
});
test("failed forced compression preserves original error and never aborts the main controller",async()=>{
  const chat=researchChat(),api=integration(chat,async()=>{throw new Error("summary provider unavailable")});
  await assert.rejects(api.compressChatContext(chat,{force:true}),/summary provider unavailable/);
  assert.equal(api.controller.signal.aborted,false);
});
test("supervisor failure does not block execution, and ask_user comes from the AI decision",async()=>{
  const chat={messages:[{role:"user",content:"check runtime"}],resumeState:{operations:[{name:"workspace_preview",status:"completed"}],notes:{findings:["unknown runtime"]}}};
  const failed=integration(chat,async()=>{throw new DOMException("monitor transport aborted","AbortError")});assert.equal(await failed.reviewRunWithAI(chat,3,{}),null);assert.equal(failed.controller.signal.aborted,false);
  const active=integration(chat,async({purpose,input})=>{assert.equal(purpose,"supervision");assert.match(input,/workspace_preview/);return '{"action":"ask_user","reason":"操作後の挙動が未観測","guidance":"クリック後の画面を質問"}'});
  const decision=await active.reviewRunWithAI(chat,3,{});assert.equal(decision.action,"ask_user");assert.equal(chat.supervision.action,"ask_user");
});
test("abort classification distinguishes the stop button from child transport failures",()=>{
  const api=runInNewContext(continuation+";({generationFailureMessage,contextPressure,recordContextUsage})",{DOMException});
  const abort=new DOMException("provider cancelled its transport","AbortError"),controller=new AbortController();
  assert.doesNotMatch(api.generationFailureMessage(abort,controller.signal),/^生成を停止しました/);
  controller.abort({code:"user_stop"});assert.equal(api.generationFailureMessage(abort,controller.signal),"生成を停止しました。");
  assert.doesNotMatch(html,/if\(!signal\?\.aborted\)abortController\?\.abort/);
});
test("token pressure uses model capacity and measured prompt usage, not archived source bytes",()=>{
  const api=runInNewContext(continuation+";({contextPressure,recordContextUsage})",{DOMException});
  const chat={},model={key:"route",contextLength:1000000,maxOutputTokens:65536},messages=[{role:"user",content:"word ".repeat(60000)}];
  const initial=api.contextPressure(chat,messages,model,16384);assert.equal(initial.shouldCompact,false);
  api.recordContextUsage(chat,messages,model,{prompt_tokens:100000});assert.ok(api.contextPressure(chat,messages,model,16384).input>=99000);
  assert.equal(api.contextPressure(chat,messages,{...model,key:"other",contextLength:65536,maxOutputTokens:8192},8192).shouldCompact,true);
});
test("legacy handoff summaries are invalidated instead of promoted into System instructions",()=>{
  const chat=researchChat();chat.contextSummary={through:2,text:"old handoff"};assert.equal(pure.usableContextSummary(chat),null);
  const api=integration(chat,async()=>"unused");const messages=api.apiMessages(chat);assert.equal(messages[0].content,"system stays intact");assert.ok(messages.some(m=>m.tool_call_id==="c0"));
});
test("fixed round/tool limits and heuristic stopping logic are absent from the running harness",()=>{
  assert.doesNotMatch(html,/Tool Callingが最大|toolCallsUsed>80|settings\.maxRounds|createInvestigationTracker|blockedCount>=3|1回の生成が3分/);
  assert.doesNotMatch(harness,/repeated_read|repeated_tool_failure|maxCalls=80|stale>=5/);
  assert.doesNotMatch(readFileSync(new URL("../detached-chat.mjs",import.meta.url),"utf8"),/timeoutMs|maxJobs|maxBytes|maxTotalBytes|delivery_capacity|5分の上限/);
  assert.match(html,/while\(true\)/);assert.match(html,/await reviewRunWithAI/);assert.match(html,/await prepareApiMessages/);
});
