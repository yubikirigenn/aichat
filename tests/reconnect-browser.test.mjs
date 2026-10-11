import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";

test("browser reconnects after offline and reload, without an extra user message or model start",{skip:!process.env.CHAT_UI_BROWSER},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  const server=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:"31303",APP_ACCESS_PASSWORD:"browser-test-password"},stdio:["ignore","pipe","pipe"]});
  let browser;
  try{
    await once(server.stdout,"data");
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    let starts=0,offline=false,finish=false,lost=false,cancels=0;const jobs=new Set();
    const event=data=>"data: "+JSON.stringify(data)+"\n\n";
    await page.route("**/api/chat",async route=>{
      const body=route.request().postDataJSON(),delivery=body.delivery;
      if(!delivery)return route.fulfill({json:{choices:[{message:{content:"再接続確認"}}]}});
      if(offline)return route.abort("internetdisconnected");
      if(delivery.action==="start"){starts++;jobs.add(delivery.id);return route.fulfill({json:{delivery:true}})}
      if(delivery.action==="cancel"){cancels++;jobs.delete(delivery.id);return route.fulfill({json:{cancelled:true}})}
      if(delivery.action==="release"){jobs.delete(delivery.id);return route.fulfill({json:{released:true}})}
      if(lost||!jobs.has(delivery.id))return route.fulfill({status:410,json:{error:{code:"delivery_lost",message:"一時記録がありません。重複生成はしていません。"}}});
      const cursor=delivery.cursor;
      const chunks=cursor===0?[event({choices:[{delta:{reasoning:"思考中",content:"前半"}}]})]:finish?[event({choices:[{delta:{content:"後半"},finish_reason:"stop"}]})+"data: [DONE]\n\n"]:[];
      return route.fulfill({json:{cursor:cursor+chunks.length,chunks,status:200,done:cursor>0&&finish}});
    });
    await page.goto("http://127.0.0.1:31303");await page.waitForFunction(()=>chatHistoryReady);
    await page.evaluate(()=>{setApiKey("browser-test-password",true);settings.saveKey=true;persistSettings();els.settings.close();els.prompt.value="通信復帰テスト";void sendMessage()});
    await page.waitForFunction(()=>activeChat().liveTurn?.content==="前半"&&activeChat().pendingRound);
    offline=true;await page.waitForFunction(()=>document.querySelector("#chatStatus")?.textContent.includes("自動再接続")||Array.from(document.querySelectorAll("*")).some(el=>el.childNodes.length===1&&el.textContent.includes("通信待ち · 自動再接続中")));
    offline=false;finish=true;await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await page.waitForFunction(()=>!running&&activeChat().messages.at(-1)?.content==="前半後半");
    assert.equal(starts,1);assert.equal(await page.evaluate(()=>activeChat().messages.filter(m=>m.role==="user").length),1);
    finish=false;
    await page.evaluate(()=>{els.prompt.value="再読込テスト";void sendMessage()});
    await page.waitForFunction(async()=>{const c=activeChat();await persistChats();return c.liveTurn?.content==="前半"&&c.pendingRound});
    page.once("dialog",dialog=>dialog.accept());await page.reload();await page.waitForFunction(()=>running&&activeChat()?.pendingRound);
    finish=true;await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await page.waitForFunction(()=>!running&&activeChat().messages.at(-1)?.content==="前半後半");
    assert.equal(starts,2);assert.equal(await page.evaluate(()=>activeChat().messages.filter(m=>m.role==="user").length),2);
    assert.equal(await page.evaluate(()=>activeChat().messages.filter(m=>m.role==="assistant"&&!m.internal).length),2);
    finish=false;await page.evaluate(()=>{els.prompt.value="停止テスト";void sendMessage()});
    await page.waitForFunction(()=>activeChat().liveTurn?.content==="前半");await page.click("#stopBtn");await page.waitForFunction(()=>!running);
    await page.waitForFunction(()=>!activeChat().pendingRound);assert.equal(cancels,1);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));assert.equal(starts,3);
    await page.evaluate(()=>{els.prompt.value="記録消失テスト";void sendMessage()});await page.waitForFunction(()=>activeChat().liveTurn?.content==="前半");
    lost=true;await page.waitForFunction(()=>!running&&activeChat().messages.at(-1)?.error?.includes("一時記録がありません"));
    assert.equal(starts,4);assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();await once(server,"exit")}
});
