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
function integration(chat,testRequest){
  const signal=new AbortController().signal;
  const source=html.slice(html.indexOf("async function requestAuxiliaryAI("),html.indexOf("function buildTools("));
  return runInNewContext(history+harness+continuation+source+";requestAuxiliaryAI=(_chat,args)=>testRequest(args);({prepareApiMessages,compressChatContext,apiMessages,reviewRunWithAI})",{
    DOMException,Date,abortController:{signal},testRequest,settings:{systemPrompt:""},activeChat:()=>chat,buildSystemPrompt:()=>"system",buildTools:()=>[],persistChats:async()=>{},nowISO:()=>"now",upsertActivity:()=>{},setStatus:()=>{},safeImageDataUrl:()=>false,
  });
}
test("oversized current-turn input is automatically summarized while original messages and images stay saved",async()=>{
  const chat={messages:[{role:"user",content:"important latest request "+"x".repeat(300000),images:[{name:"image",dataUrl:"unchanged-image"}]}]},original=JSON.stringify(chat.messages);let calls=0;
  const api=integration(chat,async({purpose})=>{assert.equal(purpose,"compression");calls++;return "重要な依頼と未完了の作業を保持。原文はindex 0。"});
  const messages=await api.prepareApiMessages(chat);
  assert.ok(calls>1);assert.ok(JSON.stringify(messages).length<30000);assert.equal(JSON.stringify(chat.messages),original);assert.equal(chat.contextSummary.through,1);
  assert.match(messages[0].content,/引継ぎ要約/);assert.equal(pure.usableContextSummary(chat).text,chat.contextSummary.text);
  const before=calls;await api.prepareApiMessages(chat);assert.equal(calls,before);
  chat.messages[0].content="changed "+chat.messages[0].content;assert.equal(pure.usableContextSummary(chat),null);await api.prepareApiMessages(chat);assert.ok(calls>before);
});
test("completed tool protocols are summarized together and originals remain available for history reads",async()=>{
  const chat={messages:[{role:"user",content:"fix game"},{role:"assistant",content:"",internal:true,tool_calls:[{id:"call",function:{name:"workspace_write_file",arguments:'{"path":"game.js","content":"done"}'}}]},{role:"tool",internal:true,tool_call_id:"call",name:"workspace_write_file",content:"z".repeat(260000)}]},original=JSON.stringify(chat.messages);let source="";
  const api=integration(chat,async({input})=>{source+=JSON.parse(input).fragment;return "game.jsへ書込済み。動作は未検証。"});
  const messages=await api.prepareApiMessages(chat);assert.match(source,/workspace_write_file/);assert.match(source,/game.js/);assert.equal(JSON.stringify(chat.messages),original);
  assert.equal(messages.some(m=>m.role==="tool"),false);assert.equal(messages.some(m=>m.tool_calls),false);
});
test("supervisor failure does not block execution, and ask_user comes from the AI decision",async()=>{
  const chat={messages:[{role:"user",content:"check runtime"}],resumeState:{operations:[{name:"workspace_preview",status:"completed"}],notes:{findings:["unknown runtime"]}}};
  const failed=integration(chat,async()=>{throw new Error("quota unavailable")});assert.equal(await failed.reviewRunWithAI(chat,3,{}),null);
  const active=integration(chat,async({purpose,input})=>{assert.equal(purpose,"supervision");assert.match(input,/workspace_preview/);return '{"action":"ask_user","reason":"操作後の挙動が未観測","guidance":"クリック後の画面を質問"}'});
  const decision=await active.reviewRunWithAI(chat,3,{});assert.equal(decision.action,"ask_user");assert.equal(chat.supervision.action,"ask_user");
});
test("fixed round/tool limits and heuristic stopping logic are absent from the running harness",()=>{
  assert.doesNotMatch(html,/Tool Callingが最大|toolCallsUsed>80|settings\.maxRounds|createInvestigationTracker|blockedCount>=3|1回の生成が3分/);
  assert.doesNotMatch(harness,/repeated_read|repeated_tool_failure|maxCalls=80|stale>=5/);
  assert.doesNotMatch(readFileSync(new URL("../detached-chat.mjs",import.meta.url),"utf8"),/timeoutMs|maxJobs|maxBytes|maxTotalBytes|delivery_capacity|5分の上限/);
  assert.match(html,/while\(true\)/);assert.match(html,/await reviewRunWithAI/);assert.match(html,/await prepareApiMessages/);
});
