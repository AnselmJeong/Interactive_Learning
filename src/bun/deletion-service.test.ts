import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { TutorService } from "./tutor-service";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "learnie-delete-test-"));
  process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
  closeDbForTests();
});

afterEach(async () => {
  closeDbForTests();
  delete process.env.LEARNIE_APP_DATA_ROOT;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

function rowCount(table: string, where = "1 = 1") {
  return getDb().query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()?.count || 0;
}

function insertMaterial(projectId: string, materialId = "material-1") {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'Material', 'ready', ?, ?)`
    )
    .run(materialId, projectId, now, now);
  return materialId;
}

describe("deletion services", () => {
  test("project deletion removes the project row, dependent rows, and project folder", async () => {
    const service = new ProjectService();
    const project = await service.create({ title: "Delete Me" });
    const projectPath = join(project.rootPath, project.id);
    const now = Date.now();
    const sourceId = "source-1";
    const materialId = insertMaterial(project.id);
    const sessionId = "session-1";

    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, imported_file_path, content_hash, quality_status, created_at, updated_at)
         VALUES (?, ?, 'Source', 'markdown', 'source.md', ?, 'hash-1', 'good', ?, ?)`
      )
      .run(sourceId, project.id, join(projectPath, "sources", sourceId, "source.md"), now, now);
    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json,
          current_chunk_id, covered_chunk_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 'Session', 'active', 'module-1', '[]', 'chunk-1', '[]', ?, ?)`
      )
      .run(sessionId, project.id, materialId, now, now);
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, source_refs_json, choices_json, blocks_json, created_at, ordinal)
         VALUES ('message-1', ?, 'assistant', 'Hello', '[]', '[]', '[]', ?, 0)`
      )
      .run(sessionId, now);
    getDb()
      .query(
        `INSERT INTO material_annotations
         (id, project_id, material_id, source_id, chunk_id, kind, selected_text, normalized_text, result_json, created_at, updated_at)
         VALUES ('annotation-1', ?, ?, ?, 'chunk-1', 'note', 'text', 'text', '{}', ?, ?)`
      )
      .run(project.id, materialId, sourceId, now, now);

    expect(existsSync(projectPath)).toBe(true);

    await service.delete(project.id);

    expect(rowCount("projects", `id = '${project.id}'`)).toBe(0);
    expect(rowCount("project_sources", `project_id = '${project.id}'`)).toBe(0);
    expect(rowCount("learning_materials", `project_id = '${project.id}'`)).toBe(0);
    expect(rowCount("learning_sessions", `project_id = '${project.id}'`)).toBe(0);
    expect(rowCount("learning_messages", `session_id = '${sessionId}'`)).toBe(0);
    expect(rowCount("material_annotations", `project_id = '${project.id}'`)).toBe(0);
    expect(existsSync(projectPath)).toBe(false);
  });

  test("session deletion removes the session row, messages, and bundle snapshot", async () => {
    const project = await new ProjectService().create({ title: "Session Delete" });
    const materialId = insertMaterial(project.id);
    const sessionId = "session-to-delete";
    const now = Date.now();
    const snapshotDir = join(project.rootPath, project.id, "sessions", sessionId);

    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json,
          current_chunk_id, covered_chunk_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 'Session', 'active', 'module-1', '[]', 'chunk-1', '[]', ?, ?)`
      )
      .run(sessionId, project.id, materialId, now, now);
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, source_refs_json, choices_json, blocks_json, created_at, ordinal)
         VALUES ('message-to-delete', ?, 'assistant', 'Hello', '[]', '[]', '[]', ?, 0)`
      )
      .run(sessionId, now);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, "session.json"), "{}\n", "utf8");

    const deleted = await new TutorService().deleteSession(sessionId);

    expect(deleted).toBe(true);
    expect(rowCount("learning_sessions", `id = '${sessionId}'`)).toBe(0);
    expect(rowCount("learning_messages", `session_id = '${sessionId}'`)).toBe(0);
    expect(existsSync(snapshotDir)).toBe(false);
  });
});
