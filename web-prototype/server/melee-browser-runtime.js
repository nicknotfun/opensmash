// The browser runtime contains generic emulator code only. Its complete static
// payload is admitted from a hashed manifest before any file can be served.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = '/melee/browser-runtime/';
const REVISION = '7e38409ace3dda709c178312ff63fd92a3653cc7';
const CORE = 'cores/dolphin/dolphin-core-upstream';
const REQUIRED = [`${CORE}.js`, `${CORE}.wasm`, `${CORE}.build.json`, 'src/core-host.js', 'src/upstream-worker-adapter.js', 'src/upstream-discio-worker.js', 'src/upstream-worker-protocol.js', 'src/audio.js', 'LICENSE', 'SOURCE.md', 'provenance/dolphin-core-abi-v1.json'];
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const TYPES = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8', '.gz': 'application/gzip'};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const allowedName = name => typeof name === 'string' && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) &&
  (REQUIRED.includes(name) || /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(js|css)$/.test(name) || name === 'generic-source.tar.gz');

async function ordinaryPath(filename, directory = false) {
  const absolute = path.resolve(filename);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw Error('Runtime paths must be ordinary files/directories without symlinks.');
  }
  return absolute;
}

async function readOrdinary(filename, limit = MAX_FILE_BYTES) {
  const absolute = await ordinaryPath(filename);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error('Runtime input is not a bounded ordinary file.');
    const data = await handle.readFile();
    if (data.length > limit) throw Error('Runtime file grew beyond its limit.');
    return data;
  } finally { await handle.close(); }
}

async function treeFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error('Runtime tree cannot contain symlinks.');
    if (entry.isDirectory()) result.push(...await treeFiles(root, name));
    else if (entry.isFile()) result.push(name);
    else throw Error('Runtime tree contains a non-file entry.');
    if (result.length > 512) throw Error('Runtime tree has too many files.');
  }
  return result;
}

