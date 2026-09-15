import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createMeleeBrowserRuntime, validateMeleeBrowserRuntime, verifyControllerExports} from './melee-browser-runtime.js';

const revision = '7e38409ace3dda709c178312ff63fd92a3653cc7';
const core = 'cores/dolphin/dolphin-core-upstream';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['src/core-host.js','src/upstream-worker-adapter.js','src/upstream-discio-worker.js','src/upstream-worker-protocol.js','src/audio.js','LICENSE','SOURCE.md','provenance/dolphin-core-abi-v1.json'];
function fixtureWasm(ports = 4) {
  const exports = ['OpenSmashControllerPorts','SetControllerState','OpenSmashReadController'];
  const section = [exports.length];
  for (const name of exports) section.push(name.length,...Buffer.from(name),0,0);
  return Buffer.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,section.length,...section,10,6,1,4,0,65,ports,11]);
}
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(),'melee-runtime-test-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root = path.join(base,'runtime');
  await mkdir(root);
  const contents = Object.fromEntries(names.map(name=>[name,Buffer.from('fixture')]));
  contents[`${core}.wasm`] = fixtureWasm();
  contents[`${core}.js`] = Buffer.from('export default function genericRuntime(){}');
  contents[`${core}.build.json`] = Buffer.from(JSON.stringify({revision,controllerPorts:4,containsGameData:false,artifacts:{'dolphin-core-upstream.js':hash(contents[`${core}.js`]),'dolphin-core-upstream.wasm':hash(contents[`${core}.wasm`])}}));
  const manifest = {protocol:1,engine:'melee',runtime:'wasm-dolphin',revision,controllerPorts:4,containsGameData:false,sharedMemoryBytes:1610612736,files:{}};
  for (const [name,bytes] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root,name)),{recursive:true});
    await writeFile(path.join(root,name),bytes);
    manifest.files[name]=hash(bytes);
  }
  const saveManifest = ()=>writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest));
  await saveManifest();
  const indexFile=path.join(base,'melee-browser-host.html');
  await writeFile(indexFile,'<!doctype html><script type="module" src="/melee-browser-host.js"></script>');
  return {root,base,indexFile,manifest,saveManifest,contents};
}
async function serve(t, runtime) {
  const server=http.createServer(async(req,res)=>{if(!await runtime.handle(req,res)){res.statusCode=404;res.end('Not found');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('verifies actual four-port Wasm capability without booting emulator',()=>{
  verifyControllerExports(fixtureWasm(), '');
  assert.throws(()=>verifyControllerExports(fixtureWasm(1),''),/four ports/);
  assert.throws(()=>verifyControllerExports(Buffer.from('not wasm'),''),WebAssembly.CompileError);
});

test('manifest admits only exact verified generic emulator files',async t=>{
  const f=await fixture(t);
  const validated=await validateMeleeBrowserRuntime(f.root);
  assert.equal(validated.manifest.controllerPorts,4);
  assert.equal(validated.names.length,Object.keys(f.manifest.files).length+1);
  assert.deepEqual(validated.files.get(`${core}.wasm`),f.contents[`${core}.wasm`]);
  await writeFile(path.join(f.root,'private.iso'),'private fixture');
  await assert.rejects(validateMeleeBrowserRuntime(f.root),/outside its manifest/);
});

test('rejects path traversal, symlinks, game data, and unsupported manifest paths',async t=>{
  for(const bad of ['../secret','/secret','src/../secret.js','src/.env.js','game.iso','src/game.iso','source.iso.gz','src\\secret.js']) {
    const f=await fixture(t);
    f.manifest.files[bad]='0'.repeat(64);
    await f.saveManifest();
    await assert.rejects(validateMeleeBrowserRuntime(f.root),/file paths/);
  }
  const f=await fixture(t);
  await rm(path.join(f.root,'src/audio.js'));
  await symlink(f.indexFile,path.join(f.root,'src/audio.js'));
  await assert.rejects(validateMeleeBrowserRuntime(f.root),/symlink/);
  const linked=path.join(f.base,'linked-root');
  await symlink(f.root,linked);
  await assert.rejects(validateMeleeBrowserRuntime(linked),/symlink/);
});

test('rejects changed hashes, stale build records, and single-port manifests',async t=>{
  const changed=await fixture(t);
  await writeFile(path.join(changed.root,'src/audio.js'),'changed');
  await assert.rejects(validateMeleeBrowserRuntime(changed.root),/checksum/);
  const ports=await fixture(t);
  ports.manifest.controllerPorts=1;
  await ports.saveManifest();
  await assert.rejects(validateMeleeBrowserRuntime(ports.root),/manifest/);
  const record=await fixture(t);
  const bytes=Buffer.from(JSON.stringify({controllerPorts:4,revision,containsGameData:false,artifacts:{}}));
  await writeFile(path.join(record.root,`${core}.build.json`),bytes);
  record.manifest.files[`${core}.build.json`]=hash(bytes);
  await record.saveManifest();
  await assert.rejects(validateMeleeBrowserRuntime(record.root),/build record/);
});

test('serves verified bytes and host iframe with required isolation and MIME types',async t=>{
  const f=await fixture(t);
  const runtime=await createMeleeBrowserRuntime(f);
  assert.equal(runtime.available,true);
  const base=await serve(t,runtime);
  const info=await fetch(base+'/api/melee/browser');
  assert.deepEqual(await info.json(),{available:true,baseUrl:'/melee/browser-runtime/'});
  const html=await fetch(base+'/melee/browser-runtime/index.html');
  assert.equal(html.status,200);
  assert.match(await html.text(),/melee-browser-host.js/);
  assert.equal(html.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal(html.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.equal(html.headers.get('cross-origin-embedder-policy'),'require-corp');
  assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  assert.match(html.headers.get('content-type'),/^text\/html/);
  const wasm=await fetch(base+'/melee/browser-runtime/'+core+'.wasm');
  assert.equal(wasm.headers.get('content-type'),'application/wasm');
  assert.deepEqual(Buffer.from(await wasm.arrayBuffer()),f.contents[`${core}.wasm`]);
  const head=await fetch(base+'/melee/browser-runtime/'+core+'.wasm',{method:'HEAD'});
  assert.equal(head.headers.get('content-length'),String(f.contents[`${core}.wasm`].length));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  for (const relative of ['private.iso','src%2faudio.js','%2e%2e%2fsecret']) assert.equal((await fetch(base+'/melee/browser-runtime/'+relative)).status,404);
  assert.equal((await fetch(base+'/melee/browser-runtime/src/audio.js',{method:'POST',body:'private fixture'})).status,405);
  // Bytes were checked and retained before serving; later filesystem mutation
  // cannot switch a public response to an unverified private file.
  await writeFile(path.join(f.root,'src/audio.js'),'unverified changed data');
  assert.equal(await(await fetch(base+'/melee/browser-runtime/src/audio.js')).text(),'fixture');
});

test('missing runtime or symlinked host shell remains unavailable without leaking paths',async t=>{
  const f=await fixture(t);
  const missing=await createMeleeBrowserRuntime({root:path.join(f.base,'missing'),indexFile:f.indexFile});
  const base=await serve(t,missing);
  assert.deepEqual(await(await fetch(base+'/api/melee/browser')).json(),{available:false,baseUrl:'/melee/browser-runtime/'});
  const response=await fetch(base+'/melee/browser-runtime/index.html');
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),new RegExp(f.base));
  const link=path.join(f.base,'linked-index.html');
  await symlink(f.indexFile,link);
  assert.equal((await createMeleeBrowserRuntime({root:f.root,indexFile:link})).available,false);
});
