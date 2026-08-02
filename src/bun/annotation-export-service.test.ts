import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationExportService } from "./annotation-export-service";
import { closeDbForTests, getDb } from "./project-db";

describe("annotation readable export", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-annotation-export-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("exports only the selected project annotations as readable Markdown", async () => {
    const now = Date.now();
    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'My Project', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query("INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, imported_at, updated_at) VALUES ('d1', 'p1', 'book', 'A Book', 'book.pdf', ?, ?)").run(now, now);
    getDb().query(`INSERT INTO project_sources
      (id, project_id, document_id, source_ordinal, title, source_type, document_type, original_file_name, imported_file_path, content_hash, quality_status, created_at, updated_at)
      VALUES ('s1', 'p1', 'd1', 0, 'Chapter One', 'markdown', 'book', 'one.md', ?, 'hash', 'good', ?, ?)` ).run(join(tempRoot, "one.md"), now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('m1', 'p1', 'Material', 'ready', ?, ?)").run(now, now);
    getDb().query(`INSERT INTO material_annotations
      (id, project_id, material_id, source_id, chunk_id, kind, selected_text, normalized_text, result_json, source_meta_json, created_at, updated_at)
      VALUES ('a1', 'p1', 'm1', 's1', 'chunk', 'note', 'quoted text', 'quoted text', ?, '[]', ?, ?)` ).run(JSON.stringify({ kind: "note", note: "**Structured** note" }), now, now);

    const result = await new AnnotationExportService().exportReadable("p1", ["a1"], tempRoot);
    expect(result.annotationCount).toBe(1);
    expect(existsSync(result.zipPath)).toBe(true);
    const archiveText = (await readFile(result.zipPath)).toString("utf8");
    expect(archiveText).toContain("annotations.md");
    expect(archiveText).toContain("## A Book");
    expect(archiveText).toContain("### Chapter One");
    expect(archiveText).toContain("**Structured** note");
    expect(archiveText).not.toContain("a1");
    expect(archiveText).not.toContain(tempRoot);
  });
});
