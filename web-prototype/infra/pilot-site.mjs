import {lstat, readFile, readdir} from "node:fs/promises";
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
      MELEE_SERVICE_ORIGIN: httpsUrl(config.meleeServiceOrigin, "meleeServiceOrigin", true),
    });
    secrets.MELEE_SERVICE_TOKEN = secretReference(config.meleeServiceToken, "meleeServiceToken (Secret Manager name:version)");
    if (config.fighterWorkerOrigin) {
      secrets.OPENAI_API_KEY = secretReference(config.openaiSecret, "openaiSecret (Secret Manager name:version; required for submission moderation)");
      environment.FIGHTER_EXECUTION_MODE = "cloud-run-service";
      environment.FIGHTER_WORKER_URL = httpsUrl(config.fighterWorkerOrigin, "fighterWorkerOrigin", true);
      environment.FIGHTER_MODERATION_ENABLED = "1";
      environment.CREATION_ENABLED = "1";
    }
  } else if (config.relayOrigin || config.meleeServiceOrigin || config.fighterWorkerOrigin) {
    throw Error("Service origins require mode=full and durable stores.");
  }
  return {projectId, region, siteOrigin, mode, environment, secrets};
}

export const runtimeFiles = Object.freeze([
  "index.html", "BattleShip.js", "BattleShip.wasm", "manifest.json", "rom-extract.js", "torch-worker.js",
]);
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
        if (/\.(z64|n64|v64|iso|gcm|o2r)$/i.test(entry.name)) throw Error(`Remove ROM/disc or extracted game archive from runtime context: ${relative}`);
        seen.add(relative.split(path.sep).join("/"));
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
