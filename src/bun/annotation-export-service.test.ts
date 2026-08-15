import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationExportService } from "./annotation-export-service";
import { closeDbForTests, getDb } from "./project-db";
import { saveMaterialAnnotation } from "./annotation-store";
import { ExternalHtmlImportService } from "./external-html-import-service";
import { readZipEntries } from "./archive-reader";

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

  test("copies persisted note images into the readable archive", async () => {
    const now = Date.now();
    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'Images', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('m1', 'p1', 'Material', 'ready', ?, ?)").run(now, now);
    const image = { id: "image-1", fileName: "diagram.png", mimeType: "image/png", byteSize: 8 };
    getDb().query(`INSERT INTO material_annotations
      (id, project_id, material_id, chunk_id, kind, selected_text, normalized_text, result_json, source_meta_json, created_at, updated_at)
      VALUES ('note-1', 'p1', 'm1', 'chunk', 'note', 'quoted text', 'quoted text', ?, '[]', ?, ?)`)
      .run(JSON.stringify({ kind: "note", note: "Caption", images: [image] }), now, now);
    const assetDir = join(tempRoot, "p1", "materials", "m1", "annotation-assets", "note-1");
    await mkdir(assetDir, { recursive: true });
    await writeFile(join(assetDir, "image-1.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const result = await new AnnotationExportService().exportReadable("p1", ["note-1"], tempRoot);
    expect(result.assetCount).toBe(1);
    const archiveText = (await readFile(result.zipPath)).toString("utf8");
    expect(archiveText).toContain("assets/note-1-image-1.png");
    expect(archiveText).toContain("![diagram.png](assets/note-1-image-1.png)");
  });

  test("exports external HTML originals, manifests, README, and licenses without runnable snapshots", async () => {
    const now = Date.now();
    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'Applets', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('m1', 'p1', 'Material', 'ready', ?, ?)").run(now, now);
    const annotation = saveMaterialAnnotation({ materialId: "m1", chunkId: "chunk", kind: "note", selectedText: "Applet", result: { kind: "note", note: "Interactive" } });
    const htmlPath = join(tempRoot, "chart.html");
    await writeFile(htmlPath, "<!doctype html><html><title>Chart</title><script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js\"></script><body><canvas></canvas></body></html>", "utf8");
    const importer = new ExternalHtmlImportService(async () => htmlPath);
    const preview = await importer.prepare(annotation.id);
    const committed = await importer.commit(annotation.id, preview!.previewId, annotation.updatedAt);
    const attachmentId = committed.attachments?.[0]?.id;

    const result = await new AnnotationExportService().exportReadable("p1", [annotation.id], tempRoot);
    const files = readZipEntries(await Bun.file(result.zipPath).bytes());
    const prefix = `Applets-annotations/assets/${annotation.id}/${attachmentId}`;
    expect(files.has(`${prefix}/original.html`)).toBe(true);
    expect(files.has(`${prefix}/manifest.json`)).toBe(true);
    expect(files.has(`${prefix}/README.txt`)).toBe(true);
    expect(files.has(`${prefix}/licenses/chart.js.txt`)).toBe(true);
    expect([...files.keys()].some((path) => path.endsWith("runnable.html"))).toBe(false);
  });
});
