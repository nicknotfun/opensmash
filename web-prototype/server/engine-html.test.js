import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { withControllerRemap, withSsb64Netplay } from "./engine-html.js";

test("injects the controller remapper before engine scripts run", () => {
  const html = "<html><head><title>Engine</title></head><body><script>boot()</script></body></html>";
  const result = withControllerRemap(html);
  assert.match(result, /<script src="\/controller-remap\.js"><\/script>/);
  assert.ok(result.indexOf("controller-remap.js") < result.indexOf("</head>"));
  assert.ok(result.indexOf("controller-remap.js") < result.indexOf("boot()"));
});

test("does not inject the remapper twice", () => {
  const html = '<head><script src="/controller-remap.js"></script></head>';
  const result = withControllerRemap(html);
  assert.equal(result.match(/src="\/controller-remap.js"/g).length, 1);
  assert.equal(withControllerRemap(result), result);
});

test("netplay lifecycle hook follows Module and precedes asynchronous engine startup", () => {
  const html = '<html><head></head><body><script>var Module = {}; Promise.resolve().then(boot);</script></body></html>';
  const result = withSsb64Netplay(html);
  assert.ok(result.indexOf('src="/ssb64-netplay.js"') < result.indexOf("var Module"));
  assert.ok(result.indexOf("install(Module") > result.indexOf("var Module"));
  assert.ok(result.indexOf("install(Module") < result.indexOf("</body>"));
  assert.equal(withSsb64Netplay(result), result);
});

test("a missing bridge blocks local startup for a network room", () => {
  const errors = [];
  let started = false;
  const module = { onRuntimeInitialized: () => { started = true; } };
  const html = withSsb64Netplay("<body></body>");
  const inline = [...html.matchAll(/<script>(.*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(inline, { parent: { openSmashNetplay: { fail: e => errors.push(e.message) } }, window: {}, Module: module, Error });
  module.onRuntimeInitialized();
  assert.equal(started, false);
  assert.match(errors[0], /bridge could not load/);
});
