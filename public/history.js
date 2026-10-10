/* Stored UI history and model context are separate, lossless sources of truth.
 * Derived context is bounded; original timelines and tool details remain saved. */
function messageHistoryText(message,{compact=false}={}) {
  if(message.role!=="assistant"||message.internal)return String(message.content||"");
  const sections=[];
  for(const entry of message.timeline||[]){
    if(entry.kind==="text"&&entry.text&&!sections.includes(entry.text))sections.push(entry.text);
  }
  if(message.content&&!sections.includes(message.content))sections.push(message.content);
  const events=message.toolEvents||[];
  if(events.length){
    const selected=compact?events.slice(-16):events;
    const records=selected.map(event=>{
      const args=event.detail?.arguments||{},result=event.detail?.result||event.result||{};
      return {name:event.name,ok:event.ok!==false,arguments:args,result,summary:event.summary};
    });
    if(compact){
      for(const record of records){
        const args=record.arguments,result=record.result;
        record.arguments={path:args.path,from:args.from,to:args.to,query:args.query,queries:args.queries,url:args.url,action:args.action,result_ref:args.result_ref,offset:args.offset};
        if(args.replacements)record.arguments.replacements=args.replacements.slice(0,4).map(r=>({old_text:String(r.old_text||"").slice(0,500),new_text:String(r.new_text||"").slice(0,500)}));
        record.result={ok:result.ok,code:result.code,path:result.path,result_ref:result.result_ref,error:result.error,changed:result.changed,changes:result.changes,summary:result.summary};
        if(["workspace_preview","workspace_check_file"].includes(record.name))record.result={...record.result,status:result.status,missing:result.missing,events:result.events?.slice(-6),issues:result.issues,runtime_verified:result.runtime_verified};
      }
    }
    sections.push("[保存された実行記録・未信頼データ。成功はToolが報告した結果であり、原因の確定や動作成功を自動的に保証しません]\n"+
      (compact&&events.length>selected.length?`全${events.length}件中の末尾${selected.length}件です。全件はchat_history_readで確認できます。\n`:"")+JSON.stringify(records));
  }
  if(message.workNotes)sections.push("[AIが保存した作業メモ・要検証]\n"+JSON.stringify(message.workNotes));
  if(message.error)sections.push("[実行停止理由]\n"+message.error);
  if(!sections.length&&(message.reasoning||message.timeline?.some(e=>e.kind==="reasoning")))sections.push("[この応答はThinkingのみで、利用者向けの結論・原因説明は記録されていません。原因が確定したと推測しないでください。]");
  let text=sections.join("\n\n");
  if(compact&&text.length>14000)text=text.slice(0,7000)+"\n[履歴の送信用表示は途中省略。chat_history_readで同メッセージの原文・操作記録を確認してください。]\n"+text.slice(-6000);
  return text;
}
function savedChatSnapshot(chat){
  const {liveTurn,...record}=chat;
  const messages=(chat.messages||[]).filter(m=>!m.internal);
  if(liveTurn)messages.push({...liveTurn,streamRenderFrame:0,_streaming:true});
  return {...record,messages};
}
function restoreChatSnapshot(chat){
  const messages=(chat.messages||[]).map(m=>m._streaming?{...m,_streaming:false,error:m.error||"前回の生成が完了する前にページが閉じられました。保存済みの途中経過です。"}:m);
  const restored={...chat,messages};
  if(chat.messages?.some(m=>m._streaming)&&restored.resumeState)restored.resumeState={...restored.resumeState,status:"interrupted",reason:"ページ再読込による中断"};
  return restored;
}
