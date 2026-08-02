import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDb } from "./project-db";
import { dataPath } from "./paths";
import { listMaterialAnnotations, replaceMaterialAnnotations } from "./annotation-store";
import type { DocumentType, MaterialAnnotation, MaterialManifest, MaterialOverview, QualityStatus, SourceManifest, SourceType } from "../shared/artifact-types";
import type { ProjectSummary } from "../shared/rpc-types";
import type { SessionSnapshot, TutorMessage } from "../shared/tutor-types";
import { normalizeLearningLevel, type LearningLevel } from "../shared/learning-levels";

const PROJECT_BUNDLE_SCHEMA_VERSION = 4;

type ProjectBundleManifest = {
  schemaVersion: number;
  id: string;
  title: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  learningLevel?: LearningLevel;
};

type ProjectDocumentBundle = {
  id: string;
  projectId: string;
  documentType: DocumentType;
  title: string;
  subtitle: string | null;
  description: string | null;
  authorsJson: string;
  publisher: string | null;
  publishedDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  journal: string | null;
  doi: string | null;
  language: string | null;
  metadataStatus: string;
  originalFileName: string;
  originalFilePath: string | null;
  contentHash: string | null;
  coverImagePath: string | null;
  provider: string | null;
  providerVolumeId: string | null;
  metadataFetchedAt: number | null;
  metadataOverridesJson: string;
  sourceIds: string[];
  importedAt: number;
  updatedAt: number;
};

export function resolveRecoveredDocumentMembership(input: {
  sourceId: string;
  manifestDocumentId?: string;
  manifestSourceOrdinal?: number;
  originalPath?: string;
  documents: Array<Pick<ProjectDocumentBundle, "id" | "originalFilePath" | "sourceIds">>;
}) {
  if (input.manifestDocumentId) return { documentId: input.manifestDocumentId, sourceOrdinal: input.manifestSourceOrdinal ?? 0 };
  for (const document of input.documents) {
    const ordinal = document.sourceIds?.indexOf(input.sourceId) ?? -1;
    if (ordinal >= 0) return { documentId: document.id, sourceOrdinal: ordinal };
  }
  const normalizedOrigin = (value: string | null | undefined) =>
    (value || "").replaceAll("\\", "/").split("#", 1)[0]!.replace(/\/+$/, "").toLocaleLowerCase();
  const origin = normalizedOrigin(input.originalPath);
  const matching = origin ? input.documents.find((document) => normalizedOrigin(document.originalFilePath) === origin) : undefined;
  return matching ? { documentId: matching.id, sourceOrdinal: input.manifestSourceOrdinal ?? 0 } : null;
}

type ProjectBundleMarker = {
  kind: "source" | "material" | "session";
  path: string;
  projectId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
};

type ProjectSyncIssue = {
  folderName?: string;
  path: string;
  reason: "root_unavailable" | "missing_manifest" | "invalid_manifest" | "import_failed" | "sync_disabled";
  message: string;
  recoverable: boolean;
};

type ProjectSyncReport = {
  rootPath: string;
  available: boolean;
  scannedAt: number;
  scannedFolderCount: number;
  foundProjectCount: number;
  importedProjectCount: number;
  recoveredProjectCount: number;
  skippedFolderCount: number;
  removedCacheCount: number;
  issues: ProjectSyncIssue[];
};