function readU32(bytes, cursor) {
  let value = 0, shift = 0;
  for (let count = 0; count < 5; count++) {
    if (cursor.at >= bytes.length) throw Error('Truncated Wasm metadata.');
    const byte = bytes[cursor.at++];
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
  throw Error('Invalid Wasm metadata integer.');
}

function exportName(js, publicName, exports) {
  if (exports.some(entry => entry.kind === 'function' && entry.name === publicName)) return publicName;
  // Emscripten may minify the Wasm name, but the public JS ABI is stable. Only
  // accept a direct binding to a real function export, not a text assertion.
  const escaped = publicName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binding = new RegExp(`(?:Module\\[?["']_${escaped}["']\\]?|Module\\._${escaped})\\s*=\\s*wasmExports(?:\\[["']([^"']+)["']\\]|\\.([A-Za-z_$][\\w$]*))`);
  const match = js.match(binding);
  const name = match?.[1] || match?.[2];
  if (!name || !exports.some(entry => entry.kind === 'function' && entry.name === name)) throw Error(`Runtime lacks the ${publicName} export.`);
  return name;
}

export function verifyControllerExports(wasm, js) {
  const module = new WebAssembly.Module(wasm);
  const exports = WebAssembly.Module.exports(module);
  const portsName = exportName(js, 'OpenSmashControllerPorts', exports);
  exportName(js, 'SetControllerState', exports);
  exportName(js, 'OpenSmashReadController', exports);
  const importedFunctions = WebAssembly.Module.imports(module).filter(entry => entry.kind === 'function').length;
  const cursor = {at: 8};
  let targetIndex = -1, targetBody;
  while (cursor.at < wasm.length) {
    const section = wasm[cursor.at++];
    const size = readU32(wasm, cursor);
    const end = cursor.at + size;
    if (section === 7) {
      const count = readU32(wasm, cursor);
      for (let i = 0; i < count; i++) {
        const length = readU32(wasm, cursor);
        const name = wasm.subarray(cursor.at, cursor.at += length).toString('utf8');
        const kind = wasm[cursor.at++];
        const index = readU32(wasm, cursor);
        if (kind === 0 && name === portsName) targetIndex = index - importedFunctions;
      }
    } else if (section === 10) {
      const count = readU32(wasm, cursor);
      for (let i = 0; i < count; i++) {
        const length = readU32(wasm, cursor);
        if (i === targetIndex) targetBody = wasm.subarray(cursor.at, cursor.at + length);
        cursor.at += length;
      }
    }
    cursor.at = end;
  }
  // This capability is deliberately a leaf `return 4`, so verify its actual
  // machine code without starting threads, allocating 1.5 GiB, or booting a ROM.
  if (!targetBody || !['0041040b', '0041040f0b'].includes(targetBody.toString('hex'))) throw Error('Runtime controller capability must return exactly four ports.');
}

export async function validateMeleeBrowserRuntime(root) {
  root = await ordinaryPath(root, true);
  const manifestBytes = await readOrdinary(path.join(root, 'manifest.json'), 256 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.protocol !== 1 || manifest.engine !== 'melee' || manifest.runtime !== 'wasm-dolphin' || manifest.revision !== REVISION || manifest.controllerPorts !== 4 || manifest.containsGameData !== false || manifest.sharedMemoryBytes !== 1610612736 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw Error('Invalid generic Melee runtime manifest or controller capability.');
  const names = Object.keys(manifest.files);
  if (names.length > 511 || REQUIRED.some(name => !names.includes(name)) || names.some(name => !allowedName(name) || !/^[0-9a-f]{64}$/.test(manifest.files[name]))) throw Error('Runtime manifest has missing, private, or unsupported file paths.');
  const actual = await treeFiles(root);
  if (actual.length !== names.length + 1 || actual.some(name => name !== 'manifest.json' && !Object.hasOwn(manifest.files, name))) throw Error('Runtime contains files outside its manifest.');
  const files = new Map([['manifest.json', manifestBytes]]);
  let total = manifestBytes.length;
  for (const name of names) {
    const bytes = await readOrdinary(path.join(root, name));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES || sha256(bytes) !== manifest.files[name]) throw Error('Runtime file checksum or total size is invalid.');
    files.set(name, bytes);
  }
  const record = JSON.parse(files.get(`${CORE}.build.json`).toString('utf8'));
  if (record.controllerPorts !== 4 || record.containsGameData !== false || record.revision !== REVISION || record.artifacts?.['dolphin-core-upstream.wasm'] !== manifest.files[`${CORE}.wasm`] || record.artifacts?.['dolphin-core-upstream.js'] !== manifest.files[`${CORE}.js`]) throw Error('Runtime build record does not match the packaged four-port artifacts.');
  verifyControllerExports(files.get(`${CORE}.wasm`), files.get(`${CORE}.js`).toString('utf8'));
  return {manifest, files, names: ['manifest.json', ...names].sort(), bytes: total};
}

export async function createMeleeBrowserRuntime({root = process.env.OPENSMASH_MELEE_BROWSER_ROOT || '/workspace/melee-browser-runtime', indexFile} = {}) {
  let payload, index, error;
  try {
    payload = await validateMeleeBrowserRuntime(root);
    index = await readOrdinary(indexFile, 1024 * 1024);
  } catch (cause) { error = cause; }
  const available = Boolean(payload && index);
  const respond = (req, res, status, bytes, type) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // The generic core compiles Wasm JIT blocks dynamically and creates module
    // workers. The host owns the same-origin iframe and its local ISO handle.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    res.statusCode = status;
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  return {available, error, async handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://runtime.invalid').pathname; } catch { return false; }
    const api = pathname === '/api/melee/browser';
    if (!api && !pathname.startsWith(BASE_URL)) return false;
    const json = (status, value) => respond(req, res, status, Buffer.from(JSON.stringify(value)), 'application/json; charset=utf-8');
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); json(405, {error: 'Method not allowed.'}); return true; }
    if (api) { json(200, {available, baseUrl: BASE_URL}); return true; }
    if (!available) { json(503, {error: 'Browser Melee runtime is unavailable.'}); return true; }
    const name = pathname.slice(BASE_URL.length) || 'index.html';
    const bytes = name === 'index.html' ? index : payload.files.get(name);
    if (!bytes) { json(404, {error: 'Runtime file not found.'}); return true; }
    respond(req, res, 200, bytes, name === 'index.html' ? 'text/html; charset=utf-8' : TYPES[path.extname(name)] || 'text/plain; charset=utf-8');
    return true;
  }};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'check' || !process.argv[3]) throw Error('Usage: node melee-browser-runtime.js check /path/to/runtime');
    const result = await validateMeleeBrowserRuntime(process.argv[3]);
    console.log(JSON.stringify({files: result.names, bytes: result.bytes, controllerPorts: 4, containsGameData: false}));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
