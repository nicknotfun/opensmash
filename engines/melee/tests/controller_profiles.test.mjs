import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,rebindButton,gamepadBindings,loadBindings,nativeBindings,saveBindings} from '../web/lib/controls.ts';
test('controller profiles survive browser index changes and stay separate from N64 remapping',()=>{
 const oldWindow=globalThis.window,oldStorage=globalThis.localStorage;
 const saved=new Map();let pads=[{id:'Xbox',index:3,connected:true},{id:'Sony',index:0,connected:true}];
 globalThis.localStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
 globalThis.window={openSmashControllerRemap:{rawGamepads:()=>pads}};
 try{
  const original=defaults(),edited=rebindButton(original,'a',2,'Xbox');
  assert.equal(gamepadBindings(edited,'Xbox').a,2);
  assert.equal(gamepadBindings(edited,'Xbox').x,0);
  assert.equal(gamepadBindings(edited,'Sony').a,0);
  assert.equal(original.gamepad.a,0);
  saveBindings(edited);assert.equal(loadBindings(),edited);
  assert.equal(nativeBindings().gamepads.gamepad3.a,2);
  pads=[{id:'Xbox',index:1,connected:true}];
  assert.equal(nativeBindings().gamepads.gamepad1.a,2);
  assert.equal(nativeBindings().gamepads.gamepad3,undefined);
 }finally{globalThis.window=oldWindow;globalThis.localStorage=oldStorage;}
});
