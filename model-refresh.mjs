import { MODEL_CATALOG, DEFAULT_MODEL, createCatalogModel } from "./models.mjs";

export const MODEL_SOURCES=Object.freeze({
  openrouter:"https://openrouter.ai/api/v1/models",
  tokenharbor:"https://tokenharbor.ai/models",
  gemini:"https://ai.google.dev/gemini-api/docs/pricing",
  groq:"https://console.groq.com/docs/rate-limits",
});
const GROQ_MODELS="https://console.groq.com/docs/models";
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;
const zero=value=>(typeof value==="number"||typeof value==="string"&&value.trim()!=="")&&Number(value)===0;
function expiry(value){
  if(value==null)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+"T00:00:00Z"))||new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value)throw new Error("invalid expiry");
  return value;
}
function expired(model,at){return model.expiresAt&&at>=Date.parse(model.expiresAt+"T00:00:00Z")+86400000}
function entry(provider,id,name,options={}){
  if(!idPattern.test(id)||typeof name!=="string"||!name.trim()||name.length>250)throw new Error("invalid model metadata");
  const until=expiry(options.expiresAt),model=createCatalogModel(provider,id,name.trim(),{
    ...options,...(until?{freeLabel:"FREE · "+until.slice(5).replace("-","/"),note:`Free endpoint expires ${until}.`}:{}),
  });
  return Object.freeze({...model,...(until?{expiresAt:until}:{})});
}
function unique(models){if(new Set(models.map(m=>m.key)).size!==models.length)throw new Error("duplicate models");return models}
export function parseOpenRouterCatalog(data){
  if(!Array.isArray(data?.data)||!data.data.length)throw new Error("missing model catalog");
  const models=[];
  for(const row of data.data){
    if(!row||typeof row.id!=="string")throw new Error("invalid catalog row");
    if(!(row.id.endsWith(":free")||row.id==="openrouter/free")||!zero(row.pricing?.prompt)||!zero(row.pricing?.completion))continue;
    if(!row.architecture?.output_modalities?.includes("text"))continue;
    if(!positive(row.context_length)||!Array.isArray(row.supported_parameters)||!Array.isArray(row.architecture.input_modalities))throw new Error("missing capabilities");
    models.push(entry("openrouter",row.id,row.name,{
      vision:row.architecture.input_modalities.includes("image"),contextLength:row.context_length,maxOutputTokens:positive(row.top_provider?.max_completion_tokens),
      supportsTools:row.supported_parameters.includes("tools"),supportsReasoning:row.supported_parameters.includes("reasoning"),
      supportsTemperature:row.supported_parameters.includes("temperature"),expiresAt:row.expiration_date,
    }));
  }
  return unique(models);
}
function jsonArrayAt(text,key){
  const match=new RegExp('"'+key+'"\\s*:\\s*\\[').exec(text);if(!match)return null;
  const start=text.indexOf("[",match.index);let depth=0,string=false,escape=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];if(string){if(escape)escape=false;else if(c==="\\")escape=true;else if(c==='"')string=false;continue}
    if(c==='"')string=true;else if(c==="[")depth++;else if(c==="]"&&!--depth)return JSON.parse(text.slice(start,i+1));
  }
  throw new Error("incomplete catalog");
}
export function parseTokenHarborCatalog(html,seed=MODEL_CATALOG){
  let rows=jsonArrayAt(html,"freeRows");
  if(!rows)for(const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)){
    const fragment=JSON.parse(match[1])?.[1];if(typeof fragment!=="string")continue;
    rows=jsonArrayAt(fragment,"freeRows");if(rows)break;
  }
  if(!Array.isArray(rows))throw new Error("missing freeRows");
  return unique(rows.flatMap(row=>{
    // A badge or free account allowance on a paid ID is not a free API route.
    if(typeof row?.surface!=="string")throw new Error("unverified free route");
    for(const price of [row.priceIn,row.priceOut])if(!(typeof price==="number"||typeof price==="string"&&price.trim()!=="")||!Number.isFinite(Number(price))||Number(price)<0)throw new Error("missing price");
    if(!row.surface.endsWith(":free")||row.isFree!==true||!zero(row.priceIn)||!zero(row.priceOut))return [];
    if(!positive(row.contextWindow)||!Array.isArray(row.inputModalities))throw new Error("missing capabilities");
    const prior=seed.find(m=>m.provider==="tokenharbor"&&m.id===row.surface);
    return [entry("tokenharbor",row.surface,row.label,{
      vision:row.inputModalities.includes("image"),contextLength:row.contextWindow,maxOutputTokens:positive(row.maxOutput),reasoningMode:"automatic",
      supportsTools:row.supportsTools===true||prior?.supportsTools===true,supportsReasoning:true,expiresAt:row.freeUntil,
      supportsTemperature:prior?.supportsTemperature??false,
      note:"無料ルートの有効化が必要です。入力・出力が保存される場合があります。Thinkingはモデルの自動設定です。",
    })];
  }));
}
function plain(text){return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<\/(?:td|th)>/gi," | ").replace(/<\/(?:tr|p|div|h[1-6])>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/\*\*/g,"")}
function tableRows(html){return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match=>[...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>plain(cell[1]).replace(/\s+/g," ").trim()))}
export function parseGroqCatalog(limits,models,seed=MODEL_CATALOG){
  const tables=[...limits.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m=>m[0]);
  const index=tables.findIndex(t=>t.includes("Free Plan Limits")&&t.includes("MODEL ID")),free=tables[index];
  if(!free)throw new Error("missing Free Plan table");
  if(free.includes("Developer Plan Limits")&&!/<button\b[^>]*(?:bg-black|aria-selected="true"|data-state="active")[^>]*>Free Plan Limits<\/button>/.test(free))throw new Error("unverified plan selection");
  // Groq splits sticky column headers and the rendered body into two tables.
  const body=tableRows(free).some(row=>idPattern.test(row[0])&&row.length>=7)?free:tables[index+1];
  if(!body||body!==free&&body.includes("MODEL ID"))throw new Error("missing free plan body");
  // Accept only the rendered Free Plan table, never Developer/Enterprise rows.
  const freeRows=tableRows(body).filter(row=>row.length>=7&&idPattern.test(row[0]));
  if(!freeRows.length)throw new Error("missing free plan rows");
  const ids=freeRows.map(row=>row[0]).filter(id=>/^(?:openai\/gpt-oss|qwen\/|llama-|meta-llama\/llama-\d|deepseek|gemma|mixtral|moonshotai\/kimi|minimax)/.test(id));
  const rows=tableRows(models);if(!rows.some(r=>r[0]?.includes("MODEL ID")&&r.length>=6))throw new Error("missing model capabilities table");
  return unique(ids.map(id=>{
    const row=rows.find(r=>r[0]?.endsWith(id));if(!row)throw new Error("missing supported model");
    const context=Number(row[4]?.replaceAll(",","")),output=Number(row[5]?.replaceAll(",",""));
    if(!positive(context)||!positive(output))throw new Error("missing context limits");
    const prior=seed.find(m=>m.provider==="groq"&&m.id===id);
    return entry("groq",id,prior?.name||id,{...prior,contextLength:context,maxOutputTokens:output,
      // Undocumented capabilities of a new route are not guessed.
      vision:prior?.vision||false,supportsTools:prior?.supportsTools===true,supportsReasoning:prior?.supportsReasoning===true,supportsTemperature:prior?.supportsTemperature??false,
    });
  }));
}
export function parseGeminiFreeIds(pricing){
  if(!pricing.includes("Free Tier")||!pricing.includes("Input price"))throw new Error("missing Gemini pricing schema");
  const sections=pricing.split(/\n## /),ids=[];let recognized=0;
  for(const section of sections){
    const id=section.match(/`(gemini-[a-z0-9.-]+)`/)?.[1];
    if(!id||!/^gemini-\d+(?:\.\d+)?-(?:flash|pro)/.test(id)||/tts|live|audio|image|transcrib|embedding|robotic/.test(id))continue;
    const table=section.split(/\{% tab title="Batch"/)[0];
    if(!table.includes("Input price")||!table.includes("Output price"))continue;recognized++;
    const free=field=>new RegExp(field+'[^\\n|]*\\s*(?:\\n\\s*\\*|\\|)\\s*Free of charge','i').test(table);
    if(free("Input price")&&free("Output price"))ids.push(id);
  }
  if(!recognized||ids.length>64)throw new Error("no verified chat pricing tables");
  return [...new Set(ids)];
}
export function parseGeminiModel(id,page,seed=MODEL_CATALOG){
  const text=plain(page),context=Number(text.match(/Input token limit[^\d]{0,80}([\d,]+)/i)?.[1]?.replaceAll(",","")),output=Number(text.match(/Output token limit[^\d]{0,80}([\d,]+)/i)?.[1]?.replaceAll(",",""));
  if(!text.includes(id)||!/Output\s+Text\b/i.test(text)||!positive(context)||!positive(output))throw new Error("missing Gemini text capabilities");
  const prior=seed.find(m=>m.provider==="gemini"&&m.id===id);
  const capability=label=>{
    const flag=page.match(new RegExp(label+'[\\s\\S]{0,220}?type="(not-supported|supported)"','i'))?.[1];
    return flag?flag==="supported":null;
  };
  return entry("gemini",id,prior?.name||id,{vision:/Inputs[\s\S]{0,160}\bImage\b/i.test(text),contextLength:context,maxOutputTokens:output,
    supportsTools:capability("Function calling")??prior?.supportsTools??false,supportsReasoning:capability("Thinking")??prior?.supportsReasoning??false,
    supportsTemperature:prior?.supportsTemperature??false,
    note:prior?.note||"Google AI StudioのFree Tierプロジェクトのキーが必要です。無料枠のデータ利用条件を確認してください。",
  });
}
async function mapConcurrent(values,fn){const result=new Array(values.length);let cursor=0;await Promise.all(Array.from({length:Math.min(3,values.length)},async()=>{while(cursor<values.length){const i=cursor++;result[i]=await fn(values[i])}}));return result}
export function modelRefreshInterval(value){const hours=Number(value??6);return Number.isFinite(hours)&&hours>=1&&hours<=168?hours*3600000:6*3600000}
export function createAutoModelCatalog({seed=MODEL_CATALOG,fetchImpl=fetch,now=Date.now,intervalMs=6*3600000,enabled=true,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}){
  const initial=seed.map(m=>{const date=m.note?.match(/expires (\d{4}-\d{2}-\d{2})/)?.[1];return date?{...m,expiresAt:date}:m});
  const groups=new Map(Object.keys(MODEL_SOURCES).map(id=>[id,initial.filter(m=>m.provider===id)]));
  const status=Object.fromEntries(Object.keys(MODEL_SOURCES).map(id=>[id,{source:MODEL_SOURCES[id],updatedAt:null,lastAttempt:null,error:null}]));
  const lifetime=new AbortController();let inFlight=null,timer=null,lastAttempt=null;
  async function read(url){
    const hosts=new Set(["openrouter.ai","tokenharbor.ai","www.tokenharbor.ai","ai.google.dev","aistudio.google.com","console.groq.com"]);
    const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(20000)]);let response;
    for(let hop=0;hop<4;hop++){
      const target=new URL(url);if(target.protocol!=="https:"||!hosts.has(target.hostname)||target.port&&target.port!=="443"||target.username||target.password)throw new Error("unsafe source redirect");
      response=await fetchImpl(target.href,{redirect:"manual",headers:{Accept:"application/json, text/markdown, text/html"},signal});
      if(![301,302,303,307,308].includes(response.status))break;
      await response.body?.cancel();const next=response.headers.get("location");if(!next)throw new Error("missing redirect");url=new URL(next,url).href;
    }
    if(!response.ok)throw new Error("source unavailable");
    if(Number(response.headers.get("content-length"))>8*1024*1024)throw new Error("source too large");
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)throw new Error("source too large");chunks.push(Buffer.from(value))}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
    return Buffer.concat(chunks).toString("utf8");
  }
  async function load(id){
    const source=await read(MODEL_SOURCES[id]);
    if(id==="openrouter")return parseOpenRouterCatalog(JSON.parse(source));
    if(id==="tokenharbor")return parseTokenHarborCatalog(source,seed);
    if(id==="groq")return parseGroqCatalog(source,await read(GROQ_MODELS),seed);
    const ids=parseGeminiFreeIds(source);
    return mapConcurrent(ids,async modelId=>parseGeminiModel(modelId,await read("https://ai.google.dev/gemini-api/docs/models/"+modelId),seed));
  }
  function models(){return [...initial.filter(m=>!groups.has(m.provider)),...[...groups.values()].flat()].filter(m=>!expired(m,now()))}
  function defaultModel(){const list=models();return list.find(m=>m.key===DEFAULT_MODEL.key)||list.find(m=>m.provider==="openrouter"&&m.supportsTools)||list.find(m=>m.provider!=="experientiallabs")||DEFAULT_MODEL}
  function refresh(){
    if(!enabled||lifetime.signal.aborted)return Promise.resolve();if(inFlight)return inFlight;
    lastAttempt=now();
    inFlight=Promise.all(Object.keys(MODEL_SOURCES).map(async id=>{
      status[id].lastAttempt=new Date(now()).toISOString();
      try{const result=await load(id);if(lifetime.signal.aborted)return;groups.set(id,Object.freeze(result));status[id].updatedAt=new Date(now()).toISOString();status[id].error=null}
      catch{status[id].error="source_unavailable_or_schema_changed"}
    })).finally(()=>{inFlight=null});return inFlight;
  }
  return {
    models,defaultModel,find:(provider,id)=>models().find(m=>m.provider===provider&&m.id===id)||null,
    status:()=>({enabled,intervalHours:intervalMs/3600000,sources:structuredClone(status)}),refresh,
    refreshIfDue(){return lastAttempt===null||now()-lastAttempt>=intervalMs?refresh():inFlight||Promise.resolve()},
    start(){if(timer||!enabled||lifetime.signal.aborted)return;void refresh();timer=setIntervalImpl(()=>{void refresh()},intervalMs);timer.unref?.()},
    close(){lifetime.abort();if(timer)clearIntervalImpl(timer);timer=null},
  };
}
