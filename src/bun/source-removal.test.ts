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
});
