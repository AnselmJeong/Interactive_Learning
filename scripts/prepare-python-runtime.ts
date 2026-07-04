import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPlatformName, findExistingPythonExecutable, runtimeBundleName, type RuntimePlatform } from "../src/bun/platform-utils";

type PythonRuntimeInfo = {
  basePrefix: string;
  executable: string;
  major: number;
  minor: number;
  sitePackages: string;
};

const projectRoot = resolve(import.meta.dir, "..");
const pythonRoot = join(projectRoot, "python");
const targetPlatform = (process.env.ELECTROBUN_OS || process.env.LEARNIE_TARGET_OS || process.platform) as RuntimePlatform;
const targetPlatformName = buildPlatformName(targetPlatform);
const targetArch = process.env.ELECTROBUN_ARCH || process.env.LEARNIE_TARGET_ARCH || process.arch;
const venvPython = targetPlatformName === "win32" ? join(pythonRoot, ".venv", "Scripts", "python.exe") : join(pythonRoot, ".venv", "bin", "python");
const targetName = runtimeBundleName(targetPlatform, targetArch);
const bundleRoot = join(pythonRoot, ".bundle", targetName);
const runtimeRoot = join(bundleRoot, "runtime");

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }

  return result.stdout.trim();
}

function ensureVenv() {
  run("uv", ["sync", "--frozen"], { cwd: pythonRoot });
  if (!existsSync(venvPython)) {
    throw new Error(`Python virtualenv was not created at ${venvPython}`);
  }
}

function inspectPython(): PythonRuntimeInfo {
  const script = `
import json
import site
import sys
data = {
    "basePrefix": sys.base_prefix,
    "executable": sys.executable,
    "major": sys.version_info.major,
    "minor": sys.version_info.minor,
    "sitePackages": site.getsitepackages()[0],
}
print(json.dumps(data))
`;
  return JSON.parse(run(venvPython, ["-c", script])) as PythonRuntimeInfo;
}

async function removePythonCaches(root: string) {
  const entries = await readdir(root, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory() && entry.name === "__pycache__") {
        await rm(path, { recursive: true, force: true });
        return;
      }
      if (entry.isDirectory()) {
        await removePythonCaches(path);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".pyc")) {
        await rm(path, { force: true });
      }
    }),
  );
}

async function copyRuntime(info: PythonRuntimeInfo) {
  const bundledSitePackages = targetPlatformName === "win32"
    ? join(runtimeRoot, "Lib", "site-packages")
    : join(runtimeRoot, "lib", `python${info.major}.${info.minor}`, "site-packages");

  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  await cp(info.basePrefix, runtimeRoot, {
    recursive: true,
    filter: (source) => !source.includes("__pycache__") && !source.endsWith(".pyc"),
  });
  await rm(bundledSitePackages, { recursive: true, force: true });
  await cp(info.sitePackages, bundledSitePackages, {
    recursive: true,
    filter: (source) => !source.includes("__pycache__") && !source.endsWith(".pyc"),
  });

  const bundledPython = findExistingPythonExecutable({ pythonRoot, platform: targetPlatform, arch: targetArch, major: info.major, minor: info.minor });
  if (!bundledPython) throw new Error(`Bundled Python executable was not found under ${runtimeRoot}`);
  if (targetPlatformName !== "win32") await chmod(bundledPython, 0o755);
}

async function verifyRuntime(info: PythonRuntimeInfo) {
  const bundledPython = findExistingPythonExecutable({ pythonRoot, platform: targetPlatform, arch: targetArch, major: info.major, minor: info.minor });
  if (!bundledPython) throw new Error(`Bundled Python executable was not found under ${runtimeRoot}`);
  const env = {
    PYTHONPATH: join(pythonRoot, "src"),
    PYTHONDONTWRITEBYTECODE: "1",
  };

  run(
    bundledPython,
    [
      "-c",
      "import click, preppy.cli; print(click.__name__); print(preppy.cli.app.info.name)",
    ],
    { cwd: pythonRoot, env },
  );
}

async function main() {
  ensureVenv();
  await removePythonCaches(join(pythonRoot, "src"));
  const info = inspectPython();
  await copyRuntime(info);
  await verifyRuntime(info);
  console.log(`Prepared packaged Python runtime at ${bundleRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
