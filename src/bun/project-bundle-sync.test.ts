import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverProjectManifestIfPossible, shouldImportSessionSnapshot, shouldPurgeProjectsMissingFromRoot } from "./project-bundle-sync";

describe("project root purge safety", () => {
  test("does not purge cached projects when a root has no project manifests", () => {
    expect(shouldPurgeProjectsMissingFromRoot(new Set())).toBe(false);
  });

  test("allows pruning only after at least one project manifest is visible", () => {
    expect(shouldPurgeProjectsMissingFromRoot(new Set(["project-a"]))).toBe(true);
  });

  test("does not prune when Drive has incomplete project folders", () => {
    expect(shouldPurgeProjectsMissingFromRoot(new Set(["project-a"]), true)).toBe(false);
  });
});

describe("project manifest recovery", () => {
  test("recovers a missing project manifest from source bundle artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "learnie-sync-"));
    try {
      const sourceDir = join(root, "project-a", "sources", "source-a");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, "source_manifest.json"),
        `${JSON.stringify({
          id: "source-a",
          projectId: "project-a",
          title: "Drive Synced Course",
          sourceType: "markdown",
          originalPath: "course.md",
          importedAt: "2026-01-02T03:04:05.000Z",
          extractionMethod: "test",
          language: "ko",
          quality: { status: "good", warnings: [] },
        })}\n`,
        "utf8"
      );

      const recovered = await recoverProjectManifestIfPossible(root, "project-a");
      expect(recovered.recovered).toBe(true);
      expect(recovered.markerCount).toBe(1);

      const manifest = JSON.parse(await readFile(join(root, "project-a", "project.json"), "utf8"));
      expect(manifest.id).toBe("project-a");
      expect(manifest.title).toBe("Drive Synced Course");
      expect(manifest.archivedAt).toBe(null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not recover empty folders as projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "learnie-sync-"));
    try {
      await mkdir(join(root, "notes"), { recursive: true });
      const recovered = await recoverProjectManifestIfPossible(root, "notes");
      expect(recovered.recovered).toBe(false);
      expect(recovered.markerCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("session snapshot import staleness", () => {
  test("imports only snapshots newer than the cached session", () => {
    expect(shouldImportSessionSnapshot(undefined, 100)).toBe(true);
    expect(shouldImportSessionSnapshot(99, 100)).toBe(true);
    expect(shouldImportSessionSnapshot(100, 100)).toBe(false);
    expect(shouldImportSessionSnapshot(101, 100)).toBe(false);
  });
});
