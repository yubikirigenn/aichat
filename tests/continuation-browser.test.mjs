import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import {once} from "node:events";
import {createDetachedChat} from "../detached-chat.mjs";
import {MODEL_CATALOG,PROVIDERS} from "../models.mjs";

test("browser: long runs use real disk replay, AI supervision, automatic summaries and quota waits",{skip:!process.env.CHAT_UI_BROWSER},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  let mode="long",modelCalls=0,monitorCalls=0,compressionCalls=0,revised=false,rejectCompression=false,compressionRateLimited=false,contextRejected=0,quotaRejected=0;
  const event=value=>"data: "+JSON.stringify(value)+"\n\n";
  const detached=createDetachedChat({authorize:req=>({ok:req.body?.access_password==="test"}),handleChat:async(req,res)=>{
    const body=req.body;
    if(body.access_password!=="test")return res.status(401).json({error:{code:"auth",message:"unauthorized"}});
    if(body.stream===false){
      const system=body.messages[0].content;let content;
      if(system.startsWith("あなたは会話の引継ぎ要約")){
        if(rejectCompression&&!compressionRateLimited){compressionRateLimited=true;res.setHeader("retry-after","0");return res.status(429).json({error:{code:429,message:"compression rate limit"},retry_after:"0"})}
        compressionCalls++;assert.equal(body.reasoning.enabled,true);assert.equal(body.tools,undefined);content="最新依頼の目的・制約を保持し、未完了の作業を継続する。原文の末尾はEND_OF_ORIGINAL。元ログはindex 0。";
      }else if(system.startsWith("あなたは作業監視AI")){
        monitorCalls++;assert.equal(body.reasoning.enabled,true);assert.equal(body.tools,undefined);
        const evidence=JSON.parse(body.messages[1].content);assert.ok(evidence.recent_operations.length>0);
        content=JSON.stringify({action:mode==="ask"?"ask_user":monitorCalls===1?"revise":"continue",reason:mode==="ask"?"クリック後の表示が未観測":"追加の検証を続けられる",guidance:mode==="ask"?"操作後の表示を利用者に質問":"別の根拠を検討して継続"});
      }else content="継続テスト";
      return res.json({choices:[{message:{content}}],usage:{completion_tokens:20,cost:0}});
    }
    modelCalls++;assert.ok(JSON.stringify(body.messages).length<180000);
    revised||=body.messages.some(m=>typeof m.content==="string"&&m.content.includes("別の根拠を検討"));
    if(mode==="context"&&!contextRejected++){return res.status(400).json({error:{code:"context_length_exceeded",message:"maximum context length exceeded"}})}
    if(mode==="quota"&&!quotaRejected++){return res.status(429).json({error:{code:429,message:"rate limited"},retry_after:"0"})}
    res.setHeader("content-type","text/event-stream");
    if(mode==="stalled"){res.write(event({choices:[{delta:{reasoning:"thinking without a fixed deadline"}}]}));return}
    const asking=mode==="ask"&&!body.tools;
    const complete=asking||mode==="context"||mode==="quota"||modelCalls>=35;
    if(complete)return res.end(event({choices:[{delta:{content:asking?"クリック後の表示はどうなっていますか？":"継続した作業を完了しました。"},finish_reason:"stop"}]})+"data: [DONE]\n\n");
    res.end(event({choices:[{delta:{content:"確認します。",tool_calls:Array.from({length:6},(_,i)=>({index:i,id:`call-${modelCalls}-${i}`,type:"function",function:{name:"current_datetime",arguments:"{}"}}))},finish_reason:"tool_calls"}]})+"data: [DONE]\n\n");
  }});
  const app=express();app.use(express.json({limit:"20mb"}));app.get("/api/models",(_req,res)=>res.json({models:MODEL_CATALOG.map(m=>({...m,providerLabel:PROVIDERS[m.provider].label,configured:true})),providers:Object.values(PROVIDERS).map(p=>({...p,configured:true}))}));app.post("/api/chat",detached);app.use(express.static(path.resolve("public")));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*",route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(origin);await page.waitForFunction(()=>chatHistoryReady);
    await page.evaluate(()=>{setApiKey("test",false);els.settings.close();settings.web=false;settings.planner="off";settings.supervisorInterval=3;settings.maxRounds=1;const original=reconnectDelay;reconnectDelay=(ms,signal)=>original(Math.min(ms,3),signal)});
    const long=await page.evaluate(async()=>{
      els.prompt.value="長い作業を継続してください。"+"source ".repeat(40000)+"END_OF_ORIGINAL";await sendMessage();
      const c=activeChat();const original=await executeTool({function:{name:"chat_history_read",arguments:JSON.stringify({start:0,count:1,offset:c.messages[0].content.length-100,limit:100})}});
      return {error:c.messages.at(-1).error,rounds:c.messages.at(-1).meta.rounds,tools:c.messages.at(-1).toolEvents.length,aux:c.messages.at(-1).meta.auxiliary,original:original.messages[0].content,sourceLength:c.messages[0].content.length,summary:c.contextSummary.text};
    });
    assert.equal(long.error,undefined);assert.equal(long.rounds,35);assert.equal(long.tools,204);assert.ok(monitorCalls>=11);assert.ok(compressionCalls>=6);assert.equal(revised,true);assert.match(long.original,/END_OF_ORIGINAL/);assert.ok(long.sourceLength>240000);assert.match(long.summary,/原文/);assert.ok(long.aux.requests>=17);assert.match(await page.locator(".meta").last().textContent(),/補助AI/);
    mode="ask";modelCalls=0;
    const asked=await page.evaluate(async()=>{createChat();els.prompt.value="動作を確認して";await sendMessage();return {message:activeChat().messages.at(-1),state:activeChat().resumeState.status}});
    assert.equal(asked.state,"interrupted");assert.equal(asked.message.error,undefined);assert.match(asked.message.content,/クリック後/);assert.equal(modelCalls,4);
    mode="context";modelCalls=0;rejectCompression=true;
    const compressed=await page.evaluate(async()=>{createChat();els.prompt.value="小さい依頼でも上流がコンテキスト超過を返す場合の検証";await sendMessage();return activeChat().messages.at(-1)});
    assert.equal(compressed.error,undefined);assert.equal(modelCalls,2);assert.equal(compressionRateLimited,true);
    mode="quota";modelCalls=0;
    const recovered=await page.evaluate(async()=>{createChat();els.prompt.value="API枠の回復を待つ検証";await sendMessage();return activeChat().messages.at(-1)});
    assert.equal(recovered.error,undefined);assert.equal(modelCalls,2);
    mode="stalled";await page.evaluate(()=>{createChat();els.prompt.value="停止ボタンの検証";void sendMessage()});await page.waitForFunction(()=>activeChat().liveTurn?.reasoning?.includes("deadline"));await page.click("#stopBtn");await page.waitForFunction(()=>!running);
    assert.equal(await page.evaluate(()=>activeChat().messages.at(-1).error),"生成を停止しました。");assert.equal(await page.locator("#maxRoundsInput").count(),0);assert.deepEqual(errors,[]);
  }finally{await browser?.close();await detached.close();await new Promise(resolve=>server.close(resolve))}
});
