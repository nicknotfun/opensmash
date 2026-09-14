import {samplePorts} from './input.mjs';
import {useEffect,useState} from 'react';
export default function NativeGame({src,onClose,soundOn}){
 const [status,setStatus]=useState('Preparing Smash 64…'),[error,setError]=useState('');
 useEffect(()=>{
  const session=crypto.randomUUID();let closed=false,timer,inputTimer;
  const bridge=window.openSmashDesktop;
  async function start(){
   try{
    const result=await bridge.launch({engine:'ssb64',session,src,soundOn});if(closed)return;setStatus(result.message);
    const plan=JSON.parse(new URL(src,location.origin).searchParams.get('ports')||'[null,null,null,null]');
    inputTimer=setInterval(()=>bridge.input(session,samplePorts(plan,[...(navigator.getGamepads?.()||[])],[...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some(el=>el.getClientRects().length>0))),16);
    const poll=async()=>{try{const state=await bridge.status('ssb64');if(closed)return;setStatus(state.message);if(state.running)timer=setTimeout(poll,500);else clearInterval(inputTimer);}catch(e){if(!closed)setError(e.message);}};void poll();
   }catch(e){if(!closed)setError(e.message);}
  }
  void start();return()=>{closed=true;clearTimeout(timer);clearInterval(inputTimer);void bridge.stop({engine:'ssb64',session});};
 },[src]);
 return <section className="native-engine-status"><h2>Smash 64</h2><p role={error?'alert':'status'}>{error||status}</p><button onClick={onClose}>Return to roster</button></section>;
}
