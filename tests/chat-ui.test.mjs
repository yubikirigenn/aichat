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

test("partial tool activity retains streamed targets before execution",()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const {syncPartialToolActivity}=runInNewContext(html.slice(html.indexOf("function upsertActivity("),html.indexOf("function chartColor("))+";({syncPartialToolActivity})",{
    nowISO:()=>"test",functionTools:[],webFunctionTools:[{function:{name:"web_search"}}],friendlyToolName:name=>name,isServerToolName:name=>name.startsWith("openrouter:"),
  });
  const msg={timeline:[]};
  syncPartialToolActivity(msg,{tool_calls:[{id:"search",function:{name:"web_search",arguments:'{"queries":['}}]});
  assert.equal(msg.activity[0].detail,"引数を受信中");
  syncPartialToolActivity(msg,{tool_calls:[{id:"search",function:{name:"web_search",arguments:'{"queries":["Gemini API","無料枠"]}'}}]});
  assert.equal(msg.activity[0].detail,"Gemini API / 無料枠");assert.equal(msg.activity[0].status,"requested");assert.equal(msg.timeline.length,1);
  syncPartialToolActivity(msg,{tool_calls:[{id:"native",function:{name:"openrouter:web_fetch",arguments:'{"url":"https://ai.google.dev/"}'}}]});
  assert.equal(msg.activity[1].detail,"https://ai.google.dev/");assert.equal(msg.activity[1].status,"running");
});

