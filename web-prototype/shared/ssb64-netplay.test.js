import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { crc32 } from "node:zlib";

const source = await readFile(new URL("../public/ssb64-netplay.js", import.meta.url), "utf8");
function bridge(extra = {}) {
  const context = vm.createContext({ console, URL, TextEncoder, Uint8Array, Error, Promise, ...extra });
  vm.runInContext(source, context);
  return context.openSmashSsb64Netplay;
}
const neutral = () => [0, 0, 0, 0, 0, 0, 0];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const unpaced = { wait: async () => {} };

test("simulation waits for complete confirmed frame and never resamples a waiting tick", async () => {
  const api = bridge(), module = { HEAP32: new Int32Array(64) }, calls = [], errors = [];
  let resolveFrame;
  const gate = api.createGate({ module, clock: unpaced, players: [{ seat: 0 }, { seat: 2 }], sample: () => [0x8000, 80, 0, 0, 0, 0, 0],
    session: { fail: e => errors.push(e), nextFrame: (tick, pad) => { calls.push([tick, pad]); return new Promise(resolve => { resolveFrame = resolve; }); } } });
  // Initial boot can read controls before the first VI: neutral for everybody.
  gate.readPorts(0);
  assert.deepEqual(Array.from(module.HEAP32.slice(0, 8)), [3, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(gate.beforeFrame(0), false);
  const waiting = gate.waitFrame(0);
  for (let retry = 0; retry < 50; retry++) assert.equal(gate.beforeFrame(0), false);
  assert.equal(calls.length, 1);
  const remote = [0x4000, -60, 20, 0, 0, 0, 0];
  resolveFrame([neutral(), neutral(), remote, neutral()]);
  assert.equal(await waiting, true);
  assert.equal(gate.beforeFrame(0), true);
  gate.readPorts(0);
  assert.deepEqual(Array.from(module.HEAP32.slice(8, 12)), [3, 0x4000, -60, 20]);
  // The engine receives committed network input, never the just-sampled local A.
  assert.equal(module.HEAP32[1], 0);
  assert.equal(gate.beforeFrame(1), false);
  assert.equal(calls.length, 1); // The synchronous guard never samples or waits.
  void gate.waitFrame(1);
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 0);
});

test("malformed frames and transport rejection stop simulation without local fallback", async () => {
  for (const response of [Promise.resolve([[1, 2]]), Promise.reject(Error("Disconnected"))]) {
    const errors = [], module = { HEAP32: new Int32Array(16) };
    const gate = bridge().createGate({ module, clock: unpaced, players: [{ seat: 0 }], sample: neutral,
      session: { nextFrame: () => response, fail: e => errors.push(e) } });
    assert.equal(gate.beforeFrame(0), false);
    assert.equal(await gate.waitFrame(0), false);
    assert.equal(gate.beforeFrame(0), false);
    assert.equal(gate.beforeFrame(1), false);
    assert.equal(errors.length, 1);
    gate.readPorts(0);
    assert.equal(module.HEAP32[1], 0);
  }
});

test("out-of-order simulation ticks fail closed", async () => {
  for (const tick of [1, -1, NaN]) {
    const errors = [];
    const gate = bridge().createGate({ module: {}, players: [{ seat: 0 }], sample: neutral,
      session: { nextFrame: () => { throw Error("should not sample"); }, fail: e => errors.push(e) } });
    assert.equal(gate.beforeFrame(tick), false);
    assert.equal(await gate.waitFrame(tick), false);
    assert.match(errors[0].message, /frame order/);
  }
});

test("old wasm is rejected before readiness; common seed and authoritative input precede boot", async () => {
  const api = bridge(), events = [], env = { SSB64_NETPLAY: "1" };
  const session = { room: { config: { seed: 0xf1234567 }, players: [{ seat: 0 }, { seat: 1 }] },
    ready: async hash => events.push(hash), fail() {}, nextFrame() {} };
  await assert.rejects(api.prepare({ module: {}, session }), /multiplayer build/);
  assert.equal(events.length, 0);
  const removed = [];
  await assert.rejects(api.prepare({ module: { _port_netplay_version: () => 1 }, session }), /multiplayer build/);
  const module = { _port_netplay_version: () => 2, HEAP32: new Int32Array(16),
    FS: { analyzePath: path => ({ exists: path === "/opensmash-netplay-save.bin" }), unlink: path => removed.push(path) } };
  await api.prepare({ module, session, env, shell: {}, host: {}, getFingerprint: async () => {
    assert.equal(env.SSB64_LOCKSTEP_SEED, "4045620583");
    assert.equal(env.SSB64_LOCKSTEP, "1");
    assert.equal(env.SSB64_INTERP_FPS, "0");
    assert.equal(env.SSB64_NETPLAY, undefined);
    assert.equal(typeof module.readPorts, "function");
    assert.deepEqual(removed, ["/opensmash-netplay-save.bin"]);
    return "common-assets-hash";
  } });
  assert.deepEqual(events, ["common-assets-hash"]);
});

function fakeTime() {
  let time = 0;
  const timers = [];
  return {
    now: () => time,
    set: value => { time = value; },
    sleep: delay => new Promise(resolve => timers.push({ at: time + Math.max(0, delay), resolve })),
    async next() {
      await flush();
      assert.ok(timers.length, "simulation must schedule a timer without needing a display callback");
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      time = Math.max(time, timer.at);
      timer.resolve();
      await flush();
    },
  };
}

test("60 Hz confirmed simulation advances identically with 30 Hz, 144 Hz, or absent display callbacks", async () => {
  async function run(displayHz) {
    const time = fakeTime(), samples = [], ticks = [], errors = [];
    let rafRequests = 0, latest = -1, nextDisplay = 0, presentations = 0, done = false;
    const api = bridge({ performance: { now: time.now }, setTimeout: (resolve, ms) => { void time.sleep(ms).then(resolve); },
      requestAnimationFrame: () => { rafRequests++; } });
    const module = { HEAP32: new Int32Array(16) };
    const gate = api.createGate({ module, players: [{ seat: 0 }], sample: () => { samples.push(samples.length); return neutral(); },
      session: { fail: error => errors.push(error), nextFrame: async tick => [[tick, 0, 0, 0, 0, 0, 0], neutral(), neutral(), neutral()] } });
    const simulation = (async () => {
      for (let tick = 0; tick < 180; tick++) {
        assert.equal(await gate.waitFrame(tick), true);
        assert.equal(gate.beforeFrame(tick), true);
        gate.readPorts(0);
        ticks.push([tick, module.HEAP32[1], time.now()]);
        latest = tick;
      }
      done = true;
    })();
    for (let iterations = 0; !done && iterations < 1000; iterations++) {
      await time.next();
      // Presentation only observes the latest completed tick; it never
      // requests inputs or advances the game. Infinity means no display.
      if (displayHz) while (nextDisplay <= time.now()) {
        assert.ok(latest < 180);
        presentations++;
        nextDisplay += 1000 / displayHz;
      }
    }
    assert.ok(done);
    await simulation;
    assert.equal(rafRequests, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(samples, Array.from({ length: 180 }, (_, i) => i));
    assert.equal(ticks.length, 180);
    assert.ok(Math.abs(ticks.at(-1)[2] - 179 * 1000 / 60) < 0.001);
    return { ticks, presentations };
  }
  const low = await run(30), high = await run(144), absent = await run(0);
  assert.deepEqual(low.ticks, high.ticks);
  assert.deepEqual(low.ticks, absent.ticks);
  assert.ok(high.presentations > low.presentations);
  assert.equal(absent.presentations, 0);
});

test("long stalls bound catch-up debt and yield tasks without skipping confirmed ticks", async () => {
  const api = bridge(), time = fakeTime(), clock = api.createClock(time), deadlines = [];
  for (let tick = 0; tick < 12; tick++) {
    if (tick === 1) time.set(60000);
    const waiting = clock.wait(tick);
    await time.next();
    await waiting;
    deadlines.push(time.now());
  }
  assert.equal(deadlines.filter(value => value === 60000).length, 2);
  assert.ok(deadlines[3] > 60000);
  assert.ok(deadlines[11] > 60100);
  await assert.rejects(clock.wait(13), /clock order/);
});

test("late confirmation resumes on the timer task while a duplicate wait does not resample", async () => {
  const api = bridge(), time = fakeTime(), errors = [];
  let confirm, samples = 0;
  const session = { fail: error => errors.push(error), nextFrame: () => new Promise(resolve => { confirm = resolve; }) };
  const gate = api.createGate({ module: {}, clock: api.createClock(time), players: [{ seat: 0 }], sample: () => { samples++; return neutral(); }, session });
  const first = gate.waitFrame(0), duplicate = gate.waitFrame(0);
  time.set(250);
  assert.equal(gate.beforeFrame(0), false);
  assert.equal(samples, 1);
  confirm([neutral(), neutral(), neutral(), neutral()]);
  await time.next();
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(time.now(), 250);
  let retried = false;
  const retry = gate.waitFrame(0).then(value => { retried = true; return value; });
  await flush();
  assert.equal(retried, false);
  await time.next();
  assert.equal(await retry, true);
  assert.equal(samples, 1);
  assert.equal(errors.length, 0);
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
