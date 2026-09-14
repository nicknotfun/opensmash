const test=require('node:test'),assert=require('node:assert/strict');
const {parseLaunch}=require('./service.cjs');
test('native launcher accepts only engine URLs and supported option values',()=>{
 assert.equal(parseLaunch('/engine/?SSB64_START_SCENE=16').env.SSB64_START_SCENE,'16');
 for(const url of ['https://other.example/engine/','/api/characters','/engine/?SSB64_START_SCENE=../../file'])assert.throws(()=>parseLaunch(url));
 assert.throws(()=>parseLaunch('/engine/?ports='+encodeURIComponent(JSON.stringify([{kind:'gamepad',index:2},null,null,null]))),/controller assignment/);
});