test("browser: stable streaming, real generation flow, scrolling and responsive panels",{skip:!process.env.CHAT_UI_BROWSER},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  const {spawn}=await import("node:child_process");const {once}=await import("node:events");
  const server=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:"31302",APP_ACCESS_PASSWORD:"browser-test-password",TAVILY_API_KEY:"tvly-test-disabled",TAVILY_FREE_TIER_CONFIRMED:"false"},stdio:["ignore","pipe","pipe"]});
  let browser;
  try{
    await once(server.stdout,"data");
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/*",route=>route.request().url().startsWith("http://127.0.0.1:31302")?route.continue():route.abort());
    // Seed the old schema before loading the app; migration must preserve files.
    await page.goto("http://127.0.0.1:31302/api/health");
    await page.evaluate(()=>new Promise((resolve,reject)=>{
      const request=indexedDB.open("NemotronWorkspaceDB",1);
      request.onupgradeneeded=()=>request.result.createObjectStore("files",{keyPath:"path"});
      request.onerror=()=>reject(request.error);request.onsuccess=()=>{
        const db=request.result,transaction=db.transaction("files","readwrite");transaction.objectStore("files").put({path:"kept.txt",content:"preserved"});
        transaction.oncomplete=()=>{db.close();resolve()};
      };
    }));
    await page.goto("http://127.0.0.1:31302");await page.waitForFunction(()=>!!document.querySelector("#quickModel option"));
    const searchCatalog=await page.request.get("http://127.0.0.1:31302/api/models");
    assert.equal((await searchCatalog.json()).webSearch.provider,"tavily");
    assert.equal(await page.evaluate(()=>webSearchProvider),"tavily");
    const disabledSearch=await page.request.post("http://127.0.0.1:31302/api/web-search",{data:{access_password:"browser-test-password",query:"Liquid AI LFM"}});
    assert.equal(disabledSearch.status(),503);
    assert.equal((await disabledSearch.json()).error.code,"tavily_free_unconfirmed");
    const disabledBatch=await page.request.post("http://127.0.0.1:31302/api/web-search",{data:{access_password:"browser-test-password",queries:["Liquid AI LFM","Artificial Analysis LFM"]}});
    const batchData=await disabledBatch.json();assert.equal(batchData.ok,false);
    assert.equal(batchData.searches[1].code,"tavily_free_unconfirmed");
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"),"/favicon.svg");
    const favicon=await page.request.get("http://127.0.0.1:31302/favicon.svg");
    assert.equal(favicon.status(),200);assert.match(favicon.headers()["content-type"],/image\/svg\+xml/);
    assert.match(await favicon.text(),/viewBox="0 0 64 64"/);
    await page.waitForFunction(()=>db?.version===2);
    assert.equal(await page.evaluate(async()=>(await getFile("kept.txt")).content),"preserved");
    await page.evaluate(()=>{document.querySelector("#settingsDialog").close();setApiKey("test-password",false)});
    const previousModel=await page.locator("#quickModel").inputValue();
    await page.locator("#quickModel").selectOption("tokenharbor:deepseek-v4.1-flash:free");
    assert.equal(await page.evaluate(()=>settings.provider),"tokenharbor");
    assert.equal(await page.evaluate(()=>selectedModel().vision),true);
    assert.equal(await page.evaluate(()=>buildTools().some(t=>t.function?.name==="web_search")),true);
    assert.equal(await page.evaluate(()=>buildTools().some(t=>t.type==="openrouter:web_search")),false);
    await page.locator("#quickModel").selectOption(previousModel);
    await page.route("**/api/chat",route=>{
      const body=route.request().postDataJSON();assert.equal(body.stream,false);assert.equal(body.tools,undefined);
      return route.fulfill({json:{choices:[{message:{content:"日時の動作確認"}}]}});
    });
    await page.evaluate(async()=>{
      let round=0;
      streamRound=async(messages,forced,onUpdate)=>{
        round++;
        const msg=round===1?{role:"assistant",content:"調査します。",reasoning:"条件を確認しています。",tool_calls:[{id:"test-time",function:{name:"current_datetime",arguments:"{}"}}]}:{role:"assistant",reasoning:"確認できました。",content:"# 回答\n\n"+"動作確認の本文です。\n\n".repeat(80)};
        onUpdate({...msg});return {msg,usage:{completion_tokens:20,cost:0,...(round===1?{prompt_tokens:2000,prompt_tokens_details:{cached_tokens:1000}}:{})}};
      };
      document.querySelector("#prompt").value="テスト";await sendMessage();
    });
    await page.waitForFunction(()=>activeChat().aiTitleGenerated===true);
    assert.equal(await page.locator("#chatTitle").textContent(),"日時の動作確認");
    assert.deepEqual(await page.evaluate(()=>activeChat().messages.at(-1).meta.cache),{prompt_tokens:2000,cached_tokens:1000,cache_write_tokens:0,reported_rounds:1,total_rounds:2});
    assert.match(await page.locator(".meta details").textContent(),/Cache: 1,000 \/ 2,000 tokens \(50.0%\).*1\/2 rounds報告/);
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
    await page.route("**/api/x-search",route=>{
      assert.equal(route.request().postDataJSON().query,"Gemini lang:ja");
      return route.fulfill({json:{ok:true,provider:"X API v2",results:[{url:"https://x.com/example/status/123",text:"<script>search text</script>",author:{handle:"example"},created_at:"2026-10-09"}],count:1}});
    });
    const xSearchTool=await page.evaluate(async()=>{
      const registered=buildTools().some(t=>t.function?.name==="x_search");
      const result=await executeTool({function:{name:"x_search",arguments:JSON.stringify({query:"Gemini lang:ja"})}});
      const node=renderMessage({role:"assistant",toolEvents:[{name:"x_search",ok:true,detail:{arguments:{query:"Gemini lang:ja"},result}}]});els.thread.appendChild(node);
      const safe=node.textContent.includes("<script>search text</script>")&&!node.querySelector("script")&&Boolean(node.querySelector('a[href="https://x.com/example/status/123"]'));
      node.remove();return registered&&result.ok&&safe;
    });assert.equal(xSearchTool,true);
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
    let activeReads=0,peakReads=0;
    await page.route("**/api/web-fetch",async route=>{
      activeReads++;peakReads=Math.max(peakReads,activeReads);
      const request=route.request().postDataJSON(),url=request.url;
      assert.equal(request.include_full_content,true);
      await new Promise(resolve=>setTimeout(resolve,url.endsWith("a")?90:30));activeReads--;
      await route.fulfill({json:{ok:true,url,content:"initial excerpt",full_content:"prefix "+"x".repeat(2000100)+"NEEDLE "+url,stored_chars:2000200,full_content_truncated:false}});
    });
    const generation=await page.evaluate(async()=>{
      let round=0,ordered=false;
      streamRound=async(messages,forced,onUpdate)=>{
        round++;
        if(round===2){const tools=messages.filter(m=>m.role==="tool");ordered=tools.map(t=>t.tool_call_id).join(",")==="read-a,read-b,read-c"&&tools.every(t=>JSON.parse(t.content).result_ref)}
        const msg=round===1?{role:"assistant",content:"",tool_calls:["a","b","c"].map(id=>({id:"read-"+id,function:{name:"web_fetch",arguments:JSON.stringify({url:"https://example.com/"+id})}}))}:{role:"assistant",content:"並列取得を確認しました。"};
        onUpdate(msg);return {msg};
      };
      els.prompt.value="並列取得テスト";await sendMessage();
      const chat=activeChat(),last=chat.messages.at(-1),events=last.toolEvents;
      const refs=events.map(e=>e.detail.result.result_ref);
      const found=await executeTool({function:{name:"tool_result_search",arguments:JSON.stringify({result_ref:refs[0],query:"NEEDLE"})}});
      const read=await executeTool({function:{name:"tool_result_read",arguments:JSON.stringify({result_ref:refs[0],offset:found.matches[0].offset,limit:1000})}});
      let otherChatBlocked=false;try{await getStoredObservation(refs[0],"another-chat")}catch{otherChatBlocked=true}
      return {ordered,first_ref:refs[0],refs:refs.length,found:found.count,read:read.content.includes("NEEDLE"),otherChatBlocked,events:events.map(e=>({id:e.activityId,url:e.detail.arguments.url,resultUrl:e.detail.result.url}))};
    });
    assert.equal(peakReads,3);assert.equal(generation.ordered,true);assert.equal(generation.refs,3);assert.equal(generation.found,1);assert.equal(generation.read,true);assert.equal(generation.otherChatBlocked,true);
    for(const event of generation.events)assert.equal(event.url,event.resultUrl);
    assert.equal(await page.locator("[data-result-download]").count(),3);
    const downloadPromise=page.waitForEvent("download");
    await page.locator("[data-result-download]").first().evaluate(button=>button.click());
    assert.ok((await downloadPromise).suggestedFilename().startsWith("result-"));
    await page.reload();await page.waitForFunction(()=>db?.version===2);
    await page.evaluate(()=>{document.querySelector("#settingsDialog").close();setApiKey("test-password",false)});
    assert.equal(await page.evaluate(async ref=>(await getStoredObservation(ref,activeChat().id)).text.includes("NEEDLE"),generation.first_ref),true);
    page.once("dialog",dialog=>dialog.dismiss());
    const denied=await page.evaluate(async()=>{
      const result=await executeTool({function:{name:"workspace_delete_file",arguments:JSON.stringify({path:"kept.txt"})}});
      return result.code==="user_denied"&&(await getFile("kept.txt")).content==="preserved";
    });assert.equal(denied,true);
    await page.evaluate(()=>{
      activeChat().messages.push({role:"assistant",content:"長い会話のスクロール確認。\n\n".repeat(150)});
      renderThread({forceBottom:true});
      els.chatScroll.scrollTop=0;els.chatScroll.dispatchEvent(new Event("scroll"));
    });
    assert.equal(await page.evaluate(()=>chatAutoFollow),false);
    await page.evaluate(()=>{
      streamRound=async()=>new Promise((resolve,reject)=>abortController.signal.addEventListener("abort",()=>reject(new DOMException("Stopped","AbortError"))));
      els.prompt.value="停止テスト";void sendMessage();
    });
    await page.waitForFunction(()=>!document.querySelector("#stopBtn").hidden);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(()=>chatDistanceFromBottom()<3&&chatAutoFollow),true);
    const bubbleMetrics=await page.locator(".message.user").last().evaluate(node=>{
      const bubble=node.querySelector(".bubble"),text=bubble.firstElementChild,actions=node.querySelector(".messageActions");
      return {height:bubble.getBoundingClientRect().height,textHeight:text.getBoundingClientRect().height,actionsOutside:actions.parentElement===node,actionsBelow:actions.getBoundingClientRect().top>=bubble.getBoundingClientRect().bottom};
    });
    assert.equal(bubbleMetrics.actionsOutside,true);assert.equal(bubbleMetrics.actionsBelow,true);
    assert.ok(bubbleMetrics.height-bubbleMetrics.textHeight<=22);
    assert.equal(await page.locator(".liveExecutionStatus:visible").count(),1);
    assert.equal(await page.locator(".liveExecutionStatus:visible").textContent(),"応答を待っています");
    assert.equal(await page.locator("#sendBtn").isDisabled(),true);
    await page.locator("#prompt").fill("次の下書き");await page.locator("#prompt").press("Control+Enter");
    assert.equal(await page.evaluate(()=>running),true);
    await page.locator("#stopBtn").click();await page.waitForFunction(()=>!running);
    assert.equal(await page.locator(".liveExecutionStatus:visible").count(),0);
    assert.equal(await page.locator("#prompt").inputValue(),"次の下書き");
    await page.evaluate(()=>{
      window.savedFetchForTest=window.fetch;window.pendingReadsForTest=0;window.cancelledReadsForTest=0;
      window.fetch=(url,options)=>url===WEB_FETCH_URL?new Promise((resolve,reject)=>{
        window.pendingReadsForTest++;
        options.signal.addEventListener("abort",()=>{window.cancelledReadsForTest++;reject(new DOMException("Stopped","AbortError"))},{once:true});
      }):window.savedFetchForTest(url,options);
      streamRound=async()=>({msg:{role:"assistant",content:"",tool_calls:["a","b"].map(id=>({id:"cancel-"+id,function:{name:"web_fetch",arguments:JSON.stringify({url:"https://example.com/"+id})}})).concat([{id:"blocked-write",function:{name:"workspace_write_file",arguments:JSON.stringify({path:"must-not-exist.txt",content:"blocked"})}}])}});
      els.prompt.value="読取中の停止テスト";void sendMessage();
    });
    await page.waitForFunction(()=>window.pendingReadsForTest===2);
    assert.equal(await page.locator('.executionRow[data-state="running"] .executionLabel').count(),2);
    assert.match(await page.locator('.executionRow[data-state="running"] .executionLabel').first().textContent(),/Webページを読み込んでいます.*https:\/\/example.com\/a/);
    assert.equal(await page.locator(".liveExecutionStatus:visible").count(),0);
    await page.locator("#stopBtn").click();await page.waitForFunction(()=>!running);
    const stopped=await page.evaluate(async()=>{
      window.fetch=window.savedFetchForTest;
      return window.cancelledReadsForTest===2&&!(await getFile("must-not-exist.txt"));
    });assert.equal(stopped,true);
    // Completed writes survive an error/reload and reach the next API request.
    await page.evaluate(async()=>{
      let round=0;
      streamRound=async()=>{
        if(++round===1)return {msg:{role:"assistant",content:"ファイルを作成します",tool_calls:[{id:"resume-write",function:{name:"workspace_write_file",arguments:JSON.stringify({path:"resume-check.txt",content:"created once"})}}]}};
        throw new Error("resume test interruption");
      };
      els.prompt.value="再開の検証";await sendMessage();
    });
    assert.equal(await page.evaluate(()=>activeChat().resumeState.status),"interrupted");
    assert.equal(await page.evaluate(()=>activeChat().resumeState.operations.some(op=>op.name==="workspace_write_file"&&op.status==="completed")),true);
    await page.reload();await page.waitForFunction(()=>db?.version===2);
    const resumed=await page.evaluate(async()=>{
      document.querySelector("#settingsDialog").close();setApiKey("test-password",false);
      let context="";
      streamRound=async messages=>{context=messages.map(m=>m.content).filter(v=>typeof v==="string").join("\n");return {msg:{role:"assistant",content:"作成済みファイルを確認して続けます。"}}};
      els.prompt.value="続きから再開して";await sendMessage();
      return {hasRecord:context.includes("中断・作業引継ぎ記録")&&context.includes("resume-check.txt")&&context.includes("completed"),cleared:!activeChat().resumeState,content:(await getFile("resume-check.txt")).content};
    });
    assert.equal(resumed.hasRecord,true);assert.equal(resumed.cleared,true);assert.equal(resumed.content,"created once");
    assert.deepEqual(errors,[]);
    if(process.env.CHAT_UI_SCREENSHOT)await page.screenshot({path:process.env.CHAT_UI_SCREENSHOT});
  }finally{await browser?.close();server.kill();await once(server,"exit")}
});
