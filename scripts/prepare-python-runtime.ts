import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildPlatformName, findExistingPythonExecutable, runtimeBundleName, type RuntimePlatform } from "../src/bun/platform-utils";

type PythonRuntimeInfo = {
  basePrefix: string;
  executable: string;
  major: number;
  minor: number;
  sitePackages: string;
};

type RuntimeBundleManifest = {
  schemaVersion: 1;
  targetName: string;
  targetPlatformName: string;
  targetArch: string;
  dependencyHash: string;
  basePrefix: string;
  major: number;
  minor: number;
  preparedAt: string;
};

const MANIFEST_SCHEMA_VERSION = 1;
const PREPARE_SCRIPT_VERSION = 2;
const projectRoot = resolve(import.meta.dir, "..");
const pythonRoot = join(projectRoot, "python");
const targetPlatform = (process.env.ELECTROBUN_OS || process.env.LEARNIE_TARGET_OS || process.platform) as RuntimePlatform;
const targetPlatformName = buildPlatformName(targetPlatform);
const targetArch = process.env.ELECTROBUN_ARCH || process.env.LEARNIE_TARGET_ARCH || process.arch;
const venvPython = targetPlatformName === "win32" ? join(pythonRoot, ".venv", "Scripts", "python.exe") : join(pythonRoot, ".venv", "bin", "python");
const targetName = runtimeBundleName(targetPlatform, targetArch);
const bundleRoot = join(pythonRoot, ".bundle", targetName);
const runtimeRoot = join(bundleRoot, "runtime");
const manifestPath = join(bundleRoot, "runtime-manifest.json");
const forceRuntimePrepare = process.argv.includes("--force")
  || process.env.LEARNIE_PYTHON_RUNTIME_FORCE === "1"
  || process.env.LEARNIE_PYTHON_RUNTIME_FORCE === "true";

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

async function hashFile(hasher: ReturnType<typeof createHash>, path: string) {
  hasher.update(`file:${path}\0`);
  hasher.update(await readFile(path));
  hasher.update("\0");
}

async function runtimeDependencyHash() {
  const hasher = createHash("sha256");
  hasher.update(`prepare-script:${PREPARE_SCRIPT_VERSION}\0`);
  hasher.update(`target:${targetName}\0`);
  // python/src is copied separately by Electrobun, so source-only edits should not rebuild the runtime bundle.
  await hashFile(hasher, join(pythonRoot, "pyproject.toml"));
  await hashFile(hasher, join(pythonRoot, "uv.lock"));
  return hasher.digest("hex");
}

function sitePackagesPath(info: Pick<PythonRuntimeInfo, "major" | "minor">) {
  return targetPlatformName === "win32"
    ? join(runtimeRoot, "Lib", "site-packages")
    : join(runtimeRoot, "lib", `python${info.major}.${info.minor}`, "site-packages");
}

function baseSitePackagesPath(info: Pick<PythonRuntimeInfo, "basePrefix" | "major" | "minor">) {
  return targetPlatformName === "win32"
    ? join(info.basePrefix, "Lib", "site-packages")
    : join(info.basePrefix, "lib", `python${info.major}.${info.minor}`, "site-packages");
}

function isPathAtOrInside(path: string, parent: string) {
  const childPath = resolve(path);
  const parentPath = resolve(parent);
  const pathRelativeToParent = relative(parentPath, childPath);
  return pathRelativeToParent === "" || (!pathRelativeToParent.startsWith("..") && !isAbsolute(pathRelativeToParent));
}

async function readRuntimeManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeBundleManifest;
  } catch {
    return null;
  }
}

async function runtimeBundleIsReusable(dependencyHash: string) {
  if (forceRuntimePrepare) return false;
  const manifest = await readRuntimeManifest();
  if (!manifest) return false;
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.targetName !== targetName ||
    manifest.targetPlatformName !== targetPlatformName ||
    manifest.targetArch !== targetArch ||
    manifest.dependencyHash !== dependencyHash
  ) {
    return false;
  }
  const runtimeEntry = await lstat(runtimeRoot).catch(() => null);
  if (!runtimeEntry?.isDirectory()) return false;
  const bundledPython = findExistingPythonExecutable({
    pythonRoot,
    platform: targetPlatform,
    arch: targetArch,
    major: manifest.major,
    minor: manifest.minor,
  });
  if (!bundledPython) return false;
  const sitePackages = await stat(sitePackagesPath(manifest)).catch(() => null);
  return Boolean(sitePackages?.isDirectory());
}

async function writeRuntimeManifest(info: PythonRuntimeInfo, dependencyHash: string) {
  const manifest: RuntimeBundleManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    targetName,
    targetPlatformName,
    targetArch,
    dependencyHash,
    basePrefix: info.basePrefix,
    major: info.major,
    minor: info.minor,
    preparedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
  const bundledSitePackages = sitePackagesPath(info);
  const baseSitePackages = baseSitePackagesPath(info);
  const realBaseSitePackages = await realpath(baseSitePackages).catch(() => null);

  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  await cp(info.basePrefix, runtimeRoot, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      if (source.includes("__pycache__") || source.endsWith(".pyc")) return false;
      if (isPathAtOrInside(source, baseSitePackages)) return false;
      return !realBaseSitePackages || !isPathAtOrInside(source, realBaseSitePackages);
    },
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
  let verificationRoot: string | null = null;
  let verificationPython = bundledPython;
  const env = {
    PYTHONPATH: join(pythonRoot, "src"),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  try {
    if (targetPlatformName === "macos" && isPathAtOrInside(runtimeRoot, "/Volumes")) {
      verificationRoot = await mkdtemp(join(tmpdir(), "learnie-python-runtime-verify-"));
      const verificationPythonRoot = join(verificationRoot, "python");
      const verificationBundleRoot = join(verificationPythonRoot, ".bundle", targetName);
      await mkdir(join(verificationPythonRoot, ".bundle"), { recursive: true });
      await cp(bundleRoot, verificationBundleRoot, { recursive: true });
      verificationPython = findExistingPythonExecutable({
        pythonRoot: verificationPythonRoot,
        platform: targetPlatform,
        arch: targetArch,
        major: info.major,
        minor: info.minor,
      }) || "";
      if (!verificationPython) throw new Error(`Temporary bundled Python executable was not found under ${verificationBundleRoot}`);
    }
    run(
      verificationPython,
      [
        "-c",
        "import click, preppy.cli; print(click.__name__); print(preppy.cli.app.info.name)",
      ],
      { cwd: pythonRoot, env },
    );
  } finally {
    if (verificationRoot) await rm(verificationRoot, { recursive: true, force: true });
  }
}

async function main() {
  const dependencyHash = await runtimeDependencyHash();
  await removePythonCaches(join(pythonRoot, "src"));
  if (await runtimeBundleIsReusable(dependencyHash)) {
    console.log(`Reusing packaged Python runtime at ${bundleRoot}`);
    return;
  }
  ensureVenv();
  const info = inspectPython();
  await copyRuntime(info);
  await verifyRuntime(info);
  await writeRuntimeManifest(info, dependencyHash);
  console.log(`Prepared packaged Python runtime at ${bundleRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
