import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";

test("browser: per-chat workspaces migrate safely and isolate tools, drafts, imports and previews",{skip:!process.env.CHAT_UI_BROWSER},async()=>{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  const server=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:"31304",APP_ACCESS_PASSWORD:"test"},stdio:["ignore","pipe","pipe"]});let browser;
  try{
    await once(server.stdout,"data");browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*",route=>route.request().url().startsWith("http://127.0.0.1:31304")?route.continue():route.abort());
    await page.goto("http://127.0.0.1:31304/api/health");
    await page.evaluate(()=>new Promise((resolve,reject)=>{
      localStorage.setItem("nemotron_workspace_settings_v1",JSON.stringify({saveKey:true}));localStorage.setItem("nemotron_workspace_access_password","test");
      const req=indexedDB.open("NemotronWorkspaceDB",3);req.onerror=()=>reject(req.error);
      req.onupgradeneeded=()=>{req.result.createObjectStore("files",{keyPath:"path"});req.result.createObjectStore("chat_history",{keyPath:"id"});req.result.createObjectStore("tool_results",{keyPath:"id"})};
      req.onsuccess=()=>{const db=req.result,t=db.transaction(["files","chat_history"],"readwrite");
        t.objectStore("files").put({path:"legacy.txt",content:"legacy current",history:[{content:"legacy prior",at:"prior"}],createdAt:"original"});
        t.objectStore("chat_history").put({id:"current",activeChatId:"a",chats:[{id:"a",title:"A",messages:[]},{id:"b",title:"B",messages:[]}]});
        t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)};
    }));
    await page.goto("http://127.0.0.1:31304");await page.waitForFunction(()=>chatHistoryReady&&db.version===4);
    const migrated=await page.evaluate(async()=>({active:activeChatId,a:await listFiles(),legacy:await listFiles("legacy-playground-v1"),raw:await dbReq(tx(LEGACY_FILE_STORE).get("legacy.txt")),count:chats.filter(c=>c.id==="legacy-playground-v1").length}));
    assert.equal(migrated.active,"a");assert.equal(migrated.a.length,0);assert.equal(migrated.count,1);assert.equal(migrated.legacy[0].history[0].content,"legacy prior");assert.equal(migrated.raw.createdAt,"original");
    await page.evaluate(async()=>{
      await putFile("index.html",'<div id="owner">A-secret</div>');await putFile("same.txt","A original");await putFile("same.txt","A changed");await openFile("same.txt");
      els.codeEditor.value="A unsaved draft";els.codeEditor.dispatchEvent(new Event("input"));
      pushToolLog({name:"A-private-tool",ok:true,at:nowISO(),ms:1,detail:{path:"same.txt"}});
      selectChat("b");await switchWorkspace();
    });
    assert.equal(await page.evaluate(async()=>(await listFiles()).length),0);assert.equal(await page.locator("#codeEditor").inputValue(),"");
    assert.doesNotMatch(await page.locator("#toolLog").textContent(),/A-private-tool/);
    const isolated=await page.evaluate(async()=>{
      const result=await executeTool({function:{name:"workspace_read_file",arguments:JSON.stringify({path:"same.txt"})}});
      const search=await executeTool({function:{name:"workspace_search_files",arguments:JSON.stringify({query:"A-secret"})}});
      await executeTool({function:{name:"workspace_write_file",arguments:JSON.stringify({path:"index.html",content:'<div id="owner">B-only</div>'})}});
      await putFile("same.txt","B original");await putFile("same.txt","B changed");await openFile("same.txt");await undoCurrentFile();await buildPreview();
      let exported;const saved=downloadBlob;downloadBlob=(_name,data)=>exported=JSON.parse(data);await exportWorkspace();downloadBlob=saved;
      return {read:result.ok,search:search.count,content:(await getFile("same.txt")).content,preview:els.previewFrame.srcdoc,exported};
    });
    assert.equal(isolated.read,false);assert.equal(isolated.search,0);assert.equal(isolated.content,"B original");assert.match(isolated.preview,/B-only/);assert.doesNotMatch(isolated.preview,/A-secret/);assert.deepEqual(isolated.exported.files.map(f=>f.path),["index.html","same.txt"]);
    const drafts=await page.evaluate(async()=>{selectChat("a");await switchWorkspace();return {draft:els.codeEditor.value,stored:(await getFile("same.txt")).content,history:(await getFile("same.txt")).history}});
    assert.equal(drafts.draft,"A unsaved draft");assert.equal(drafts.stored,"A changed");assert.equal(drafts.history[0].content,"A original");
    const race=await page.evaluate(async()=>{
      const oldPreview=buildPreview();let deliver;
      const importing=importTextFiles([{name:"late.txt",size:4,text:()=>new Promise(resolve=>deliver=resolve)}]);
      selectChat("b");await switchWorkspace();deliver("A import");await importing;await oldPreview;await buildPreview();
      return {preview:els.previewFrame.srcdoc,a:await getFile("late.txt","a"),b:await getFile("late.txt","b")};
    });
    assert.match(race.preview,/B-only/);assert.doesNotMatch(race.preview,/A-secret/);assert.equal(race.a.content,"A import");assert.equal(race.b,undefined);
    await page.evaluate(async()=>{createChat();await switchWorkspace()});assert.equal(await page.evaluate(async()=>(await listFiles()).length),0);assert.equal(await page.evaluate(()=>els.previewFrame.srcdoc),"");
    await page.evaluate(async()=>{selectChat("a");await switchWorkspace();await persistChats()});
    await page.reload();await page.waitForFunction(()=>chatHistoryReady&&db.version===4);
    assert.equal(await page.locator("#codeEditor").inputValue(),"A unsaved draft");assert.equal(await page.evaluate(()=>chats.filter(c=>c.id==="legacy-playground-v1").length),1);
    await page.evaluate(async()=>{window.confirm=()=>true;await deleteChat("b");await deleteChat("legacy-playground-v1");await persistChats()});
    assert.equal(await page.evaluate(async()=>(await listFiles("b")).length),0);assert.equal(await page.evaluate(async()=>(await getFile("same.txt")).content),"A changed");
    await page.reload();await page.waitForFunction(()=>chatHistoryReady);assert.equal(await page.evaluate(()=>chats.some(c=>c.id==="legacy-playground-v1")),false);
    assert.equal(await page.evaluate(async()=>(await dbReq(tx(LEGACY_FILE_STORE).get("legacy.txt"))).content),"legacy current");assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();await once(server,"exit")}
});
