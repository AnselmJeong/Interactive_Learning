import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { normalizeMarkdownChunks, sanitizeHeadingPath, SourceService } from "./source-service";

describe("markdown chunk heading paths", () => {
  test("does not create sparse heading paths when a document starts at h2", () => {
    const chunks = normalizeMarkdownChunks("source", "## Opening\n\nFirst body.");
    expect(chunks[0]?.headingPath).toEqual(["Opening"]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("does not create sparse heading paths when heading levels are skipped", () => {
    const chunks = normalizeMarkdownChunks("source", "# Top\n\nIntro.\n\n### Deep\n\nDetail.");
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([["Top"], ["Top", "Deep"]]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("sanitizes stored null and non-string heading path parts", () => {
    expect(sanitizeHeadingPath(["Top", null, 42, "  Deep  ", ""])).toEqual(["Top", "Deep"]);
  });
});

describe("source title rename", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-source-rename-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("persists the title in both the database and source manifest", async () => {
    const project = await new ProjectService().create({ title: "Rename Project" });
    const sourceId = "source-1";
    const sourceDir = join(project.rootPath, project.id, "sources", sourceId);
    const manifestPath = join(sourceDir, "source_manifest.json");
    const importedPath = join(sourceDir, "original.md");
    const now = Date.now();
    await mkdir(sourceDir, { recursive: true });
    await writeFile(importedPath, "# Source\n\nBody", "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      id: sourceId,
      projectId: project.id,
      title: "OLD TITLE",
      sourceType: "markdown",
      importedAt: new Date(now).toISOString(),
      extractionMethod: "test",
      language: "en",
      quality: { status: "good", warnings: [] },
    }, null, 2)}\n`, "utf8");
    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, imported_file_path, content_hash,
          manifest_path, quality_status, created_at, updated_at)
         VALUES (?, ?, 'OLD TITLE', 'markdown', 'original.md', ?, 'rename-hash', ?, 'good', ?, ?)`
      )
      .run(sourceId, project.id, importedPath, manifestPath, now, now);

    const renamed = await new SourceService().rename(project.id, sourceId, "  A clearer source title  ");
    const row = getDb().query<{ title: string }, [string]>("SELECT title FROM project_sources WHERE id = ?").get(sourceId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(renamed.title).toBe("A clearer source title");
    expect(row?.title).toBe("A clearer source title");
    expect(manifest.title).toBe("A clearer source title");
    expect(typeof manifest.updatedAt).toBe("string");
  });

  test("rejects an empty title", async () => {
    await expect(new SourceService().rename("project", "source", "   ")).rejects.toThrow("Source title is required");
  });
});
