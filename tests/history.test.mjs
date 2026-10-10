import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const source=readFileSync(new URL("../public/history.js",import.meta.url),"utf8");
const h=runInNewContext(source+";({messageHistoryText,savedChatSnapshot,restoreChatSnapshot})");
test("empty final content retains intermediate explanations, edits, errors and work notes",()=>{
  const message={role:"assistant",content:"",timeline:[{kind:"text",text:"原因はスクリプトの読込順です。"},{kind:"reasoning",text:"private scratchpad"}],
    toolEvents:[{name:"workspace_edit_file",ok:true,detail:{arguments:{path:"index.html",replacements:[{old_text:'src="game.js"',new_text:'defer src="game.js"'}]},result:{ok:true,changed:true}}}],workNotes:{findings:["load order"]},error:"interrupted"};
  const original=JSON.stringify(message),text=h.messageHistoryText(message);
  assert.match(text,/読込順/);assert.match(text,/workspace_edit_file/);assert.match(text,/defer/);assert.match(text,/load order/);assert.match(text,/interrupted/);
  assert.doesNotMatch(text,/private scratchpad/);assert.equal(JSON.stringify(message),original);
  assert.match(h.messageHistoryText(message,{compact:true}),/defer/);
});
test("thinking-only histories are not represented as empty or as completed fixes",()=>{
  assert.match(h.messageHistoryText({role:"assistant",reasoning:"thinking",content:""}),/結論・原因説明は記録されていません/);
  assert.match(h.messageHistoryText({role:"assistant",content:"",error:"limit"}),/limit/);
});
test("context compaction is explicit and never truncates the persisted original",()=>{
  const message={role:"assistant",content:"long".repeat(6000),toolEvents:[]};
  assert.ok(h.messageHistoryText(message,{compact:true}).length<15000);
  assert.match(h.messageHistoryText(message,{compact:true}),/途中省略/);
  assert.equal(h.messageHistoryText(message),message.content);
});
test("live history snapshots restore progress and leave source data untouched",()=>{
  const chat={id:"c",messages:[{role:"user",content:"task"},{role:"tool",internal:true,content:"large temporary context"}],resumeState:{status:"running"},liveTurn:{role:"assistant",content:"progress",timeline:[{kind:"text",text:"progress"}],toolEvents:[{name:"workspace_read_file"}],_streaming:true}};
  const saved=h.savedChatSnapshot(chat);
  assert.equal(saved.liveTurn,undefined);assert.equal(saved.messages.length,2);assert.equal(saved.messages.at(-1).content,"progress");
  const restored=h.restoreChatSnapshot(saved);assert.equal(restored.resumeState.status,"interrupted");assert.equal(restored.messages.at(-1)._streaming,false);assert.match(restored.messages.at(-1).error,/保存済み/);
  assert.equal(chat.liveTurn._streaming,true);assert.equal(chat.messages.length,2);
});
test("all user messages take the model path; the automatic assistant acknowledgement is removed",()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.doesNotMatch(html,/isTaskClosure\(|承知しました。作業はここで終了します。/);
  assert.doesNotMatch(html,/const tiny=|chats\.slice\(0,40\)/);
});
function storageHarness({failPrimary=false,failBackup=false}={}){
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8"),saved=[],warnings=[];
  const chats=Array.from({length:45},(_,i)=>({id:"c"+i,messages:Array.from({length:70},(_,j)=>({role:"user",content:`${i}:${j}`,images:[{dataUrl:"keep-image"}]}))}));
  const db={transaction(){
    if(failPrimary)throw new DOMException("quota","QuotaExceededError");
    const transaction={objectStore(){return {put(record){saved.push(structuredClone(record));queueMicrotask(()=>transaction.oncomplete())}}}};return transaction;
  }};
  const env={chats,activeChatId:"c0",db,CHAT_STORE:"chat_history",LS_CHATS:"history",chatSaveDirty:false,chatSaveQueue:Promise.resolve(),chatSaveError:"",localStorage:{removeItem(){},setItem(key,value){if(failBackup)throw new Error("quota");saved.push(JSON.parse(value))}},toast:message=>warnings.push(message),console:{warn(){}}};
  const fn=runInNewContext(source+html.slice(html.indexOf("function persistChats("),html.indexOf("function persistSettings("))+";persistChats",env);
  return {save:fn,saved,warnings,chats};
}
test("primary and fallback saves retain every chat, old message and image",async()=>{
  for(const failPrimary of [false,true]){
    const store=storageHarness({failPrimary});await store.save();
    assert.equal(store.saved[0].chats.length,45);assert.equal(store.saved[0].chats[0].messages.length,70);assert.equal(store.saved[0].chats[0].messages[0].images[0].dataUrl,"keep-image");
    if(failPrimary)assert.match(store.warnings[0],/省略せず予備保存/);
  }
});
test("total storage failure warns without discarding in-memory history",async()=>{
  const store=storageHarness({failPrimary:true,failBackup:true}),original=JSON.stringify(store.chats);
  await store.save();await store.save();
  assert.equal(store.saved.length,0);assert.equal(JSON.stringify(store.chats),original);assert.equal(store.warnings.length,1);assert.match(store.warnings[0],/再読込前に書き出して/);
});
