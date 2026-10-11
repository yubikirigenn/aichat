import { Writable } from "node:stream";
import { createHash } from "node:crypto";

// Process-local, capability-protected buffers. No files, credentials or external DB.
export function createDetachedChat({ handleChat, authorize, ttlMs=60*60*1000, maxJobs=32, maxBytes=8*1024*1024, maxTotalBytes=64*1024*1024, timeoutMs=5*60*1000, now=Date.now }) {
  const jobs=new Map();
  const hash=value=>createHash("sha256").update(value).digest("hex");
  const fail=(res,status,code,message)=>res.status(status).json({error:{code,message},proxy:true});
  function sweep(){for(const [key,job] of jobs)if(job.done&&now()-job.updatedAt>ttlMs)jobs.delete(key)}
  function totalBytes(){return [...jobs.values()].reduce((n,j)=>n+j.bytes,0)}
  return async function detached(req,res){
    const delivery=req.body?.delivery;
    if(!delivery)return handleChat(req,res);
    if(!authorize(req).ok)return handleChat(req,res);
    if(!/^[a-f0-9]{64}$/.test(delivery.id||"")||!["start","read","cancel","release"].includes(delivery.action))return fail(res,400,"invalid_delivery","再接続IDが不正です。");
    sweep();
    const key=hash(delivery.id);let job=jobs.get(key);
    if(delivery.action!=="start"){
      if(!job)return fail(res,410,"delivery_lost","生成の一時記録がありません。Renderの再デプロイ・再起動、または保持期限切れの可能性があります。重複生成はしていません。");
      if(delivery.action==="release"){
        if(!job.done)return fail(res,409,"delivery_running","実行中の生成は解放できません。");
        jobs.delete(key);return res.json({released:true});
      }
      if(delivery.action==="cancel"){
        job.controller.abort();job.finish(499,"生成を停止しました。");return res.json({cancelled:true});
      }
      const cursor=delivery.cursor??0;
      if(!Number.isInteger(cursor)||cursor<0||cursor>job.chunks.length)return fail(res,400,"invalid_cursor","受信位置が不正です。");
      // Bound each poll; the cursor refers to whole decoded chunks, not JS characters.
      const chunks=[];let bytes=0;
      for(let i=cursor;i<job.chunks.length;i++){
        const chunk=job.chunks[i];if(chunks.length&&bytes+Buffer.byteLength(chunk)>1024*1024)break;
        chunks.push(chunk);bytes+=Buffer.byteLength(chunk);
      }
      const next=cursor+chunks.length;
      return res.json({cursor:next,chunks,done:job.done&&next===job.chunks.length,status:job.status,error:job.error});
    }
    const {delivery:ignored,access_password:password,...body}=req.body;
    const fingerprint=hash(JSON.stringify(body));
    if(job){
      if(job.fingerprint!==fingerprint)return fail(res,409,"delivery_conflict","同じ生成IDで異なるリクエストは送信できません。");
      return res.json({delivery:true});
    }
    if(jobs.size>=maxJobs||totalBytes()>=maxTotalBytes)return fail(res,503,"delivery_capacity","一時生成の保持枠が満杯です。時間を置いてください。");
    const controller=new AbortController();
    job={fingerprint,controller,chunks:[],bytes:0,status:200,done:false,updatedAt:now()};jobs.set(key,job);
    const decoder=new TextDecoder();let timer;
    job.finish=(status=job.status,error)=>{
      if(job.done)return;
      job.status=status;job.error=error;job.done=true;job.updatedAt=now();clearTimeout(timer);
    };
    const sink=new Writable({write(chunk,encoding,callback){
      if(job.done)return callback();
      const bytes=Buffer.byteLength(chunk);
      if(job.bytes+bytes>maxBytes||totalBytes()+bytes>maxTotalBytes){controller.abort();job.finish(507,"生成結果が一時保持上限に達しました。");return callback()}
      job.bytes+=bytes;job.updatedAt=now();job.chunks.push(decoder.decode(chunk,{stream:true}));callback();
    },final(callback){const tail=decoder.decode();if(tail)job.chunks.push(tail);job.finish();callback()}});
    sink.status=status=>{if(!job.done)job.status=status;return sink};
    sink.setHeader=()=>sink;sink.flushHeaders=()=>{};
    sink.send=value=>sink.end(typeof value==="string"?value:JSON.stringify(value));
    sink.json=value=>sink.end(JSON.stringify(value));
    sink.on("error",()=>job.finish(502,"生成の一時保持に失敗しました。"));
    timer=setTimeout(()=>{controller.abort();job.finish(504,"サーバーでの生成が5分の上限に達しました。")},timeoutMs);timer.unref?.();
    // The upstream lifetime is independent of the original browser connection.
    const detachedRequest=Object.create(req);detachedRequest.body={...body,access_password:password};detachedRequest.detachedSignal=controller.signal;
    Promise.resolve().then(()=>handleChat(detachedRequest,sink)).catch(()=>job.finish(502,"生成処理でエラーが発生しました。"));
    return res.json({delivery:true});
  };
}
