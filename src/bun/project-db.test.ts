import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";

describe("project database migrations", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-project-db-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("migrates legacy learning_messages before creating delivery_state indexes", async () => {
    const appData = join(tempRoot, "learnie");
    await mkdir(appData, { recursive: true });
    const legacyDb = new Database(join(appData, "projects.sqlite"), { create: true });
    legacyDb.exec(`
      CREATE TABLE learning_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        module_id TEXT,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        choices_json TEXT NOT NULL DEFAULT '[]',
        blocks_json TEXT NOT NULL DEFAULT '[]',
        visual_id TEXT,
        state_update_json TEXT,
        created_at INTEGER NOT NULL,
        ordinal INTEGER NOT NULL
      );
    `);
    legacyDb.close();

    const columns = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(learning_messages)")
      .all()
      .map((column) => column.name);
    const indexes = getDb()
      .query<{ name: string }, []>("PRAGMA index_list(learning_messages)")
      .all()
      .map((index) => index.name);

    expect(columns).toContain("delivery_state");
    expect(columns).toContain("batch_run_id");
    expect(columns).toContain("cursor_before_json");
    expect(columns).toContain("cursor_after_json");
    expect(columns).toContain("origin_prepared_message_id");
    expect(columns).toContain("conversation_kind");
    expect(indexes).toContain("idx_learning_messages_prepared_batch");
    const tables = getDb().query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).toContain("learning_message_sets");
    expect(tables).toContain("prepared_learning_messages");
    expect(tables).toContain("session_module_progress");
    const materialColumns = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(learning_materials)")
      .all()
      .map((column) => column.name);
    expect(materialColumns).toContain("overview_json");
  });

  test("moves legacy prepared batch rows into immutable message sets and binds the session", () => {
    const now = Date.now();
    const database = getDb();
    database.query("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?)").run(now, now);
    database.query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)").run(now, now);
    database.query(
      `INSERT INTO learning_sessions
       (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json, current_chunk_id,
        covered_chunk_ids_json, model, created_at, updated_at)
       VALUES ('session-1', 'project-1', 'material-1', 'Session', 'active', 'module-1', '[]', 'chunk-1', '[]', 'model-1', ?, ?)`
    ).run(now, now);
    database.query(
      `INSERT INTO learning_message_batch_runs
       (id, session_id, material_id, status, route_kind, provider, model, settings_fingerprint, material_fingerprint,
        prompt_version, total_steps, completed_steps, created_at, updated_at)
       VALUES ('legacy-run', 'session-1', 'material-1', 'ready', 'default_continue', 'openai', 'model-1', 'settings', 'material',
        'prompt-v1', 2, 2, ?, ?)`
    ).run(now, now);
    database.query(
      `INSERT INTO learning_messages
       (id, session_id, role, content, module_id, source_refs_json, choices_json, blocks_json, delivery_state,
        batch_run_id, cursor_before_json, cursor_after_json, created_at, ordinal)
       VALUES
       ('visible-route', 'session-1', 'assistant', 'Visible route', 'module-1', '["chunk-1"]', '[]', '[]', 'visible',
        'legacy-run', '{"currentModuleId":"module-1","currentChunkId":"chunk-1","coveredChunkIds":[],"completedModuleIds":[]}',
        '{"currentModuleId":"module-1","currentChunkId":"chunk-1","coveredChunkIds":[],"completedModuleIds":[]}', ?, 0),
       ('prepared-route', 'session-1', 'assistant', 'Prepared route', 'module-1', '["chunk-2"]', '[]', '[]', 'prepared',
        'legacy-run', '{"currentModuleId":"module-1","currentChunkId":"chunk-1","coveredChunkIds":[],"completedModuleIds":[]}',
        '{"currentModuleId":"module-1","currentChunkId":"chunk-2","coveredChunkIds":["chunk-1"],"completedModuleIds":[]}', ?, 1)`
    ).run(now, now);
    closeDbForTests();

    const migrated = getDb();
    expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM prepared_learning_messages WHERE message_set_id = 'legacy-run'").get()?.count).toBe(2);
    expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM learning_messages WHERE delivery_state != 'visible'").get()?.count).toBe(0);
    expect(migrated.query<{ message_set_id: string | null }, []>("SELECT message_set_id FROM learning_sessions WHERE id = 'session-1'").get()?.message_set_id).toBe("legacy-run");
    expect(migrated.query<{ origin_prepared_message_id: string | null }, []>("SELECT origin_prepared_message_id FROM learning_messages WHERE id = 'visible-route'").get()?.origin_prepared_message_id).toBe("legacy-prepared-visible-route");
  });

  test("adds annotation anchor_json before rebuilding legacy annotation constraints", async () => {
    const appData = join(tempRoot, "learnie");
    await mkdir(appData, { recursive: true });
    const legacyDb = new Database(join(appData, "projects.sqlite"), { create: true });
    legacyDb.exec(`
      CREATE TABLE material_annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        source_id TEXT,
        chunk_id TEXT NOT NULL,
        surface TEXT NOT NULL DEFAULT 'source' CHECK (surface IN ('chat', 'source')),
        anchor_message_id TEXT,
        anchor_block_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('define', 'lookup', 'image', 'note', 'highlight')),
        selected_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        result_json TEXT NOT NULL,
        source_meta_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacyDb.close();

    const columns = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(material_annotations)")
      .all()
      .map((column) => column.name);

    expect(columns).toContain("anchor_json");
    const sql = getDb()
      .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'material_annotations'")
      .get()?.sql || "";
    expect(sql).toContain("'question'");
  });
});
