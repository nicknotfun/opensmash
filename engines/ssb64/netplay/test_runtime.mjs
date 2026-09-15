// Optional integration test against the actual compiled browser package.
// OPENSMASH_TEST_ENGINE_ROOT=/path/to/web-dist node --test test_runtime.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import test from "node:test";

const root = process.env.OPENSMASH_TEST_ENGINE_ROOT;
test("compiled browser engine exposes capability and live controller heap views", {
  skip: !root && "Set OPENSMASH_TEST_ENGINE_ROOT to the built web-dist directory.", timeout: 30000,
}, async () => {
  const directory = path.resolve(root), filename = path.join(directory, "BattleShip.js");
  const [glue, wasm] = await Promise.all([readFile(filename, "utf8"), readFile(path.join(directory, "BattleShip.wasm"))]);
  assert.ok(WebAssembly.Module.exports(new WebAssembly.Module(wasm)).some(entry => entry.name === "port_netplay_version" && entry.kind === "function"));
  let native;
  const module = await new Promise((resolve, reject) => {
    const Module = {
      // Package URLs carry ?v=; Node reads the corresponding local file.
      locateFile: name => path.join(directory, name.split("?")[0]),
      noInitialRun: true, print() {}, printErr() {}, onAbort: reject,
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasm, imports).then(({instance}) => {
          native = instance.exports;
          receive(instance);
        }, reject);
        return {};
      },
      onRuntimeInitialized() { resolve(Module); },
    };
    // Execute the generated non-modularized Emscripten shell with its normal
    // Module injection contract. Do not call game main or supply game assets.
    new Function("Module", "require", "__dirname", "__filename", "module", glue)(
      Module, createRequire(import.meta.url), directory, filename, {exports: {}},
    );
  });
  assert.equal(module._port_netplay_version(), 2);
  const checkViews = () => {
    assert.ok(module.HEAPU8 instanceof Uint8Array, "Module.HEAPU8 must be exported");
    assert.ok(module.HEAP32 instanceof Int32Array, "Module.HEAP32 must be exported");
    assert.equal(module.HEAPU8.buffer, module.HEAP32.buffer);
  };
  // These libc functions are raw Wasm exports; the game does not need aliases
  // on Module. Its resize import still refreshes the public Module heap views.
  const checkControllerMemory = () => {
    const pointer = native.malloc(64);
    assert.ok(pointer > 0);
    try {
      module.HEAP32[pointer >>> 2] = 0x12345678;
      assert.deepEqual([...module.HEAPU8.subarray(pointer, pointer + 4)], [0x78, 0x56, 0x34, 0x12]);
    } finally { native.free(pointer); }
  };
  checkViews();
  checkControllerMemory();
  const oldBuffer = module.HEAPU8.buffer, oldBytes = oldBuffer.byteLength;
  // Existing allocations mean requesting the current entire heap must grow it.
  const allocation = native.malloc(oldBytes);
  assert.ok(allocation > 0, "The test must exercise a successful memory growth");
  try {
    checkViews();
    assert.notEqual(module.HEAPU8.buffer, oldBuffer, "Heap exports must refresh after growth");
    assert.ok(module.HEAPU8.byteLength > oldBytes);
    checkControllerMemory();
    assert.equal(module._port_netplay_version(), 2);
  } finally { native.free(allocation); }
});
