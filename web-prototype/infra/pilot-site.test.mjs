import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createHash} from "node:crypto";
import {ZipWriter, Uint8ArrayWriter, Uint8ArrayReader} from "@zip.js/zip.js";
import {checkRuntime, checkShaderArchive, runtimeFiles, siteConfiguration} from "./pilot-site.mjs";

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
test("browser Melee full mode needs no legacy game workspace service", () => {
  const browserConfig = {...fullConfig, meleeServiceOrigin: undefined, meleeServiceToken: undefined};
  const {environment, secrets} = siteConfiguration(browserConfig);
  assert.equal(environment.OPENSMASH_NETPLAY_URL, fullConfig.relayOrigin);
  assert.equal(environment.MELEE_SERVICE_ORIGIN, undefined);
  assert.equal(secrets.MELEE_SERVICE_TOKEN, undefined);
  assert.throws(() => siteConfiguration({...browserConfig, meleeServiceOrigin: fullConfig.meleeServiceOrigin}), /meleeServiceToken/);
  assert.throws(() => siteConfiguration({...browserConfig, meleeServiceToken: fullConfig.meleeServiceToken}), /meleeServiceOrigin/);
});
test("Cloudflare TURN requires a public key id and pinned secret reference together", () => {
  const keyId = "a".repeat(32);
  const {environment, secrets} = siteConfiguration({...fullConfig, cloudflareTurnKeyId:keyId, cloudflareTurnSecret:"opensmash-turn:2"});
  assert.equal(environment.CLOUDFLARE_TURN_KEY_ID,keyId);
  assert.equal(environment.CLOUDFLARE_TURN_KEY_API_TOKEN,undefined);
  assert.equal(secrets.CLOUDFLARE_TURN_KEY_API_TOKEN,"opensmash-turn:2");
  for (const override of [
    {cloudflareTurnKeyId:keyId}, {cloudflareTurnSecret:"opensmash-turn:2"},
    {cloudflareTurnKeyId:"bad",cloudflareTurnSecret:"opensmash-turn:2"},
    {cloudflareTurnKeyId:keyId,cloudflareTurnSecret:"opensmash-turn:latest"},
    {cloudflareTurnKeyId:keyId,cloudflareTurnSecret:"raw-secret"},
  ]) assert.throws(()=>siteConfiguration({...fullConfig,...override}),/cloudflareTurn/);
  assert.throws(()=>siteConfiguration({...config,cloudflareTurnKeyId:keyId,cloudflareTurnSecret:"opensmash-turn:2"}),/mode=full/);
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

async function shaderZip(entries, comment) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {useWebWorkers: false});
  for (const [name, data, options = {}] of entries) await writer.add(name, new Uint8ArrayReader(Buffer.from(data)), options);
  return writer.close(comment === undefined ? undefined : Buffer.from(comment));
}

test("shader archives accept only the pinned file names and bytes", async () => {
  const name = "shaders/opengl/default.shader.glsl", data = "void main() {}";
  const expected = {[name]: {size: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex")}};
  assert.deepEqual(await checkShaderArchive(await shaderZip([[name, data]]), expected), {files: 1});
  const cases = [
    [[name, "void fake() {}"]],
    [[name, data], ["BattleShip.o2r", "game-data"]],
    [["../" + name, data]],
    [[name, data, {unixMode: 0o120777}]],
    [],
  ];
  for (const entries of cases) await assert.rejects(checkShaderArchive(await shaderZip(entries), expected));
});

test("shader archives reject bytes outside the ZIP records", async () => {
  const name = "shaders/opengl/default.shader.glsl", data = "void main() {}";
  const expected = {[name]: {size: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex")}};
  const archive = Buffer.from(await shaderZip([[name, data]]));
  const payload = Buffer.from("unclaimed payload");
  // Keep the shader names, contents and checksums intact: otherwise an ordinary
  // content mismatch could mask missing archive-boundary validation.
  await assert.rejects(checkShaderArchive(Buffer.concat([payload, archive]), expected));
  await assert.rejects(checkShaderArchive(Buffer.concat([archive, payload]), expected));
});

test("shader archives reject archive and member comments", async () => {
  const name = "shaders/opengl/default.shader.glsl", data = "void main() {}";
  const expected = {[name]: {size: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex")}};
  await assert.rejects(checkShaderArchive(await shaderZip([[name, data]], "unclaimed payload"), expected), /comment/);
  await assert.rejects(checkShaderArchive(await shaderZip([[name, data, {comment: "unclaimed payload"}]]), expected), /Invalid shader archive entry/);
});

test("shader archives reject unrecognized extra fields", async () => {
  const name = "shaders/opengl/default.shader.glsl", data = "void main() {}";
  const expected = {[name]: {size: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex")}};
  const extraField = new Map([[0xcafe, Buffer.from("unclaimed payload")]]);
  await assert.rejects(checkShaderArchive(await shaderZip([[name, data, {extraField}]]), expected), /Unexpected shader ZIP extra field/);
});

test("runtime preflight does not allow an arbitrary archive renamed to f3d.o2r", async context => {
  const root = await fixture(context);
  await writeFile(path.join(root, "files/f3d.o2r"), await shaderZip([["shaders/opengl/default.shader.glsl", "wrong bytes"]]));
  await assert.rejects(checkRuntime(root), /Unexpected shader file or size|Shader checksum mismatch/);
});
