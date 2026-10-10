import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source=readFileSync(new URL("../public/harness.js",import.meta.url),"utf8");
const h=runInNewContext(source+";({createInvestigationTracker,runToolBatch,createToolFailureTracker,toolResultPreview,resultSlice,observationText,searchStoredResult,conversationWindow,beginResumeState,checkpointTool,resumeContext,validResumeState})",{DOMException});
const call=(name,id)=>({id,function:{name,arguments:JSON.stringify({id})}});
const operation=(name,args)=>({function:{name,arguments:JSON.stringify(args)}});
test("investigation detects renamed result refs and overlapping read ranges without penalizing new source ranges",()=>{
  const tracker=h.createInvestigationTracker();
  const file={ok:true,path:"game.js",content:"x".repeat(20000)};
  tracker.observe(operation("workspace_read_file",{path:"game.js"}),file,{...h.toolResultPreview(file,"result-a")});
  assert.equal(tracker.finishRound(),"continue");
  tracker.observe(operation("tool_result_read",{result_ref:"result-a",offset:3000,limit:1000}),{ok:true,offset:3000,next_offset:4000,view:"text"});
  assert.equal(tracker.finishRound(),"continue"); // genuinely unread source
  for(let round=0;round<5;round++){
    const ref="result-new-"+round;
    tracker.observe(operation("workspace_read_file",{path:"game.js"}),file,h.toolResultPreview(file,ref));
    tracker.observe(operation("tool_result_read",{result_ref:ref,offset:3100+round,limit:200}),{ok:true,offset:3100+round,next_offset:3300+round,view:"text"});
    const state=tracker.finishRound();assert.equal(state,round<2?"continue":round<4?"redirect":"finalize");
  }
  tracker.observe(operation("tool_result_read",{result_ref:"result-a",offset:4000}),{ok:true,offset:4000,next_offset:5000,view:"text"});
  assert.equal(tracker.finishRound(),"continue");
});
test("preview reload timestamps, plan claims and checkpoints cannot masquerade as progress",()=>{
  const tracker=h.createInvestigationTracker();
  for(let i=0;i<6;i++){
    tracker.observe(operation("workspace_preview",{action:i%2?"reload":"inspect"}),{ok:true,entry:"index.html",status:"loaded",events:[{kind:"ready",at:String(i),message:"DOM loaded"}],missing:[]});
    tracker.observe(operation("plan_update",{step:1}),{ok:true,status:"done"});
    tracker.observe(operation("task_checkpoint",{}),{ok:true,saved:true});
    assert.equal(tracker.finishRound(),i<3?"continue":i<5?"redirect":"finalize");
  }
  tracker.observe(operation("workspace_preview",{action:"inspect"}),{ok:true,entry:"index.html",events:[{kind:"click",at:"new-click",message:"BUTTON#startBtn"}],missing:[]});
  assert.equal(tracker.finishRound(),"continue");
});
test("edited content and saved evidence survive continuation; no-op writes do not reset stagnation",()=>{
  let tracker=h.createInvestigationTracker();
  const read=operation("workspace_read_file",{path:"app.js"});
  tracker.observe(read,{path:"app.js",content:"old"});tracker.finishRound();
  tracker=h.createInvestigationTracker(JSON.parse(JSON.stringify(tracker.snapshot())));
  for(let i=0;i<3;i++){
    tracker.observe(read,{path:"app.js",content:"old",updated_at:String(i)});
    tracker.observe(operation("workspace_edit_file",{path:"app.js"}),{ok:true,changed:false});
    tracker.finishRound();
  }
  assert.equal(tracker.finishRound(),"redirect");
  tracker.observe(read,{path:"app.js",content:"new"});assert.equal(tracker.finishRound(),"continue");
  tracker.observe(operation("workspace_edit_file",{}),{ok:true,changed:true});assert.equal(tracker.finishRound(),"continue");
});
test("raw source ranges preserve literal newlines and quotes; metadata requires JSON view",()=>{
  const content='function start() {\n  const quote = "value";\n}\n';
  const record={text:JSON.stringify({path:"game.js",content,full_content:content+"tail"})};
  const selected=h.observationText(record);
  assert.equal(selected.text,content+"tail");assert.equal(selected.view,"text");
  const hit=h.searchStoredResult(selected.text,'const quote')["matches"][0];
  assert.ok(h.resultSlice(selected.text,hit.offset,1000).content.includes(content));
  assert.equal(h.observationText(record,"json").text,record.text);
  assert.equal(h.observationText({text:'{"ok":true}'}).view,"json");
  assert.throws(()=>h.observationText(record,"bad"));
  assert.throws(()=>h.observationText({text:'{"ok":true}'},"text"));
});
test("repeated successful reads are bounded, persisted, and invalidated by file edits only",()=>{
  const read=call("tool_result_read","one"),tracker=h.createToolFailureTracker();
  for(let i=0;i<3;i++){assert.equal(tracker.check(read),null);tracker.observe(read,{ok:true})}
  assert.equal(tracker.check(read).code,"repeated_read");
  assert.equal(tracker.check(call("tool_result_read","other-offset")),null);
  tracker.observe(call("task_checkpoint","notes"),{ok:true});assert.equal(tracker.check(read).code,"repeated_read");
  tracker.observe(call("workspace_edit_file","game.js"),{ok:true});assert.equal(tracker.check(read),null);
  const seed=Array.from({length:3},()=>({name:read.function.name,arguments_excerpt:read.function.arguments,read_only:true,status:"completed"}));
  assert.equal(h.createToolFailureTracker(seed).check(read).code,"repeated_read");
  seed.push({name:"workspace_edit_file",status:"completed"});assert.equal(h.createToolFailureTracker(seed).check(read),null);
});
test("read-only tools run in parallel but writes and planner updates are ordered barriers",async()=>{
  let active=0,peak=0;const events=[];
  const calls=[call("web_fetch","a"),call("x_read_post","b"),call("web_search","c"),call("workspace_write_file","write"),call("workspace_read_file","read"),call("plan_update","plan")];
  const outcomes=await h.runToolBatch(calls,{execute:async c=>{
    const id=c.id;events.push("start:"+id);active++;peak=Math.max(peak,active);
    if(["write","plan"].includes(id))assert.equal(active,1);
    await new Promise(resolve=>setImmediate(resolve));active--;events.push("end:"+id);return {result:{ok:true,id,count:1}};
  }});
  assert.equal(peak,3);assert.ok(events.indexOf("start:write")>events.indexOf("end:c"));
  assert.ok(events.indexOf("start:read")>events.indexOf("end:write"));assert.ok(events.indexOf("start:plan")>events.indexOf("end:read"));
  assert.deepEqual(Array.from(outcomes,o=>o.result.id),["a","b","c","write","read","plan"]);
});
test("identical failing calls are serialized and blocked after two executions",async()=>{
  let executions=0;const tracker=h.createToolFailureTracker();
  const outcomes=await h.runToolBatch(Array(4).fill(call("web_fetch","same")),{tracker,execute:async()=>{executions++;return {result:{ok:false,error:"unavailable"}}}});
  assert.equal(executions,2);assert.equal(outcomes[2].result.code,"repeated_tool_failure");assert.equal(tracker.blockedCount,2);
  assert.ok(outcomes[3].result.next_action);
  const denied=h.createToolFailureTracker(),operation=call("workspace_delete_file","file");
  denied.observe(operation,{ok:false,code:"user_denied"});assert.equal(denied.check(operation).code,"tool_permission_denied");
});
test("cancellation drains active readers without starting a queued write",async()=>{
  const controller=new AbortController();let writes=0,finished=0;
  await assert.rejects(h.runToolBatch([call("web_fetch","a"),call("web_fetch","b"),call("workspace_delete_file","write")],{signal:controller.signal,execute:async c=>{
    if(c.id==="write")writes++;await new Promise(resolve=>setImmediate(resolve));finished++;controller.abort();return {result:{ok:true}};
  }}),{name:"AbortError"});
  assert.equal(writes,0);assert.equal(finished,2);
});
test("large previews are marked and received originals can be sliced and searched",()=>{
  const raw={ok:true,url:"https://example.com",content:"a".repeat(10000)+"NEEDLE"+"b".repeat(10000)};
  const preview=h.toolResultPreview(raw,"result-test");assert.equal(preview.truncated,true);assert.ok(preview.content_excerpt.length<3000);
  const text=JSON.stringify(raw),found=h.searchStoredResult(text,"NEEDLE",5);
  assert.equal(found.count,1);assert.ok(h.resultSlice(text,found.matches[0].offset,1000).content.includes("NEEDLE"));
  assert.throws(()=>h.resultSlice(text,-1,10));assert.throws(()=>h.searchStoredResult(text,"",5));
});
test("context window never splits latest tool pairs or mutates saved history",()=>{
  const messages=[{role:"user",content:"old".repeat(3000)},{role:"assistant",content:"answer".repeat(3000)},{role:"user",content:"new"},{role:"assistant",content:"",tool_calls:[call("web_fetch","a")]},{role:"tool",tool_call_id:"a",content:JSON.stringify({ok:true,result_ref:"result-a",content_excerpt:"x".repeat(5000)})}];
  const original=JSON.stringify(messages),window=h.conversationWindow(messages,2000);
  assert.equal(window.omitted,2);assert.equal(window.messages[0].role,"user");assert.equal(window.messages[1].tool_calls[0].id,"a");assert.equal(window.messages[2].tool_call_id,"a");
  assert.equal(window.over_budget,false);assert.equal(JSON.stringify(messages),original);assert.equal(JSON.parse(window.messages[2].content).result_ref,"result-a");
});
test("full page beyond the initial excerpt is searchable and truncation stays explicit",()=>{
  const result={ok:true,content:"initial excerpt",full_content:"a".repeat(60000)+"END_OF_LONG_PAGE",stored_chars:60016,full_content_truncated:false};
  const preview=h.toolResultPreview(result,"result-page");
  assert.equal(preview.full_content,undefined);assert.equal(preview.full_content_truncated,false);
  assert.ok(JSON.stringify(preview).length<4000);
  const text=JSON.stringify(result),found=h.searchStoredResult(text,"END_OF_LONG_PAGE",5);
  assert.equal(found.count,1);assert.ok(h.resultSlice(text,found.matches[0].offset,1000).content.includes("END_OF_LONG_PAGE"));
  assert.match(h.toolResultPreview({...result,full_content_truncated:true},"result-page").next_action,/保存範囲外/);
});
test("a moderate research turn fits the expanded default context",()=>{
  const messages=[{role:"user",content:"調査して"}];
  for(let i=0;i<8;i++)messages.push({role:"assistant",content:"確認します",reasoning:"r".repeat(6000),tool_calls:[call("web_search",String(i))]},{role:"tool",tool_call_id:String(i),content:"result".repeat(1000)});
  const window=h.conversationWindow(messages);assert.equal(window.over_budget,false);assert.equal(window.omitted,0);
});
test("current-turn compaction preserves pairs, latest results, signatures and saved originals",()=>{
  const messages=[{role:"user",content:"調査して"}];
  for(let i=0;i<12;i++)messages.push({role:"assistant",content:"progress ".repeat(1000),reasoning:"r".repeat(10000),reasoning_details:[{signature:"signed"}],tool_calls:[{...call("web_search",String(i)),extra_content:{google:{thought_signature:"sig"}}}]},{role:"tool",tool_call_id:String(i),content:JSON.stringify({ok:true,content:"data".repeat(2000)})});
  const original=JSON.stringify(messages),window=h.conversationWindow(messages,50000);
  assert.equal(window.over_budget,false);assert.ok(window.compacted>0);assert.equal(window.messages.length,messages.length);
  assert.equal(JSON.stringify(messages),original);assert.equal(window.messages.at(-1).content,messages.at(-1).content);
  for(let i=1;i<window.messages.length;i+=2){assert.equal(window.messages[i].tool_calls[0].id,window.messages[i+1].tool_call_id);assert.equal(window.messages[i].tool_calls[0].extra_content.google.thought_signature,"sig");assert.equal(window.messages[i].reasoning_details[0].signature,"signed")}
  assert.ok(window.messages.some(m=>m.content.includes("history_message_index")));
});
test("interrupted checkpoints retain completed results and unknown operations across reload and continuation",()=>{
  const chat={messages:[{role:"user",content:"ファイルを編集して",at:"first"}],plan:{goal:"編集",steps:[{status:"pending"}]}};
  chat.resumeState=h.beginResumeState(chat);
  h.checkpointTool(chat.resumeState,call("workspace_edit_file","write"),"write",{ok:true,path:"app.js"});
  h.checkpointTool(chat.resumeState,call("web_fetch","read"),"read",{ok:true,result_ref:"result-read",content_excerpt:"取得情報"});
  h.checkpointTool(chat.resumeState,call("workspace_delete_file","unknown"),"unknown");
  chat.resumeState.status="interrupted";chat.resumeState.reason="停止";
  chat.resumeState.notes={findings:["script not loaded"],ruled_out:["syntax failure"],next_steps:["reload preview"]};
  const restored=JSON.parse(JSON.stringify(chat));restored.messages.push({role:"assistant",content:"",error:"停止"},{role:"user",content:"続けて",at:"next"});
  restored.resumeState=h.beginResumeState(restored);
  assert.equal(restored.resumeState.task,"ファイルを編集して");assert.equal(restored.resumeState.operations.length,3);
  assert.match(h.resumeContext(restored),/script not loaded/);assert.match(h.resumeContext(restored),/reload preview/);
  const context=h.resumeContext(restored);assert.match(context,/result-read/);assert.match(context,/workspace_delete_file/);assert.match(context,/実行結果不明/);assert.match(context,/完了済み操作を繰り返さず/);
  restored.messages[restored.resumeState.sourceIndex].content="編集された指示";
  assert.equal(h.resumeContext(restored),"");
});
test("a write completed immediately before stop is recorded before cancellation propagates",async()=>{
  const controller=new AbortController();const recorded=[];let writes=0;
  await assert.rejects(h.runToolBatch([call("workspace_edit_file","done"),call("workspace_delete_file","next")],{
    signal:controller.signal,execute:async c=>{writes++;controller.abort();return {result:{ok:true,path:"file.js"}}},
    onFinish:async(c,outcome)=>recorded.push({id:c.id,ok:outcome.result.ok}),
  }),e=>e.name==="AbortError");
  assert.equal(writes,1);assert.equal(recorded[0].id,"done");assert.equal(recorded[0].ok,true);
});
