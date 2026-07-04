import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, join, parse } from "node:path";

export type RuntimePlatform = NodeJS.Platform | "macos" | "win";

export function buildPlatformName(platform: RuntimePlatform = process.platform) {
  if (platform === "win") return "win32";
  return platform === "darwin" ? "macos" : platform;
}

export function runtimeBundleName(platform: RuntimePlatform = process.platform, arch: string = process.arch) {
  return `${buildPlatformName(platform)}-${arch}`;
}

export function executableName(name: string, platform: RuntimePlatform = process.platform) {
  if (buildPlatformName(platform) !== "win32" || name.toLowerCase().endsWith(".exe")) return name;
  return `${name}.exe`;
}

export function pathListSeparator(platform: RuntimePlatform = process.platform) {
  return buildPlatformName(platform) === "win32" ? ";" : delimiter;
}

export function pythonRuntimeBinDirs(pythonRoot: string, platform: RuntimePlatform = process.platform, arch = process.arch) {
  const runtimeRoot = join(pythonRoot, ".bundle", runtimeBundleName(platform, arch), "runtime");
  if (buildPlatformName(platform) === "win32") return [runtimeRoot, join(runtimeRoot, "Scripts")];
  return [join(runtimeRoot, "bin")];
}

export function pythonExecutableCandidates(input: {
  pythonRoot: string;
  platform?: RuntimePlatform;
  arch?: string;
  major?: number;
  minor?: number;
}) {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const versioned = input.major && input.minor ? `python${input.major}.${input.minor}` : "python3.12";
  const runtimeRoot = join(input.pythonRoot, ".bundle", runtimeBundleName(platform, arch), "runtime");
  const venvRoot = join(input.pythonRoot, ".venv");
  if (buildPlatformName(platform) === "win32") {
    return [
      join(runtimeRoot, "python.exe"),
      join(runtimeRoot, "Scripts", "python.exe"),
      join(venvRoot, "Scripts", "python.exe"),
    ];
  }
  return [
    join(runtimeRoot, "bin", versioned),
    join(runtimeRoot, "bin", "python3"),
    join(runtimeRoot, "bin", "python"),
    join(venvRoot, "bin", "python"),
  ];
}

export function findExistingPythonExecutable(input: {
  pythonRoot: string;
  platform?: RuntimePlatform;
  arch?: string;
  major?: number;
  minor?: number;
}) {
  return pythonExecutableCandidates(input).find((candidate) => existsSync(candidate)) || null;
}

export function defaultUserDataBase(input: {
  electrobunUserData?: string;
  env?: NodeJS.ProcessEnv;
  platform?: RuntimePlatform;
  cwd?: string;
}) {
  if (input.electrobunUserData) return input.electrobunUserData;
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (buildPlatformName(platform) === "win32") return env.APPDATA || (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : input.cwd || process.cwd());
  if (buildPlatformName(platform) === "macos") return join(env.HOME || input.cwd || process.cwd(), "Library", "Application Support");
  return env.XDG_DATA_HOME || join(env.HOME || input.cwd || process.cwd(), ".local", "share");
}

export function isPotentiallyUnavailableProjectRoot(rootPath: string, platform: RuntimePlatform = process.platform) {
  const normalized = rootPath.replaceAll("\\", "/");
  if (buildPlatformName(platform) === "macos") return normalized.startsWith("/Volumes/") && normalized.split("/").filter(Boolean).length >= 2;
  if (buildPlatformName(platform) === "win32") return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return false;
}

export async function projectRootAvailable(rootPath: string, platform: RuntimePlatform = process.platform) {
  try {
    const info = await stat(rootPath);
    return info.isDirectory();
  } catch {
    return !isPotentiallyUnavailableProjectRoot(rootPath, platform);
  }
}

export type OpenTargetKind = "file" | "folder" | "url";

export function openCommandForPlatform(kind: OpenTargetKind, platform: RuntimePlatform = process.platform) {
  if (buildPlatformName(platform) === "macos") return { command: "open", argsPrefix: [] as string[] };
  if (buildPlatformName(platform) === "win32") {
    if (kind === "url") return { command: "cmd.exe", argsPrefix: ["/c", "start", ""] };
    return { command: "explorer.exe", argsPrefix: [] as string[] };
  }
  return { command: "xdg-open", argsPrefix: [] as string[] };
}

export async function openFilesystemPath(path: string, kind: Exclude<OpenTargetKind, "url"> = "folder") {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`${kind === "folder" ? "Folder" : "File"} does not exist`);
  const command = openCommandForPlatform(kind);
  const child = spawn(command.command, [...command.argsPrefix, path], { stdio: "ignore", detached: true });
  child.unref();
  return true;
}

export function isDriveOrShareRoot(path: string, platform: RuntimePlatform = process.platform) {
  if (buildPlatformName(platform) === "win32") {
    const normalized = path.replaceAll("\\", "/");
    return /^[A-Za-z]:\/?$/.test(normalized) || /^\/\/[^/]+\/[^/]+\/?$/.test(normalized);
  }
  return parse(path).root === path;
}