type ProjectRootDiscovery = {
  validProjectIds: Set<string>;
  recoveredProjectIds: Set<string>;
  scannedFolderCount: number;
  skippedFolderCount: number;
  hasIndeterminateFolders: boolean;
  issues: ProjectSyncIssue[];
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

function optionalTimestamp(value: unknown) {
  const parsed = timestamp(value, 0);
  return parsed > 0 ? parsed : undefined;
}

function qualityStatus(value: unknown): QualityStatus {
  return value === "good" || value === "warning" || value === "poor" ? value : "warning";
}

function sourceType(value: unknown): SourceType {
  return value === "markdown" || value === "pdf" || value === "text" ? value : "text";
}

function documentType(value: unknown): DocumentType {
  return value === "article" ? "article" : "book";
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

function baseSyncReport(rootPath: string, available: boolean): ProjectSyncReport {
  return {
    rootPath,
    available,
    scannedAt: Date.now(),
    scannedFolderCount: 0,
    foundProjectCount: 0,
    importedProjectCount: 0,
    recoveredProjectCount: 0,
    skippedFolderCount: 0,
    removedCacheCount: 0,
    issues: [],
  };
}

function projectSyncIssue(input: {
  path: string;
  folderName?: string;
  reason: ProjectSyncIssue["reason"];
  message: string;
  recoverable: boolean;
}): ProjectSyncIssue {
  return input;
}

async function projectBundleMarkers(projectDir: string) {
  const markers: ProjectBundleMarker[] = [];
  for (const sourceId of await childDirs(join(projectDir, "sources"))) {
    const path = join(projectDir, "sources", sourceId, "source_manifest.json");
    const manifest = await readJson<SourceManifest>(path);
    if (!manifest?.id) continue;
    markers.push({
      kind: "source",
      path,
      projectId: manifest.projectId,
      title: manifest.title,
      createdAt: optionalTimestamp(manifest.importedAt),
      updatedAt: optionalTimestamp(manifest.updatedAt || manifest.importedAt),
    });
  }

  for (const materialId of await childDirs(join(projectDir, "materials"))) {
    const path = join(projectDir, "materials", materialId, "material_manifest.json");
    const manifest = await readJson<MaterialManifest>(path);
    if (!manifest?.id) continue;
    const generatedAt = optionalTimestamp(manifest.generatedAt);
    markers.push({
      kind: "material",
      path,
      projectId: manifest.projectId,
      title: manifest.title,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    });
  }

  for (const sessionId of await childDirs(join(projectDir, "sessions"))) {
    const path = join(projectDir, "sessions", sessionId, "session.json");
    const snapshot = await readJson<SessionSnapshot>(path);
    if (!snapshot?.id) continue;
    markers.push({
      kind: "session",
      path,
      projectId: snapshot.projectId,
      title: snapshot.title,
      createdAt: optionalTimestamp(snapshot.createdAt),
      updatedAt: optionalTimestamp(snapshot.updatedAt),
    });
  }
  return markers;
}

export async function recoverProjectManifestIfPossible(rootPath: string, projectDirName: string) {
  const projectDir = join(rootPath, projectDirName);
  const manifestPath = join(projectDir, "project.json");
  const markers = await projectBundleMarkers(projectDir);
  if (!markers.length) return { recovered: false, markerCount: 0 };

  const info = await stat(projectDir).catch(() => null);
  const markerTimes = markers.flatMap((marker) => [marker.createdAt, marker.updatedAt]).filter((value): value is number => typeof value === "number");
  const createdAt = markerTimes.length ? Math.min(...markerTimes) : info?.birthtimeMs || Date.now();
  const updatedAt = markerTimes.length ? Math.max(...markerTimes) : info?.mtimeMs || createdAt;
  const title = markers.find((marker) => marker.title?.trim())?.title?.trim() || titleFromFile(projectDirName);
  const manifest: ProjectBundleManifest = {
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    id: projectDirName,
    title,
    description: null,
    createdAt,
    updatedAt,
    archivedAt: null,
    learningLevel: "medium",
  };
  await writeJson(manifestPath, manifest);
  return { recovered: true, markerCount: markers.length, manifest };
}

async function discoverProjectsInRoot(rootPath: string): Promise<ProjectRootDiscovery> {
  const discovery: ProjectRootDiscovery = {
    validProjectIds: new Set(),
    recoveredProjectIds: new Set(),
    scannedFolderCount: 0,
    skippedFolderCount: 0,
    hasIndeterminateFolders: false,
    issues: [],
  };
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    discovery.scannedFolderCount += 1;
    const manifestPath = join(rootPath, entry.name, "project.json");
    if (existsSync(manifestPath)) {
      const manifest = await readJson<ProjectBundleManifest>(manifestPath);
      if (manifest?.id) {
        discovery.validProjectIds.add(entry.name);
        continue;
      }
      const recovered = await recoverProjectManifestIfPossible(rootPath, entry.name);
      if (recovered.recovered) {
        discovery.validProjectIds.add(entry.name);
        discovery.recoveredProjectIds.add(entry.name);
        continue;
      }
      discovery.hasIndeterminateFolders = true;
      discovery.skippedFolderCount += 1;
      discovery.issues.push(projectSyncIssue({
        path: manifestPath,
        folderName: entry.name,
        reason: "invalid_manifest",
        message: "Project manifest exists but could not be read as a valid project bundle.",
        recoverable: true,
      }));
      continue;
    }

    const recovered = await recoverProjectManifestIfPossible(rootPath, entry.name);
    if (recovered.recovered) {
      discovery.validProjectIds.add(entry.name);
      discovery.recoveredProjectIds.add(entry.name);
      continue;
    }

    discovery.hasIndeterminateFolders = true;
    discovery.skippedFolderCount += 1;
    discovery.issues.push(projectSyncIssue({
      path: join(rootPath, entry.name),
      folderName: entry.name,
      reason: "missing_manifest",
      message: "Folder does not contain project.json or recognizable project bundle artifacts.",
      recoverable: true,
    }));
  }
  return discovery;
}

export function shouldPurgeProjectsMissingFromRoot(validProjectIds: Set<string>, hasIndeterminateFolders = false) {
  return validProjectIds.size > 0 && !hasIndeterminateFolders;
}

async function purgeDbProjectsMissingFromRoot(rootPath: string, validProjectIds: Set<string>, hasIndeterminateFolders: boolean) {
  if (!shouldPurgeProjectsMissingFromRoot(validProjectIds, hasIndeterminateFolders)) {
    console.warn(`[project-sync] Project root is incomplete or empty; keeping cached projects for ${rootPath}.`);
    return 0;
  }
  const rows = getDb()
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE root_path = ?")
    .all(rootPath);
  let removed = 0;
  for (const row of rows) {
    if (validProjectIds.has(row.id)) continue;
    console.warn(`[project-sync] Removing cached project missing from root: ${row.id}`);
    removed += getDb().query("DELETE FROM projects WHERE id = ?").run(row.id).changes;
  }
  return removed;
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
    learningLevel: normalizeLearningLevel(project.learningLevel),
  };
}

