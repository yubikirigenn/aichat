function deliveryId(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("")}
function reconnectDelay(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new DOMException("Stopped","AbortError"));
    const cleanup=()=>{clearTimeout(timer);for(const name of ["online","pageshow","focus"])window.removeEventListener(name,wake);document.removeEventListener("visibilitychange",visible);signal?.removeEventListener("abort",abort)};
    const wake=()=>{cleanup();resolve()},visible=()=>{if(document.visibilityState==="visible")wake()},abort=()=>{cleanup();reject(new DOMException("Stopped","AbortError"))};
    const timer=setTimeout(wake,ms);
    for(const name of ["online","pageshow","focus"])window.addEventListener(name,wake,{once:true});
    document.addEventListener("visibilitychange",visible);signal?.addEventListener("abort",abort,{once:true});
  });
}
async function openReconnectStream(body,{id,recover=false,signal,request,onState=()=>{}}){
  let connected=false;
  async function rpc(delivery,starting=false){
    let attempt=0,probing=false;
    for(;;){
      if(signal.aborted)throw new DOMException("Stopped","AbortError");
      try{
        const timeout=AbortSignal.timeout(20000);
        const response=await request(starting?{...body,delivery}:{delivery},{signal:AbortSignal.any([signal,timeout])});
        if(!response.ok){
          const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={}}
          if([502,503,504].includes(response.status)&&!data.error?.code)throw new TypeError("Gateway temporarily unavailable");
          const error=new Error(data.error?.message||`再接続エラー (${response.status})`);error.httpStatus=response.status;error.code=data.error?.code;error.permanent=true;throw error;
        }
        if(response.headers.get("content-type")?.includes("application/json")){
          const text=await response.text();
          if(!connected){onState("connected");connected=true}
          return new Response(probing?JSON.stringify({delivery:true}):text,{headers:{"content-type":"application/json"}});
        }
        if(!connected){onState("connected");connected=true}
        return response;
      }catch(error){
        if(signal.aborted)throw new DOMException("Stopped","AbortError");
        if(error.permanent)throw error;
        // An ambiguous start must only probe the ID, never start a new generation.
        if(starting){starting=false;probing=true;delivery={id,action:"read",cursor:0}}
        connected=false;onState("reconnecting");
        await reconnectDelay(Math.min(30000,1000*2**Math.min(attempt++,5)),signal);
      }
    }
  }
  if(!recover){
    const response=await rpc({id,action:"start"},true);
    // Compatibility with older servers while Render rolls out the new version.
    if(!response.headers.get("content-type")?.includes("application/json"))return response;
    const data=await response.json();if(!data.delivery)throw new Error("再接続APIの応答が不正です。");
  }
  let cursor=0,done=false;
  const stream=new ReadableStream({async pull(controller){
    try{
      while(!done){
        const response=await rpc({id,action:"read",cursor});const data=await response.json();
        if(done)return;
        if(!Array.isArray(data.chunks)||!Number.isInteger(data.cursor)||data.cursor!==cursor+data.chunks.length)throw new Error("再接続APIの受信位置が不正です。");
        if(data.error)throw new Error(data.error);
        if(data.status>=400&&data.done){
          const detail=data.chunks.join("");let parsed;try{parsed=JSON.parse(detail)}catch{}
          const error=new Error(parsed?.error?.message||detail||`生成エラー (${data.status})`);error.httpStatus=data.status;error.code=parsed?.error?.code;throw error;
        }
        cursor=data.cursor;done=data.done;
        const text=data.chunks.join("");if(text)controller.enqueue(new TextEncoder().encode(text));
        if(done){controller.close();return}
        if(text)return;
        await reconnectDelay(650,signal);
      }
    }catch(error){controller.error(error)}
  },cancel(){done=true}});
  const response=new Response(stream,{headers:{"content-type":"text/event-stream"}});response.resumable=true;return response;
}
