import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";
import test from "node:test";

const source=readFileSync(new URL("../public/chat-ui.js",import.meta.url),"utf8");
test("chat view script parses and preserves text segments across tool rounds",()=>{
  new Script(source);
  const ui=runInNewContext(source+";({recordTurnText,turnTimeline,safeResultUrl})",{URL,getReasoningText:m=>m.reasoning||"",friendlyToolName:n=>n});
  const message={timeline:[]};
  ui.recordTurnText(message,"reasoning","考え",1);
  ui.recordTurnText(message,"reasoning","考えています",1);
  message.timeline.push({id:"call-1",kind:"activity"});
  ui.recordTurnText(message,"text","回答",2);
  assert.equal(message.timeline.length,3);
  assert.equal(message.timeline[0].text,"考えています");
  assert.equal(message.timeline[1].id,"call-1");
  assert.equal(message.timeline[2].text,"回答");
  assert.equal(ui.safeResultUrl("javascript:alert(1)"),"#");
  const legacy=ui.turnTimeline({reasoning:"以前のThinking",content:"以前の回答",toolEvents:[{name:"search"}]});
  assert.deepEqual(Array.from(legacy,e=>e.kind),["reasoning","tool","text"]);
});

test("browser: stable streaming, real generation flow, scrolling and responsive panels",{skip:!process.env.CHAT_UI_BROWSER},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  const {spawn}=await import("node:child_process");const {once}=await import("node:events");
  const server=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:"31302"},stdio:["ignore","pipe","pipe"]});
  let browser;
  try{
    await once(server.stdout,"data");
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/*",route=>route.request().url().startsWith("http://127.0.0.1:31302")?route.continue():route.abort());
    await page.goto("http://127.0.0.1:31302");await page.waitForFunction(()=>!!document.querySelector("#quickModel option"));
    await page.evaluate(()=>{document.querySelector("#settingsDialog").close();setApiKey("test-password",false)});
    await page.evaluate(async()=>{
      let round=0;
      streamRound=async(messages,forced,onUpdate)=>{
        round++;
        const msg=round===1?{role:"assistant",content:"調査します。",reasoning:"条件を確認しています。",tool_calls:[{id:"test-time",function:{name:"current_datetime",arguments:"{}"}}]}:{role:"assistant",reasoning:"確認できました。",content:"# 回答\n\n"+"動作確認の本文です。\n\n".repeat(80)};
        onUpdate({...msg});return {msg,usage:{completion_tokens:20,cost:0}};
      };
      document.querySelector("#prompt").value="テスト";await sendMessage();
    });
    assert.equal(await page.locator(".timelineText").count(),2);
    assert.equal(await page.locator(".reasoningText").count(),2);
    assert.equal(await page.locator(".executionRow.activity").count(),1);
    assert.equal(await page.locator("[data-copy-response]").count(),1);
    await page.evaluate(()=>{const scroll=els.chatScroll;scroll.scrollTop=0;scroll.dispatchEvent(new Event("scroll"))});
    assert.equal(await page.locator("#jumpLatest").isVisible(),true);
    await page.locator("#jumpLatest").click();await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>chatDistanceFromBottom()<3),true);
    const stable=await page.evaluate(()=>{
      const message={role:"assistant",timeline:[],activity:[],toolEvents:[]};recordTurnText(message,"reasoning","first",1);
      const node=renderMessage(message);els.thread.appendChild(node);renderStreamingAssistant(node,message);
      const details=node.querySelector(".executionRow"),body=node.querySelector(".reasoningText");details.open=false;
      recordTurnText(message,"reasoning","first second",1);renderStreamingAssistant(node,message);
      const same=details===node.querySelector(".executionRow")&&body===node.querySelector(".reasoningText")&&!details.open;
      els.chatScroll.scrollTop=100;chatAutoFollow=false;
      const position=els.chatScroll.scrollTop;
      recordTurnText(message,"text","streaming update",1);renderStreamingAssistant(node,message);
      const keptPosition=els.chatScroll.scrollTop===position;
      node.remove();return same&&keptPosition;
    });assert.equal(stable,true);
    await page.locator("#workspaceBtn").click();assert.equal(await page.locator("#playground").isVisible(),true);
    await page.locator("#closePlayBtn").click();
    await page.setViewportSize({width:700,height:900});
    await page.locator("#workspaceBtn").click();assert.equal(await page.locator(".chatPane").isVisible(),false);
    await page.locator("#closePlayBtn").click();assert.equal(await page.locator(".chatPane").isVisible(),true);
    await page.setViewportSize({width:1440,height:960});
    await page.route("**/api/x-post",route=>route.fulfill({json:{ok:true,post:{url:"https://x.com/jack/status/20",text:"<script>untrusted</script>",author:{name:"jack",handle:"jack"},media:[]}}}));
    const xTool=await page.evaluate(async()=>{
      settings.web=true;
      const registered=buildTools().some(t=>t.function?.name==="x_read_post");
      const result=await executeTool({function:{name:"x_read_post",arguments:JSON.stringify({url:"https://x.com/jack/status/20"})}});
      const message={role:"assistant",toolEvents:[{name:"x_read_post",ok:true,detail:{arguments:{url:result.post.url},result}}]};
      const node=renderMessage(message);els.thread.appendChild(node);
      const safe=node.querySelector(".xPostText").textContent==="<script>untrusted</script>"&&!node.querySelector(".xPostCard script");
      node.remove();return registered&&result.ok&&safe;
    });assert.equal(xTool,true);
    await page.route("**/api/web-search",route=>{
      assert.deepEqual(route.request().postDataJSON().queries,["Gemini API","Gemini Free Tier"]);
      return route.fulfill({json:{ok:true,queries:["Gemini API","Gemini Free Tier"],searches:[{query:"Gemini API",ok:true,results:[{url:"https://ai.google.dev/",title:"Google"}]},{query:"Gemini Free Tier",ok:false,error:"検索失敗",results:[]}],results:[{url:"https://ai.google.dev/",title:"Google",snippet:"API"}],count:1}});
    });
    const batchTool=await page.evaluate(async()=>{
      settings.provider="gemini";settings.model="gemini-3.8-flash";syncChips();
      const result=await executeTool({function:{name:"web_search",arguments:JSON.stringify({queries:["Gemini API","Gemini Free Tier"]})}});
      const node=renderMessage({role:"assistant",toolEvents:[{name:"web_search",ok:true,detail:{arguments:{queries:result.queries},result}}]});els.thread.appendChild(node);
      const shown=node.textContent.includes("Gemini Free Tier")&&node.textContent.includes("検索失敗");node.remove();
      return result.ok&&shown&&document.querySelector("#quickModel").value==="gemini:gemini-3.8-flash";
    });assert.equal(batchTool,true);
    await page.evaluate(()=>{
      streamRound=async()=>new Promise((resolve,reject)=>abortController.signal.addEventListener("abort",()=>reject(new DOMException("Stopped","AbortError"))));
      els.prompt.value="停止テスト";void sendMessage();
    });
    await page.waitForFunction(()=>!document.querySelector("#stopBtn").hidden);
    assert.equal(await page.locator("#sendBtn").isDisabled(),true);
    await page.locator("#prompt").fill("次の下書き");await page.locator("#prompt").press("Control+Enter");
    assert.equal(await page.evaluate(()=>running),true);
    await page.locator("#stopBtn").click();await page.waitForFunction(()=>!running);
    assert.equal(await page.locator("#prompt").inputValue(),"次の下書き");
    assert.deepEqual(errors,[]);
    if(process.env.CHAT_UI_SCREENSHOT)await page.screenshot({path:process.env.CHAT_UI_SCREENSHOT});
  }finally{await browser?.close();server.kill();await once(server,"exit")}
});
