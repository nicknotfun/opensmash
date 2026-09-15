import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { crc32 } from "node:zlib";

const source = await readFile(new URL("../public/ssb64-netplay.js", import.meta.url), "utf8");
function bridge() {
  const context = vm.createContext({ console, URL, TextEncoder, Uint8Array, Error, Promise });
  vm.runInContext(source, context);
  return context.openSmashSsb64Netplay;
}
const neutral = () => [0, 0, 0, 0, 0, 0, 0];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("simulation waits for complete confirmed frame and never resamples a waiting tick", async () => {
  const api = bridge(), module = { HEAP32: new Int32Array(64) }, calls = [], errors = [];
  let resolveFrame;
  const gate = api.createGate({ module, players: [{ seat: 0 }, { seat: 2 }], sample: () => [0x8000, 80, 0, 0, 0, 0, 0],
    session: { fail: e => errors.push(e), nextFrame: (tick, pad) => { calls.push([tick, pad]); return new Promise(resolve => { resolveFrame = resolve; }); } } });
  // Initial boot can read controls before the first VI: neutral for everybody.
  gate.readPorts(0);
  assert.deepEqual(Array.from(module.HEAP32.slice(0, 8)), [3, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(gate.beforeFrame(0), false);
  for (let retry = 0; retry < 50; retry++) assert.equal(gate.beforeFrame(0), false);
  assert.equal(calls.length, 1);
  const remote = [0x4000, -60, 20, 0, 0, 0, 0];
  resolveFrame([neutral(), neutral(), remote, neutral()]);
  await flush();
  assert.equal(gate.beforeFrame(0), true);
  gate.readPorts(0);
  assert.deepEqual(Array.from(module.HEAP32.slice(8, 12)), [3, 0x4000, -60, 20]);
  // The engine receives committed network input, never the just-sampled local A.
  assert.equal(module.HEAP32[1], 0);
  assert.equal(gate.beforeFrame(1), false);
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 0);
});

test("malformed frames and transport rejection stop simulation without local fallback", async () => {
  for (const response of [Promise.resolve([[1, 2]]), Promise.reject(Error("Disconnected"))]) {
    const errors = [], module = { HEAP32: new Int32Array(16) };
    const gate = bridge().createGate({ module, players: [{ seat: 0 }], sample: neutral,
      session: { nextFrame: () => response, fail: e => errors.push(e) } });
    assert.equal(gate.beforeFrame(0), false);
    await flush();
    assert.equal(gate.beforeFrame(0), false);
    assert.equal(gate.beforeFrame(1), false);
    assert.equal(errors.length, 1);
    gate.readPorts(0);
    assert.equal(module.HEAP32[1], 0);
  }
});

test("out-of-order simulation ticks fail closed", () => {
  const errors = [];
  const gate = bridge().createGate({ module: {}, players: [{ seat: 0 }], sample: neutral,
    session: { nextFrame: () => { throw Error("should not sample"); }, fail: e => errors.push(e) } });
  assert.equal(gate.beforeFrame(1), false);
  assert.match(errors[0].message, /frame order/);
});

test("old wasm is rejected before readiness; common seed and authoritative input precede boot", async () => {
  const api = bridge(), events = [], env = { SSB64_NETPLAY: "1" };
  const session = { room: { config: { seed: 0xf1234567 }, players: [{ seat: 0 }, { seat: 1 }] },
    ready: async hash => events.push(hash), fail() {}, nextFrame() {} };
  await assert.rejects(api.prepare({ module: {}, session }), /multiplayer build/);
  assert.equal(events.length, 0);
  const removed = [];
  const module = { _port_netplay_version: () => 1, HEAP32: new Int32Array(16),
    FS: { analyzePath: path => ({ exists: path === "/opensmash-netplay-save.bin" }), unlink: path => removed.push(path) } };
  await api.prepare({ module, session, env, shell: {}, host: {}, getFingerprint: async () => {
    assert.equal(env.SSB64_LOCKSTEP_SEED, "4045620583");
    assert.equal(env.SSB64_LOCKSTEP, "1");
    assert.equal(env.SSB64_NETPLAY, undefined);
    assert.equal(typeof module.readPorts, "function");
    assert.deepEqual(removed, ["/opensmash-netplay-save.bin"]);
    return "common-assets-hash";
  } });
  assert.deepEqual(events, ["common-assets-hash"]);
});

function zip(entries, timestamp) {
  const locals = [], central = [];
  let offset = 0;
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(text), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(timestamp, 10); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(timestamp, 12); directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const footer = Buffer.alloc(22), table = Buffer.concat(central);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(table.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, footer]);
}

