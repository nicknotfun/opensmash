import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createBitmapPresenter, createBitmapSender} from '../runtime/web/presentation.mjs';

function bitmap(id) {
  return {id, closes:0, close(){this.closes++; assert.equal(this.closes,1,`bitmap ${id} closed twice`);}};
}
function display() {
  let next=0; const pending=new Map(), shown=[];
  const presenter=createBitmapPresenter({
    requestFrame:callback=>{pending.set(++next,callback);return next;},
    cancelFrame:id=>pending.delete(id), present:frame=>shown.push(frame.id),
  });
  return {presenter, shown, pending, paint(){const callbacks=[...pending.values()];pending.clear();callbacks.forEach(callback=>callback());}};
}

test('RAF presents the latest completed image and releases every stale image',()=>{
  const d=display(),frames=Array.from({length:300},(_,i)=>bitmap(i));
  frames.forEach(d.presenter.offer);
  assert.equal(d.pending.size,1);
  assert.deepEqual(d.shown,[]);
  assert(frames.slice(0,-1).every(frame=>frame.closes===1));
  assert.equal(frames.at(-1).closes,0);
  d.paint();assert.deepEqual(d.shown,[299]);assert.equal(d.pending.size,0);
  assert(frames.every(frame=>frame.closes===1));
  d.paint();assert.deepEqual(d.shown,[299]);
});

test('hidden displays and disposal release buffered and late images without scheduling RAF',()=>{
  const d=display(),frames=Array.from({length:5},(_,i)=>bitmap(i));
  d.presenter.offer(frames[0]);d.presenter.setVisible(false);
  d.presenter.offer(frames[1]);assert.equal(d.pending.size,0);
  d.paint();assert.deepEqual(d.shown,[]);
  d.presenter.setVisible(true);assert.equal(d.pending.size,0);
  d.presenter.offer(frames[2]);d.paint();assert.deepEqual(d.shown,[2]);
  d.presenter.offer(frames[3]);d.presenter.dispose();
  d.presenter.offer(frames[4]);assert.equal(d.pending.size,0);
  assert(frames.every(frame=>frame.closes===1));
});

test('a frozen receiver retains only one transfer and the latest replacement, never blocking its producer',()=>{
  const sent=[],sender=createBitmapSender({send:frame=>sent.push(frame)});
  const frames=Array.from({length:500},(_,i)=>bitmap(i));
  frames.forEach(sender.offer);
  assert.equal(sent.length,1);assert.equal(sent[0].bitmap.id,0);
  assert(frames.slice(1,-1).every(frame=>frame.closes===1));
  assert.equal(sender.received(999),false);assert.equal(sent.length,1);
  sent[0].bitmap.close();sender.received(sent[0].id);
  assert.equal(sent.length,2);assert.equal(sent[1].bitmap.id,499);
  assert.equal(sender.received(sent[0].id),false);
  sent[1].bitmap.close();sender.received(sent[1].id);sender.dispose();
  assert(frames.every(frame=>frame.closes===1));
});

test('simulation progresses through the same ticks with slow, fast or absent presentation',()=>{
  const results=[];
  for(const paintEvery of [1,2,4,Infinity]) {
    const d=display(),frames=[];
    const sender=createBitmapSender({send:({id,bitmap})=>{
      d.presenter.offer(bitmap);sender.received(id); // Receipt precedes display.
    }});
    let state=17;
    for(let tick=0;tick<180;tick++) {
      state=(Math.imul(state,1664525)+tick+1013904223)>>>0;
      const frame=bitmap(tick);frames.push(frame);sender.offer(frame);
      if((tick+1)%paintEvery===0)d.paint();
    }
    results.push(state);assert.equal(frames.length,180);
    assert.equal(d.shown.length,Number.isFinite(paintEvery)?180/paintEvery:0);
    sender.dispose();d.presenter.dispose();assert(frames.every(frame=>frame.closes===1));
  }
  assert(results.every(value=>value===results[0]));
});

test('hidden senders discard pending output and resume with a fresh snapshot',()=>{
  const sent=[],sender=createBitmapSender({send:frame=>sent.push(frame)}),frames=Array.from({length:5},(_,i)=>bitmap(i));
  sender.offer(frames[0]);sender.offer(frames[1]);sender.setVisible(false);
  sender.offer(frames[2]);sent[0].bitmap.close();sender.received(sent[0].id);
  assert.equal(sent.length,1);sender.setVisible(true);sender.offer(frames[3]);
  assert.equal(sent[1].bitmap.id,3);sender.offer(frames[4]);sender.dispose();sent[1].bitmap.close();
  assert(frames.every(frame=>frame.closes===1));
});

test('failed transfer and display operations release bitmap ownership',()=>{
  const frame=bitmap(1),sender=createBitmapSender({send:()=>{throw Error('closed channel');}});
  assert.throws(()=>sender.offer(frame),/closed channel/);assert.equal(frame.closes,1);
  let draw;const next=bitmap(2),presenter=createBitmapPresenter({requestFrame:f=>{draw=f;return 1;},cancelFrame:()=>{},present:()=>{throw Error('lost canvas');}});
  presenter.offer(next);assert.throws(()=>draw(),/lost canvas/);assert.equal(next.closes,1);presenter.dispose();
});

test('actual pthread bridge returns image credit at receipt without waiting for display',()=>{
  let receive;const heap=new Uint32Array(new SharedArrayBuffer(16));
  class Worker {addEventListener(type,listener){if(type==='message')receive=listener;}}
  const context={Worker,Module:{},HEAPU32:heap,Atomics};
  runInNewContext(readFileSync(new URL('../runtime/web/register_canvas.js',import.meta.url),'utf8'),context);
  new context.Worker();
  const first=bitmap(1);Atomics.store(heap,1,1);
  receive({data:{cmd:'opensmash-frame',bitmap:first,pending:4},stopImmediatePropagation(){}});
  assert.equal(first.closes,1);assert.equal(Atomics.load(heap,1),0);
  const held=bitmap(2);context.Module.onFrame=frame=>assert.equal(frame,held);Atomics.store(heap,1,1);
  receive({data:{cmd:'opensmash-frame',bitmap:held,pending:4},stopImmediatePropagation(){}});
  assert.equal(held.closes,0);assert.equal(Atomics.load(heap,1),0);held.close();
});
