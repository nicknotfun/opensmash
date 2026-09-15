// Exercises the real React component with a synthetic runtime/ISO inspector.
// This isolates UI lifecycle and iframe input; it does not validate a game ISO
// or emulator boot. host-stream-smoke.mjs covers real network/media transport.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {createServer}=await import(resolve(repo,'web-prototype/node_modules/vite/dist/node/index.js'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const scratch=await mkdtemp(resolve(tmpdir(),'opensmash-stream-ui-'));
let vite,server,browser;
const errors=[];
const html=`<!doctype html><div id="root"></div><script type="module">
import React,{StrictMode,useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import MeleeStreamGame from '/src/MeleeStreamGame.jsx';
window.records=[];window.bootDelay=0;window.failBoot=false;let notify;
const seat=new URLSearchParams(location.search).has('guest')?1:0;
const room={id:'b'.repeat(32),engine:'melee',mode:'host-stream',state:'lobby',players:[{seat:0,generation:1,connected:true}]};
if(seat===1)room.players.push({seat:1,generation:1,connected:true});
window.session={seat,room,token:'fixture',connected:true,closed:false,
 subscribeSignals(){return()=>{};},subscribe(callback){callback({room,connected:this.connected,error:''});return()=>{};},
 async prepare(){records.push({type:'prepare'});room.state='preparing';},async ready(){records.push({type:'ready'});},async start(){records.push({type:'start'});room.state='running';},signal(){throw Error('No guest in UI fixture');}};
function Harness(){const[view,setView]=useState({room,connected:true,error:''});notify=setView;return React.createElement(MeleeStreamGame,{session,view,onLeave:()=>root.unmount(),onRejoin:()=>records.push({type:'rejoin'})});}
window.root=createRoot(document.querySelector('#root'));root.render(React.createElement(StrictMode,null,React.createElement(Harness)));
window.failRoom=()=>{session.closed=true;session.connected=false;notify({room,connected:false,error:'Room disconnected'});};
window.loaded=true;
</script>`;
const runtime=`<!doctype html><canvas id="game" tabindex="0" width="320" height="240"></canvas><input id="editor" placeholder="fixture editor"><script>
const canvas=document.querySelector('canvas');canvas.getContext('2d').fillRect(0,0,320,240);let stream;
setTimeout(()=>{window.openSmashBrowserHost={
 async load(file,status){if(parent.failBoot)throw Error('Synthetic boot failure');parent.records.push({type:'load',name:file.name});status('Fixture loading');await new Promise(resolve=>setTimeout(resolve,parent.bootDelay));stream=canvas.captureStream(30);parent.records.push({type:'loaded'});return stream;},
 setPad(seat,pad,connected=true){parent.records.push({type:'pad',seat,pad:[...pad],connected});},
 setMuted(value){parent.records.push({type:'mute',value});},stop(){parent.records.push({type:'stop'});stream?.getTracks().forEach(track=>track.stop());}};parent.postMessage({type:'opensmash:melee-host-ready'},location.origin);},100);
</script>`;
try{
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'||req.url==='/?guest=1'){res.writeHead(200,{'Content-Type':'text/html'});res.end(await vite.transformIndexHtml('/',html));}
  else if(req.url==='/melee/browser-runtime/index.html'){res.writeHead(200,{'Content-Type':'text/html'});res.end(runtime);}
  else if(req.url==='/api/netplay/ice'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({iceServers:[],relay:false}));}
  else vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 vite=await createServer({root:resolve(repo,'web-prototype'),configFile:resolve(repo,'web-prototype/vite.config.js'),cacheDir:resolve(scratch,'vite'),
  plugins:[{name:'synthetic-ui-disc-fixture',enforce:'pre',resolveId(id){if(id.endsWith('/runtime/web/disc.mjs'))return '\0synthetic-disc';},load(id){if(id==='\0synthetic-disc')return `export async function inspectDisc(file){if(file.name!=='fixture.iso')throw Error('Synthetic fixture only');return{};}`;}}],
  server:{middlewareMode:true,ws:{server},port:server.address().port,fs:{allow:[repo]}}});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{}),args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 const origin='http://127.0.0.1:'+server.address().port;
 await page.goto(origin);await page.waitForFunction(()=>window.loaded);
 const input=page.getByLabel('Melee ISO',{exact:true});await input.waitFor();await page.waitForFunction(()=>{const input=document.querySelector('input[type=file]');return input&&!input.disabled;});
 await page.evaluate(()=>{window.failBoot=true;});await input.setInputFiles({name:'fixture.iso',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic test fixture')});
 await page.getByRole('button',{name:'Reload local engine',exact:true}).click();await page.evaluate(()=>{window.failBoot=false;});await page.waitForFunction(()=>{const input=document.querySelector('input[type=file]');return input&&!input.disabled;});await input.setInputFiles({name:'fixture.iso',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic test fixture')});
 await page.waitForFunction(()=>window.records.some(record=>record.type==='start'));
 await page.evaluate(()=>{window.openSmashControllerRemap={rawGamepads:()=>[{connected:true,id:'idle fixture pad',index:0,axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false,value:0}))}]};});
 const frame=page.frameLocator('iframe');await frame.locator('#game').click();await page.keyboard.down('j');
 await page.waitForFunction(()=>window.records.some(record=>record.type==='pad'&&record.seat===0&&record.pad[0]===0x100));
 await page.keyboard.up('j');await page.waitForFunction(()=>window.records.filter(record=>record.type==='pad').at(-1)?.pad[0]===0);
 await page.keyboard.down('w');await page.waitForFunction(()=>window.records.filter(record=>record.type==='pad').at(-1)?.pad[2]===100);await page.keyboard.up('w');
 await page.evaluate(()=>{window.records=[];});await frame.locator('#editor').fill('jjjj');await page.waitForTimeout(100);
 assert.ok(await page.evaluate(()=>window.records.filter(record=>record.type==='pad').every(record=>record.pad[0]===0)),'typing in an iframe editor does not control the game');
 await page.getByRole('button',{name:'Mute',exact:true}).click();
 await page.waitForFunction(()=>window.records.some(record=>record.type==='mute'&&record.value));
 await page.evaluate(()=>window.failRoom());await page.waitForFunction(()=>window.records.some(record=>record.type==='stop'));
 assert.equal(await page.getByRole('button',{name:'Reconnect stream',exact:true}).count(),0,'no ineffective guest-only reconnect');
 // A pending local load completing after unmount must not prepare/start a room.
 await page.reload();await page.waitForFunction(()=>window.loaded);await page.waitForFunction(()=>{const input=document.querySelector('input[type=file]');return input&&!input.disabled;});await page.evaluate(()=>{window.bootDelay=500;});
 await page.getByLabel('Melee ISO',{exact:true}).setInputFiles({name:'fixture.iso',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic test fixture')});
 await page.waitForFunction(()=>window.records.some(record=>record.type==='load'));
 await page.getByRole('button',{name:'Leave game',exact:true}).click();await page.waitForTimeout(700);
 const cancelled=await page.evaluate(()=>window.records);
 assert.ok(cancelled.some(record=>record.type==='stop'),'unmount stops pending runtime');
 assert.ok(cancelled.every(record=>!['prepare','ready','start'].includes(record.type)),'late boot cannot start a room');
 await page.goto(origin+'/?guest=1');await page.waitForFunction(()=>window.loaded);
 await page.waitForSelector('video');assert.equal(await page.locator('iframe,input[type=file]').count(),0,'guest has no runtime or ISO picker');
 await page.evaluate(()=>window.failRoom());await page.getByRole('button',{name:'Clear old player slot and rejoin',exact:true}).click();
 assert.ok(await page.evaluate(()=>window.records.some(record=>record.type==='rejoin')),'guest recovery invokes room-session rejoin');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,strictMode:true,iframeKeyboard:true,keyboardWithIdleGamepad:true,failedBootRecovery:true,guestRejoinCallback:true,guestHasNoIsoPicker:true,iframeEditableExcluded:true,muting:true,disconnectStopsRuntime:true,lateLoadCancelled:true},null,2));
}finally{await browser?.close();await vite?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true});}
