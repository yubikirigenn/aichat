import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtemp, open, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Ephemeral disk spool, not a DB. RAM holds metadata and bounded read blocks.
// Real disk failures remain errors; there is no fixed byte/job-count/time cutoff.
export function createDetachedChat({handleChat,authorize,ttlMs=60*60*1000,now=Date.now,spoolParent=tmpdir()}={}){
  const jobs=new Map();let directory;
  const hash=value=>createHash("sha256").update(value).digest("hex");
  const fail=(res,status,code,message)=>res.status(status).json({error:{code,message},proxy:true});
  async function discard(key,job){clearTimeout(job.expiryTimer);jobs.delete(key);await job.closed;await unlink(job.file).catch(()=>{})}
  async function sweep(){for(const [key,job] of jobs)if(job.done&&now()-job.updatedAt>ttlMs)await discard(key,job)}
  const detached=async function(req,res){
    const delivery=req.body?.delivery;
    if(!delivery||!authorize(req).ok)return handleChat(req,res);
    if(!/^[a-f0-9]{64}$/.test(delivery.id||"")||!["start","read","cancel","release"].includes(delivery.action))return fail(res,400,"invalid_delivery","再接続IDが不正です。");
    if(delivery.action==="start"&&delivery.version!==2){const legacy=Object.create(req);const {delivery:ignored,...body}=req.body;legacy.body=body;return handleChat(legacy,res)}
    await sweep();const key=hash(delivery.id);let job=jobs.get(key);
    if(job)try{await job.ready}catch{return fail(res,503,"delivery_storage_error","生成の一時ファイルを準備できませんでした。")}
    if(delivery.action!=="start"){
      if(!job)return fail(res,410,"delivery_lost","生成の一時記録がありません。Renderの再デプロイ・再起動、または保持期限切れの可能性があります。重複生成はしていません。");
      if(delivery.action==="release"){
        if(!job.done)return fail(res,409,"delivery_running","実行中の生成は解放できません。");
        await discard(key,job);return res.json({released:true});
      }
      if(delivery.action==="cancel"){job.controller.abort();job.finish(499,"生成を停止しました。");job.sink?.destroy();return res.json({cancelled:true})}
      const cursor=delivery.cursor??0;
      if(!Number.isSafeInteger(cursor)||cursor<0||cursor>job.bytes)return fail(res,400,"invalid_cursor","受信位置が不正です。");
      try{
        const buffer=Buffer.alloc(Math.min(1024*1024,job.bytes-cursor));
        if(buffer.length){const reader=await open(job.file,"r");try{const result=await reader.read(buffer,0,buffer.length,cursor);if(result.bytesRead!==buffer.length)throw new Error("Incomplete spool read")}finally{await reader.close()}}
        const next=cursor+buffer.length;
        return res.json({encoding:"base64",cursor:next,chunks:buffer.length?[buffer.toString("base64")]:[],done:job.done&&next===job.bytes,status:job.status,error:job.error});
      }catch{return fail(res,503,"delivery_storage_error","生成の一時ファイルを読み出せません。ディスクの状態を確認してください。")}
    }
    const {delivery:ignored,access_password:password,...body}=req.body,fingerprint=hash(JSON.stringify(body));
    if(job){if(job.fingerprint!==fingerprint)return fail(res,409,"delivery_conflict","同じ生成IDで異なるリクエストは送信できません。");await job.ready;return res.json({delivery:true})}
    const controller=new AbortController();
    job={fingerprint,controller,bytes:0,status:200,done:false,updatedAt:now()};jobs.set(key,job);
    job.ready=(async()=>{
      directory||=mkdtemp(path.join(spoolParent,"nemotron-generations-")).catch(error=>{directory=undefined;throw error});
      job.file=path.join(await directory,key+".sse");job.handle=await open(job.file,"wx",0o600);
    })();
    try{await job.ready}catch{jobs.delete(key);return fail(res,503,"delivery_storage_error","生成の一時ファイルを作成できません。ディスクの空き容量と権限を確認してください。")}
    job.finish=(status=job.status,error)=>{
      if(job.done)return;job.status=status;job.error=error;job.done=true;job.updatedAt=now();
      job.closed=Promise.resolve(job.pendingWrite).catch(()=>{}).then(()=>job.handle.close()).catch(()=>{});
      job.expiryTimer=setTimeout(()=>{if(jobs.get(key)===job)void discard(key,job)},ttlMs);job.expiryTimer.unref?.();
    };
    const sink=new Writable({write(chunk,encoding,callback){
      if(job.done)return callback();
      job.pendingWrite=(async()=>{let written=0;while(written<chunk.length){const {bytesWritten}=await job.handle.write(chunk,written,chunk.length-written,job.bytes);if(!bytesWritten)throw new Error("Spool write made no progress");written+=bytesWritten;job.bytes+=bytesWritten}job.updatedAt=now()})();
      job.pendingWrite.then(()=>callback(),error=>callback(error));
    },final(callback){job.finish();callback()}});
    job.sink=sink;sink.status=status=>{if(!job.done)job.status=status;return sink};sink.setHeader=()=>sink;sink.flushHeaders=()=>{};
    sink.send=value=>sink.end(typeof value==="string"?value:JSON.stringify(value));sink.json=value=>sink.end(JSON.stringify(value));
    sink.on("error",()=>{controller.abort();job.finish(507,"生成結果を一時ファイルへ保存できません。ディスクの空き容量と権限を確認してください。")});
    const detachedRequest=Object.create(req);detachedRequest.body={...body,access_password:password};detachedRequest.detachedSignal=controller.signal;
    Promise.resolve().then(()=>handleChat(detachedRequest,sink)).catch(()=>{job.finish(502,"生成処理でエラーが発生しました。");sink.destroy()});
    return res.json({delivery:true});
  };
  detached.close=async()=>{
    for(const [key,job] of jobs){await job.ready.catch(()=>{});job.controller.abort();job.finish?.(499,"生成を停止しました。");job.sink?.destroy();await discard(key,job)}
    if(directory)await directory.then(root=>rmdir(root)).catch(()=>{});
  };
  return detached;
}
