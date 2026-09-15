import { existsSync } from "node:fs";
import path from "node:path";

export function resolveProjectPaths(appRoot, env = process.env) {
  const pipelineProjectRoot = path.resolve(appRoot, "..");
  const localEngineRoot = path.join(pipelineProjectRoot, "BattleShip", "web-dist");
  const workspaceRoot = existsSync(localEngineRoot)
    ? pipelineProjectRoot
    : path.resolve(pipelineProjectRoot, "..");

  return {
    pipelineProjectRoot,
    engineRoot: env.OPENSMASH_ENGINE_ROOT
      ? path.resolve(env.OPENSMASH_ENGINE_ROOT)
      : path.join(workspaceRoot, "BattleShip", "web-dist"),
    pipelineUiRoot: path.join(pipelineProjectRoot, "play", "ui"),
  };
}
