import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findExistingPythonExecutable, pathListSeparator, pythonRuntimeBinDirs } from "./platform-utils";

type PreppyBuildResult = {
  output: string;
  ok: boolean;
  chapter_count?: number;
  figure_count?: number;
  issues?: Array<{ severity: string; message: string }>;
};

function pythonRootCandidates() {
  const roots = [
    process.env.LEARNIE_PROJECT_ROOT,
    process.env.INTERACTIVE_LEARNING_PROJECT_ROOT,
    process.cwd(),
    resolve(import.meta.dir, ".."),
    resolve(import.meta.dir, "../.."),
    resolve(import.meta.dir, "../../.."),
  ].filter(Boolean) as string[];
  return roots.map((root) => join(root, "python"));
}

function resolvePythonRoot() {
  const found = pythonRootCandidates().find((candidate) => existsSync(join(candidate, "pyproject.toml")) && existsSync(join(candidate, "src", "preppy")));
  if (!found) throw new Error("Bundled Preppy backend was not found.");
  return found;
}

function pythonCommand(pythonRoot: string) {
  const python = findExistingPythonExecutable({ pythonRoot });
  if (python) return { command: python, args: ["-m", "preppy.cli"] };

  return { command: "uv", args: ["run", "python", "-m", "preppy.cli"] };
}

function parsePreppyResult(text: string) {
  if (!text.trim()) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as PreppyBuildResult;
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted) as PreppyBuildResult;
    } catch {
      return null;
    }
  }
}

function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function preppyFailureMessage(result: PreppyBuildResult, fallback = "Preppy conversion failed.") {
  const issues = (result.issues || []).map((issue) => issue.message).filter(Boolean);
  if (!issues.length) return fallback;
  const visible = issues.slice(0, 5).map((message) => `- ${message}`);
  const extra = issues.length > visible.length ? [`- ...and ${issues.length - visible.length} more`] : [];
  return ["Preppy conversion failed.", ...visible, ...extra].join("\n");
}

function spawnPreppy(inputPath: string, outputPath: string) {
  const pythonRoot = resolvePythonRoot();
  const { command, args } = pythonCommand(pythonRoot);
  const childArgs = [...args, inputPath, "-o", outputPath, "--overwrite", "--json"];
  const pathParts = [
    ...pythonRuntimeBinDirs(pythonRoot),
    process.env.PATH || "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(process.env.HOME || "", ".cargo", "bin"),
    join(process.env.HOME || "", ".local", "bin"),
  ].filter(Boolean);

  return new Promise<PreppyBuildResult>((resolveResult, reject) => {
    const child = spawn(command, childArgs, {
      cwd: pythonRoot,
      env: {
        ...process.env,
        PATH: pathParts.join(pathListSeparator()),
        PYTHONPATH: join(pythonRoot, "src"),
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Preppy backend failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      const result = parsePreppyResult(stdout);
      if (code !== 0) {
        reject(new Error(result ? preppyFailureMessage(result, stderr.trim()) : stderr.trim() || stdout.trim() || `Preppy exited with status ${code}`));
        return;
      }
      if (!result) {
        reject(new Error(`Preppy returned invalid JSON: ${stdout.trim() || stderr.trim()}`));
        return;
      }
      if (!result.ok) {
        reject(new Error(preppyFailureMessage(result)));
        return;
      }
      resolveResult(result);
    });
  });
}

export async function buildPreppySourcePack(inputPath: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), "learnie-preppy-"));
  const safeName = basename(inputPath).replace(/\.[^.]+$/, "") || "source";
  const outputPath = join(tempRoot, `${safeName}.preppy`);
  await mkdir(outputPath, { recursive: true });
  try {
    await spawnPreppy(inputPath, outputPath);
    return {
      outputPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
