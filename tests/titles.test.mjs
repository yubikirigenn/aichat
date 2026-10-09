import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const source=html.slice(html.indexOf("const titleRequests="),html.indexOf("function renderChatList("));
function harness(fetchImpl){
  const chat={id:"chat",title:"仮タイトル",messages:[{role:"user",content:"天気について"},{role:"assistant",content:"回答"}]};
  const chats=[chat];let saved=0;
  const run=runInNewContext(source+";generateChatTitle",{fetch:fetchImpl,API_URL:"/api/chat",proxyHeaders:()=>({}),getApiKey:()=>"password",AbortSignal,chats,activeChatId:"chat",persistChats:()=>saved++,renderChatList:()=>{},updateTitle:()=>{}});
  return {chat,chats,run:()=>run(chat,{provider:"tokenharbor",id:"claude-haiku-5.5:free"}),saved:()=>saved};
}
test("AI title uses selected model, no tools, a reasoning-off request, and a bounded transcript",async()=>{
  const h=harness(async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.model,"claude-haiku-5.5:free");assert.equal(body.stream,false);
    assert.equal(body.reasoning.enabled,false);assert.equal(body.tools,undefined);
    assert.equal(JSON.parse(body.messages[1].content).user,"天気について");
    return Response.json({choices:[{message:{content:"「天気の調べ方」"}}]});
  });
  await h.run();assert.equal(h.chat.title,"天気の調べ方");assert.equal(h.chat.aiTitleGenerated,true);assert.equal(h.saved(),1);
});
test("title failure never fails chat; duplicate requests are coalesced",async()=>{
  let resolve,calls=0;
  const h=harness(()=>{calls++;return new Promise(r=>resolve=r)});
  const first=h.run();await h.run();assert.equal(calls,1);
  resolve(new Response("failed",{status:503}));await first;
  assert.equal(h.chat.title,"仮タイトル");assert.equal(h.saved(),0);
});
test("late title responses cannot overwrite edited or deleted chats",async()=>{
  for(const mutate of [h=>h.chat.messages[0].content="編集",h=>h.chat.title="手動変更",h=>h.chats.pop()]){
    let resolve;
    const h=harness(()=>new Promise(r=>resolve=r));const request=h.run();mutate(h);
    resolve(Response.json({choices:[{message:{content:"遅いタイトル"}}]}));await request;
    assert.notEqual(h.chat.title,"遅いタイトル");assert.equal(h.saved(),0);
  }
});
