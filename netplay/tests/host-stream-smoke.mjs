// Real WebRTC media/input plus production NetplaySession signaling over a
// real Go WebTransport relay, using separate browser processes and generated
// canvas/audio. No game file, emulator binary, or mocked transport is involved.
// Set OPENSMASH_SITE_ORIGIN=https://smash.not.fun to test deployed room APIs,
// relay and authenticated ICE. Live mode only intercepts random fixture paths;
// it uses ordinary TLS and creates/closes its own temporary gameplay room.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import {execFile, spawn} from 'node:child_process';
import {createHash, randomBytes, X509Certificate} from 'node:crypto';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browsers = [], errors = [], pages = new Map();
let liveOrigin;
if (process.env.OPENSMASH_SITE_ORIGIN) {
  const site = new URL(process.env.OPENSMASH_SITE_ORIGIN);
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw Error('OPENSMASH_SITE_ORIGIN must be a plain HTTPS origin.');
  }
  liveOrigin = site.origin;
}
// Only these random fixture paths are intercepted in live mode. Public API,
// relay, and ICE requests use real HTTPS with ordinary browser certificate trust.
const fixtureBase = liveOrigin ? '/__opensmash_stream_smoke_' + randomBytes(8).toString('hex') : '';
let server, relay, relayURL, certificateHash;
let relayLogs = '';
const run = promisify(execFile);
const scratch = await mkdtemp(resolve(tmpdir(), 'opensmash-host-stream-'));
async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function readyRelay(ca) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (relay.exitCode !== null) throw Error(relayLogs || 'Relay stopped');
    try {
      await new Promise((resolve, reject) => {
        const request = https.get(relayURL + '/healthz', {ca,timeout:1000}, response => {
          response.resume(); response.on('end',()=>response.statusCode===200?resolve():reject(Error('Not ready')));
        });
        request.on('error',reject); request.on('timeout',()=>request.destroy(Error('Timeout')));
      }); return;
    } catch {await new Promise(resolve=>setTimeout(resolve,50));}
  }
  throw Error('Relay readiness timeout: ' + relayLogs);
}
const executablePath = process.env.CHROME_BIN || process.env.CHROMIUM_EXECUTABLE;
const html = `<!doctype html><meta charset="utf-8"><canvas id="source" width="320" height="240"></canvas>
<video id="screen" autoplay playsinline></video><script type="module">
import {HostStream} from '${fixtureBase}/shared/host-stream.js';
import {NetplaySession,createGame,joinGame,forgetAccess} from '${fixtureBase}/shared/netplay-client.js';
window.liveSite=${Boolean(liveOrigin)};
window.errors=[];window.pads=[];window.states=[];window.videoFrames=0;window.phase='setup';window.offerDelay=0;
window.setup=async(seat,roomID)=>{
  const certificateHash=window.liveSite?null:await fetch('${fixtureBase}/fixture-certificate').then(response=>response.json());
  window.access=seat===0?await createGame('melee',{seed:123456789},{mode:'host-stream'}):await joinGame(roomID);
  if(access.seat!==seat)throw Error('Unexpected assigned seat');
  window.session=new NetplaySession(access,{transportFactory:url=>certificateHash?new WebTransport(url,{serverCertificateHashes:[{algorithm:'sha-256',value:new Uint8Array(certificateHash)}]}):new WebTransport(url)});
  const options={seat,sendSignal:async(to,signal)=>{if(signal.description?.type==='offer'&&window.offerDelay)await new Promise(resolve=>setTimeout(resolve,window.offerDelay));return session.signal(to,signal);},
    onPad:(seat,pad)=>window.pads.push({seat,pad,at:performance.now()}),
    onState:state=>window.states.push(state),onError:(error,seat)=>window.errors.push({message:error.message,seat,phase:window.phase,errorDetail:error.cause?.errorDetail,sctpCauseCode:error.cause?.sctpCauseCode,causeMessage:error.cause?.message})};
  if(seat===0){
    const canvas=document.querySelector('#source'),ctx=canvas.getContext('2d');let frame=0;
    const paint=()=>{ctx.fillStyle=frame++%30<15?'rgb(230,20,10)':'rgb(10,40,230)';ctx.fillRect(0,0,320,240);};
    paint();window.paintTimer=setInterval(paint,1000/30);const video=canvas.captureStream(30);
    window.audio=new AudioContext({sampleRate:48000});await audio.resume();
    const destination=audio.createMediaStreamDestination(),oscillator=audio.createOscillator(),gain=audio.createGain();
    oscillator.frequency.value=660;gain.gain.value=0.2;oscillator.connect(gain).connect(destination);oscillator.start();
    window.sourceStream=options.stream=new MediaStream([...video.getTracks(),...destination.stream.getTracks()]);
  }else{
    window.audio=new AudioContext();await audio.resume();
    options.onStream=stream=>{
      const video=document.querySelector('#screen');
      if(video.srcObject!==stream){video.srcObject=stream;video.play().catch(error=>window.errors.push({message:error.message}));}
      if(!window.analyser&&stream.getAudioTracks().length){
        window.analyser=audio.createAnalyser();analyser.fftSize=1024;
        const source=audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const gain=audio.createGain();gain.gain.value=0;source.connect(analyser).connect(gain).connect(audio.destination);
      }
    };
    const frame=()=>{window.videoFrames++;document.querySelector('#screen').requestVideoFrameCallback(frame);};
    document.querySelector('#screen').requestVideoFrameCallback(frame);
  }
  await session.connect();
  const connectedBy=performance.now()+10000;
  while(!session.room.players.some(player=>player.seat===seat&&player.connected&&player.generation>0)){
    if(session.closed||performance.now()>connectedBy)throw Error(session.error||'Connected room seat was not published');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(window.liveSite){
    const response=await fetch('/api/netplay/ice',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({room:session.room.id,token:session.token})});
    const ice=await response.json();
    if(!response.ok)throw Error(ice.error||'Live ICE endpoint failed');
    if(!Array.isArray(ice.iceServers)||!ice.iceServers.length||typeof ice.relay!=='boolean')throw Error('Invalid live ICE response');
    for(const server of ice.iceServers){
      const urls=Array.isArray(server.urls)?server.urls:[server.urls];
      if(!urls.length||!urls.every(url=>typeof url==='string'&&/^(stun|stuns|turn|turns):/.test(url)))throw Error('Invalid live ICE server');
    }
    options.iceServers=ice.iceServers;
    // Credential values remain in browser memory and are never printed.
    window.iceReport={authenticated:true,relay:ice.relay,serverCount:ice.iceServers.length};
  }
  window.client=new HostStream(options);
  session.subscribeSignals(message=>client.receiveSignal(message).catch(error=>window.errors.push({message:error.message})));
  const generations=new Map();
  session.subscribe(snapshot=>{
    if(snapshot.error||session.closed){client.close();return;}
    if(!snapshot.connected)return;
    if(seat!==0)return;
    const guests=snapshot.room.players.filter(player=>player.connected&&player.seat!==0);
    for(const previous of generations.keys())if(!guests.some(player=>player.seat===previous)){client.removePeer(previous);generations.delete(previous);}
    for(const player of guests)if(generations.get(player.seat)!==player.generation){
      generations.set(player.seat,player.generation);client.connectGuest(player.seat).catch(error=>window.errors.push({message:error.message}));
    }
  });
  return access.room.id;
};
window.sample=()=>{
  const video=document.querySelector('#screen'),canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
  const ctx=canvas.getContext('2d');if(video.videoWidth)ctx.drawImage(video,0,0,2,2);
  const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3);
  const data=new Float32Array(1024);window.analyser?.getFloatTimeDomainData(data);
  return {rgb,frames:window.videoFrames,audioPeak:Math.max(...data.map(Math.abs)),width:video.videoWidth};
};
window.dispose=async()=>{window.client?.close();window.session?.close();clearInterval(window.paintTimer);window.sourceStream?.getTracks().forEach(t=>t.stop());if(window.audio&&audio.state!=='closed')await audio.close();};
window.loaded=true;
</script>`;
try {
  let origin=liveOrigin, spki;
  const sources = new Map(await Promise.all(['host-stream.js', 'netplay-client.js'].map(async name =>
    [fixtureBase+`/shared/${name}`, await readFile(resolve(repo, 'web-prototype/shared', name))])));
  if(!liveOrigin){
    const certPath=resolve(scratch,'cert.pem'),keyPath=resolve(scratch,'key.pem');
    await run('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
      '-keyout',keyPath,'-out',certPath,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost']);
    const certificate=await readFile(certPath),x509=new X509Certificate(certificate);
    spki=createHash('sha256').update(x509.publicKey.export({type:'spki',format:'der'})).digest('base64');
    certificateHash=[...createHash('sha256').update(x509.raw).digest()];
    const port=await unusedPort();relayURL='https://127.0.0.1:'+port;
    server = http.createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, {'Content-Type':'text/html'}); res.end(html); }
      else if(req.url==='/api/netplay/config'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({enabled:true,relayUrl:relayURL}));}
      else if(req.url==='/fixture-certificate'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(certificateHash));}
      else if (sources.has(req.url)) { res.writeHead(200, {'Content-Type':'application/javascript'}); res.end(sources.get(req.url)); }
      else { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    const relayBinary=resolve(scratch,'relay');
    await run('go',['build','-o',relayBinary,'.'],{cwd:resolve(repo,'netplay/relay'),env:{...process.env,
      GOCACHE:process.env.GOCACHE||resolve(tmpdir(),'opensmash-go-build'),GOMODCACHE:process.env.GOMODCACHE||resolve(tmpdir(),'opensmash-go-mod')}});
    relay=spawn(relayBinary,[],{env:{...process.env,RELAY_ADDR:'127.0.0.1:'+port,
      RELAY_TLS_CERT:certPath,RELAY_TLS_KEY:keyPath,RELAY_ALLOWED_ORIGINS:origin},stdio:['ignore','pipe','pipe']});
    relay.stdout.on('data',data=>{relayLogs=(relayLogs+data).slice(-8192);});
    relay.stderr.on('data',data=>{relayLogs=(relayLogs+data).slice(-8192);});
    await readyRelay(certificate);
  }
  let roomID;
  for (const seat of [0, 1, 2, 3]) {
    const browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {}),
      args:['--no-sandbox','--autoplay-policy=no-user-gesture-required',...(!liveOrigin?['--ignore-certificate-errors-spki-list='+spki]:[])]});
    browsers.push(browser);
    const page = await browser.newPage(); pages.set(seat,page);
    page.on('pageerror', error => errors.push(error.message));
    if(liveOrigin)await page.route(url=>url.origin===liveOrigin&&url.pathname.startsWith(fixtureBase+'/'),async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname===fixtureBase+'/')await route.fulfill({status:200,contentType:'text/html',body:html});
      else if(sources.has(pathname))await route.fulfill({status:200,contentType:'application/javascript',body:sources.get(pathname)});
      else await route.fulfill({status:404,body:'Unknown smoke fixture path'});
    });
    await page.goto(origin+fixtureBase+'/'); await page.waitForFunction(()=>window.loaded);
    const joinedID=await page.evaluate(({seat,roomID})=>window.setup(seat,roomID),{seat,roomID});
    roomID??=joinedID;
    if(seat===0){
      await page.waitForFunction(()=>session.room.players[0].connected);
      await page.evaluate(async()=>{await session.prepare();await session.ready();await session.start();});
      await page.waitForFunction(()=>session.started);
    }
  }
  const host=pages.get(0),guest=pages.get(1);
  const guestPages=[...pages.entries()].filter(([seat])=>seat!==0);
  await Promise.all(guestPages.map(([,page])=>page.waitForFunction(()=>window.states.some(s=>s.state==='connected')&&window.videoFrames>=8&&window.analyser,null,{timeout:20000})));
  const firstFrames=new Map(await Promise.all(guestPages.map(async([seat,page])=>[seat,(await page.evaluate(()=>window.sample())).frames])));
  const samples=[];
  for(let i=0;i<6;i++) { samples.push(await guest.evaluate(()=>window.sample())); await new Promise(resolve=>setTimeout(resolve,180)); }
  assert.ok(samples.every(sample=>sample.width===320),'guest decodes host canvas dimensions');
  assert.ok(samples.at(-1).frames>samples[0].frames+10,'guest decodes changing frames');
  assert.ok(samples.some(a=>samples.some(b=>Math.abs(a.rgb[0]-b.rgb[0])>100)),'received pixels change with host canvas');
  assert.ok(samples.some(sample=>sample.audioPeak>0.05),'received audio contains the generated tone');
  const mediaReports=await Promise.all(guestPages.map(async([seat,page])=>({seat,...await page.evaluate(()=>window.sample())})));
  for(const media of mediaReports){
    assert.equal(media.width,320,'every guest decodes host video');
    assert.ok(media.frames>firstFrames.get(media.seat)+10,'every guest receives advancing frames');
    assert.ok(media.audioPeak>0.05,'every guest decodes game audio');
  }
  const isolatedPads=guestPages.map(([seat])=>({seat,pad:[0x100<<(seat-1),seat*10,-seat*10,seat,-seat,seat*64,0]}));
  await Promise.all(isolatedPads.map(async({seat,pad})=>assert.equal(await pages.get(seat).evaluate(pad=>client.sendPad(pad),pad),true)));
  await host.waitForFunction(expected=>expected.every(({seat,pad})=>window.pads.some(entry=>entry.seat===seat&&JSON.stringify(entry.pad)===JSON.stringify(pad))),isolatedPads);
  // Start a separate timeout measurement after the concurrent seat check.
  await host.evaluate(()=>{window.pads=[];});
  const pad=[0x100,100,-100,30,-30,200,255];
  assert.equal(await guest.evaluate(pad=>client.sendPad(pad),pad),true);
  await host.waitForFunction(pad=>window.pads.some(entry=>JSON.stringify(entry.pad)===JSON.stringify(pad)),pad);
  await host.waitForFunction(()=>window.pads.filter(entry=>entry.seat===1).length>=2&&window.pads.filter(entry=>entry.seat===1).at(-1).pad.every(value=>value===0),{timeout:5000});
  const timeout=await host.evaluate(()=>window.pads.filter(entry=>entry.seat===1).at(-1).at-window.pads.find(entry=>entry.seat===1).at);
  assert.ok(timeout>=300&&timeout<1500,'missing releases neutralize within bounded host timeout');
  assert.equal(await guest.evaluate(pad=>client.sendPad(pad),pad),true);
  await host.waitForFunction(()=>window.pads.filter(entry=>entry.seat===1).at(-1)?.pad[0]===0x100);
  const originalGeneration=await guest.evaluate(()=>session.room.players.find(player=>player.seat===1).generation);
  await Promise.all([host,guest].map(page=>page.evaluate(()=>{window.phase='guest departure';})));
  await guest.evaluate(()=>window.dispose());
  await host.waitForFunction(()=>window.pads.filter(entry=>entry.seat===1).at(-1)?.pad.every(value=>value===0),{timeout:5000});
  await host.waitForFunction(()=>!session.room.players.some(player=>player.seat===1));
  // A replacement guest gets a fresh seat generation and receives a new offer.
  await guest.reload();await guest.waitForFunction(()=>window.loaded);
  await guest.evaluate(roomID=>window.setup(1,roomID),roomID);
  await guest.waitForFunction(()=>window.videoFrames>=8&&client.peers.get(0)?.channel?.readyState==='open');
  assert.ok(await guest.evaluate(()=>session.room.players.find(player=>player.seat===1).generation)>originalGeneration,'rejoin fences the previous seat generation');
  assert.equal(await guest.evaluate(pad=>client.sendPad(pad),pad),true);
  await host.waitForFunction(()=>window.pads.filter(entry=>entry.seat===1).at(-1)?.pad[0]===0x100);
  // Host-triggered reconnect also works without changing room generations.
  const oldID=await host.evaluate(()=>client.peers.get(1).id);
  await Promise.all([host,guest].map(page=>page.evaluate(()=>{window.phase='host reoffer';})));
  await host.evaluate(()=>{window.offerDelay=200;return client.connectGuest(1);});
  await guest.waitForFunction(oldID=>client.peers.get(0)?.id!==oldID&&client.peers.get(0)?.channel?.readyState==='open',oldID);
  assert.equal(await guest.evaluate(pad=>client.sendPad(pad),pad),true);
  await host.waitForFunction(()=>window.pads.filter(entry=>entry.seat===1).at(-1)?.pad[0]===0x100);
  for(const page of pages.values()) errors.push(...await page.evaluate(()=>window.errors));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,browsers:pages.size,guests:guestPages.length,isolatedControllers:true,media:mediaReports.map(({seat,frames,audioPeak})=>({seat,frames,audioPeak})),liveSite:liveOrigin||null,ice:liveOrigin?await Promise.all([...pages.values()].map(page=>page.evaluate(()=>window.iceReport))):undefined,productionGoRelay:true,lateJoin:true,rejoin:true,reoffer:true,videoFrames:samples.at(-1).frames,
    audioPeak:Math.max(...samples.map(sample=>sample.audioPeak)),inputTimeoutMs:Math.round(timeout),
    checks:['decoded changing video','decoded synthetic audio','seat-bound controller packet','lost release neutralization','disconnect neutralization']},null,2));
} finally {
  for(const page of pages.values()) await page.evaluate(()=>window.dispose?.()).catch(()=>{});
  await Promise.all(browsers.map(browser=>browser.close()));
  if(relay&&relay.exitCode===null){
    const exited=once(relay,'exit'),timeout=setTimeout(()=>relay.kill('SIGKILL'),6000);relay.kill('SIGTERM');await exited;clearTimeout(timeout);
  }
  if(server) await new Promise(resolve=>server.close(resolve));
  await rm(scratch,{recursive:true,force:true});
}
