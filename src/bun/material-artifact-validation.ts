type TransferBytes = Map<string, Uint8Array>;

function sha256(bytes: Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function decodeJson(bytes: Uint8Array, label: string) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON in material artifact: ${label}`);
  }
}

function safeAdjacentPath(path: unknown) {
  if (typeof path !== "string" || !path || path.includes("\\")) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

export function validateTransferredMaterialArtifacts(files: TransferBytes, materialIds: string[], rootPrefix: string) {
  for (const materialId of materialIds) {
    const materialRoot = `${rootPrefix}/materials/${materialId}`;
    const manifestPath = `${materialRoot}/material_manifest.json`;
    const manifestBytes = files.get(manifestPath);
    if (!manifestBytes) continue; // Legacy incomplete material rows keep their existing import behavior.
    const manifest = decodeJson(manifestBytes, manifestPath);
    if (manifest.artifactSchemaVersion !== 2) continue;
    const descriptors = manifest.files;
    if (!descriptors || typeof descriptors !== "object" || Array.isArray(descriptors)) {
      throw new Error(`Material ${materialId} has an invalid v2 artifact manifest`);
    }
    for (const requiredName of ["learning_ir.json", "source_brief.json"]) {
      const descriptor = (descriptors as Record<string, unknown>)[requiredName] as Record<string, unknown> | undefined;
      if (!descriptor || descriptor.required !== true) throw new Error(`Material ${materialId} is missing required artifact metadata: ${requiredName}`);
    }
    for (const [requiredName, rawDescriptor] of Object.entries(descriptors as Record<string, unknown>)) {
      const descriptor = rawDescriptor as Record<string, unknown> | undefined;
      if (!descriptor || descriptor.required !== true) continue;
      const relativePath = safeAdjacentPath(descriptor.path);
      if (!relativePath || typeof descriptor.sha256 !== "string") throw new Error(`Material ${materialId} has an unsafe artifact path: ${requiredName}`);
      const artifactPath = `${materialRoot}/${relativePath}`;
      const bytes = files.get(artifactPath);
      if (!bytes) throw new Error(`Material ${materialId} is missing required artifact: ${requiredName}`);
      if (sha256(bytes) !== descriptor.sha256) throw new Error(`Material ${materialId} artifact checksum failed: ${requiredName}`);
      const artifact = decodeJson(bytes, artifactPath);
      if ((requiredName === "learning_ir.json" || requiredName === "source_brief.json") && (artifact.schemaVersion !== 1 || artifact.materialId !== materialId)) {
        throw new Error(`Material ${materialId} artifact schema mismatch: ${requiredName}`);
      }
    }
  }
}

export async function refreshMaterialArtifactChecksums(materialsRoot: string) {
  if (!existsSync(materialsRoot)) return;
  for (const entry of await readdir(materialsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(materialsRoot, entry.name);
    const manifestPath = join(dir, "material_manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifest.artifactSchemaVersion !== 2 || !manifest.files || typeof manifest.files !== "object") continue;
    for (const rawDescriptor of Object.values(manifest.files as Record<string, unknown>)) {
      const descriptor = rawDescriptor as Record<string, unknown>;
      const relativePath = safeAdjacentPath(descriptor.path);
      if (!relativePath) throw new Error(`Unsafe v2 material artifact path in ${entry.name}`);
      const artifactPath = join(dir, relativePath);
      if (!existsSync(artifactPath)) {
        if (descriptor.required === true) throw new Error(`Required v2 material artifact is missing in ${entry.name}: ${relativePath}`);
        continue;
      }
      descriptor.sha256 = sha256(await readFile(artifactPath));
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
