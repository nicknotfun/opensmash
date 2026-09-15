import {useEffect,useMemo,useState} from 'react';
import Game from '../web/app/Game';
import NativeGame from '../web/app/NativeGame';
import LaunchSettings from '../web/app/LaunchSettings';
import {applyLauncherSelection,launchFighter,originalCharacter,withOriginalFighters} from './launch-plan.mjs';
import {schema} from '../web/lib/launch';
import {loadSettings,type Settings} from '../web/lib/launch';
import {desktop,preferences} from '../web/lib/desktop';
import {suspendMelee,selectLocalDisc,subscribeLocalDisc,clearLocalDisc} from '../web/lib/melee-session';
import {pollService} from '../web/lib/service-poll';
import {resolveFighters} from './resolve';
import catalog from '../web/public/catalog.json';
import type {Fighter} from '../web/lib/fighter';
import './launcher.css';
export const roster=catalog as Fighter[];
export function MeleeDiscSettings(){
 const [status,setStatus]=useState(''),[error,setError]=useState('');
 useEffect(()=>desktop()?pollService<{message:string}>('/melee/api/setup',s=>setStatus(s.message),e=>setError(e.message)):subscribeLocalDisc(s=>setStatus(s.message)),[]);
 async function choose(file?:File){
  setError('');
  try{if(desktop())await desktop()!.chooseDisc();else if(file)await selectLocalDisc(file);}catch(e){setError((e as Error).message);}
 }
 async function clear(){
  setError('');
  try{
   if(desktop()){
    const response=await fetch('/melee/api/setup/clear',{method:'POST'});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Could not forget this disc.');
    setStatus(result.message);
   }else clearLocalDisc();
  }catch(e){setError((e as Error).message);}
 }
 return <section><h3>Melee disc</h3><p role="status">{status}</p>{error&&<p role="alert">{error}</p>}
  {desktop()?<button onClick={()=>void choose()}>Choose another disc</button>:<label>Choose another disc<input type="file" accept=".iso,.gcm" onChange={e=>void choose(e.target.files?.[0])}/></label>}
  <button onClick={()=>void clear()}>Forget disc and close Melee</button>
 </section>;
}
export function MeleeSettings({onPlayOriginals}:{onPlayOriginals?:()=>void}){
 const [settings,setSettings]=useState(loadSettings);
 function update(value:Settings){setSettings(value);preferences.setItem('melee-launch-v1',JSON.stringify(value));}
 function chooseOriginal(index:number,value:string){
  update({...settings,ports:settings.ports.map((port,i)=>i===index?{...port,
   // Returning to website selection also clears an old explicit vanilla value.
   character:!value&&/^vanilla:/.test(port.character)?index===0?'selected':'random':port.character,originalCharacter:value||undefined,
  }:port)});
 }
 function playOriginals(){update(withOriginalFighters(settings));onPlayOriginals?.();}
 return <div className="melee-settings"><MeleeDiscSettings/>
  <section aria-label="Melee fighters"><h3>Original Melee fighters</h3>
   <p>Choose fighters from your ISO, or use characters from the website roster.</p>
   {settings.ports.map((port,index)=><label key={index}>Player {index+1} fighter<select value={originalCharacter(port)||''} onChange={e=>chooseOriginal(index,e.target.value)}>
    <option value="">Use website roster selection</option><option value="random:vanilla">Random original fighter</option>
    {schema.fighters.map(fighter=><option key={fighter.id} value={'vanilla:'+fighter.id}>{fighter.label}</option>)}
   </select></label>)}
   <button onClick={playOriginals}>{onPlayOriginals?'Play original Melee':'Use original fighters for all players'}</button>
   <p>Uses the selected originals. Any remaining slots use Mario for player 1 and random original fighters for the other players.</p>
  </section>
  <LaunchSettings section="gameplay" value={settings} onChange={update} roster={roster}/>
  {settings.ports.map((port,index)=><label key={index}>Player {index+1} custom moveset<select disabled={Boolean(originalCharacter(port))} value={port.target||'auto'} onChange={e=>update({...settings,ports:settings.ports.map((p,i)=>i===index?{...p,target:e.target.value}:p)})}><option value="auto">Character default</option>{schema.targets.map(t=><option key={t.slug} value={t.slug}>{t.label}</option>)}</select></label>)}
 </div>;
}
export default function MeleeExperience({action,onClose,soundOn=true}:{action:any;onClose:()=>void;soundOn?:boolean}){
 const [ready,setReady]=useState(false),[status,setStatus]=useState('Choose your unmodified Melee USA 1.02 ISO or GCM.'),[error,setError]=useState('');
 const [setupError,setSetupError]=useState(''),[preparationStatus,setPreparationStatus]=useState('Preparing fighters…');
 const [resolved,setResolved]=useState<{action:any;roster:Fighter[]}|null>(null);
 const [settings,setSettings]=useState(()=>applyLauncherSelection(action.netplaySettings||loadSettings(),action));
 const fighters=resolved?.roster||roster;
 const fighter=useMemo(()=>resolved?launchFighter(schema,settings,resolved.action,fighters):fighters[0],[resolved,settings,fighters]);
 useEffect(()=>{
  if(!ready)return;
  const abort=new AbortController();
  setResolved(null);setError('');
  const saved=action.netplaySettings||loadSettings();
  resolveFighters(action,roster,abort.signal,setPreparationStatus,applyLauncherSelection(saved,action)).then(result=>{
   if(!abort.signal.aborted){
    setSettings(applyLauncherSelection(saved,result.action));setResolved(result);
   }
  }).catch(e=>{if(!abort.signal.aborted){setError(e.message);(window as any).openSmashNetplay?.fail(e);}});
  return()=>abort.abort();
 },[ready,action]);
 useEffect(()=>{
  if(desktop()){
   return pollService<{ready:boolean;message:string}>('/melee/api/setup',s=>{
    setReady(s.ready);setStatus(s.message||'Choose your Melee disc.');setSetupError('');
   },e=>setSetupError(e.message));
  }
  return subscribeLocalDisc(s=>{setReady(s.ready);setStatus(s.message);});
 },[]);
 useEffect(()=>()=>suspendMelee(),[]);
 async function choose(file?:File){
  setError('');
  try{
   if(desktop()){
    const result=await desktop()!.chooseDisc();
    if(result.accepted)setStatus('Preparing disc…');
   }else if(file)await selectLocalDisc(file);
  }catch(e){setError((e as Error).message);}
 }
 if(ready&&!resolved)return <section className="melee-setup"><h2>Preparing fighters</h2><p role={error?'alert':'status'}>{error||preparationStatus}</p><button onClick={onClose}>Return to roster</button></section>;
 if(!ready)return <section className="melee-setup"><h2>Play Melee</h2><p>{status}</p>{(error||setupError)&&<p role="alert">{error||setupError}</p>}{desktop()?<button onClick={()=>void choose()}>Choose disc</button>:<label>Choose disc<input type="file" accept=".iso,.gcm" onChange={e=>void choose(e.target.files?.[0])}/></label>}<button onClick={onClose}>Return to roster</button></section>;
 if(!fighter)return <section className="melee-setup" role="alert"><p>This character has not been prepared for Melee yet.</p><button onClick={onClose}>Return to roster</button></section>;
 return desktop()?<NativeGame fighter={fighter} settings={settings} roster={fighters} onClose={onClose}/>:<Game fighter={fighter} settings={settings} roster={fighters} onClose={onClose} soundOn={soundOn}/>;
}
