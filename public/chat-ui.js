/* Stable, keyed turn views. No providers, credentials or tool execution here. */
function recordTurnText(msg,kind,text,round){
  if(!text)return;
  msg.timeline ||= [];
  const id=`${kind}-${round}`;
  let entry=msg.timeline.find(item=>item.id===id);
  if(!entry){entry={id,kind,text:""};msg.timeline.push(entry)}
  entry.text=text;
}
function turnTimeline(msg){
  if(msg.timeline?.length)return msg.timeline;
  // Older saved chats remain readable without rewriting their stored format.
  const entries=[];
  for(const a of msg.activity||[])entries.push({id:a.id,kind:"activity"});
  const reasoning=getReasoningText(msg);
  if(reasoning)entries.push({id:"legacy-reasoning",kind:"reasoning",text:reasoning});
  for(const [index,event] of (msg.toolEvents||[]).entries()){
    if(!msg.activity?.some(a=>a.id===event.activityId||a.name===friendlyToolName(event.name)))entries.push({id:`legacy-tool-${index}`,kind:"tool",event});
  }
  if(msg.planSnapshot)entries.push({id:"legacy-plan",kind:"plan"});
  if(msg.content)entries.push({id:"legacy-answer",kind:"text",text:msg.content});
  return entries;
}
function createTurnView(target){
  const bubble=target.querySelector(".bubble");
  const timeline=document.createElement("div");timeline.className="turnTimeline";
  const footer=document.createElement("div");footer.className="turnFooter";
  bubble.append(timeline,footer);
  const view={timeline,footer,entries:new Map()};target.turnView=view;return view;
}
function updateTurnHTML(node,html){
  if(node.renderedHTML===html)return;
  // Do not destroy a user's selected text while streaming. Catch up when the
  // selection clears; unrelated nodes can continue updating normally.
  const selection=window.getSelection?.();
  if(selection&&!selection.isCollapsed&&(node.contains(selection.anchorNode)||node.contains(selection.focusNode)))return;
  const open=[...node.querySelectorAll("details")].map(detail=>detail.open);
  node.innerHTML=html;node.renderedHTML=html;
  [...node.querySelectorAll("details")].forEach((detail,index)=>{if(open[index]!==undefined)detail.open=open[index]});
}
function makeExecutionRow(kind){
  const node=document.createElement("details");node.className=`executionRow ${kind}`;
  const summary=document.createElement("summary");
  const glyph=document.createElement("span");glyph.className="executionGlyph";glyph.setAttribute("aria-hidden","true");
  const label=document.createElement("span");label.className="executionLabel";
  summary.append(glyph,label);
  const detail=document.createElement("div");detail.className="executionDetail";
  node.append(summary,detail);return {node,glyph,label,detail};
}
function renderTurnView(target,msg,{streaming=false,messageIndex=null}={}){
  target.displayMessage=msg;target.displayStreaming=streaming;
  const view=target.turnView||createTurnView(target);
  for(const item of turnTimeline(msg)){
    const activity=item.kind==="activity"?(msg.activity||[]).find(a=>a.id===item.id):null;
    // Model rounds are implementation detail, not another "answer generated" row.
    if(item.kind==="activity"&&(!activity||/^model-round-/.test(item.id)))continue;
    let row=view.entries.get(item.id);
    if(!row){
      if(item.kind==="text"){
        const node=document.createElement("div");node.className="timelineText";row={node};
      }else{
        row=makeExecutionRow(item.kind);
        if(item.kind==="reasoning"){
          row.node.open=typeof msg.thinkingOpen==="boolean"?msg.thinkingOpen:streaming;
          row.detail.classList.add("reasoningText");
          row.node.addEventListener("toggle",()=>{target.displayMessage.thinkingOpen=row.node.open});
        }
      }
      view.entries.set(item.id,row);view.timeline.appendChild(row.node);
    }
    if(item.kind==="text"){updateTurnHTML(row.node,markdown(item.text||""));continue}
    if(item.kind==="reasoning"){
      row.label.textContent="Thinking";
      row.glyph.textContent=streaming?"◌":"◇";
      const follow=row.detail.scrollHeight-row.detail.scrollTop-row.detail.clientHeight<=24;
      const text=item.text||"",previous=row.detail.textContent;
      if(text!==previous){
        if(text.startsWith(previous)&&row.detail.firstChild)row.detail.firstChild.appendData(text.slice(previous.length));
        else row.detail.textContent=text;
        if(follow)row.detail.scrollTop=row.detail.scrollHeight;
      }
      continue;
    }
    const event=item.event||(msg.toolEvents||[]).find(ev=>ev.activityId===item.id)
      ||(activity?(msg.toolEvents||[]).find(ev=>!ev.activityId&&friendlyToolName(ev.name)===activity.name):null);
    const state=activity?.status||(event?.ok===false?"failed":"done");row.node.dataset.state=state;
    row.glyph.textContent=state==="failed"?"!":state==="running"||state==="requested"?"◌":"✓";
    const args=event?.detail?.arguments||{};
    const destination=args.path||args.query||(Array.isArray(args.queries)?args.queries.join(" / "):"")||args.url||activityDetailText(activity||{})||"";
    row.label.textContent=item.kind==="plan"?"計画":`${activity?activityCopy(activity.name,state):friendlyToolName(event?.name||"Tool")}${destination?` · ${destination}`:""}`;
    let html="";
    if(event){
      const result=toolEventResult(event);
      if(result?.result_ref)html+=`<button type="button" class="artifactLink" data-result-download="${escapeHTML(result.result_ref)}">取得結果をダウンロード</button>`;
      if(result?.searches)html+=result.searches.map(search=>`<div>${escapeHTML(search.query)} · ${search.ok?`${search.results.length}件`:escapeHTML(search.error||"失敗")}</div>`).join("");
      if(result?.post){
        const post=result.post;
        html+=`<div class="xPostCard"><a href="${escapeHTML(safeResultUrl(post.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(post.author?.name||"")} @${escapeHTML(post.author?.handle||"")}</a><div class="xPostDate">${escapeHTML(post.created_at||"")}</div><div class="xPostText">${escapeHTML(post.text||"")}</div>`;
        if(post.quote)html+=`<blockquote><a href="${escapeHTML(safeResultUrl(post.quote.url))}" target="_blank" rel="noopener noreferrer">@${escapeHTML(post.quote.author?.handle||"")}</a><div class="xPostText">${escapeHTML(post.quote.text||"")}</div></blockquote>`;
        html+=(post.media||[]).map((media,index)=>`<a href="${escapeHTML(safeResultUrl(media.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(media.type||"メディア")} ${index+1}</a> `).join("")+`</div>`;
        if(!row.autoOpened){row.node.open=true;row.autoOpened=true}
      }
      if(result?.chart)html+=renderChartHTML(result.chart);
      if(event.name?.startsWith("plan_")&&msg.planSnapshot)html+=renderPlanCard(msg.planSnapshot);
      if(args.path)html+=`<button type="button" class="artifactLink" data-open-artifact="${escapeHTML(args.path)}">${escapeHTML(args.path)}</button>`;
      html+=`<details><summary>実行データ</summary><pre>${escapeHTML(JSON.stringify(event.detail||{},null,2).slice(0,12000))}</pre></details>`;
      if(result?.results?.length)html+=result.results.map(r=>`<p><a href="${escapeHTML(safeResultUrl(r.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(r.title||(r.author?.handle?`@${r.author.handle} · ${r.created_at||""}`:r.url))}</a><br>${escapeHTML(r.snippet||r.text||"")}</p>`).join("");
      if(result?.chart&&!row.autoOpened){row.node.open=true;row.autoOpened=true}
    }else if(item.kind==="plan")html=renderPlanCard(msg.planSnapshot);
    else html=`<div>${escapeHTML(activity?.detail||"実行中")}</div>`;
    updateTurnHTML(row.detail,html);
  }
  let footer="";
  if(msg.error)footer+=`<div class="errorCard">${escapeHTML(msg.error)}</div>`;
  const citations=(msg.annotations||[]).filter(a=>a?.url_citation?.url);
  if(citations.length)footer+=`<div class="sources">${[...new Map(citations.map(a=>[a.url_citation.url,a.url_citation])).values()].map(c=>`<a class="sourceChip" href="${escapeHTML(safeResultUrl(c.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(c.title||c.url)}</a>`).join("")}</div>`;
  if(!streaming&&msg.meta)footer+=`<div class="meta"><details><summary>使用量・実行情報</summary>${Number(msg.meta.tokens||0).toLocaleString()} tokens · ${Number(msg.meta.rounds||0)} rounds · ${(Number(msg.meta.ms||0)/1000).toFixed(1)}s · $${Number(msg.meta.cost||0).toFixed(6)}</details></div>`;
  if(Number.isInteger(messageIndex))footer+=`<div class="messageActions"><button type="button" class="messageAction" data-copy-response>コピー</button><button type="button" class="messageAction" data-message-action="delete">削除</button></div>`;
  updateTurnHTML(view.footer,footer);
  if(!streaming&&!view.grouped){
    let group=null;
    for(const child of [...view.timeline.children]){
      if(child.classList.contains("timelineText")){group=null;continue}
      if(!group){
        group=document.createElement("details");group.className="completedWork";
        const summary=document.createElement("summary");summary.textContent="作業履歴";group.appendChild(summary);
        view.timeline.insertBefore(group,child);
      }
      if(child.open)group.open=true;
      group.appendChild(child);
    }
    view.grouped=true;
  }
}
function safeResultUrl(value){try{const url=new URL(value);return ["http:","https:"].includes(url.protocol)?url.href:"#"}catch{return "#"}}
function syncQuickControls(){
  const select=document.querySelector("#quickModel");if(!select)return;
  const signature=JSON.stringify(modelCatalog.map(m=>[m.key,m.id,m.provider,m.name,m.vision]));
  if(select.catalogSignature!==signature){
    select.innerHTML="";
    for(const provider of providerEntries())for(const vision of [true,false]){
      const group=document.createElement("optgroup");group.label=`${provider.label} · ${vision?"画像対応":"画像非対応"}`;
      for(const model of modelCatalog.filter(m=>m.provider===provider.id&&m.vision===vision)){
        const option=document.createElement("option");option.value=`${model.provider}:${model.id}`;option.textContent=model.name;group.appendChild(option);
      }
      if(group.children.length)select.appendChild(group);
    }
    select.catalogSignature=signature;
  }
  select.value=`${settings.provider}:${settings.model}`;select.disabled=running;
  document.querySelector("#quickReasoning").checked=!!settings.reasoning;
  document.querySelector("#quickWeb").checked=!!settings.web;
  document.querySelector("#quickPlanner").value=settings.planner;
  for(const id of ["#quickReasoning","#quickWeb","#quickPlanner"])document.querySelector(id).disabled=running;
  document.querySelector("#stopBtn").hidden=!running;els.send.disabled=running;
}
function updateLatestButton(){const button=document.querySelector("#jumpLatest");if(button)button.hidden=chatAutoFollow||chatDistanceFromBottom()<24}
function finishTurnView(node,live,final,chat){
  if(live.streamRenderFrame){cancelAnimationFrame(live.streamRenderFrame);live.streamRenderFrame=0}
  for(const a of final.activity||[])if(["running","requested"].includes(a.status)){a.status=final.error?"failed":"done"}
  const scrollTop=els.chatScroll.scrollTop;
  node.dataset.messageIndex=String(chat.messages.indexOf(final));
  renderTurnView(node,final,{messageIndex:chat.messages.indexOf(final)});
  if(chatAutoFollow)scrollBottom();else restoreChatScroll(scrollTop);
}
