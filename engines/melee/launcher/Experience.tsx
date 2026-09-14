import {useEffect,useState} from 'react';
import Game from '../web/app/Game';
import NativeGame from '../web/app/NativeGame';
import LaunchSettings from '../web/app/LaunchSettings';
import {applyLauncherSelection} from './launch-plan.mjs';
import {schema} from '../web/lib/launch';
import {loadSettings,type Settings} from '../web/lib/launch';
import {desktop,preferences} from '../web/lib/desktop';
import {suspendMelee,selectLocalDisc,subscribeLocalDisc} from '../web/lib/melee-session';
import catalog from '../web/public/catalog.json';
import type {Fighter} from '../web/lib/fighter';
import './launcher.css';
export const roster=catalog as Fighter[];
export function MeleeSettings(){
 const [settings,setSettings]=useState(loadSettings);
 function update(value:Settings){setSettings(value);preferences.setItem('melee-launch-v1',JSON.stringify(value));}
 return <div className="melee-settings"><LaunchSettings section="gameplay" value={settings} onChange={update} roster={roster}/>{settings.ports.map((port,index)=><label key={index}>Player {index+1} moveset<select value={port.target||'auto'} onChange={e=>update({...settings,ports:settings.ports.map((p,i)=>i===index?{...p,target:e.target.value}:p)})}><option value="auto">Character default</option>{schema.targets.map(t=><option key={t.slug} value={t.slug}>{t.label}</option>)}</select></label>)}</div>;
}
export default function MeleeExperience({action,onClose,soundOn=true}:{action:any;onClose:()=>void;soundOn?:boolean}){
 const [ready,setReady]=useState(false),[status,setStatus]=useState('Choose your unmodified Melee USA 1.02 ISO or GCM.'),[error,setError]=useState('');
 const [settings]=useState(()=>applyLauncherSelection(loadSettings(),action));
 const fighter=action.character ? roster.find(f=>f.slug===action.character.slug) : roster[0];
 useEffect(()=>{
  if(desktop()){
   const abort=new AbortController();
   fetch('/melee/api/setup',{signal:abort.signal}).then(r=>r.json()).then(s=>{setReady(s.ready);setStatus(s.message||'Choose your Melee disc.');}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
   return()=>abort.abort();
  }
  return subscribeLocalDisc(s=>{setReady(s.ready);setStatus(s.message);});
 },[]);
 useEffect(()=>()=>suspendMelee(),[]);
 async function choose(file?:File){
  setError('');
  try{
   if(desktop()){
    await desktop()!.chooseDisc();
    const response=await fetch('/melee/api/setup');const s=await response.json();setReady(s.ready);setStatus(s.message||'Preparing disc…');
   }else if(file)await selectLocalDisc(file);
  }catch(e){setError((e as Error).message);}
 }
 if(!fighter)return <section className="melee-setup" role="alert"><p>This character has not been prepared for Melee yet.</p><button onClick={onClose}>Return to roster</button></section>;
 if(!ready)return <section className="melee-setup"><h2>Play Melee</h2><p>{status}</p>{error&&<p role="alert">{error}</p>}{desktop()?<button onClick={()=>void choose()}>Choose disc</button>:<label>Choose disc<input type="file" accept=".iso,.gcm" onChange={e=>void choose(e.target.files?.[0])}/></label>}<button onClick={onClose}>Return to roster</button></section>;
 return desktop()?<NativeGame fighter={fighter} settings={settings} roster={roster} onClose={onClose}/>:<Game fighter={fighter} settings={settings} roster={roster} onClose={onClose} soundOn={soundOn}/>;
}
