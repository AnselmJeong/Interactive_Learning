import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProgressService } from "./progress-service";

describe("progress service", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-progress-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("weights sources by valid chunks and unions coverage across sessions", async () => {
    const now = Date.now();
    const chunksA = join(tempRoot, "a.json");
    const chunksB = join(tempRoot, "b.json");
    await writeFile(chunksA, JSON.stringify([{ id: "a1" }, { id: "a2" }]));
    await writeFile(chunksB, JSON.stringify([{ id: "b1" }, { id: "b2" }, { id: "b3" }, { id: "b4" }]));
    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('p1', 'Project', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query(`INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, imported_at, updated_at)
      VALUES ('d1', 'p1', 'book', 'Book', 'book.pdf', ?, ?)` ).run(now, now);
    getDb().query(`INSERT INTO project_sources
      (id, project_id, document_id, source_ordinal, title, source_type, document_type, original_file_name, imported_file_path, content_hash, chunks_path, quality_status, created_at, updated_at)
      VALUES ('a', 'p1', 'd1', 0, 'A', 'markdown', 'book', 'a.md', ?, 'ha', ?, 'good', ?, ?)` ).run(join(tempRoot, "a.md"), chunksA, now, now);
    getDb().query(`INSERT INTO project_sources
      (id, project_id, document_id, source_ordinal, title, source_type, document_type, original_file_name, imported_file_path, content_hash, chunks_path, quality_status, created_at, updated_at)
      VALUES ('b', 'p1', 'd1', 1, 'B', 'markdown', 'book', 'b.md', ?, 'hb', ?, 'good', ?, ?)` ).run(join(tempRoot, "b.md"), chunksB, now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('m1', 'p1', 'Material', 'ready', ?, ?)").run(now, now);
    getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES ('m1', 'a', 0), ('m1', 'b', 1)").run();
    getDb().query(`INSERT INTO learning_sessions
      (id, project_id, material_id, title, status, completed_module_ids_json, current_chunk_id, covered_chunk_ids_json, created_at, updated_at)
      VALUES ('old', 'p1', 'm1', 'Earlier', 'completed', '[]', NULL, '["a1","a2"]', ?, ?)` ).run(now - 1000, now - 1000);
    getDb().query(`INSERT INTO learning_sessions
      (id, project_id, material_id, title, status, completed_module_ids_json, current_chunk_id, covered_chunk_ids_json, created_at, updated_at)
      VALUES ('active', 'p1', 'm1', 'Current', 'active', '[]', 'b2', '["b1","orphan"]', ?, ?)` ).run(now, now);

    const snapshot = new ProgressService().getProjectSnapshot("p1");
    expect(snapshot.coveredChunks).toBe(3);
    expect(snapshot.totalChunks).toBe(6);
    expect(snapshot.percent).toBe(50);
    expect(snapshot.orphanCoveredChunkCount).toBe(1);
    expect(snapshot.documents[0]?.sources[0]?.status).toBe("completed");
    expect(snapshot.documents[0]?.sources[1]?.percent).toBe(25);
    expect(snapshot.currentSourceId).toBe("b");
    expect(snapshot.activeSessionId).toBe("active");
  });
});
