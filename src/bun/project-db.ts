import { Database } from "bun:sqlite";
import { dataPath } from "./paths";

let db: Database | null = null;

export function getDb() {
  if (db) return db;

  db = new Database(dataPath("projects.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      root_path TEXT,
      learning_level TEXT NOT NULL DEFAULT 'medium' CHECK (learning_level IN ('casual', 'medium', 'hard')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS project_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('markdown', 'pdf', 'text')),
      original_file_name TEXT NOT NULL,
      original_file_path TEXT,
      imported_file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      manifest_path TEXT,
      chunks_path TEXT,
      quality_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_sources_hash
      ON project_sources(project_id, content_hash);

    CREATE TABLE IF NOT EXISTS learning_materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      material_type TEXT NOT NULL DEFAULT 'source_course',
      status TEXT NOT NULL CHECK (status IN ('draft', 'generating', 'ready', 'failed')),
      manifest_path TEXT,
      concept_map_path TEXT,
      course_plan_path TEXT,
      lecture_plan_path TEXT,
      presentation_plan_path TEXT,
      critic_report_path TEXT,
      visual_specs_path TEXT,
      source_index_path TEXT,
      generation_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS material_sources (
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES project_sources(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (material_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
      current_module_id TEXT,
      completed_module_ids_json TEXT NOT NULL DEFAULT '[]',
      current_chunk_id TEXT,
      covered_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_learning_sessions_material_updated
      ON learning_sessions(material_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS learning_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      module_id TEXT,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      choices_json TEXT NOT NULL DEFAULT '[]',
      blocks_json TEXT NOT NULL DEFAULT '[]',
      visual_id TEXT,
      state_update_json TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'visible' CHECK (delivery_state IN ('visible', 'prepared', 'discarded')),
      batch_run_id TEXT,
      cursor_before_json TEXT,
      cursor_after_json TEXT,
      created_at INTEGER NOT NULL,
      ordinal INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learning_messages_session_ordinal
      ON learning_messages(session_id, ordinal ASC);

    CREATE TABLE IF NOT EXISTS learning_message_batch_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'partial', 'failed', 'cancelled', 'stale')),
      route_kind TEXT NOT NULL CHECK (route_kind IN ('default_continue')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_fingerprint TEXT NOT NULL,
      material_fingerprint TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      total_steps INTEGER NOT NULL DEFAULT 0,
      completed_steps INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learning_message_batch_runs_session_status
      ON learning_message_batch_runs(session_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tutor_prefetches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('default_continue')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'consumed', 'stale', 'failed', 'cancelled')),
      base_message_count INTEGER NOT NULL,
      base_last_message_id TEXT,
      base_current_chunk_id TEXT,
      base_covered_chunk_ids_json TEXT NOT NULL,
      base_session_fingerprint TEXT NOT NULL,
      target_event TEXT NOT NULL,
      target_module_id TEXT,
      target_chunk_id TEXT,
      cursor_after_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_fingerprint TEXT NOT NULL,
      material_fingerprint TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tutor_prefetches_session_kind_status
      ON tutor_prefetches(session_id, kind, status, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tutor_prefetches_unique_ready_base
      ON tutor_prefetches(session_id, kind, base_session_fingerprint)
      WHERE status IN ('queued', 'generating', 'ready');

    CREATE TABLE IF NOT EXISTS learner_signals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      module_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('misconception', 'strength', 'interest', 'remediation')),
      content TEXT NOT NULL,
      evidence_message_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS module_progress (
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed', 'needs_review')),
      mastery_score REAL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, module_id)
    );

    CREATE TABLE IF NOT EXISTS material_annotations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      source_id TEXT,
      chunk_id TEXT NOT NULL,
      surface TEXT NOT NULL DEFAULT 'source' CHECK (surface IN ('chat', 'source')),
      anchor_message_id TEXT,
      anchor_block_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('define', 'lookup', 'question', 'image', 'note', 'highlight')),
      selected_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      result_json TEXT NOT NULL,
      source_meta_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_material_annotations_material_chunk
      ON material_annotations(material_id, chunk_id, created_at ASC);
  `);

  const projectColumns = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all().map((column) => column.name);
  if (!projectColumns.includes("root_path")) {
    db.exec("ALTER TABLE projects ADD COLUMN root_path TEXT;");
  }
  if (!projectColumns.includes("learning_level")) {
    db.exec("ALTER TABLE projects ADD COLUMN learning_level TEXT NOT NULL DEFAULT 'medium';");
  }
  const messageColumns = db.query<{ name: string }, []>("PRAGMA table_info(learning_messages)").all().map((column) => column.name);
  if (!messageColumns.includes("choices_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN choices_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!messageColumns.includes("blocks_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!messageColumns.includes("delivery_state")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'visible';");
  }
  if (!messageColumns.includes("batch_run_id")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN batch_run_id TEXT;");
  }
  if (!messageColumns.includes("cursor_before_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN cursor_before_json TEXT;");
  }
  if (!messageColumns.includes("cursor_after_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN cursor_after_json TEXT;");
  }
  const sessionColumns = db.query<{ name: string }, []>("PRAGMA table_info(learning_sessions)").all().map((column) => column.name);
  if (!sessionColumns.includes("current_chunk_id")) {
    db.exec("ALTER TABLE learning_sessions ADD COLUMN current_chunk_id TEXT;");
  }
  if (!sessionColumns.includes("covered_chunk_ids_json")) {
    db.exec("ALTER TABLE learning_sessions ADD COLUMN covered_chunk_ids_json TEXT NOT NULL DEFAULT '[]';");
  }
  const materialColumns = db.query<{ name: string }, []>("PRAGMA table_info(learning_materials)").all().map((column) => column.name);
  if (!materialColumns.includes("lecture_plan_path")) {
    db.exec("ALTER TABLE learning_materials ADD COLUMN lecture_plan_path TEXT;");
  }
  if (!materialColumns.includes("presentation_plan_path")) {
    db.exec("ALTER TABLE learning_materials ADD COLUMN presentation_plan_path TEXT;");
  }
  if (!materialColumns.includes("critic_report_path")) {
    db.exec("ALTER TABLE learning_materials ADD COLUMN critic_report_path TEXT;");
  }
  const annotationColumns = db.query<{ name: string }, []>("PRAGMA table_info(material_annotations)").all().map((column) => column.name);
  if (!annotationColumns.includes("anchor_message_id")) {
    db.exec("ALTER TABLE material_annotations ADD COLUMN anchor_message_id TEXT;");
  }
  if (!annotationColumns.includes("anchor_block_id")) {
    db.exec("ALTER TABLE material_annotations ADD COLUMN anchor_block_id TEXT;");
  }
  if (!annotationColumns.includes("surface")) {
    db.exec("ALTER TABLE material_annotations ADD COLUMN surface TEXT NOT NULL DEFAULT 'source';");
    db.exec(`
      UPDATE material_annotations
      SET surface = CASE
        WHEN anchor_message_id IS NOT NULL OR anchor_block_id IS NOT NULL THEN 'chat'
        ELSE 'source'
      END;
    `);
  }
  migrateMaterialAnnotationKindCheck(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_material_annotations_material_chunk
      ON material_annotations(material_id, chunk_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS learning_message_batch_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'ready', 'partial', 'failed', 'cancelled', 'stale')),
      route_kind TEXT NOT NULL CHECK (route_kind IN ('default_continue')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_fingerprint TEXT NOT NULL,
      material_fingerprint TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      total_steps INTEGER NOT NULL DEFAULT 0,
      completed_steps INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learning_message_batch_runs_session_status
      ON learning_message_batch_runs(session_id, status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_learning_messages_prepared_batch
      ON learning_messages(session_id, delivery_state, ordinal ASC);

    UPDATE learning_message_batch_runs
      SET status = CASE WHEN completed_steps > 0 THEN 'partial' ELSE 'cancelled' END,
          updated_at = strftime('%s', 'now') * 1000
      WHERE status = 'generating';
  `);
  normalizeMessageOrdinals(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_messages_session_ordinal_unique
      ON learning_messages(session_id, ordinal ASC);
  `);

  return db;
}

export function closeDbForTests() {
  db?.close();
  db = null;
}

function migrateMaterialAnnotationKindCheck(database: Database) {
  const row = database
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'material_annotations'")
    .get();
  if (!row?.sql || row.sql.includes("'question'")) return;

  const migrate = database.transaction(() => {
    database.exec(`
      ALTER TABLE material_annotations RENAME TO material_annotations_old;

      CREATE TABLE material_annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES learning_materials(id) ON DELETE CASCADE,
        source_id TEXT,
        chunk_id TEXT NOT NULL,
        surface TEXT NOT NULL DEFAULT 'source' CHECK (surface IN ('chat', 'source')),
        anchor_message_id TEXT,
        anchor_block_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('define', 'lookup', 'question', 'image', 'note', 'highlight')),
        selected_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        result_json TEXT NOT NULL,
        source_meta_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO material_annotations
       (id, project_id, material_id, source_id, chunk_id, surface, anchor_message_id, anchor_block_id, kind, selected_text, normalized_text,
        result_json, source_meta_json, created_at, updated_at)
      SELECT
        id, project_id, material_id, source_id, chunk_id, surface, anchor_message_id, anchor_block_id, kind, selected_text, normalized_text,
        result_json, source_meta_json, created_at, updated_at
      FROM material_annotations_old;

      DROP TABLE material_annotations_old;
    `);
  });
  migrate();
}

function normalizeMessageOrdinals(database: Database) {
  const sessionIds = database.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM learning_messages").all();
  const update = database.query("UPDATE learning_messages SET ordinal = ? WHERE id = ?");
  const normalize = database.transaction((sessionId: string) => {
    const rows = database
      .query<{ id: string; ordinal: number; created_at: number }, [string]>(
        "SELECT id, ordinal, created_at FROM learning_messages WHERE session_id = ? ORDER BY ordinal ASC, created_at ASC, id ASC"
      )
      .all(sessionId);
    rows.forEach((row, index) => {
      if (row.ordinal !== index) update.run(index, row.id);
    });
  });
  for (const row of sessionIds) normalize(row.session_id);
}
