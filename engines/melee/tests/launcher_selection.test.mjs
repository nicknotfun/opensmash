import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLauncherSelection,launchFighter,withOriginalFighters} from '../launcher/launch-plan.mjs';
import schema from '../runtime/launch-options.json' with {type:'json'};
import {planLaunch} from '../runtime/web/launch-options.mjs';
const roster=[{slug:'one',target:'fox'},{slug:'two',target:'mario'}];
test('shared assignments preserve CPU and off slots before human ports',()=>{
 const settings=applyLauncherSelection(structuredClone(schema.defaults),{character:roster[0],picks:[roster[1]],portPlan:[{kind:'cpu'},{kind:'gamepad',index:2},{kind:'none'},{kind:'keyboard'}]});
 const plan=planLaunch(schema,settings,roster[0],roster,()=>0);
 assert.deepEqual(plan.ports.map(p=>p.device),['cpu','gamepad2','off','keyboard']);
 assert.equal(plan.ports[1].character,'one');assert.equal(plan.ports[3].character,'two');
 assert.equal(plan.ports[2].custom,false);
});
test('engine settings and moveset overrides survive shared device translation',()=>{
 const defaults=structuredClone(schema.defaults);defaults.ports[0].target='marth';
 const settings=applyLauncherSelection(defaults,{character:roster[0],portPlan:[{kind:'keyboard'},null,null,{kind:'none'}]});
 assert.equal(settings.ports[0].target,'marth');assert.equal(settings.stage,defaults.stage);
 assert.notEqual(settings.ports,defaults.ports);
});

test('manual opponents follow human picks even when CPUs occupy earlier ports',()=>{
 const settings=applyLauncherSelection(structuredClone(schema.defaults),{character:roster[0],picks:[roster[1]],selectionMode:'full-roster',portPlan:[{kind:'cpu'},{kind:'keyboard'},{kind:'none'},{kind:'none'}]});
 assert.equal(settings.ports[1].character,'one');assert.equal(settings.ports[0].character,'two');
});
test('full-game and character-select actions retain their meaning in Melee',()=>{
 for(const [type,mode] of [['start',4],['select',2]]){
  const settings=applyLauncherSelection(structuredClone(schema.defaults),{type,portPlan:[{kind:'keyboard'},null,null,null]});
  assert.equal(settings.mode,mode);
 }
});


test('explicit original fighters survive custom roster picks and need no costumes',()=>{
 const saved=withOriginalFighters(structuredClone(schema.defaults));
 saved.ports[0].originalCharacter='vanilla:2';
 saved.ports[1].originalCharacter='vanilla:12';
 const before=structuredClone(saved);
 const action={character:roster[0],picks:[roster[1]],selectionMode:'full-roster',
  portPlan:[{kind:'keyboard'},{kind:'gamepad',index:0},{kind:'cpu'},{kind:'cpu'}]};
 const settings=applyLauncherSelection(saved,action);
 const selected=launchFighter(schema,settings,action,roster);
 const plan=planLaunch(schema,settings,selected,roster,()=>0);
 assert.deepEqual(plan.ports.map(port=>port.fighter),[2,12,0,0]);
 assert.equal(plan.ports.every(port=>!port.custom),true);
 assert.deepEqual(plan.costumes,[]);
 assert.equal(selected.name,'Fox');assert.equal(selected.original,true);
 assert.deepEqual(saved,before,'launch translation must not mutate saved settings');
});

test('an original override leaves the other custom selections and controller assignments intact',()=>{
 const saved=structuredClone(schema.defaults);saved.ports[0].originalCharacter='vanilla:8';
 const action={character:roster[0],picks:[roster[1]],selectionMode:'full-roster',
  portPlan:[{kind:'keyboard'},{kind:'gamepad',index:2},{kind:'none'},{kind:'none'}]};
 const settings=applyLauncherSelection(saved,action);
 const plan=planLaunch(schema,settings,launchFighter(schema,settings,action,roster),roster,()=>0);
 assert.deepEqual(plan.ports.map(port=>port.character),['vanilla:8','two','vanilla:2','vanilla:2']);
 assert.deepEqual(plan.ports.map(port=>port.device),['keyboard','gamepad2','off','off']);
 assert.deepEqual(plan.costumes.map(costume=>costume.character),['two']);
});

test('original preset needs no custom catalog and supports the existing direct vanilla selections',()=>{
 const saved=structuredClone(schema.defaults);saved.ports[0].character='vanilla:12';
 const settings=applyLauncherSelection(withOriginalFighters(saved),{});
 const selected=launchFighter(schema,settings,{},[]);
 const plan=planLaunch(schema,settings,selected,[],()=>0);
 assert.equal(selected.name,'Peach');assert.equal(plan.ports[0].fighter,12);
 assert.deepEqual(plan.costumes,[]);assert.equal(saved.ports[0].originalCharacter,undefined);
});

test('invalid original overrides fail before launching or importing',()=>{
 for(const value of ['vanilla:99','vanilla:-1','random','custom',{},null]){
  const saved=structuredClone(schema.defaults);saved.ports[0].originalCharacter=value;
  assert.throws(()=>applyLauncherSelection(saved,{}),/valid original Melee/);
 }
});