export async function writeProjectManifest(project: ProjectSummary) {
  await writeJson(join(project.rootPath, project.id, "project.json"), projectManifestFromSummary(project));
  await writeProjectDocumentIndex(project.id, project.rootPath);
}

export async function writeProjectDocumentIndex(projectId: string, rootPath: string) {
  const projectDir = join(rootPath, projectId);
  const portablePath = (value: string | null) => {
    if (!value) return null;
    const portable = relative(projectDir, value).replaceAll("\\", "/");
    return !portable || portable === "." || portable.startsWith("../") || isAbsolute(portable) ? null : portable;
  };
  const rows = getDb().query<{
    id: string; project_id: string; document_type: DocumentType; title: string; subtitle: string | null;
    description: string | null; authors_json: string; publisher: string | null; published_date: string | null;
    isbn_10: string | null; isbn_13: string | null; journal: string | null; doi: string | null;
    language: string | null; metadata_status: string; original_file_name: string; original_file_path: string | null;
    content_hash: string | null; cover_image_path: string | null; provider: string | null;
    provider_volume_id: string | null; metadata_fetched_at: number | null; metadata_overrides_json: string;
    imported_at: number; updated_at: number;
  }, [string]>("SELECT * FROM project_documents WHERE project_id = ? ORDER BY imported_at, id").all(projectId);
  const documents: ProjectDocumentBundle[] = rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    documentType: row.document_type,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    authorsJson: row.authors_json,
    publisher: row.publisher,
    publishedDate: row.published_date,
    isbn10: row.isbn_10,
    isbn13: row.isbn_13,
    journal: row.journal,
    doi: row.doi,
    language: row.language,
    metadataStatus: row.metadata_status,
    originalFileName: row.original_file_name,
    originalFilePath: null,
    contentHash: row.content_hash,
    coverImagePath: portablePath(row.cover_image_path),
    provider: row.provider,
    providerVolumeId: row.provider_volume_id,
    metadataFetchedAt: row.metadata_fetched_at,
    metadataOverridesJson: row.metadata_overrides_json,
    sourceIds: getDb().query<{ id: string }, [string]>(
      "SELECT id FROM project_sources WHERE document_id = ? ORDER BY COALESCE(source_ordinal, 2147483647), created_at, id"
    ).all(row.id).map((source) => source.id),
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  }));
  const memberships = getDb().query<{
    id: string; document_id: string | null; source_ordinal: number | null; manifest_path: string | null;
  }, [string]>("SELECT id, document_id, source_ordinal, manifest_path FROM project_sources WHERE project_id = ?").all(projectId);
  for (const membership of memberships) {
    if (!membership.manifest_path || !membership.document_id) continue;
    const manifestPath = resolve(membership.manifest_path);
    if (!manifestPath.startsWith(`${resolve(projectDir)}${sep}`)) continue;
    const manifest = await readJson<SourceManifest>(manifestPath);
    if (!manifest || (manifest.documentId === membership.document_id && manifest.sourceOrdinal === membership.source_ordinal)) continue;
    await writeJson(manifestPath, { ...manifest, documentId: membership.document_id, sourceOrdinal: membership.source_ordinal ?? undefined });
  }
  await writeJson(join(rootPath, projectId, "documents.json"), { schemaVersion: 1, documents });
}

