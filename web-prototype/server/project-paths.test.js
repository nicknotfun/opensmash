import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveProjectPaths } from "./project-paths.js";

test("project paths support the consolidated local checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opensmash-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "BattleShip", "web-dist"), { recursive: true });

  assert.deepEqual(resolveProjectPaths(path.join(root, "web-prototype"), {}), {
    pipelineProjectRoot: root,
    engineRoot: path.join(root, "BattleShip", "web-dist"),
    pipelineUiRoot: path.join(root, "play", "ui"),
  });
});

test("project paths support the split deployment workspace", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opensmash-paths-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "BattleShip", "web-dist"), { recursive: true });
  const pipelineProjectRoot = path.join(workspace, "pipeline");

  assert.deepEqual(resolveProjectPaths(path.join(pipelineProjectRoot, "web-prototype"), {}), {
    pipelineProjectRoot,
    engineRoot: path.join(workspace, "BattleShip", "web-dist"),
    pipelineUiRoot: path.join(pipelineProjectRoot, "play", "ui"),
  });
});

test("an isolated engine build can be selected without replacing a checkout", () => {
  const root = path.join(os.tmpdir(), "opensmash-engine-selection");
  const output = path.join(root, "build", "ssb64-netplay-source", "web-dist");
  const paths = resolveProjectPaths(path.join(root, "web-prototype"), { OPENSMASH_ENGINE_ROOT: output });
  assert.equal(paths.engineRoot, output);
  assert.equal(paths.pipelineProjectRoot, root);
  assert.equal(paths.pipelineUiRoot, path.join(root, "play", "ui"));
});
