import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveFighters} from '../launcher/resolve-fighters.mjs';
import {applyLauncherSelection,withOriginalFighters} from '../launcher/launch-plan.mjs';
import schema from '../runtime/launch-options.json' with {type:'json'};

const action={character:{slug:'unavailable',name:'Unused custom'},picks:[{slug:'new-custom',name:'Custom',base:'captain'}],
 selectionMode:'full-roster',portPlan:[{kind:'keyboard'},{kind:'gamepad',index:0},{kind:'none'},{kind:'none'}]};
const signal=()=>new AbortController().signal;

test('original-only lineup makes no source export or converter requests with an empty custom roster',async()=>{
 const settings=applyLauncherSelection(withOriginalFighters(structuredClone(schema.defaults)),action);
 const result=await resolveFighters(action,[],settings,{signal:signal(),fetchImpl:()=>assert.fail('Original fighters must not request custom assets')});
 assert.deepEqual(result.roster,[]);
 assert.deepEqual(result.action,action);
});

test('mixed lineup imports only the custom pick actually used after original overrides',async()=>{
 const saved=structuredClone(schema.defaults);saved.ports[0].originalCharacter='vanilla:8';
 const settings=applyLauncherSelection(saved,action);
 const calls=[];
 const imported={slug:'import-123',name:'Custom',short:'CUSTOM',target:'captain-falcon'};
 const result=await resolveFighters(action,[],settings,{signal:signal(),pathFor:path=>'/melee'+path,
  fetchImpl:async(url,init)=>{
   calls.push({url,body:init.body});
   if(url==='/api/melee/source/new-custom')return Response.json({url:'/engine/character-source/fixture/manifest.json'});
   if(url==='/melee/api/imports')return Response.json({state:'complete',fighter:imported});
   assert.fail('Unexpected conversion request: '+url);
  },origin:'https://smash.not.fun'});
 assert.deepEqual(calls.map(call=>call.url),['/api/melee/source/new-custom','/melee/api/imports']);
 assert.equal(JSON.parse(calls[1].body).target,'captain-falcon');
 assert.equal(JSON.parse(calls[1].body).url,'https://smash.not.fun/engine/character-source/fixture/manifest.json');
 assert.deepEqual(result.roster,[imported]);assert.deepEqual(result.action.picks[0],imported);
 assert.equal(result.action.character.slug,'unavailable','unused custom pick does not require an import');
 const final=applyLauncherSelection(saved,result.action);
 assert.equal(final.ports[0].character,'vanilla:8');assert.equal(final.ports[1].character,imported.slug);
});

test('existing custom roster picks still resolve without re-importing and keep their identity',async()=>{
 const settings=applyLauncherSelection(structuredClone(schema.defaults),action);
 const roster=[{...action.character,target:'mario'},{...action.picks[0],target:'captain-falcon'}];
 const result=await resolveFighters(action,roster,settings,{signal:signal(),fetchImpl:()=>assert.fail('Catalog fighters do not require re-import')});
 assert.deepEqual(result.action,action);assert.deepEqual(result.roster,roster);
});

test('failed used custom source remains an error instead of silently switching to original fighters',async()=>{
 const settings=applyLauncherSelection(structuredClone(schema.defaults),action);
 await assert.rejects(resolveFighters(action,[],settings,{signal:signal(),fetchImpl:async()=>Response.json({error:'Source unavailable'},{status:404})}),/Source unavailable/);
});
