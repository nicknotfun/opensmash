import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHost, dolphinPad} from '../public/melee-browser-host-runtime.js';

function fixture({game = {fullCore:true, coreBoot:{accepted:true}}, advance = true, present = true, delayedAudio} = {}) {
  let instance, audio, terminated = 0, closed = 0;
  const pads = [], video = {kind:'video', stop(){this.stopped=true;}}, track = {kind:'audio', stop(){this.stopped=true;}};
  const media = {tracks:[video], getTracks(){return this.tracks;}, addTrack(track){this.tracks.push(track);}};
  const gain = () => ({gain:{value:1}, outputs:[], connect(target){this.outputs.push(target);}, disconnect(){this.outputs=[];}});
  class EmulatorHost {
    constructor(options) {instance=this; this.options=options; this.mode='dolphin'; this.adapter={worker:{terminate(){terminated++;}}, rejectAll(){}};}
    async mountFile(file){this.file=file; return game;}
    start(){if(advance) {this.options.onFrame({mode:'dolphin',frame:1,coreTicks:1,presentedFrame:0}); this.options.onFrame({mode:'dolphin',frame:2,coreTicks:2,presentedFrame:present?1:0});}}
    pause(){}
    setInputState(state, port){pads.push({state,port});}
    mixAudio(){}
    configureAudioWorklet(){}
  }
  class AudioController {
    constructor(){audio=this; this.gain=gain(); this.context={state:'running', destination:{}, createGain:gain,
      createMediaStreamDestination:()=>({stream:{getAudioTracks:()=>[track]}}), close:async()=>{closed++;this.context.state='closed';}};}
    async ensureContext(){await delayedAudio;}
    setSource(source){this.source=source;}
    setTransportBridge(){}
    async setMuted(muted){this.muted=muted;}
    stopPump(){}
  }
  const host = createBrowserHost({EmulatorHost, AudioController, canvas:{captureStream(){return media;}}, timeout:25});
  return {host, pads, media, file:{slice(){}}, get instance(){return instance;}, get audio(){return audio;}, get terminated(){return terminated;}, get closed(){return closed;}};
}

test('GameCube masks, sticks and analog triggers map to the generic controller ABI', () => {
  const mapped = dolphinPad([0x100|0x40|0x10|8, -128,127,-80,80,25,255]);
  assert.deepEqual(mapped, {connected:true, mask:1|32|128|256, stickX:0,stickY:255,cStickX:48,cStickY:208,triggerLeft:25,triggerRight:255,analogA:255,analogB:0});
  assert.equal(dolphinPad([0,0,0,0,0,0,0], false).connected,false);
  assert.throws(()=>dolphinPad([0,128,0,0,0,0,0]),/Invalid/);
});

test('host mounts only the selected File, exposes audio/video and owns four controller ports', async () => {
  const f=fixture();
  const stream=await f.host.load(f.file);
  assert.equal(f.instance.file,f.file);
  assert.deepEqual(stream.getTracks().map(t=>t.kind),['video','audio']);
  for(let port=0;port<4;port++)f.host.setPad(port,[0x100,0,0,0,0,0,0]);
  assert.deepEqual(f.pads.map(p=>p.port),[0,1,2,3]);
  f.host.setMuted(true);
  assert.equal(f.audio.muted,false,'host speaker mute must not silence guests');
  assert.equal(f.audio.gain.outputs[1].gain.value,0);
  f.host.stop();
  assert.equal(f.terminated,1);assert.equal(f.closed,1);
  assert.ok(stream.getTracks().every(track=>track.stopped));
});

test('an accepted mount is insufficient until real game ticks and frames advance', async () => {
  const f=fixture({advance:false});
  await assert.rejects(f.host.load(f.file),/did not produce game frames/);
  assert.ok(f.terminated>0); assert.ok(f.closed>0);
});

test('advancing CPU frames without a working video presenter never become a stream', async () => {
  const f=fixture({present:false});
  await assert.rejects(f.host.load(f.file),/did not produce game frames/);
  assert.ok(f.terminated>0); assert.ok(f.closed>0);
});

test('demo fallback and rejected disc boot never become a playable stream', async () => {
  for(const game of [{fullCore:false,coreBoot:{accepted:true}},{fullCore:true,coreBoot:{accepted:false}}]){
    const f=fixture({game});
    await assert.rejects(f.host.load(f.file),/could not boot/);
    assert.ok(f.terminated>0);
  }
});

test('closing during an asynchronous audio setup never starts a worker later', async () => {
  let ready; const delayedAudio=new Promise(resolve=>{ready=resolve;});
  const f=fixture({delayedAudio});
  const pending=f.host.load(f.file);
  f.host.stop();
  await assert.rejects(pending,/closed/);
  ready();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.instance,undefined);
  assert.equal(f.audio.context.state,'closed');
});
