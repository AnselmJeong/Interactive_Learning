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
      created_at INTEGER NOT NULL,
      ordinal INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learning_messages_session_ordinal
      ON learning_messages(session_id, ordinal ASC);

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
  `);

  const projectColumns = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all().map((column) => column.name);
  if (!projectColumns.includes("root_path")) {
    db.exec("ALTER TABLE projects ADD COLUMN root_path TEXT;");
  }
  const messageColumns = db.query<{ name: string }, []>("PRAGMA table_info(learning_messages)").all().map((column) => column.name);
  if (!messageColumns.includes("choices_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN choices_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!messageColumns.includes("blocks_json")) {
    db.exec("ALTER TABLE learning_messages ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]';");
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

  return db;
}
