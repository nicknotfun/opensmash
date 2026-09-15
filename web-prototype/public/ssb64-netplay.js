/* Same-origin engine bridge. No transport lives in the iframe: its parent
 * supplies confirmed frames through openSmashNetplay.nextFrame(). */
(function (global) {
  "use strict";
  const VERSION = 1;
  const neutral = () => [0, 0, 0, 0, 0, 0, 0];

  function localPad(host, shell) {
    const pad = [...(host.navigator?.getGamepads?.() || [])].find(p => p?.connected);
    if (!pad) {
      const input = shell.controllerPorts?.sampleKeyboard?.();
      return input ? [input.button, input.sx, input.sy, 0, 0, 0, 0] : neutral();
    }
    // Parent navigator is already processed by OpenSmash's N64 remapper.
    const down = i => pad.buttons[i]?.pressed || pad.buttons[i]?.value > 0.5;
    const axis = i => Number.isFinite(pad.axes[i]) ? Math.max(-1, Math.min(1, pad.axes[i])) : 0;
    let buttons = 0;
    for (const [i, bit] of [[0,0x8000],[1,0x4000],[2,8],[3,8],[4,0x20],[5,0x10],[7,0x10],[6,0x2000],[9,0x1000],[12,0x800],[13,0x400],[14,0x200],[15,0x100]]) if (down(i)) buttons |= bit;
    if (axis(3) < -0.5) buttons |= 8;
    if (axis(3) > 0.5) buttons |= 4;
    if (axis(2) < -0.5) buttons |= 2;
    if (axis(2) > 0.5) buttons |= 1;
    let x = axis(0), y = axis(1), length = Math.hypot(x, y);
    if (length < 0.15) { x = 0; y = 0; }
    else { const scale = Math.min(1, (length - 0.15) / 0.85) / length; x *= scale; y *= scale; }
    return [buttons, Math.round(x * 80), Math.round(-y * 80) || 0, 0, 0, 0, 0];
  }

  function checkedPads(pads) {
    if (!Array.isArray(pads) || pads.length !== 4 || pads.some(p =>
      !Array.isArray(p) || p.length !== 7 || !p.every(Number.isInteger) ||
      p[0] < 0 || p[0] > 65535 || p.slice(1, 5).some(v => v < -128 || v > 127) ||
      p.slice(5).some(v => v < 0 || v > 255))) throw Error("Invalid confirmed Smash 64 frame.");
    return pads.map(p => [...p]);
  }

  function createGate({ module, session, sample, players }) {
    const occupied = new Set(players.map(p => p.seat));
    let current = Array.from({ length: 4 }, neutral), requested = -1, committed = -1, failed = false;
    function fail(error) {
      if (failed) return;
      failed = true;
      session.fail(error instanceof Error ? error : Error(String(error)));
    }
    return {
      enabled: true,
      fail,
      beforeFrame(tick) {
        if (session.closed && !failed) fail(Error(session.error || "This game has ended."));
        if (failed) return false;
        if (committed === tick) return true;
        if (requested === tick) return false;
        if (!Number.isSafeInteger(tick) || tick !== requested + 1) {
          fail(Error("Smash 64 simulation frame order changed."));
          return false;
        }
        requested = tick;
        try {
          Promise.resolve(session.nextFrame(tick, sample())).then(pads => {
            if (failed) return;
            current = checkedPads(pads);
            committed = tick;
          }).catch(fail);
        } catch (error) { fail(error); }
        return false;
      },
      readPorts(ptr) {
        const heap = module.HEAP32, start = ptr >>> 2;
        for (let seat = 0; seat < 4; seat++) {
          const p = failed ? neutral() : current[seat], offset = start + seat * 4;
          heap[offset] = occupied.has(seat) ? 3 : 1; // GAMEPAD or NONE; CPUs have no device.
          heap[offset + 1] = p[0];
          heap[offset + 2] = p[1];
          heap[offset + 3] = p[2];
        }
      },
    };
  }

  async function assetDigest(bytes, digest) {
    // Torch/miniz writes wall-clock DOS timestamps into O2R ZIP headers.
    // Compare named resources, ignoring timestamps and container ordering.
    // The same pinned packer produces identical compressed resource payloads.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) return digest(bytes);
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--) {
      if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
    }
    if (end < Math.max(0, bytes.length - 65557)) throw Error("Invalid game resource archive.");
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count ||
      count === 65535 || start + size > end) throw Error("Unsupported game resource archive.");
    const entries = [], names = new Set();
    let cursor = start;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > start + size || view.getUint32(cursor, true) !== 0x02014b50) throw Error("Invalid resource archive directory.");
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const crc = view.getUint32(cursor + 16, true), compressed = view.getUint32(cursor + 20, true), plain = view.getUint32(cursor + 24, true);
      const length = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true), next = cursor + 46 + length + extra + comment;
      if ((flags & 1) || ![0, 8].includes(method) || next > start + size || local + 30 > start ||
        view.getUint32(local, true) !== 0x04034b50) throw Error("Unsupported resource archive entry.");
      const localLength = view.getUint16(local + 26, true), data = local + 30 + localLength + view.getUint16(local + 28, true);
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + length);
      if (localLength !== length || data + compressed > start ||
        nameBytes.some((value, i) => value !== bytes[local + 30 + i])) throw Error("Invalid resource archive entry.");
      const name = Array.from(nameBytes, b => b.toString(16).padStart(2, "0")).join("");
      if (names.has(name)) throw Error("Ambiguous duplicate resource in game archive.");
      names.add(name);
      entries.push([name, method, plain, crc, await digest(bytes.subarray(data, data + compressed))]);
      cursor = next;
    }
    if (cursor !== start + size) throw Error("Invalid resource archive directory length.");
    entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return digest(new TextEncoder().encode(JSON.stringify(entries)));
  }

  async function fingerprint({ module, shell, env }) {
    const digest = async bytes => Array.from(new Uint8Array(await shell.crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    const fs = module.FS || shell.FS;
    const files = [];
    function visit(dir) {
      for (const name of fs.readdir(dir).sort()) {
        if (name === "." || name === "..") continue;
        const path = (dir === "/" ? "" : dir) + "/" + name;
        // Emscripten's virtual device/proc trees contain live descriptors.
        if (["/dev", "/proc", "/tmp", "/home"].includes(path)) continue;
        const stat = fs.stat(path);
        if (fs.isDir(stat.mode)) visit(path);
        else if (fs.isFile(stat.mode)) files.push(path);
      }
    }
    visit("/");
    const hashes = [];
    // Hash one asset at a time: the ROM archive can be large.
    for (const path of files) hashes.push([path, await assetDigest(fs.readFile(path), digest)]);
    const script = [...shell.document.scripts].find(s => /\/BattleShip\.js(?:\?|$)/.test(s.src));
    if (!script) throw Error("Could not identify the Smash 64 runtime build.");
    const wasmUrl = new URL(script.src.replace(/BattleShip\.js(?=\?|$)/, "BattleShip.wasm"));
    const response = await shell.fetch(wasmUrl);
    if (!response.ok) throw Error("Could not verify the Smash 64 runtime build.");
    const wasm = await digest(await response.arrayBuffer());
    const launch = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("SSB64_")).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    return digest(new TextEncoder().encode(JSON.stringify({ version: VERSION, wasm, hashes, launch })));
  }

  async function prepare({ module, shell, host, session, env, getFingerprint = fingerprint }) {
    if (module._port_netplay_version?.() !== VERSION) throw Error("This Smash 64 engine needs the WebTransport multiplayer build. Rebuild the engine before joining.");
    const seed = session.room?.config?.seed;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error("The room has an invalid random seed.");
    const players = session.room?.players;
    if (!Array.isArray(players) || !players.length || players.some(p => !Number.isInteger(p.seat) || p.seat < 0 || p.seat > 3)) throw Error("The room has invalid player assignments.");
    // These values are set before PortGameInit and before any game RNG calls.
    env.SSB64_LOCKSTEP = "1";
    env.SSB64_LOCKSTEP_SEED = String(seed);
    env.SSB64_VS_INTRO = "0";
    env.SSB64_SAVE_PATH = "/opensmash-netplay-save.bin";
    const fs = module.FS || shell.FS;
    if (fs?.analyzePath(env.SSB64_SAVE_PATH).exists) fs.unlink(env.SSB64_SAVE_PATH);
    for (const key of ["SSB64_REPLAY_PLAY", "SSB64_REPLAY_RECORD", "SSB64_NETPLAY", "SSB64_NETPLAY_BOOTSTRAP"]) delete env[key];
    module.netplay = createGate({ module, session, sample: () => localPad(host, shell), players });
    module.readPorts = ptr => module.netplay.readPorts(ptr);
    const onAbort = module.onAbort;
    module.onAbort = reason => {
      module.netplay.fail(Error("The Smash 64 engine stopped: " + String(reason)));
      onAbort?.(reason);
    };
    await session.ready(await getFingerprint({ module, shell, env }));
    return module.netplay;
  }

  function install(module, environment) {
    let host, session;
    try { host = global.parent; session = host !== global && host.openSmashNetplay; } catch { return; }
    if (!session || module.__openSmashNetplayInstalled) return;
    module.__openSmashNetplayInstalled = true;
    const original = module.onRuntimeInitialized;
    module.onRuntimeInitialized = function () {
      void prepare({ module, shell: global, host, session, env: environment() }).then(() => original?.call(module)).catch(error => {
        module.netplay?.fail(error);
        if (!module.netplay) session.fail(error);
      });
    };
  }

  global.openSmashSsb64Netplay = { install, createGate, prepare, localPad, fingerprint, assetDigest };
})(globalThis);
