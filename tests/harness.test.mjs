import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source=readFileSync(new URL("../public/harness.js",import.meta.url),"utf8");
const h=runInNewContext(source+";({runToolBatch,createToolFailureTracker,toolResultPreview,resultSlice,searchStoredResult,conversationWindow})",{DOMException});
const call=(name,id)=>({id,function:{name,arguments:JSON.stringify({id})}});
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