test("independent ROM extractions match despite ZIP timestamps and file order", async () => {
  const api = bridge();
  const digest = async bytes => Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const a = zip([["fighters/fox", "fox-data"], ["stages/dreamland", "stage-data"]], 0x40111111);
  const b = zip([["stages/dreamland", "stage-data"], ["fighters/fox", "fox-data"]], 0x60122222);
  assert.notEqual(await digest(a), await digest(b));
  assert.equal(await api.assetDigest(a, digest), await api.assetDigest(b, digest));
  const changed = zip([["fighters/fox", "different"], ["stages/dreamland", "stage-data"]], 0x40111111);
  assert.notEqual(await api.assetDigest(a, digest), await api.assetDigest(changed, digest));
  await assert.rejects(api.assetDigest(zip([["same", "a"], ["same", "b"]], 0), digest), /duplicate/);
  const truncated = a.subarray(0, a.length - 10);
  await assert.rejects(api.assetDigest(truncated, digest), /archive/);
});

test("local keyboard and standard gamepad normalize into N64 canonical samples", () => {
  const api = bridge();
  const keyboard = api.localPad({}, { controllerPorts: { sampleKeyboard: () => ({ button: 0x8000, sx: 80, sy: -80 }) } });
  assert.deepEqual(Array.from(keyboard), [0x8000, 80, -80, 0, 0, 0, 0]);
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  buttons[0].pressed = true;
  const pad = api.localPad({ navigator: { getGamepads: () => [null, { connected: true, axes: [1, 0, 0, -1], buttons }] } }, {});
  assert.deepEqual(Array.from(pad), [0x8008, 80, 0, 0, 0, 0, 0]);
});

test("runtime, asset and launch changes alter the readiness fingerprint", async () => {
  const api = bridge(), files = new Map([["/BattleShip.o2r", new Uint8Array([1, 2, 3])]]);
  let wasm = new Uint8Array([9, 8, 7]);
  const fs = { readdir: () => [".", "..", "dev", ...[...files.keys()].map(x => x.slice(1))],
    stat: () => ({ mode: 1 }), isDir: () => false, isFile: () => true, readFile: path => files.get(path) };
  const shell = { crypto: webcrypto, document: { scripts: [{ src: "https://game.test/engine/BattleShip.js?v=abc" }] },
    fetch: async () => ({ ok: true, arrayBuffer: async () => wasm }) };
  const env = { SSB64_LOCKSTEP_SEED: "123", SSB64_BOOT_BATTLE: "0,1,4,0" };
  const options = { module: { FS: fs }, shell, env };
  const baseline = await api.fingerprint(options);
  assert.equal(await api.fingerprint(options), baseline);
  env.SSB64_LOCKSTEP_SEED = "124";
  assert.notEqual(await api.fingerprint(options), baseline);
  env.SSB64_LOCKSTEP_SEED = "123";
  wasm = new Uint8Array([1]);
  assert.notEqual(await api.fingerprint(options), baseline);
  wasm = new Uint8Array([9, 8, 7]);
  files.set("/BattleShip.o2r", new Uint8Array([4]));
  assert.notEqual(await api.fingerprint(options), baseline);
});
