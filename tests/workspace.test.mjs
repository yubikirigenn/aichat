import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
function workspace(){
  const records=new Map(),clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value)),key=value=>JSON.stringify(value);
  const store={get:k=>clone(records.get(key(k))),index:()=>({getAll:chatId=>[...records.values()].filter(r=>r.chatId===chatId).map(clone)}),put:r=>records.set(key([r.chatId,r.path]),clone(r)),add:r=>{const k=key([r.chatId,r.path]);if(records.has(k))throw new Error("already exists");records.set(k,clone(r))},delete:k=>records.delete(key(k))};
  const context={activeChatId:"a",chats:[{id:"a"},{id:"b"}],FILE_STORE:"session_files",settings:{fileHistory:20},nowISO:()=>"now",clamp:(n,min,max)=>Math.max(min,Math.min(max,n)),dbReq:async value=>value,tx:()=>store,testWrite:async write=>{const backup=new Map(records);try{write(store)}catch(error){records.clear();for(const [k,v] of backup)records.set(k,v);throw error}}};
  const source=html.slice(html.indexOf("function workspaceChatId("),html.indexOf("async function migrateLegacyWorkspace("));
  const normalize=html.match(/function normalizePath\(path\)\{[\s\S]*?\n\}/)[0];
  const rename=html.match(/async function renameFile\(from,to\)\{[^\n]*\}/)[0];
  const api=runInNewContext(source+normalize+rename+";workspaceWrite=testWrite;({listFiles,getFile,putFile,removeFile,renameFile})",context);
  return {api,context,records};
}
test("workspace file identity, histories, rename and delete are scoped by chat",async()=>{
  const {api,context}=workspace();await api.putFile("same.txt","A");await api.putFile("same.txt","A2");
  context.activeChatId="b";assert.equal(await api.getFile("same.txt"),undefined);await api.putFile("same.txt","B");
  assert.equal((await api.getFile("same.txt")).history.length,0);assert.equal((await api.listFiles()).length,1);
  context.activeChatId="a";await api.renameFile("same.txt","renamed.txt");assert.equal(await api.getFile("same.txt"),undefined);assert.equal((await api.getFile("renamed.txt")).history[0].content,"A");
  await api.removeFile("renamed.txt");assert.equal((await api.listFiles()).length,0);assert.equal((await api.getFile("same.txt","b")).content,"B");
});
test("in-flight writes keep their originating chat and createOnly never overwrites",async()=>{
  const {api,context}=workspace();const writing=api.putFile("late.txt","A");context.activeChatId="b";await writing;
  assert.equal(await api.getFile("late.txt"),undefined);assert.equal((await api.getFile("late.txt","a")).content,"A");
  await api.putFile("late.txt","B",{createOnly:true});await assert.rejects(api.putFile("late.txt","not B",{createOnly:true}));
  assert.equal((await api.getFile("late.txt")).content,"B");
  await api.putFile("other.txt","other");await assert.rejects(api.renameFile("late.txt","other.txt"));assert.equal((await api.getFile("late.txt")).content,"B");
  context.chats=context.chats.filter(c=>c.id!=="a");await assert.rejects(api.putFile("deleted.txt","x",{chatId:"a"}),/チャットが見つかりません/);
});
