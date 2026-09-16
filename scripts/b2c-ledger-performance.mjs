import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const runner = path.join(scriptDirectory, "b2c-ledger-performance-runner.ts");
const viteNode = path.join(repositoryRoot, "node_modules", ".bin", "vite-node");
const result = spawnSync(viteNode, ["--config", path.join(repositoryRoot, "vitest.config.ts"), runner, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
