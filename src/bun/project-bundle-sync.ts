import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getDb } from "./project-db";
import { dataPath } from "./paths";
import { listMaterialAnnotations, replaceMaterialAnnotations } from "./annotation-store";
import type { MaterialAnnotation, MaterialManifest, QualityStatus, SourceManifest, SourceType } from "../shared/artifact-types";
import type { ProjectSummary } from "../shared/rpc-types";
import type { SessionSnapshot, TutorMessage } from "../shared/tutor-types";

const PROJECT_BUNDLE_SCHEMA_VERSION = 1;

type ProjectBundleManifest = {
  schemaVersion: number;
  id: string;
  title: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

function isNotFound(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) return null;
    console.warn(`[project-sync] Failed to read ${path}`, error);
    return null;
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestamp(value: unknown, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function qualityStatus(value: unknown): QualityStatus {
  return value === "good" || value === "warning" || value === "poor" ? value : "warning";
}

function sourceType(value: unknown): SourceType {
  return value === "markdown" || value === "pdf" || value === "text" ? value : "text";
}

function titleFromFile(path: string) {
  return basename(path).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || basename(path);
}

async function firstExistingFile(dir: string, names: string[]) {
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const original = entries.find((entry) => entry.isFile() && entry.name.startsWith("original."));
    return original ? join(dir, original.name) : "";
  } catch {
    return "";
  }
}

async function hashProjectFile(primaryPath: string, fallbackPaths: string[]) {
  const hasher = new Bun.CryptoHasher("sha256");
  let used = false;
  for (const path of [primaryPath, ...fallbackPaths]) {
    if (!path || !existsSync(path)) continue;
    hasher.update(await readFile(path));
    used = true;
  }
  if (!used) hasher.update(primaryPath);
  return hasher.digest("hex");
}

async function childDirs(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function validProjectIdsInRoot(rootPath: string) {
  const ids = new Set<string>();
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = join(rootPath, entry.name, "project.json");
    if (existsSync(manifestPath)) ids.add(entry.name);
  }
  return ids;
}

async function purgeDbProjectsMissingFromRoot(rootPath: string, validProjectIds: Set<string>) {
  const rows = getDb()
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE root_path = ?")
    .all(rootPath);
  for (const row of rows) {
    if (validProjectIds.has(row.id)) continue;
    console.warn(`[project-sync] Removing cached project missing from root: ${row.id}`);
    getDb().query("DELETE FROM projects WHERE id = ?").run(row.id);
  }
}

export function projectManifestFromSummary(project: ProjectSummary): ProjectBundleManifest {
  return {
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    id: project.id,
    title: project.title,
    description: project.description,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
  };
}

export async function writeProjectManifest(project: ProjectSummary) {
  await writeJson(join(project.rootPath, project.id, "project.json"), projectManifestFromSummary(project));
}

async function importProject(rootPath: string, projectId: string) {
  const projectDir = join(rootPath, projectId);
  const manifestPath = join(projectDir, "project.json");
  if (!existsSync(manifestPath)) return;
  const manifest = await readJson<ProjectBundleManifest>(manifestPath);
  if (!manifest?.id) return;
  const now = Date.now();
  const createdAt = timestamp(manifest?.createdAt, now);
  const updatedAt = timestamp(manifest?.updatedAt, createdAt);
  const archivedAt = manifest?.archivedAt ? timestamp(manifest.archivedAt, 0) : null;
  const title = manifest?.title?.trim() || projectId;
  const description = typeof manifest?.description === "string" ? manifest.description : null;

  getDb()
    .query(
      `INSERT INTO projects (id, title, description, root_path, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         root_path = excluded.root_path,
         updated_at = max(projects.updated_at, excluded.updated_at),
         archived_at = excluded.archived_at`
    )
    .run(projectId, title, description, rootPath, createdAt, updatedAt, archivedAt);

  await importSources(projectDir, projectId);
  await importMaterials(projectDir, projectId);
  await importMaterialAnnotations(projectDir, projectId);
  await importSessions(projectDir, projectId);
}

async function importSources(projectDir: string, projectId: string) {
  for (const sourceId of await childDirs(join(projectDir, "sources"))) {
    const dir = join(projectDir, "sources", sourceId);
    const manifestPath = join(dir, "source_manifest.json");
    const chunksPath = join(dir, "source_chunks.json");
    const manifest = await readJson<SourceManifest>(manifestPath);
    if (!manifest?.id) continue;

    const importedPath = await firstExistingFile(dir, ["original.md", "original.pdf", "original.txt"]);
    const originalFileName = importedPath ? basename(importedPath) : basename(manifest.originalPath || `${manifest.title || sourceId}.txt`);
    const type = sourceType(manifest.sourceType);
    const createdAt = timestamp(manifest.importedAt);
    const contentHash = await hashProjectFile(importedPath, [manifestPath, chunksPath]);

    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path,
          content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           source_type = excluded.source_type,
           original_file_name = excluded.original_file_name,
           original_file_path = excluded.original_file_path,
           imported_file_path = excluded.imported_file_path,
           content_hash = excluded.content_hash,
           manifest_path = excluded.manifest_path,
           chunks_path = excluded.chunks_path,
           quality_status = excluded.quality_status,
           updated_at = excluded.updated_at`
      )
      .run(
        manifest.id,
        projectId,
        manifest.title || titleFromFile(originalFileName),
        type,
        originalFileName,
        manifest.originalPath || null,
        importedPath || manifestPath,
        contentHash,
        manifestPath,
        existsSync(chunksPath) ? chunksPath : null,
        qualityStatus(manifest.quality?.status),
        createdAt,
        createdAt
      );
  }
}

async function importMaterials(projectDir: string, projectId: string) {
  for (const materialId of await childDirs(join(projectDir, "materials"))) {
    const dir = join(projectDir, "materials", materialId);
    const manifestPath = join(dir, "material_manifest.json");
    const manifest = await readJson<MaterialManifest>(manifestPath);
    if (!manifest?.id) continue;

    const generatedAt = timestamp(manifest.generatedAt);
    const paths = {
      concepts: join(dir, "concept_map.json"),
      course: join(dir, "course_plan.json"),
      lecture: join(dir, "lecture_plan.json"),
      presentation: join(dir, "presentation_plan.json"),
      critic: join(dir, "critic_report.json"),
      visuals: join(dir, "visual_specs.json"),
      index: join(dir, "source_index.json"),
    };

    getDb()
      .query(
        `INSERT INTO learning_materials
         (id, project_id, title, material_type, status, manifest_path, concept_map_path, course_plan_path,
          lecture_plan_path, presentation_plan_path, critic_report_path, visual_specs_path, source_index_path,
          generation_error, created_at, updated_at)
         VALUES (?, ?, ?, 'source_course', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           status = excluded.status,
           manifest_path = excluded.manifest_path,
           concept_map_path = excluded.concept_map_path,
           course_plan_path = excluded.course_plan_path,
           lecture_plan_path = excluded.lecture_plan_path,
           presentation_plan_path = excluded.presentation_plan_path,
           critic_report_path = excluded.critic_report_path,
           visual_specs_path = excluded.visual_specs_path,
           source_index_path = excluded.source_index_path,
           generation_error = excluded.generation_error,
           updated_at = excluded.updated_at`
      )
      .run(
        manifest.id,
        projectId,
        manifest.title || materialId,
        manifest.status === "failed" || manifest.status === "generating" || manifest.status === "draft" ? manifest.status : "ready",
        manifestPath,
        existsSync(paths.concepts) ? paths.concepts : null,
        existsSync(paths.course) ? paths.course : null,
        existsSync(paths.lecture) ? paths.lecture : null,
        existsSync(paths.presentation) ? paths.presentation : null,
        existsSync(paths.critic) ? paths.critic : null,
        existsSync(paths.visuals) ? paths.visuals : null,
        existsSync(paths.index) ? paths.index : null,
        generatedAt,
        generatedAt
      );

    getDb().query("DELETE FROM material_sources WHERE material_id = ?").run(manifest.id);
    for (const [index, sourceId] of (manifest.sourceIds || []).entries()) {
      const exists = getDb().query<{ id: string }, [string]>("SELECT id FROM project_sources WHERE id = ?").get(sourceId);
      if (exists) getDb().query("INSERT OR IGNORE INTO material_sources (material_id, source_id, ordinal) VALUES (?, ?, ?)").run(manifest.id, sourceId, index);
    }
  }
}

async function importMaterialAnnotations(projectDir: string, projectId: string) {
  for (const materialId of await childDirs(join(projectDir, "materials"))) {
    const material = getDb()
      .query<{ id: string }, [string, string]>("SELECT id FROM learning_materials WHERE id = ? AND project_id = ?")
      .get(materialId, projectId);
    if (!material) continue;

    const annotationsPath = join(projectDir, "materials", materialId, "annotations.json");
    const annotations = await readJson<MaterialAnnotation[]>(annotationsPath);
    if (Array.isArray(annotations)) {
      replaceMaterialAnnotations(materialId, annotations.filter((annotation) => annotation?.materialId === materialId));
      continue;
    }

    const cached = listMaterialAnnotations(materialId);
    if (cached.length) {
      await writeJson(annotationsPath, cached);
    }
  }
}

async function importSessions(projectDir: string, projectId: string) {
  for (const sessionId of await childDirs(join(projectDir, "sessions"))) {
    const snapshot = await readJson<SessionSnapshot>(join(projectDir, "sessions", sessionId, "session.json"));
    if (!snapshot?.id || snapshot.projectId !== projectId) continue;
    const material = getDb().query<{ id: string }, [string]>("SELECT id FROM learning_materials WHERE id = ?").get(snapshot.materialId);
    if (!material) continue;
    const existing = getDb().query<{ updated_at: number }, [string]>("SELECT updated_at FROM learning_sessions WHERE id = ?").get(snapshot.id);
    if (existing && existing.updated_at > snapshot.updatedAt) continue;

    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json,
          current_chunk_id, covered_chunk_ids_json, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           material_id = excluded.material_id,
           title = excluded.title,
           status = excluded.status,
           current_module_id = excluded.current_module_id,
           completed_module_ids_json = excluded.completed_module_ids_json,
           current_chunk_id = excluded.current_chunk_id,
           covered_chunk_ids_json = excluded.covered_chunk_ids_json,
           model = excluded.model,
           updated_at = max(learning_sessions.updated_at, excluded.updated_at)`
      )
      .run(
        snapshot.id,
        projectId,
        snapshot.materialId,
        snapshot.title,
        snapshot.status,
        snapshot.currentModuleId,
        JSON.stringify(snapshot.completedModuleIds || []),
        snapshot.currentChunkId,
        JSON.stringify(snapshot.coveredChunkIds || []),
        snapshot.model || null,
        snapshot.createdAt,
        snapshot.updatedAt
      );

    getDb().query("DELETE FROM learning_messages WHERE session_id = ?").run(snapshot.id);
    for (const message of snapshot.messages || []) importMessage(snapshot.id, message);
  }
}

function importMessage(sessionId: string, message: TutorMessage) {
  getDb()
    .query(
      `INSERT INTO learning_messages
       (id, session_id, role, content, blocks_json, module_id, source_refs_json, choices_json,
        visual_id, state_update_json, created_at, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      message.id,
      sessionId,
      message.role,
      message.content,
      JSON.stringify(message.blocks || []),
      message.moduleId || null,
      JSON.stringify(message.sourceRefs || []),
      JSON.stringify(message.choices || []),
      message.visualId || null,
      message.stateUpdate ? JSON.stringify(message.stateUpdate) : null,
      message.createdAt,
      message.ordinal
    );
}

export async function syncProjectRootToDb(rootPath: string) {
  await mkdir(rootPath, { recursive: true });
  const validProjectIds = await validProjectIdsInRoot(rootPath);
  await purgeDbProjectsMissingFromRoot(rootPath, validProjectIds);
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!validProjectIds.has(entry.name)) continue;
    const projectDir = join(rootPath, entry.name);
    try {
      const info = await stat(projectDir);
      if (!info.isDirectory()) continue;
      await importProject(rootPath, entry.name);
    } catch (error) {
      console.warn(`[project-sync] Failed to import ${projectDir}`, error);
    }
  }
}

export async function writeSessionSnapshot(rootPath: string, snapshot: SessionSnapshot) {
  const sessionDir = join(rootPath, snapshot.projectId, "sessions", snapshot.id);
  await mkdir(sessionDir, { recursive: true });
  await writeJson(join(sessionDir, "session.json"), {
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    ...snapshot,
  });
}

export async function writeMaterialAnnotationsSnapshot(materialId: string) {
  const row = getDb()
    .query<{ project_id: string; root_path: string | null }, [string]>(
      `SELECT learning_materials.project_id, projects.root_path
       FROM learning_materials
       JOIN projects ON projects.id = learning_materials.project_id
       WHERE learning_materials.id = ?`
    )
    .get(materialId);
  if (!row) return;

  const rootPath = row.root_path || dataPath("projects");
  const annotationsPath = join(rootPath, row.project_id, "materials", materialId, "annotations.json");
  await writeJson(annotationsPath, listMaterialAnnotations(materialId));
}
