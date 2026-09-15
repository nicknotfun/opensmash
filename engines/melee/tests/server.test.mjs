import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createMeleeHandler} from '../server/handler.mjs';

test('private conversion service cannot be exposed in production or pointed at remote hosts',()=>{
 for(const origin of ['https://127.0.0.1','http://example.com','http://localhost/path','http://user:pass@localhost','http://localhost?token=x'])
  assert.throws(()=>createMeleeHandler({origin,production:false}));
 assert.throws(()=>createMeleeHandler({origin:'http://localhost:8781',production:true}));
});
test('namespaced proxy preserves binary streams and strips website credentials',async t=>{
 let received;
 const upstream=http.createServer((req,res)=>{received={url:req.url,headers:req.headers};res.setHeader('Content-Type','application/wasm');res.end(Buffer.from([0,97,115,109]));});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
 const handler=createMeleeHandler({origin:`http://127.0.0.1:${upstream.address().port}`,production:false});
 const server=http.createServer((req,res)=>{if(!handler(req,res)){res.writeHead(404);res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const origin=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(origin+'/melee/engine/module.wasm?v=123',{headers:{cookie:'private=secret',authorization:'Bearer secret','X-OpenSmash-Token':'secret'}});
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,97,115,109]);
 assert.equal(received.url,'/engine/module.wasm?v=123');
 for(const key of ['cookie','authorization','x-opensmash-token'])assert.equal(received.headers[key],undefined);
 assert.equal((await fetch(origin+'/engine/module.wasm')).status,404);
 assert.equal((await fetch(origin+'/melee/api/prepare/a',{method:'POST',headers:{Origin:'https://other.example'}})).status,403);
});

test('hosted gateway exposes only asset and conversion routes',async()=>{
 const {allowedHostedRoute,createMeleeHandler}=await import('../server/handler.mjs');
 for(const route of ['/api/game','/api/game/sys/main.dol','/api/setup','/api/setup/clear','/api/native/launch','/api/debug'])for(const method of ['GET','POST'])assert.equal(allowedHostedRoute(method,route),false,route);
 assert.equal(allowedHostedRoute('POST','/api/prepare/mario'),true);
 assert.equal(allowedHostedRoute('GET','/engine/opensmash-web.wasm'),true);
 assert.throws(()=>createMeleeHandler({serviceOrigin:'https://private.example',serviceToken:'short'}));
});

test('hosted gateway signs guest identities and replaces client-supplied service credentials',async t=>{
 const received=[];
 const upstream=http.createServer((req,res)=>{received.push(req.headers);res.end('{}');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
 const secret='private-gateway-token-'.repeat(3);
 const handler=createMeleeHandler({serviceOrigin:`http://127.0.0.1:${upstream.address().port}`,serviceToken:secret,production:false});
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const origin=`http://127.0.0.1:${server.address().port}`;
 const first=await fetch(origin+'/melee/api/imports',{headers:{'X-OpenSmash-Owner':'forged','X-OpenSmash-Token':'forged',authorization:'Bearer private'}});
 const cookie=first.headers.get('set-cookie').split(';')[0];await first.text();
 const second=await fetch(origin+'/melee/api/imports',{headers:{cookie}});await second.text();
 assert.equal(received[0]['x-opensmash-token'],secret);
 assert.equal(received[0].authorization,undefined);assert.equal(received[0].cookie,undefined);
 assert.match(received[0]['x-opensmash-owner'],/^[a-f0-9]{64}$/);
 assert.equal(received[0]['x-opensmash-owner'],received[1]['x-opensmash-owner']);
 assert.equal((await fetch(origin+'/melee/api/native/status')).status,404);assert.equal(received.length,2);
});


test('PUBLIC_ORIGIN rejects invalid or insecure website configuration',()=>{
 for(const publicOrigin of ['not a URL','http://smash.not.fun','https://user:pass@smash.not.fun','https://smash.not.fun/path','https://smash.not.fun?token=x','https://smash.not.fun#hash']){
  assert.throws(()=>createMeleeHandler({publicOrigin,production:true}),undefined,publicOrigin);
 }
 assert.throws(()=>createMeleeHandler({publicOrigin:'http://localhost:3000',production:true}));
 assert.doesNotThrow(()=>createMeleeHandler({publicOrigin:'http://localhost:3000',production:false}));
 assert.doesNotThrow(()=>createMeleeHandler({publicOrigin:'https://smash.not.fun',production:true}));
});

test('hosted Melee requests use the explicit website origin behind a Cloud Run proxy',async t=>{
 const received=[];
 const upstream=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  received.push({method:req.method,url:req.url,headers:req.headers,body});
  res.setHeader('Set-Cookie','upstream-cookie=must-not-escape');
  res.end('{"prepared":true}');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
 const serviceOrigin=`http://127.0.0.1:${upstream.address().port}`;
 const secret='private-gateway-token-'.repeat(3);
 const handler=createMeleeHandler({serviceOrigin,serviceToken:secret,publicOrigin:'https://smash.not.fun',production:true});
 const server=http.createServer((req,res)=>handler(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/melee/api/prepare/mario?v=2`;
 const response=await fetch(url,{method:'POST',headers:{
  Host:'opensmash-123.us-central1.run.app',
  Origin:'https://smash.not.fun',
  'X-Forwarded-Host':'smash.not.fun',
  'X-Forwarded-Proto':'https',
  Cookie:'opensmash_auth_v1=private-session',
  Authorization:'Bearer private-token',
  'Content-Type':'application/json',
 },body:'{"seed":123}'});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{prepared:true});
 assert.equal(received.length,1);
 assert.equal(received[0].method,'POST');
 assert.equal(received[0].url,'/api/prepare/mario?v=2');
 assert.equal(received[0].body,'{"seed":123}');
 assert.equal(received[0].headers.origin,serviceOrigin);
 assert.equal(received[0].headers.host,new URL(serviceOrigin).host);
 assert.equal(received[0].headers.cookie,undefined);
 assert.equal(received[0].headers.authorization,undefined);
 assert.equal(received[0].headers['x-opensmash-token'],secret);
 assert.match(response.headers.get('set-cookie'),/^opensmash-melee-client=.*; Secure$/);
 assert.doesNotMatch(response.headers.get('set-cookie'),/upstream-cookie/);

 for(const headers of [
  {Host:'opensmash-123.us-central1.run.app',Origin:'https://attacker.example','X-Forwarded-Host':'smash.not.fun'},
  {Host:'attacker.example',Origin:'https://attacker.example','X-Forwarded-Host':'attacker.example'},
  {Host:'opensmash-123.us-central1.run.app',Origin:'https://opensmash-123.us-central1.run.app'},
  {Host:'opensmash-123.us-central1.run.app','X-Forwarded-Host':'smash.not.fun'},
 ]){
  const rejected=await fetch(url,{method:'POST',headers});
  assert.equal(rejected.status,403);await rejected.text();
 }
 assert.equal(received.length,1,'disallowed origins never reach the private service');
});
