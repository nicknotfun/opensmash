import {gameInputBlocked} from '../lib/controls';
import {meleePath} from '../lib/paths.ts';
import {useEffect,useRef,useState} from 'react';
import {plan,schema,type Settings} from '@/lib/launch';
import type {Fighter} from '../lib/fighter';
import {names} from '../lib/fighter';
import {connectAudio,unlockAudio,setAudioEnabled} from '@/lib/audio';
import {stopAnnouncer} from '@/lib/announcer';
import {claimMelee,claimOnlineMelee,releaseMelee} from '@/lib/melee-session';
import {packNetworkPad} from '../../runtime/web/netplay.mjs';
import {keyLabel,loadBindings,rawGamepads,sampleMeleePad,type Action} from '@/lib/controls';
// GameCube button bits in the pad word, keyed by the control id from the bindings module.
const bits:Record<string,number>={a:0x100,b:0x200,x:0x400,y:0x800,z:0x10,l:0x40,r:0x20,start:0x1000};
export default function Game({fighter,settings,roster,onClose,soundOn=true}:{fighter:Fighter;settings:Settings;roster:Fighter[];onClose:()=>void;soundOn?:boolean}){
 useEffect(()=>{setAudioEnabled(soundOn);},[soundOn]);
 const canvas=useRef<HTMLCanvasElement>(null),[status,setStatus]=useState('Preparing '+fighter.name+'…'),[error,setError]=useState(''),[fps,setFps]=useState<number|null>(null),[attempt,setAttempt]=useState(0);
 const gameWorker=useRef<Worker|undefined>(undefined);
 const touch=useRef(new Set<string>());
 const networkButtons=useRef(0);
 const bindings=loadBindings(),kb=bindings.keyboard;
 useEffect(()=>{
  let worker:Worker|undefined,audioNode:AudioWorkletNode|undefined,raf=0,closed=false;const abort=new AbortController(),keys=new Set<string>(),requestedAt=Date.now();
  let playable=settings.mode!==0, audioConnecting=false;
  const netplay=(window as any).openSmashNetplay;
  let running=false,firstFrame=true,selectionAcknowledged=false,fullBootVisible=false,frameSamples:number[]=[],launchPlan:any;
  const skin=!netplay&&new URLSearchParams(location.search).get('skin')==='gx'?'gx':'host';
  const sampleNetwork=()=>{
   const held=(action:Action)=>!gameInputBlocked()&&(keys.has(kb[action])||touch.current.has(kb[action]));
   let buttons=networkButtons.current;networkButtons.current=0;
   for(const [action,bit] of Object.entries(bits))if(held(action as Action))buttons|=bit;
   let x=((held('right')?1:0)-(held('left')?1:0))*100,y=((held('up')?1:0)-(held('down')?1:0))*100;
   let cx=((held('cright')?1:0)-(held('cleft')?1:0))*100,cy=((held('cup')?1:0)-(held('cdown')?1:0))*100,l=0,r=0;
   const pad=rawGamepads().find(p=>p?.connected);
   if(pad&&!gameInputBlocked()){
    const sample=sampleMeleePad(pad);buttons|=sample[2];
    x=sample[3];y=sample[4];cx=sample[5];cy=sample[6];l=sample[7];r=sample[8];
   }
   return [buttons,x,y,cx,cy,l,r];
  };
  const send=(schedule=true)=>{
   if(worker&&running&&!netplay){
    for(let port=0;port<4;port++){
    const device=launchPlan?.ports[port]?.device;
    if(device==='off'||device==='cpu') {worker.postMessage({type:'pad',values:[port,0,0x80808080,0,0]});continue;}
    const held=(action:Action)=>!gameInputBlocked()&&device==='keyboard'&&(keys.has(kb[action])||touch.current.has(kb[action]));
    let buttons=0;for(const [action,bit] of Object.entries(bits))if(held(action as Action))buttons|=bit;
    let x=128+((held('right')?1:0)-(held('left')?1:0))*100;
    let y=128+((held('up')?1:0)-(held('down')?1:0))*100;
    let cx=128+((held('cright')?1:0)-(held('cleft')?1:0))*100;
    let cy=128+((held('cup')?1:0)-(held('cdown')?1:0))*100;
    let l=0,r=0;
    const pad=device?.startsWith('gamepad')?rawGamepads().find(p=>p?.index===Number(device.slice(7))):null;
    if(pad&&!gameInputBlocked()){
     const sample=sampleMeleePad(pad);
     buttons|=sample[2];x=128+sample[3];y=128+sample[4];cx=128+sample[5];cy=128+sample[6];l=sample[7];r=sample[8];
    }
    worker.postMessage({type:'pad',values:[port,buttons,(x|(y<<8)|(cx<<16)|(cy<<24))>>>0,l|(r<<8),device==='keyboard'||!!pad?1:0]});
    }
   }if(schedule)raf=requestAnimationFrame(()=>send());
  };
  const code=(e:KeyboardEvent)=>e.code||(/^[a-z]$/i.test(e.key)?'Key'+e.key.toUpperCase():/^[0-9]$/.test(e.key)?'Digit'+e.key:e.key===' '?'Space':e.key);
  const bound=new Set(Object.values(kb));
  const keydown=(e:KeyboardEvent)=>{if(gameInputBlocked()||(e.target instanceof HTMLElement&&e.target.matches('input,select,textarea,[contenteditable=true]')))return;const key=code(e);if(bound.has(key)){e.preventDefault();keys.add(key);if(netplay)for(const [action,bit] of Object.entries(bits))if(kb[action as Action]===key)networkButtons.current|=bit;send(false);}};
  const keyup=(e:KeyboardEvent)=>{keys.delete(code(e));send(false);};
  const blur=()=>{keys.clear();touch.current.clear();for(let port=0;port<4;port++)worker?.postMessage({type:'pad',values:[port,0,0x80808080,0,launchPlan?.ports[port]?.device==='keyboard'?1:0]});};
  window.addEventListener('keydown',keydown);window.addEventListener('keyup',keyup);window.addEventListener('blur',blur);
  async function start(){try{
   if(!crossOriginIsolated||!canvas.current?.transferControlToOffscreen)throw Error('This browser needs shared memory and OffscreenCanvas support. Open the local game in Chrome.');
   let session=netplay?undefined:claimMelee();
   if(session){worker=session.worker;gameWorker.current=worker;}
   launchPlan=plan(settings,fighter,roster,netplay?.room.config.seed);
   if(!netplay&&new URLSearchParams(location.search).get('benchmark')==='1') {
    launchPlan.packedPorts=launchPlan.packedPorts.map((p:number,i:number)=>i<2?(p&~0xff00)|256:p);
    launchPlan.stocks=20;
   }
   const costumes=await Promise.all(launchPlan.costumes.map(async (entry:any)=>{
    const response=await meleeFetch('/api/prepare/'+encodeURIComponent(entry.character)+'?target='+encodeURIComponent(entry.target)+'&color='+entry.color+(skin==='host'?'&skin=host'+(launchPlan.costumes.length>=3?'&compact=1':''):''),{method:'POST',signal:abort.signal});
    const costume=await response.json();if(!response.ok)throw Error(costume.error||'The character could not be prepared.');
    const asset=await meleeFetch(costume.url,{signal:abort.signal});if(!asset.ok)throw Error('The costume could not load.');
    return {filename:costume.filename,blob:await asset.blob()};
   }));
   const cssAssets = [];
   if (costumes.length) {
    setStatus('Preparing character select…');
    const response = await meleeFetch('/api/character-select', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({costumes:launchPlan.costumes}), signal:abort.signal});
    const prepared = await response.json();if(!response.ok)throw Error(prepared.error || 'Character select could not be prepared.');
    for (const entry of prepared.assets) {
     const asset = await meleeFetch(entry.url, {signal:abort.signal});if(!asset.ok)throw Error('Character select assets could not load.');
     cssAssets.push({filename:entry.filename,blob:await asset.blob()});
    }
   }
   setStatus('Loading Melee…');if(closed)return;
   const selection={type:'select',requestedAt,character:fighter.slug,skin,fighter:launchPlan.ports[0].fighter,launch:launchPlan,costumes,cssAssets};
   if(netplay)session=claimOnlineMelee(netplay.room.config.seed,selection);
   if(!session)throw Error('The Melee session could not start.');
   worker=session.worker;gameWorker.current=worker;
   const audio=session.audio;
   const startAudio=()=>{if(audioConnecting)return;audioConnecting=true;connectAudio(audio).then(node=>{if(closed)node.disconnect();else audioNode=node;}).catch(()=>{audioConnecting=false;});};
   if(playable)startAudio();
   worker.onerror=e=>{if(!closed){setError(e.message||'The game worker stopped.');netplay?.fail(Error(e.message||'The game worker stopped.'));}};
   worker.onmessage=({data})=>{
    if(closed)return;
    if(data.type==='frame'){canvas.current?.getContext('bitmaprenderer')?.transferFromImageBitmap(data.bitmap);if(firstFrame){firstFrame=false;canvas.current?.focus();}}
    if(data.type==='session' && data.launch)selectionAcknowledged=true;
    if(data.type==='frame' && settings.mode===4 && selectionAcknowledged && !fullBootVisible){fullBootVisible=true;setStatus('');}
    if(data.type==='status' && !fullBootVisible)setStatus(data.message);
    if(data.type==='started'){running=true;}
    if(data.type==='netplay-ready'&&netplay)netplay.ready(data.fingerprint).catch((error:Error)=>{if(!closed){setError(error.message);worker?.postMessage({type:'netplay-stop'});netplay.fail(error);}});
    if(data.type==='netplay-needed'&&netplay){
     Promise.resolve(netplay.nextFrame(data.frame,sampleNetwork())).then((pads:number[][])=>{
      if(closed)return;
      const occupied=new Set(netplay.room.players.map((p:any)=>p.seat));
      worker?.postMessage({type:'netplay-frame',frame:data.frame,pads:pads.map((pad,index)=>packNetworkPad(pad,occupied.has(index)))});
     }).catch((error:Error)=>{if(!closed){setError(error.message);running=false;worker?.postMessage({type:'netplay-stop'});netplay.fail(error);}});
    }
    if(data.type==='intro'){stopAnnouncer();setStatus('');startAudio();}
    if(data.type==='playable'){playable=true;setStatus('');startAudio();}
    if(data.type==='error'){setError(previous=>previous||data.message);running=false;netplay?.fail(Error(data.message));}
    if(data.type==='log'){console.log('[Melee]',data.text);if(playable&&data.text.includes('[opensmash] destination ready'))setStatus('');}
    if(data.type==='metrics'){
     setFps(playable&&data.completeCombatInterval!==false&&data.combatFrames>0?data.fps:null);frameSamples.push(...data.frameTimes);if(frameSamples.length>36000)frameSamples=frameSamples.slice(-36000);
     (window as any).meleePerformance={frames:data.frames,fps:data.fps,frameTimes:frameSamples};
    }
   };
   await session.ready;if(closed)return;running=true;
   if(!netplay)worker.postMessage({...selection,warmReadyBeforeClick:session.readyAt<=requestedAt});
   if(!netplay)raf=requestAnimationFrame(()=>send());
  }catch(e){if(!closed){setError((e as Error).message);netplay?.fail(e);}}}
  start();
  return()=>{closed=true;abort.abort();cancelAnimationFrame(raf);if(worker)releaseMelee(worker);audioNode?.disconnect();window.removeEventListener('keydown',keydown);window.removeEventListener('keyup',keyup);window.removeEventListener('blur',blur);touch.current.clear();};
 },[fighter,settings,roster,attempt]);
 const control=(label:string,code:string)=><button key={code} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);touch.current.add(code);}} onPointerUp={()=>touch.current.delete(code)} onPointerCancel={()=>touch.current.delete(code)}>{label}</button>;
 return <div className="game-overlay" role="region" aria-label={'Play as '+fighter.name}><section className="game-panel"><header><div><h2>{fighter.name}</h2><p>{names[settings.ports[0].target && settings.ports[0].target !== 'auto' ? settings.ports[0].target : fighter.target]} moveset · {schema.modes.find(m=>m.id===settings.mode)?.label}</p></div><span className="fps" data-slow={fps!==null&&fps<58.5} title="Target: sustained 60 FPS in combat">{fps===null?'':Math.round(fps)+' FPS'}</span><button onClick={()=>{const panel=canvas.current?.closest('.intro-video-frame');if(document.fullscreenElement)void document.exitFullscreen();else void panel?.requestFullscreen();}} aria-label="Toggle fullscreen">⛶</button><button onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();onClose();}} aria-label="Return to roster">✕</button></header><div className="game-screen"><canvas id="canvas" key={attempt} ref={canvas} width={960} height={720} tabIndex={0}/>{status&&!error&&<p className="game-message" role="status">{status}</p>}{error&&<div className="game-message" role="alert"><p>{error}</p>{!(window as any).openSmashNetplay&&<button onClick={()=>{setError('');setStatus('Preparing…');setFps(null);setAttempt(n=>n+1);}}>Try again</button>}</div>}</div><button className="sound-game" onClick={()=>void unlockAudio()}>Enable sound</button><button className="confirm-game" onClick={()=>{if((window as any).openSmashNetplay)networkButtons.current|=0x100;else gameWorker.current?.postMessage({type:'confirm'});}}>Confirm · A</button><p className="game-help">{[keyLabel(kb.up),keyLabel(kb.left),keyLabel(kb.down),keyLabel(kb.right)].join(' ')} move · {keyLabel(kb.a)} attack · {keyLabel(kb.b)} special · {keyLabel(kb.x)} / {keyLabel(kb.y)} jump · {keyLabel(kb.l)} / {keyLabel(kb.r)} shield · {keyLabel(kb.z)} grab · {[kb.cup,kb.cleft,kb.cdown,kb.cright].map(keyLabel).join(' ')} smash · {keyLabel(kb.start)} start / pause<br/>Rebind keys and gamepads under Controls. Press {keyLabel(kb.a)} to confirm any first-run memory card prompt.</p><div className="touch-controls">{control('←',kb.left)}{control('↑',kb.up)}{control('↓',kb.down)}{control('→',kb.right)}{control('Attack',kb.a)}{control('Special',kb.b)}{control('Jump',kb.x)}{control('Shield',kb.l)}{control('Start',kb.start)}</div></section></div>;
}

function meleeFetch(input:string, init?:RequestInit){return fetch(meleePath(input),init);}
