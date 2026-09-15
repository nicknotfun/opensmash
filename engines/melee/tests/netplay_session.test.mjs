import test from 'node:test';
import assert from 'node:assert/strict';

test('online claim replaces an already booted standby and waits for its own compatibility barrier', async () => {
  const previous={Worker:globalThis.Worker,location:globalThis.location,crossOriginIsolated:globalThis.crossOriginIsolated};
  const workers=[];
  class Worker extends EventTarget {
    constructor(){super();workers.push(this);}
    postMessage(message){this.start=message;}
    terminate(){this.terminated=true;}
    emit(data){this.dispatchEvent(new MessageEvent('message',{data}));}
  }
  Object.assign(globalThis,{Worker,location:{hostname:'public.example',pathname:'/melee',search:''},crossOriginIsolated:true});
  try {
    const {selectLocalDisc,claimOnlineMelee,releaseMelee}=await import('../web/lib/melee-session.ts');
    const disc=new File(['verified-disc'],'melee.iso');
    const setup=selectLocalDisc(disc),standby=workers.at(-1);
    standby.emit({type:'disc-verified'});
    standby.emit({type:'ready-for-selection'});
    await setup;
    const selection={launch:{mode:0,packedPorts:[8,12,2,9]},costumes:[],cssAssets:[]};
    const online=claimOnlineMelee(123,selection),worker=online.worker;
    assert.notEqual(worker,standby);
    assert.equal(standby.terminated,true);
    assert.deepEqual(worker.start.netplay,{seed:123});
    assert.equal(worker.start.selection,selection);
    assert.equal(worker.start.iso,disc);
    assert.equal(worker.start.discVerified,true);
    let resolved=false;void online.ready.then(()=>{resolved=true;});
    worker.emit({type:'ready-for-selection'});
    await Promise.resolve();assert.equal(resolved,false);
    worker.emit({type:'netplay-ready',fingerprint:'same-assets'});
    await online.ready;assert.equal(resolved,true);
    releaseMelee(worker);assert.equal(worker.terminated,true);
  } finally {Object.assign(globalThis,previous);}
});
