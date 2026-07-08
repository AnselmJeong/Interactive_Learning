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
    expect(indexes).toContain("idx_learning_messages_prepared_batch");
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
