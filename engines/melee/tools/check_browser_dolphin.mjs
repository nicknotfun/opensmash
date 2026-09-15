// Exercise the compiled emulator's four controller ports without a game image.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node check_browser_dolphin.mjs <built-directory>');
const wasm = await readFile(resolve(directory, 'dolphin-core-upstream.wasm'));
const module = await WebAssembly.compile(wasm);
const names = new Set(WebAssembly.Module.exports(module).map(row => row.name));
for (const name of ['OpenSmashControllerPorts', 'SetControllerState', 'OpenSmashReadController'])
  assert(names.has(name), `Missing actual Wasm export ${name}`);
const {default: create} = await import(pathToFileURL(resolve(directory, 'dolphin-core-upstream.js')));
let engine;
try {
  engine = await create({wasmBinary: wasm, noInitialRun: true, print: () => {}, printErr: line => process.stderr.write(line + '\n')});
  assert.equal(engine._OpenSmashControllerPorts(), 4);
  assert.equal(engine._RunWasmJitSmoke(7), 49, 'Dynamic Wasm compilation executes');
  assert.equal(engine._RunPpcWasmAddiSmoke(20, -3), 17, 'Generated PPC arithmetic executes');
  assert.equal(engine._RunPpcWasmStateAddiSmoke(30, 5), 35, 'Generated block shares emulator memory');
  const input = engine._SetControllerState;
  const read = engine._OpenSmashReadController;
  for (let port = 0; port < 4; port++) {
    assert.equal(input(port, 1, 1 << port, 32 + port, 96 + port, 160 + port, 224 + port, 11 + port, 21 + port, 0, 0, port + 1), 1);
  }
  for (let port = 0; port < 4; port++) {
    assert.equal(read(port, 0), 1);
    assert.equal(read(port, 1), 0x100 << port, `Port ${port} button isolation`);
    assert.deepEqual([2, 3, 4, 5, 6, 7].map(field => read(port, field)), [32 + port, 96 + port, 160 + port, 224 + port, 11 + port, 21 + port]);
  }
  assert.equal(input(2, 0, 0xfffff, 255, 255, 255, 255, 255, 255, 255, 255, 99), 1);
  assert.equal(read(2, 0), 0);
  assert.equal(read(2, 1), 0, 'Disconnect releases buttons');
  assert.equal(read(1, 1), 0x200, 'Disconnect preserves other seats');
  assert.equal(input(3, 1, 0, -100, 900, 128, 128, -1, 300, 0, 0, 0), 1);
  assert.equal(read(3, 2), 0);
  assert.equal(read(3, 3), 255);
  assert.equal(read(3, 6), 0);
  assert.equal(read(3, 7), 255);
  assert.equal(input(4, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0), 0);
  assert.equal(read(-1, 0), -1);
  assert.equal(input(0, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0), 0);
  assert.equal(read(0, 1), 0x100, 'Rejected input preserves valid state');
  console.log(JSON.stringify({ok: true, controllerPorts: 4, actualWasm: true, gameDataUsed: false, checks: ['raw exports', 'dynamic JIT', 'shared memory JIT', 'independent pads', 'buttons and analogs', 'disconnect neutralization', 'invalid seats', 'bounds']}));
} finally {
  engine?.PThread?.terminateAllThreads();
}
