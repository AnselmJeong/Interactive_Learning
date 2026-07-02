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

function resolvePythonRoot() {
  const found = pythonRootCandidates().find((candidate) => existsSync(join(candidate, "pyproject.toml")) && existsSync(join(candidate, "src", "preppy")));
  if (!found) throw new Error("Bundled Preppy backend was not found.");
  return found;
}

function pythonCommand(pythonRoot: string) {
  const venvPython = join(pythonRoot, ".venv", "bin", "python");
  if (existsSync(venvPython)) return { command: venvPython, args: ["-m", "preppy.cli"] };
  return { command: "uv", args: ["run", "python", "-m", "preppy.cli"] };
}

function spawnPreppy(inputPath: string, outputPath: string) {
  const pythonRoot = resolvePythonRoot();
  const { command, args } = pythonCommand(pythonRoot);
  const childArgs = [...args, inputPath, "-o", outputPath, "--overwrite", "--json"];
  const pathParts = [
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Preppy exited with status ${code}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout.trim()) as PreppyBuildResult);
      } catch {
        reject(new Error(`Preppy returned invalid JSON: ${stdout.trim() || stderr.trim()}`));
      }
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
