import {meleePath} from './paths.ts';
let enabled=true;
let gain:GainNode|undefined;
export function setAudioEnabled(value:boolean){enabled=value;if(gain)gain.gain.value=enabled?1:0;}
let context: AudioContext | undefined;
let ready: Promise<AudioContext> | undefined;
export function unlockAudio() {
  context ??= new AudioContext({sampleRate:48000,latencyHint:'interactive'});
  void context.resume();
  ready ??= context.audioWorklet.addModule(meleePath('/engine/audio-worklet.js')).then(()=>context!);
  return ready;
}
export async function connectAudio(ring:SharedArrayBuffer) {
  const audio = await unlockAudio();
  const node = new AudioWorkletNode(audio,'melee-audio',{outputChannelCount:[2],processorOptions:{ring}});
  gain??=audio.createGain();gain.gain.value=enabled?1:0;gain.disconnect();gain.connect(audio.destination);node.connect(gain);
  return node;
}
