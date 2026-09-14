import {useEffect,useState} from 'react';
export default function NativeGame({src,onClose,soundOn}){
 const [status,setStatus]=useState('Preparing Smash 64…'),[error,setError]=useState('');
 useEffect(()=>{
  const session=crypto.randomUUID();let closed=false,timer;
  const bridge=window.openSmashDesktop;
  async function start(){
   try{
    const result=await bridge.launch({engine:'ssb64',session,src,soundOn});if(closed)return;setStatus(result.message);
    const poll=async()=>{try{const state=await bridge.status('ssb64');if(closed)return;setStatus(state.message);if(state.running)timer=setTimeout(poll,500);}catch(e){if(!closed)setError(e.message);}};void poll();
   }catch(e){if(!closed)setError(e.message);}
  }
  void start();return()=>{closed=true;clearTimeout(timer);void bridge.stop({engine:'ssb64',session});};
 },[src]);
 return <section className="native-engine-status"><h2>Smash 64</h2><p role={error?'alert':'status'}>{error||status}</p><button onClick={onClose}>Return to roster</button></section>;
}
