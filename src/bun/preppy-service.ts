import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

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

function bundledRuntimeName() {
  const os = process.platform === "darwin" ? "macos" : process.platform;
  return `${os}-${process.arch}`;
}

function resolvePythonRoot() {
  const found = pythonRootCandidates().find((candidate) => existsSync(join(candidate, "pyproject.toml")) && existsSync(join(candidate, "src", "preppy")));
  if (!found) throw new Error("Bundled Preppy backend was not found.");
  return found;
}

function pythonCommand(pythonRoot: string) {
  const bundledPython = join(pythonRoot, ".bundle", bundledRuntimeName(), "runtime", "bin", "python3.12");
  if (existsSync(bundledPython)) return { command: bundledPython, args: ["-m", "preppy.cli"] };

  const venvPython = join(pythonRoot, ".venv", "bin", "python");
  if (existsSync(venvPython)) return { command: venvPython, args: ["-m", "preppy.cli"] };

  return { command: "uv", args: ["run", "python", "-m", "preppy.cli"] };
}

function parsePreppyResult(text: string) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text.trim()) as PreppyBuildResult;
  } catch {
    return null;
  }
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
    join(pythonRoot, ".bundle", bundledRuntimeName(), "runtime", "bin"),
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
        PATH: pathParts.join(":"),
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
