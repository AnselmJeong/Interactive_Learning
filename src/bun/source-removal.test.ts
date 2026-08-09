import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { SourceService } from "./source-service";

describe("source removal", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-source-remove-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("blocks shared materials then removes only exclusive learning state and keeps the document", async () => {
    const now = Date.now();
    const projectPath = join(tempRoot, "p1");
    const sourceManifest = join(projectPath, "sources", "s1", "source.json");
    const sourceFile = join(projectPath, "sources", "s1", "source.md");
    const materialManifest = join(projectPath, "materials", "m1", "material.json");
    await mkdir(dirname(sourceManifest), { recursive: true });
    await mkdir(dirname(materialManifest), { recursive: true });
    await writeFile(sourceManifest, "{}\n");
    await writeFile(sourceFile, "source\n");
    await writeFile(materialManifest, "{}\n");

    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'Project', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query(`INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, imported_at, updated_at)
      VALUES ('d1', 'p1', 'book', 'Book', 'book.pdf', ?, ?)` ).run(now, now);
    const insertSource = getDb().query(`INSERT INTO project_sources
      (id, project_id, document_id, source_ordinal, title, source_type, document_type, original_file_name, imported_file_path, content_hash, manifest_path, quality_status, created_at, updated_at)
      VALUES (?, 'p1', 'd1', ?, ?, 'markdown', 'book', ?, ?, ?, ?, 'good', ?, ?)`);
    insertSource.run("s1", 0, "One", "one.md", sourceFile, "h1", sourceManifest, now, now);
    insertSource.run("s2", 1, "Two", "two.md", join(projectPath, "sources", "s2", "source.md"), "h2", join(projectPath, "sources", "s2", "source.json"), now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, manifest_path, created_at, updated_at) VALUES ('m1', 'p1', 'One', 'ready', ?, ?, ?)").run(materialManifest, now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('shared', 'p1', 'Shared', 'ready', ?, ?)").run(now, now);
    getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES ('m1', 's1', 0), ('shared', 's1', 0), ('shared', 's2', 1)").run();
    getDb().query(`INSERT INTO learning_sessions
      (id, project_id, material_id, title, status, completed_module_ids_json, covered_chunk_ids_json, created_at, updated_at)
      VALUES ('session', 'p1', 'm1', 'Session', 'active', '[]', '[]', ?, ?)` ).run(now, now);
    getDb().query(`INSERT INTO learning_messages
      (id, session_id, role, content, source_refs_json, choices_json, blocks_json, created_at, ordinal)
      VALUES ('message', 'session', 'assistant', 'Hello', '[]', '[]', '[]', ?, 0)` ).run(now);
    getDb().query(`INSERT INTO material_annotations
      (id, project_id, material_id, source_id, chunk_id, kind, selected_text, normalized_text, result_json, created_at, updated_at)
      VALUES ('note', 'p1', 'm1', 's1', 'chunk', 'note', 'text', 'text', '{"kind":"note","note":"memo"}', ?, ?)` ).run(now, now);

    const service = new SourceService();
    const blocked = service.previewRemoval("p1", "d1", "s1");
    expect(blocked.exclusiveMaterials).toBe(1);
    expect(blocked.sharedMaterials).toBe(1);
    expect(blocked.sessions).toBe(1);
    expect(blocked.messages).toBe(1);
    expect(blocked.annotations).toBe(1);
    await expect(service.removeSource("p1", "d1", "s1", blocked.impactToken)).rejects.toThrow("also uses another source");

    getDb().query("DELETE FROM learning_materials WHERE id = 'shared'").run();
    const impact = service.previewRemoval("p1", "d1", "s1");
    const result = await service.removeSource("p1", "d1", "s1", impact.impactToken);
    expect(result.removed).toBe(true);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_sources WHERE id = 's1'").get()?.count).toBe(0);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_documents WHERE id = 'd1'").get()?.count).toBe(1);
    expect(getDb().query<{ source_ordinal: number }, []>("SELECT source_ordinal FROM project_sources WHERE id = 's2'").get()?.source_ordinal).toBe(0);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM learning_sessions WHERE id = 'session'").get()?.count).toBe(0);
    expect(existsSync(dirname(materialManifest))).toBe(false);
    expect(existsSync(dirname(sourceManifest))).toBe(false);
  });

  test("deletes a whole document and its sources but blocks materials shared with another document", async () => {
    const now = Date.now();
    const projectPath = join(tempRoot, "p1");
    const sourceOneDir = join(projectPath, "sources", "s1");
    const sourceTwoDir = join(projectPath, "sources", "s2");
    const otherSourceDir = join(projectPath, "sources", "s3");
    const materialDir = join(projectPath, "materials", "m1");
    const documentDir = join(projectPath, "documents", "d1");
    await Promise.all([sourceOneDir, sourceTwoDir, otherSourceDir, materialDir, documentDir].map((path) => mkdir(path, { recursive: true })));
    await Promise.all([
      writeFile(join(sourceOneDir, "source_manifest.json"), "{}\n"),
      writeFile(join(sourceTwoDir, "source_manifest.json"), "{}\n"),
      writeFile(join(otherSourceDir, "source_manifest.json"), "{}\n"),
      writeFile(join(materialDir, "material.json"), "{}\n"),
      writeFile(join(documentDir, "cover.jpg"), "cover\n"),
    ]);

    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'Project', ?, ?, ?)").run(tempRoot, now, now);
    const insertDocument = getDb().query(`INSERT INTO project_documents
      (id, project_id, document_type, title, original_file_name, imported_at, updated_at)
      VALUES (?, 'p1', ?, ?, ?, ?, ?)`);
    insertDocument.run("d1", "book", "Book", "book.pdf", now, now);
    insertDocument.run("d2", "article", "Paper", "paper.pdf", now, now);
    const insertSource = getDb().query(`INSERT INTO project_sources
      (id, project_id, document_id, source_ordinal, title, source_type, document_type, original_file_name, imported_file_path, content_hash, manifest_path, quality_status, created_at, updated_at)
      VALUES (?, 'p1', ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, 'good', ?, ?)`);
    insertSource.run("s1", "d1", 0, "One", "book", "one.md", join(sourceOneDir, "source.md"), "h1", join(sourceOneDir, "source_manifest.json"), now, now);
    insertSource.run("s2", "d1", 1, "Two", "book", "two.md", join(sourceTwoDir, "source.md"), "h2", join(sourceTwoDir, "source_manifest.json"), now, now);
    insertSource.run("s3", "d2", 0, "Paper", "article", "paper.md", join(otherSourceDir, "source.md"), "h3", join(otherSourceDir, "source_manifest.json"), now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, manifest_path, created_at, updated_at) VALUES ('m1', 'p1', 'Book material', 'ready', ?, ?, ?)").run(join(materialDir, "material.json"), now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('shared', 'p1', 'Cross document', 'ready', ?, ?)").run(now, now);
    getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES ('m1', 's1', 0), ('m1', 's2', 1), ('shared', 's2', 0), ('shared', 's3', 1)").run();
    getDb().query(`INSERT INTO learning_sessions
      (id, project_id, material_id, title, status, completed_module_ids_json, covered_chunk_ids_json, created_at, updated_at)
      VALUES ('session', 'p1', 'm1', 'Session', 'active', '[]', '[]', ?, ?)` ).run(now, now);
    getDb().query(`INSERT INTO learning_messages
      (id, session_id, role, content, source_refs_json, choices_json, blocks_json, created_at, ordinal)
      VALUES ('message', 'session', 'assistant', 'Hello', '[]', '[]', '[]', ?, 0)` ).run(now);

    const service = new SourceService();
    const blocked = service.previewDocumentRemoval("p1", "d1");
    expect(blocked).toMatchObject({ sources: 2, exclusiveMaterials: 1, sharedMaterials: 1, sessions: 1, messages: 1 });
    await expect(service.removeDocument("p1", "d1", blocked.impactToken)).rejects.toThrow("another book or article");

    getDb().query("DELETE FROM learning_materials WHERE id = 'shared'").run();
    const impact = service.previewDocumentRemoval("p1", "d1");
    const result = await service.removeDocument("p1", "d1", impact.impactToken);

    expect(result).toEqual({ removed: true, documentId: "d1" });
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_documents WHERE id = 'd1'").get()?.count).toBe(0);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_sources WHERE document_id = 'd1'").get()?.count).toBe(0);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_documents WHERE id = 'd2'").get()?.count).toBe(1);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_sources WHERE id = 's3'").get()?.count).toBe(1);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM learning_materials WHERE id = 'm1'").get()?.count).toBe(0);
    expect(existsSync(sourceOneDir)).toBe(false);
    expect(existsSync(sourceTwoDir)).toBe(false);
    expect(existsSync(materialDir)).toBe(false);
    expect(existsSync(documentDir)).toBe(false);
    expect(existsSync(otherSourceDir)).toBe(true);
  });
});
