import {lstat, readFile, readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";

function text(value, name, pattern = /^[^\r\n]+$/) {
  if (typeof value !== "string" || !value || !pattern.test(value)) throw Error(`Invalid or missing ${name}.`);
  return value;
}
function httpsUrl(value, name, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw Error(`${name} must be an HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (originOnly && url.pathname !== "/")) throw Error(`${name} must be an HTTPS ${originOnly ? "origin" : "URL"} without credentials, query or fragment.`);
  return (originOnly ? url.origin : url.href).replace(/\/+$/, "");
}
function secretReference(value, name) {
  return text(value, name, /^[a-zA-Z0-9_-]{1,255}:[1-9][0-9]*$/);
}

// The config contains public client identifiers and Secret Manager references,
// never the values of cookies, Turnstile secrets, or service tokens.
export function siteConfiguration(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw Error("Configuration must be an object.");
  const projectId = text(config.projectId, "projectId", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  const region = text(config.region, "region", /^[a-z]+-[a-z]+[0-9]+$/);
  const siteOrigin = httpsUrl(config.siteOrigin, "siteOrigin", true);
  const assetBaseUrl = httpsUrl(config.assetBaseUrl, "assetBaseUrl");
  const firebase = config.firebase || {};
  const firebaseAuthDomain = text(firebase.authDomain, "firebase.authDomain", /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  const providers = firebase.providers || ["google", "email"];
  if (!Array.isArray(providers) || !providers.length || providers.some(value => !["google", "email", "apple"].includes(value))) throw Error("firebase.providers must contain supported sign-in providers.");
  const mode = config.mode || "site";
  if (!["site", "full"].includes(mode)) throw Error("mode must be site or full.");
  const environment = {
    NODE_ENV: "production", HOST: "0.0.0.0", GOOGLE_CLOUD_PROJECT: projectId,
    CREATION_ENABLED: "0", FIGHTER_WORKER_DISABLED: "1", FIGHTER_EXECUTION_MODE: "local",
    JOB_DATABASE: "local", OBJECT_STORE: "local", HANDOFF_ROOMS: "local",
    FIGHTER_JOBS_ROOT: "/tmp/fighter-jobs", OBJECT_STORE_ROOT: "/tmp/objects",
    BAKED_ASSET_SOURCE: "remote", ASSET_BASE_URL: assetBaseUrl, ALLOWED_ORIGINS: siteOrigin, PUBLIC_ORIGIN: siteOrigin,
    FIREBASE_AUTH_ENABLED: "1", FIREBASE_PROJECT_ID: projectId,
    FIREBASE_API_KEY: text(firebase.apiKey, "firebase.apiKey"),
    FIREBASE_APP_ID: text(firebase.appId, "firebase.appId"),
    FIREBASE_AUTH_DOMAIN: firebaseAuthDomain,
    FIREBASE_AUTH_PROVIDERS: [...new Set(providers)].join("|"),
    TURNSTILE_SITE_KEY: text(config.turnstileSiteKey, "turnstileSiteKey"),
  };
  const secrets = {
    COOKIE_SECRET: secretReference(config.cookieSecret, "cookieSecret (Secret Manager name:version)"),
    TURNSTILE_SECRET_KEY: secretReference(config.turnstileSecret, "turnstileSecret (Secret Manager name:version)"),
  };
  if (mode === "full") {
    const privateBucket = text(config.privateBucket, "privateBucket", /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/);
    const publicBucket = text(config.publicBucket, "publicBucket", /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/);
    if (privateBucket === publicBucket) throw Error("Private and public asset buckets must differ.");
    Object.assign(environment, {
      JOB_DATABASE: "firestore", OBJECT_STORE: "gcs", HANDOFF_ROOMS: "firestore",
      GCS_PRIVATE_BUCKET: privateBucket, GCS_PUBLIC_BUCKET: publicBucket,
      OPENSMASH_NETPLAY_URL: httpsUrl(config.relayOrigin, "relayOrigin", true),
    });
    // Browser-hosted Melee needs only room signaling. Keep the legacy service
    // optional for deployments that still offer custom server-built fighters.
    if (config.meleeServiceOrigin !== undefined || config.meleeServiceToken !== undefined) {
      environment.MELEE_SERVICE_ORIGIN = httpsUrl(config.meleeServiceOrigin, "meleeServiceOrigin", true);
      secrets.MELEE_SERVICE_TOKEN = secretReference(config.meleeServiceToken, "meleeServiceToken (Secret Manager name:version)");
    }
    if (config.cloudflareTurnKeyId !== undefined || config.cloudflareTurnSecret !== undefined) {
      environment.CLOUDFLARE_TURN_KEY_ID = text(config.cloudflareTurnKeyId, "cloudflareTurnKeyId", /^[a-f0-9]{32}$/);
      secrets.CLOUDFLARE_TURN_KEY_API_TOKEN = secretReference(config.cloudflareTurnSecret, "cloudflareTurnSecret (Secret Manager name:version)");
    }
    if (config.fighterWorkerOrigin) {
      secrets.OPENAI_API_KEY = secretReference(config.openaiSecret, "openaiSecret (Secret Manager name:version; required for submission moderation)");
      environment.FIGHTER_EXECUTION_MODE = "cloud-run-service";
      environment.FIGHTER_WORKER_URL = httpsUrl(config.fighterWorkerOrigin, "fighterWorkerOrigin", true);
      environment.FIGHTER_MODERATION_ENABLED = "1";
      environment.CREATION_ENABLED = "1";
    }
  } else if (config.relayOrigin || config.meleeServiceOrigin !== undefined || config.meleeServiceToken !== undefined || config.fighterWorkerOrigin || config.cloudflareTurnKeyId !== undefined || config.cloudflareTurnSecret !== undefined) {
    throw Error("Service origins require mode=full and durable stores.");
  }
  return {projectId, region, siteOrigin, mode, environment, secrets};
}

export const runtimeFiles = Object.freeze([
  "index.html", "BattleShip.js", "BattleShip.wasm", "manifest.json", "rom-extract.js", "torch-worker.js",
]);
// CMake/libarchive adds Unix IDs and timestamps, whose values vary by build.
// Admit only their bounded formats, in both central and local headers. zip.js
// exposes parsed fields and raw length, so no separate ZIP parser is needed.
function checkShaderExtraFields(metadata, name, local = false) {
  let encodedSize = 0;
  for (const [type, {data}] of metadata.extraField || []) {
    const timestamps = type === 0x5455 && data[0] > 0 && data[0] <= 7 &&
      data.length === (local ? 1 + 4 * ((data[0] & 1) + ((data[0] >> 1) & 1) + ((data[0] >> 2) & 1)) : 5);
    const unixIds = type === 0x7875 && data.length === 11 && data[0] === 1 && data[1] === 4 && data[6] === 4;
    if (!timestamps && !unixIds) throw Error(`Unexpected shader ZIP extra field: ${name}`);
    encodedSize += 4 + data.length;
  }
  if (encodedSize !== metadata.extraFieldLength || encodedSize !== metadata.rawExtraField.length) {
    throw Error(`Malformed or duplicate shader ZIP extra field: ${name}`);
  }
}

// f3d.o2r is an archive of open-source renderer shaders. Game archives use
// the same extension, so allow only the exact files/bytes from the pinned source.
export async function checkShaderArchive(data, expectedFiles) {
  if (data.length > 4 * 1024 * 1024) throw Error("Shader archive exceeds its size limit.");
  const {ZipReader, Uint8ArrayReader} = await import("@zip.js/zip.js");
  const directories = new Set();
  for (const name of Object.keys(expectedFiles)) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) directories.add(parent + "/");
  }
  const reader = new ZipReader(new Uint8ArrayReader(data), {
    useWebWorkers: false, strictness: "strict", maxAppendedDataSize: 0, checkOverlappingEntry: true,
  });
  const seen = new Set(), files = new Set();
  try {
    const entries = await reader.getEntries();
    // This small, unsigned archive needs neither ZIP64 nor any comment/signature
    // payload. An ordinary end-of-central-directory record occupies 22 bytes.
    if (reader.comment.length || reader.digitalSignature !== undefined ||
        reader.directoryOffset + reader.directoryLength + 22 !== data.length) {
      throw Error("Unexpected shader ZIP comment, signature or trailing records.");
    }
    if (entries.length > Object.keys(expectedFiles).length + directories.size) throw Error("Unexpected entries in shader archive.");
    let nextOffset = 0;
    for (const entry of entries.sort((a, b) => a.offset - b.offset)) {
      const name = entry.filename;
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (seen.has(name) || entry.encrypted || entry.symlink || entry.zip64 || entry.diskNumberStart !== 0 ||
          entry.rawComment.length || ![0, 8].includes(entry.compressionMethod) ||
          !Buffer.from(entry.rawFilename).equals(Buffer.from(name)) ||
          (kind && kind !== (entry.directory ? 0o040000 : 0o100000))) {
        throw Error(`Invalid shader archive entry: ${name}`);
      }
      if (entry.offset !== nextOffset) throw Error(`Unclaimed data between shader ZIP entries: ${name}`);
      checkShaderExtraFields(entry, name);
      seen.add(name);
      let expected;
      if (entry.directory) {
        if (!directories.has(name) || entry.uncompressedSize !== 0 || entry.compressedSize !== 0 || entry.compressionMethod !== 0) {
          throw Error(`Unexpected shader directory: ${name}`);
        }
        expected = {size: 0};
      } else {
        expected = Object.hasOwn(expectedFiles, name) && expectedFiles[name];
        if (!expected || entry.uncompressedSize !== expected.size) throw Error(`Unexpected shader file or size: ${name}`);
      }
      const hash = createHash("sha256");
      let size = 0;
      // Read directories too: their local headers can otherwise hide extra data.
      await entry.getData(new WritableStream({write(chunk) {
        size += chunk.length;
        if (size > expected.size) throw Error(`Shader data exceeds expected size: ${name}`);
        hash.update(chunk);
      }}), {checkCrc32: true});
      checkShaderExtraFields(entry.localDirectory, name, true);
      const descriptor = entry.localDirectory.dataDescriptor;
      if (descriptor && (descriptor.crc32 !== entry.crc32 || descriptor.compressedSize !== entry.compressedSize ||
          descriptor.uncompressedSize !== entry.uncompressedSize)) throw Error(`Invalid shader ZIP data descriptor: ${name}`);
      nextOffset = entry.localDirectory.dataOffset + entry.compressedSize + (descriptor ? 12 + (descriptor.signature ? 4 : 0) : 0);
      if (size !== expected.size || (!entry.directory && hash.digest("hex") !== expected.sha256)) throw Error(`Shader checksum mismatch: ${name}`);
      if (!entry.directory) files.add(name);
    }
    if (nextOffset !== reader.directoryOffset) throw Error("Unclaimed data before the shader ZIP directory.");
    if (files.size !== Object.keys(expectedFiles).length) throw Error("Shader archive is missing pinned source files.");
  } finally { await reader.close(); }
  return {files: files.size};
}

export async function checkRuntime(root) {
  const seen = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isSymbolicLink()) throw Error(`Runtime context must not contain symlinks: ${relative}`);
      if (entry.isDirectory()) await walk(filename);
      else {
        if (!entry.isFile()) throw Error(`Runtime context contains a non-regular file: ${relative}`);
        const name = relative.split(path.sep).join("/");
        if (name === "files/f3d.o2r") {
          const manifest = JSON.parse(await readFile(new URL("../config/ssb64-f3d-shaders.json", import.meta.url), "utf8"));
          await checkShaderArchive(await readFile(filename), manifest.files);
        } else if (/\.(z64|n64|v64|iso|gcm|o2r)$/i.test(entry.name)) {
          throw Error(`Remove ROM/disc or extracted game archive from runtime context: ${relative}`);
        }
        seen.add(name);
      }
    }
  }
  if (!(await lstat(root)).isDirectory()) throw Error("Runtime context must be a directory.");
  await walk(root);
  for (const filename of runtimeFiles) {
    if (!seen.has(filename) || (await lstat(path.join(root, filename))).size === 0) throw Error(`Missing or empty runtime file: ${filename}`);
  }
  for (const directory of ["files", "torch"]) {
    if (![...seen].some(filename => filename.startsWith(`${directory}/`))) throw Error(`Missing or empty runtime directory: ${directory}`);
  }
  const module = new WebAssembly.Module(await readFile(path.join(root, "BattleShip.wasm")));
  if (!WebAssembly.Module.exports(module).some(entry => entry.name === "port_netplay_version" && entry.kind === "function")) {
    throw Error("BattleShip.wasm lacks the compiled netplay capability export; rebuild the patched engine.");
  }
  return {files: seen.size, netplayExport: true};
}

async function main() {
  const [command, filename] = process.argv.slice(2);
  if (!filename || !["env", "secrets", "check-config", "check-runtime"].includes(command)) throw Error("Usage: node pilot-site.mjs {env|secrets|check-config} config.json | check-runtime /path/to/web-dist");
  if (command === "check-runtime") return console.log(JSON.stringify(await checkRuntime(path.resolve(filename))));
  const config = siteConfiguration(JSON.parse(await readFile(filename, "utf8")));
  if (command === "env") console.log(JSON.stringify(config.environment, null, 2));
  else if (command === "secrets") console.log(Object.entries(config.secrets).map(([key, value]) => `${key}=${value}`).join(","));
  else console.log(JSON.stringify({projectId: config.projectId, region: config.region, siteOrigin: config.siteOrigin, mode: config.mode}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
