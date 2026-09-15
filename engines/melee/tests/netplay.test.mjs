import test from 'node:test';
import assert from 'node:assert/strict';
import {seededRandom, packNetworkPad, validateFrame, netplayFingerprint} from '../runtime/web/netplay.mjs';

test('signed network sticks and triggers round trip without losing their endpoints', () => {
  assert.deepEqual(packNetworkPad([0x1100,-128,127,0,-1,255,17]), [0x1100,0x7f80ff00,0x11ff,1]);
  assert.deepEqual(packNetworkPad([0,0,0,0,0,0,0],false), [0,0x80808080,0,0]);
  for(const pad of [[0,128,0,0,0,0,0],[0,0,0,0,0,256,0],[0x8000,0,0,0,0,0,0]])
    assert.throws(()=>packNetworkPad(pad));
  const pads=Array.from({length:4},()=>packNetworkPad([0,0,0,0,0,0,0]));
  validateFrame(0,pads);
  assert.throws(()=>validateFrame(1,pads.slice(0,3)));
  assert.throws(()=>validateFrame(-1,pads));
  assert.throws(()=>validateFrame(1,[[0,-1,0,1],...pads.slice(1)]));
});

test('a shared seed resolves the same random choices independently', () => {
  const a=seededRandom(99),b=seededRandom(99),c=seededRandom(100);
  const sequence=()=>Array.from({length:100},()=>a());
  const expected=sequence();
  assert.deepEqual(expected,Array.from({length:100},()=>b()));
  assert.notDeepEqual(expected,Array.from({length:100},()=>c()));
  assert(expected.every(value=>value>=0&&value<1));
});

test('readiness compares actual runtime, disc, launch and staged asset bytes', async () => {
  const launch={mode:0,stage:31,level:5,stocks:4,minutes:8,packedPorts:[8,12,2,9]};
  const input={build:{wasmSha256:'a'.repeat(64)},disc:'b'.repeat(64),system:'d'.repeat(64),seed:23,launch,
    costumes:[{filename:'PlMrNr.dat',blob:new Blob(['model'])}],cssAssets:[]};
  const hash=await netplayFingerprint(input);
  assert.equal(hash.length,64);
  assert.equal(hash,await netplayFingerprint({...input,launch:{...launch,device:'local-only'}}));
  for(const change of [{seed:24},{disc:'c'.repeat(64)},{system:'e'.repeat(64)},{build:{wasmSha256:'c'.repeat(64)}},
      {launch:{...launch,stage:3}}, {costumes:[{filename:'PlMrNr.dat',blob:new Blob(['changed'])}]}])
    assert.notEqual(hash,await netplayFingerprint({...input,...change}));
});
