import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshMaterialArtifactChecksums, validateTransferredMaterialArtifacts } from "./material-artifact-validation";

function bytes(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function hash(value: Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function fixture() {
  const ir = bytes({ schemaVersion: 1, materialId: "m1", contentHash: "hash" });
  const brief = bytes({ schemaVersion: 1, materialId: "m1", sourceFingerprint: "source" });
  const manifest = bytes({
    artifactSchemaVersion: 2,
    files: {
      "learning_ir.json": { path: "learning_ir.json", sha256: hash(ir), required: true },
      "source_brief.json": { path: "source_brief.json", sha256: hash(brief), required: true },
    },
  });
  return new Map<string, Uint8Array>([
    ["project/files/materials/m1/material_manifest.json", manifest],
    ["project/files/materials/m1/learning_ir.json", ir],
    ["project/files/materials/m1/source_brief.json", brief],
  ]);
}

describe("transferred material artifact validation", () => {
  test("accepts a complete v2 material before transfer commit", () => {
    expect(() => validateTransferredMaterialArtifacts(fixture(), ["m1"], "project/files")).not.toThrow();
  });

  test("rejects a missing or changed required v2 artifact", () => {
    const missing = fixture();
    missing.delete("project/files/materials/m1/source_brief.json");
    expect(() => validateTransferredMaterialArtifacts(missing, ["m1"], "project/files")).toThrow("missing required artifact");
    const changed = fixture();
    changed.set("project/files/materials/m1/learning_ir.json", bytes({ schemaVersion: 1, materialId: "m1", changed: true }));
    expect(() => validateTransferredMaterialArtifacts(changed, ["m1"], "project/files")).toThrow("checksum failed");
  });

  test("refreshes inner checksums after transfer path or ID rewriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "learnie-material-checksum-"));
    const materialDir = join(root, "materials", "m1");
    await mkdir(materialDir, { recursive: true });
    const ir = bytes({ schemaVersion: 1, materialId: "m1" });
    await writeFile(join(materialDir, "learning_ir.json"), ir);
    await writeFile(join(materialDir, "material_manifest.json"), JSON.stringify({
      artifactSchemaVersion: 2,
      files: { "learning_ir.json": { path: "learning_ir.json", sha256: "stale", required: true } },
    }));
    try {
      await refreshMaterialArtifactChecksums(join(root, "materials"));
      const manifest = JSON.parse(await readFile(join(materialDir, "material_manifest.json"), "utf8"));
      expect(manifest.files["learning_ir.json"].sha256).toBe(hash(ir));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
