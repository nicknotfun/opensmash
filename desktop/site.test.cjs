const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createSiteHandler}=require('./site.cjs');
test('desktop bundles versioned frontend but preserves website API and account requests',async t=>{
 const dist=await fs.mkdtemp(path.join(os.tmpdir(),'opensmash-site-'));t.after(()=>fs.rm(dist,{recursive:true,force:true}));
 await fs.writeFile(path.join(dist,'index.html'),'<main>bundled</main>');
 const forwarded=[];const handler=createSiteHandler({dist,backend:'http://127.0.0.1:1',token:'private-native-token',fetchRemote:async request=>{forwarded.push(request);return new Response('remote');}});
 const page=await handler(new Request('https://smash.fun/melee'));
 assert.equal(await page.text(),'<main>bundled</main>');assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');
 assert.equal((await handler(new Request('https://smash.fun/app-assets/missing.js'))).status,404);
 await handler(new Request('https://smash.fun/api/session',{headers:{Cookie:'session=website'}}));
 assert.equal(forwarded[0].headers.get('Cookie'),'session=website');assert.equal(forwarded[0].headers.get('X-OpenSmash-Token'),null);
 assert.equal(forwarded.length,1);
});