async function importProject(rootPath: string, projectId: string) {
  const projectDir = join(rootPath, projectId);
  const manifestPath = join(projectDir, "project.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = await readJson<ProjectBundleManifest>(manifestPath);
  if (!manifest?.id) return false;
  const now = Date.now();
  const createdAt = timestamp(manifest?.createdAt, now);
  const updatedAt = timestamp(manifest?.updatedAt, createdAt);
  const archivedAt = manifest?.archivedAt ? timestamp(manifest.archivedAt, 0) : null;
  const title = manifest?.title?.trim() || projectId;
  const description = typeof manifest?.description === "string" ? manifest.description : null;
  const learningLevel = normalizeLearningLevel(manifest.learningLevel);

  getDb()
    .query(
      `INSERT INTO projects (id, title, description, root_path, learning_level, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         root_path = excluded.root_path,
         learning_level = excluded.learning_level,
         updated_at = max(projects.updated_at, excluded.updated_at),
         archived_at = excluded.archived_at`
    )
    .run(projectId, title, description, rootPath, learningLevel, createdAt, updatedAt, archivedAt);

  await importDocuments(projectDir, projectId);
  await importSources(projectDir, projectId);
  await importMaterials(projectDir, projectId);
  await importMaterialAnnotations(projectDir, projectId);
  await importSessions(projectDir, projectId);
  return true;
}

async function importDocuments(projectDir: string, projectId: string) {
  const stored = await readJson<{ schemaVersion?: number; documents?: ProjectDocumentBundle[] }>(join(projectDir, "documents.json"));
  for (const document of stored?.documents || []) {
    if (!document?.id || document.projectId !== projectId) continue;
    getDb().query(`
      INSERT INTO project_documents
      (id, project_id, document_type, title, subtitle, description, authors_json, publisher, published_date,
       isbn_10, isbn_13, journal, doi, language, metadata_status, original_file_name, original_file_path,
       content_hash, cover_image_path, provider, provider_volume_id, metadata_fetched_at,
       metadata_overrides_json, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, document_type = excluded.document_type, title = excluded.title,
        subtitle = excluded.subtitle, description = excluded.description, authors_json = excluded.authors_json,
        publisher = excluded.publisher, published_date = excluded.published_date, isbn_10 = excluded.isbn_10,
        isbn_13 = excluded.isbn_13, journal = excluded.journal, doi = excluded.doi, language = excluded.language,
        metadata_status = excluded.metadata_status, original_file_name = excluded.original_file_name,
        original_file_path = excluded.original_file_path, content_hash = excluded.content_hash,
        cover_image_path = excluded.cover_image_path, provider = excluded.provider,
        provider_volume_id = excluded.provider_volume_id, metadata_fetched_at = excluded.metadata_fetched_at,
        metadata_overrides_json = excluded.metadata_overrides_json, updated_at = excluded.updated_at
    `).run(
      document.id, projectId, documentType(document.documentType), document.title || titleFromFile(document.originalFileName),
      document.subtitle, document.description, document.authorsJson || "[]", document.publisher, document.publishedDate,
      document.isbn10, document.isbn13, document.journal, document.doi, document.language,
      ["found", "not_found", "manual", "failed"].includes(document.metadataStatus) ? document.metadataStatus : "pending",
      document.originalFileName || document.title, document.originalFilePath, document.contentHash,
      document.coverImagePath && resolve(projectDir, document.coverImagePath).startsWith(`${resolve(projectDir)}${sep}`)
        ? resolve(projectDir, document.coverImagePath)
        : null,
      document.provider || null, document.providerVolumeId || null,
      document.metadataFetchedAt || null, document.metadataOverridesJson || "{}",
      timestamp(document.importedAt), timestamp(document.updatedAt || document.importedAt),
    );
  }
}

async function importSources(projectDir: string, projectId: string) {
  const stored = await readJson<{ documents?: ProjectDocumentBundle[] }>(join(projectDir, "documents.json"));
  for (const sourceId of await childDirs(join(projectDir, "sources"))) {
    const dir = join(projectDir, "sources", sourceId);
    const manifestPath = join(dir, "source_manifest.json");
    const chunksPath = join(dir, "source_chunks.json");
    const manifest = await readJson<SourceManifest>(manifestPath);
    if (!manifest?.id) continue;

    const importedPath = await firstExistingFile(dir, ["original.md", "original.pdf", "original.txt"]);
    const originalFileName = importedPath ? basename(importedPath) : basename(manifest.originalPath || `${manifest.title || sourceId}.txt`);
    const type = sourceType(manifest.sourceType);
    const sourceDocumentType = documentType(manifest.documentType);
    const createdAt = timestamp(manifest.importedAt);
    const updatedAt = timestamp(manifest.updatedAt || manifest.importedAt);
    const contentHash = await hashProjectFile(importedPath, [manifestPath, chunksPath]);
    const recoveredMembership = resolveRecoveredDocumentMembership({
      sourceId: manifest.id,
      manifestDocumentId: manifest.documentId,
      manifestSourceOrdinal: manifest.sourceOrdinal,
      originalPath: manifest.originalPath,
      documents: stored?.documents || [],
    });
    const documentId = recoveredMembership?.documentId || `document-${(new Bun.CryptoHasher("sha256").update(`${projectId}\u0000${manifest.id}`).digest("hex")).slice(0, 32)}`;
    getDb().query(`
      INSERT OR IGNORE INTO project_documents
      (id, project_id, document_type, title, original_file_name, original_file_path, content_hash, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, projectId, sourceDocumentType, manifest.title || titleFromFile(originalFileName), originalFileName, manifest.originalPath || null, contentHash, createdAt, updatedAt);

    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path,
          document_type, document_id, source_ordinal, source_kind, content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           source_type = excluded.source_type,
           document_type = excluded.document_type,
           document_id = excluded.document_id,
           source_ordinal = excluded.source_ordinal,
           source_kind = excluded.source_kind,
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
        sourceDocumentType,
        documentId,
        recoveredMembership?.sourceOrdinal ?? 0,
        sourceDocumentType === "article" ? "article" : "chapter",
        contentHash,
        manifestPath,
        existsSync(chunksPath) ? chunksPath : null,
        qualityStatus(manifest.quality?.status),
        createdAt,
        updatedAt
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
      overview: join(dir, "material_overview.json"),
      lecture: join(dir, "lecture_plan.json"),
      presentation: join(dir, "presentation_plan.json"),
      critic: join(dir, "critic_report.json"),
      visuals: join(dir, "visual_specs.json"),
      index: join(dir, "source_index.json"),
    };
    const overview = existsSync(paths.overview) ? await readJson<MaterialOverview>(paths.overview) : null;

    getDb()
      .query(
        `INSERT INTO learning_materials
         (id, project_id, title, material_type, status, manifest_path, concept_map_path, course_plan_path, overview_path, overview_json,
          lecture_plan_path, presentation_plan_path, critic_report_path, visual_specs_path, source_index_path,
          generation_error, created_at, updated_at)
         VALUES (?, ?, ?, 'source_course', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           status = excluded.status,
           manifest_path = excluded.manifest_path,
           concept_map_path = excluded.concept_map_path,
           course_plan_path = excluded.course_plan_path,
           overview_path = excluded.overview_path,
           overview_json = excluded.overview_json,
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
        existsSync(paths.overview) ? paths.overview : null,
        overview ? JSON.stringify(overview) : null,
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
    if (!shouldImportSessionSnapshot(existing?.updated_at, snapshot.updatedAt)) continue;
    const messageSetId = snapshot.messageSetId && getDb().query<{ id: string }, [string]>("SELECT id FROM learning_message_sets WHERE id = ?").get(snapshot.messageSetId)
      ? snapshot.messageSetId
      : null;

    const importSnapshot = getDb().transaction(() => {
      getDb()
        .query(
          `INSERT INTO learning_sessions
           (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json,
            current_chunk_id, covered_chunk_ids_json, model, message_set_id, last_revealed_route_index,
            last_revealed_message_id, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             message_set_id = COALESCE(excluded.message_set_id, learning_sessions.message_set_id),
             last_revealed_route_index = excluded.last_revealed_route_index,
             last_revealed_message_id = excluded.last_revealed_message_id,
             started_at = excluded.started_at,
             updated_at = excluded.updated_at`
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
          messageSetId,
          snapshot.lastRevealedRouteIndex ?? -1,
          snapshot.lastRevealedMessageId || null,
          snapshot.messages?.length ? snapshot.messages[0]?.createdAt || snapshot.createdAt : null,
          snapshot.createdAt,
          snapshot.updatedAt
        );

      getDb().query("DELETE FROM learning_messages WHERE session_id = ?").run(snapshot.id);
      [...(snapshot.messages || [])]
        .sort((left, right) => left.ordinal - right.ordinal || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .forEach((message, index) => importMessage(snapshot.id, { ...message, ordinal: index }));
    });
    importSnapshot();
  }
}

export function shouldImportSessionSnapshot(existingUpdatedAt: number | null | undefined, snapshotUpdatedAt: number) {
  return existingUpdatedAt == null || existingUpdatedAt < snapshotUpdatedAt;
}

function importMessage(sessionId: string, message: TutorMessage) {
  getDb()
    .query(
      `INSERT INTO learning_messages
       (id, session_id, role, content, blocks_json, module_id, source_refs_json, choices_json,
        visual_id, state_update_json, origin_prepared_message_id, conversation_kind, created_at, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      message.originPreparedMessageId && getDb().query<{ id: string }, [string]>("SELECT id FROM prepared_learning_messages WHERE id = ?").get(message.originPreparedMessageId)
        ? message.originPreparedMessageId
        : null,
      message.conversationKind || "main",
      message.createdAt,
      message.ordinal
    );
}

export async function syncProjectRootToDb(rootPath: string) {
  const report = baseSyncReport(rootPath, false);
  report.issues.push(projectSyncIssue({
    path: rootPath,
    reason: "sync_disabled",
    message: "Project root sync is disabled; only local database projects are listed.",
    recoverable: false,
  }));
  return report;
}

export async function writeSessionSnapshot(rootPath: string, snapshot: SessionSnapshot) {
  const sessionDir = join(rootPath, snapshot.projectId, "sessions", snapshot.id);
  await mkdir(sessionDir, { recursive: true });
  await writeJson(join(sessionDir, "session.json"), {
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    ...snapshot,
  });
}

export async function deleteSessionSnapshot(rootPath: string, projectId: string, sessionId: string) {
  await rm(join(rootPath, projectId, "sessions", sessionId), { recursive: true, force: true });
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
