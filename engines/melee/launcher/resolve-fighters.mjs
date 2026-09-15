// Import only custom roster picks that remain in the actual launch lineup.
// Original Melee fighters come from the player's local disc.
export async function resolveFighters(action,roster,settings,{signal=new AbortController().signal,onStatus=message=>{},fetchImpl=fetch,pathFor=path=>path,origin=globalThis.location?.origin}={}){
 const resolved=new Map();
 async function json(url,init={}){
  const response=await fetchImpl(url,{...init,signal,headers:{'Content-Type':'application/json',...init.headers}});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not prepare the selected fighter.');return result;
 }
 const needed=new Set(settings.ports.filter(port=>port.device!=='off').map(port=>port.character==='selected'?action.character?.slug:port.character));
 for(const pick of [action.character,...(action.picks||[])].filter(pick=>pick&&needed.has(pick.slug))){
  if(roster.some(f=>f.slug===pick.slug)||resolved.has(pick.slug))continue;
  onStatus('Preparing '+pick.name+' for Melee…');
  const base=pick.base||pick.target||'mario';
  const target=({donkey:'donkey-kong',captain:'captain-falcon',purin:'jigglypuff'})[base]||base;
  const source=await json('/api/melee/source/'+encodeURIComponent(pick.slug),{method:'POST',body:'{}'});
  let job=await json(pathFor('/api/imports'),{method:'POST',body:JSON.stringify({url:new URL(source.url,origin).href,target})});
  while(job.state!=='complete'){
   if(job.state==='failed')throw Error(job.message);
   onStatus(job.message||'Preparing character…');
   await new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);reject(signal.reason||Error('Cancelled'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},500);
    if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
   });
   job=await json(pathFor('/api/imports/'+job.id));
  }
  resolved.set(pick.slug,job.fighter);
 }
 return {roster:[...roster,...resolved.values()],action:{...action,character:resolved.get(action.character?.slug)||action.character,picks:(action.picks||[]).map(p=>resolved.get(p.slug)||p)}};
}
