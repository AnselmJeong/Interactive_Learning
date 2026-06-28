import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.env.INTERACTIVE_LEARNING_PROJECT_ROOT || process.cwd();
const result = spawnSync("uv", ["run", "python", "-m", "learning_backend.cli", "--help"], {
  cwd: join(root, "python"),
  encoding: "utf8",
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

console.log(result.stdout.trim());
