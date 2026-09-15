import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {checkRuntime, runtimeFiles, siteConfiguration} from "./pilot-site.mjs";

const config = {
  projectId: "nick-smash-pilot", region: "us-central1", siteOrigin: "https://smash.not.fun",
  assetBaseUrl: "https://storage.googleapis.com/example-public-assets",
  firebase: {apiKey: "public-client-key", appId: "1:123:web:abc", authDomain: "nick-smash-pilot.firebaseapp.com"},
  turnstileSiteKey: "public-widget-key", cookieSecret: "opensmash-cookie:1", turnstileSecret: "opensmash-turnstile:2",
};

test("a site-only pilot needs no relay, ROM, Firestore, object bucket or OpenAI key", () => {
  const {environment, secrets} = siteConfiguration(config);
  assert.equal(environment.ASSET_BASE_URL, config.assetBaseUrl);
  assert.equal(environment.PUBLIC_ORIGIN, config.siteOrigin);
  assert.equal(environment.JOB_DATABASE, "local");
  assert.equal(environment.OBJECT_STORE_ROOT, "/tmp/objects");
  assert.equal(environment.CREATION_ENABLED, "0");
  assert.equal(environment.FIGHTER_WORKER_DISABLED, "1");
  assert.equal(environment.FIREBASE_AUTH_ENABLED, "1");
  assert.equal(environment.OPENSMASH_NETPLAY_URL, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.deepEqual(secrets, {COOKIE_SECRET: "opensmash-cookie:1", TURNSTILE_SECRET_KEY: "opensmash-turnstile:2"});
});

const fullConfig = {
  ...config, mode: "full", privateBucket: "nick-smash-private", publicBucket: "nick-smash-public",
  relayOrigin: "https://relay.smash.not.fun", meleeServiceOrigin: "https://melee.smash.not.fun",
  meleeServiceToken: "opensmash-melee-token:1",
};
test("full mode connects durable stores and authenticated services without enabling an absent worker", () => {
  const {environment, secrets} = siteConfiguration(fullConfig);
  assert.equal(environment.JOB_DATABASE, "firestore");
  assert.equal(environment.HANDOFF_ROOMS, "firestore");
  assert.equal(environment.OBJECT_STORE, "gcs");
  assert.equal(environment.OPENSMASH_NETPLAY_URL, fullConfig.relayOrigin);
  assert.equal(environment.MELEE_SERVICE_ORIGIN, fullConfig.meleeServiceOrigin);
  assert.equal(secrets.MELEE_SERVICE_TOKEN, "opensmash-melee-token:1");
  assert.equal(environment.CREATION_ENABLED, "0");
  assert.throws(() => siteConfiguration({...fullConfig, privateBucket: fullConfig.publicBucket}), /must differ/);
  assert.throws(() => siteConfiguration({...fullConfig, meleeServiceToken: undefined}), /meleeServiceToken/);
});
test("creation requires an authenticated worker and a runtime moderation secret reference", () => {
  const {environment, secrets} = siteConfiguration({...fullConfig, fighterWorkerOrigin: "https://worker.example.run.app", openaiSecret: "opensmash-openai:1"});
  assert.equal(environment.CREATION_ENABLED, "1");
  assert.equal(environment.FIGHTER_EXECUTION_MODE, "cloud-run-service");
  assert.equal(environment.FIGHTER_WORKER_AUTH, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(secrets.OPENAI_API_KEY, "opensmash-openai:1");
  assert.throws(() => siteConfiguration({...fullConfig, fighterWorkerOrigin: "https://worker.example.run.app"}), /openaiSecret/);
  assert.throws(() => siteConfiguration({...config, fighterWorkerOrigin: "https://worker.example.run.app"}), /mode=full/);
});

test("production config rejects insecure origins, missing auth, and raw/unpinned secret values", () => {
  for (const override of [
    {siteOrigin: "http://smash.not.fun"}, {siteOrigin: "https://smash.not.fun/path"},
    {assetBaseUrl: "https://user:password@example.com"}, {firebase: {}},
    {cookieSecret: "paste-a-secret-here"}, {cookieSecret: "opensmash-cookie:latest"},
    {turnstileSecret: ""}, {mode: "playable"},
  ]) assert.throws(() => siteConfiguration({...config, ...override}));
});

function capabilityWasm(exportName = "port_netplay_version") {
  // Tiny valid module exporting an i32 function. This exercises real Wasm
  // export parsing instead of searching text for a capability name.
  const exportBytes = Buffer.from(exportName);
  const exportSection = [1, exportBytes.length, ...exportBytes, 0, 0];
  return Buffer.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
    7,exportSection.length,...exportSection,10,6,1,4,0,65,2,11]);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opensmash-pilot-runtime-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  for (const filename of runtimeFiles) await writeFile(path.join(root, filename), filename === "BattleShip.wasm" ? capabilityWasm() : "fixture");
  for (const directory of ["files", "torch"]) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, "module.js"), "fixture");
  }
  return root;
}

test("runtime preflight checks real capability exports and extraction files", async context => {
  const root = await fixture(context);
  assert.equal((await checkRuntime(root)).netplayExport, true);
  await writeFile(path.join(root, "BattleShip.wasm"), capabilityWasm("unpatched"));
  await assert.rejects(checkRuntime(root), /compiled netplay capability/);
  await writeFile(path.join(root, "BattleShip.wasm"), capabilityWasm());
  await rm(path.join(root, "torch-worker.js"));
  await assert.rejects(checkRuntime(root), /Missing or empty runtime file/);
});

test("runtime preflight prevents known ROM archives and symlinks entering an image", async context => {
  const root = await fixture(context);
  const archive = path.join(root, "files", "BattleShip.o2r");
  await writeFile(archive, "fixture");
  await assert.rejects(checkRuntime(root), /Remove ROM\/disc/);
  await rm(archive);
  await symlink(path.join(root, "index.html"), path.join(root, "files", "linked.html"));
  await assert.rejects(checkRuntime(root), /must not contain symlinks/);
});

test("the standalone image copies the shared bridge and Melee browser runtime helpers", async () => {
  const dockerfile = await readFile(new URL("../docker/pilot-api.Dockerfile", import.meta.url), "utf8");
  const ignore = await readFile(new URL("../docker/pilot-api.Dockerfile.dockerignore", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY engines\/melee\/runtime\/web\/\*\.mjs/);
  assert.match(ignore, /!engines\/melee\/runtime\/web\/\*\.mjs/);
  assert.match(ignore, /!web-prototype\/public\/\*\*/);
  assert.match(dockerfile, /test -s dist\/ssb64-netplay\.js/);
  assert.match(dockerfile, /FROM site AS pilot\s*$/);
  assert.doesNotMatch(dockerfile, /COPY (?:pipeline\/|BattleShip\/)/);
});
