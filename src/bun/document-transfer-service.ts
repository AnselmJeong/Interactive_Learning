import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DocumentTransferCounts,
  DocumentTransferExport,
  DocumentTransferImportPreview,
  DocumentTransferImportResult,
  DocumentTransferManifest,
  DocumentTransferPreview,
} from "../shared/document-transfer-types";
import { readZipEntries } from "./archive-reader";
import { writeZipFromDirectory } from "./archive-writer";
import { getDb } from "./project-db";
import { writeProjectDocumentIndex } from "./project-bundle-sync";
import { dataPath } from "./paths";
import { SettingsService } from "./settings-service";
import { refreshMaterialArtifactChecksums, validateTransferredMaterialArtifacts } from "./material-artifact-validation";

const MAX_ARCHIVE_BYTES = 2_000_000_000;
const MAX_FILE_COUNT = 10_000;
const MAX_FILE_BYTES = 500_000_000;
const MAX_TOTAL_BYTES = 4_000_000_000;
const TABLE_ORDER = [
  "project_documents", "project_sources", "learning_materials", "material_sources", "learning_message_sets",
  "prepared_learning_messages", "learning_sessions", "learning_messages", "session_module_progress",
  "learner_signals", "module_progress", "material_annotations",
] as const;
type TransferTable = typeof TABLE_ORDER[number];
type TransferState = { schemaVersion: 1; tables: Record<TransferTable, Array<Record<string, unknown>>> };
type DocumentRow = { id: string; project_id: string; title: string; document_type: "book" | "article" };
type PreparedDocumentTransfer = {
  dir: string;
  manifest: DocumentTransferManifest;
  state: TransferState;
  preview: DocumentTransferImportPreview;
};

const preparedTransfers = new Map<string, PreparedDocumentTransfer>();

function hash(data: string | Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function stringify(value: unknown) { return JSON.stringify(stable(value)); }
function safePart(value: string) { return value.replace(/[\/:*?"<>|#{}\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "document"; }
function stamp() { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
function collisionSafePath(folder: string, name: string) { const stem = name.replace(/\.zip$/, ""); let path = join(folder, `${stem}.zip`); for (let i = 2; existsSync(path); i += 1) path = join(folder, `${stem}-${i}.zip`); return path; }

function safeArchivePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((part) => part === "." || part === "..") || normalized.split("/").length > 14) {
    throw new Error(`Unsafe path in document transfer: ${path}`);
  }
  return normalized;
}

function portablePath(projectDir: string, value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const path = relative(projectDir, value).replaceAll("\\", "/");
  if (!path || path === "." || path.startsWith("../") || isAbsolute(path)) throw new Error("Document data is outside its portable project folder");
  return path;
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Document transfer cannot contain symbolic links");
    if (entry.isDirectory()) result.push(...await filesUnder(root, path));
    else if (entry.isFile()) result.push(relative(root, path).replaceAll("\\", "/"));
  }
  return result.sort();
}

async function manifestFiles(root: string) {
  return Promise.all((await filesUnder(root)).map(async (path) => {
    const bytes = await readFile(join(root, path));
    return { path, size: bytes.length, sha256: hash(bytes) };
  }));
}

function tableRows(documentId: string): TransferState {
  const db = getDb();
  const sources = db.query<Record<string, unknown>, [string]>("SELECT * FROM project_sources WHERE document_id = ? ORDER BY source_ordinal, id").all(documentId);
  const sourceIds = sources.map((row) => String(row.id));
  const placeholders = sourceIds.map(() => "?").join(", ");
  const documents = db.query<Record<string, unknown>, [string]>("SELECT * FROM project_documents WHERE id = ?").all(documentId);
  const materialIds = sourceIds.length ? db.query<{ material_id: string }, string[]>(`
    SELECT DISTINCT material_id FROM material_sources WHERE source_id IN (${placeholders})
  `).all(...sourceIds).map((row) => row.material_id) : [];
  const materialPlaceholders = materialIds.map(() => "?").join(", ");
  const materials = materialIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM learning_materials WHERE id IN (${materialPlaceholders}) ORDER BY id`).all(...materialIds) : [];
  const materialSources = materialIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM material_sources WHERE material_id IN (${materialPlaceholders}) ORDER BY material_id, ordinal`).all(...materialIds) : [];
  const sets = materialIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM learning_message_sets WHERE material_id IN (${materialPlaceholders}) ORDER BY id`).all(...materialIds) : [];
  const setIds = sets.map((row) => String(row.id));
  const setPlaceholders = setIds.map(() => "?").join(", ");
  const prepared = setIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM prepared_learning_messages WHERE message_set_id IN (${setPlaceholders}) ORDER BY message_set_id, route_index`).all(...setIds) : [];
  const sessions = materialIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM learning_sessions WHERE material_id IN (${materialPlaceholders}) ORDER BY id`).all(...materialIds) : [];
  const sessionIds = sessions.map((row) => String(row.id));
  const sessionPlaceholders = sessionIds.map(() => "?").join(", ");
  const messages = sessionIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM learning_messages WHERE session_id IN (${sessionPlaceholders}) ORDER BY session_id, ordinal`).all(...sessionIds) : [];
  const moduleProgress = sessionIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM session_module_progress WHERE session_id IN (${sessionPlaceholders})`).all(...sessionIds) : [];
  const signals = sessionIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM learner_signals WHERE session_id IN (${sessionPlaceholders})`).all(...sessionIds) : [];
  const progress = sessionIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM module_progress WHERE session_id IN (${sessionPlaceholders})`).all(...sessionIds) : [];
  const annotations = materialIds.length ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM material_annotations WHERE material_id IN (${materialPlaceholders}) ORDER BY id`).all(...materialIds) : [];
  return { schemaVersion: 1, tables: {
    project_documents: documents, project_sources: sources, learning_materials: materials, material_sources: materialSources,
    learning_message_sets: sets, prepared_learning_messages: prepared, learning_sessions: sessions, learning_messages: messages,
    session_module_progress: moduleProgress, learner_signals: signals, module_progress: progress, material_annotations: annotations,
  } };
}

function crossDocumentMaterialCount(documentId: string) {
  return getDb().query<{ count: number }, [string, string]>(`
    SELECT COUNT(DISTINCT ms.material_id) AS count FROM material_sources ms
    WHERE ms.source_id IN (SELECT id FROM project_sources WHERE document_id = ?)
      AND EXISTS (SELECT 1 FROM material_sources other JOIN project_sources source ON source.id = other.source_id
                  WHERE other.material_id = ms.material_id AND source.document_id <> ?)
  `).get(documentId, documentId)?.count || 0;
}

function counts(state: TransferState, assets: number, crossDocumentMaterials: number): DocumentTransferCounts {
  const rows = state.tables;
  return { sources: rows.project_sources.length, materials: rows.learning_materials.length, sessions: rows.learning_sessions.length,
    messages: rows.learning_messages.length, preparedMessages: rows.prepared_learning_messages.length,
    annotations: rows.material_annotations.length, assets, crossDocumentMaterials };
}

function normalizeStatePaths(state: TransferState, projectDir: string) {
  for (const document of state.tables.project_documents) {
    document.original_file_path = null;
    document.cover_image_path = document.cover_image_path ? portablePath(projectDir, document.cover_image_path) : null;
  }
  for (const source of state.tables.project_sources) {
    source.original_file_path = null;
    source.imported_file_path = portablePath(projectDir, source.imported_file_path);
    source.manifest_path = source.manifest_path ? portablePath(projectDir, source.manifest_path) : null;
    source.chunks_path = source.chunks_path ? portablePath(projectDir, source.chunks_path) : null;
  }
  for (const material of state.tables.learning_materials) {
    for (const column of ["manifest_path", "concept_map_path", "course_plan_path", "overview_path", "lecture_plan_path", "presentation_plan_path", "critic_report_path", "visual_specs_path", "source_index_path"]) {
      material[column] = material[column] ? portablePath(projectDir, material[column]) : null;
    }
  }
  for (const set of state.tables.learning_message_sets) {
    if (["queued", "generating", "waiting_for_provider"].includes(String(set.status))) set.status = "interrupted";
    set.generation_owner_id = null;
    set.lease_expires_at = null;
  }
  return state;
}

function rewritePortableValue(value: unknown, mode: "export" | "import", projectDir: string, replacements: Map<string, string>, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => rewritePortableValue(item, mode, projectDir, replacements));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === "originalPath") continue;
      output[childKey] = rewritePortableValue(child, mode, projectDir, replacements, childKey);
    }
    return output;
  }
  if (typeof value !== "string") return value;
  let rewritten = value;
  for (const [before, after] of replacements) rewritten = rewritten.replaceAll(before, after);
  if (key === "assetPath") return mode === "export" ? portablePath(projectDir, rewritten) : join(projectDir, safeArchivePath(rewritten));
  if (key === "assetUrl" && mode === "export" && rewritten.startsWith("file:")) {
    try { return portablePath(projectDir, fileURLToPath(rewritten)); } catch { return rewritten; }
  }
  if (key === "assetUrl" && mode === "import" && !/^[a-z][a-z0-9+.-]*:/i.test(rewritten)) return pathToFileURL(join(projectDir, safeArchivePath(rewritten))).href;
  return rewritten;
}

async function rewriteJsonFiles(root: string, mode: "export" | "import", projectDir: string, replacements = new Map<string, string>()) {
  for (const relativePath of await filesUnder(root)) {
    if (!relativePath.endsWith(".json") || relativePath === "state.json") continue;
    const path = join(root, relativePath);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    await writeFile(path, `${JSON.stringify(rewritePortableValue(parsed, mode, projectDir, replacements), null, 2)}\n`, "utf8");
  }
}

async function enrichSourceManifests(payload: string, state: TransferState) {
  for (const source of state.tables.project_sources) {
    const path = join(payload, "sources", String(source.id), "source_manifest.json");
    if (!existsSync(path)) continue;
    try {
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      manifest.documentId = source.document_id;
      manifest.sourceOrdinal = source.source_ordinal;
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch {
      // Invalid optional source manifests are ignored; state.json remains authoritative.
    }
  }
}

async function deviceId() {
  const path = dataPath("device-id.txt");
  const existing = await readFile(path, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const id = crypto.randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${id}\n`, "utf8");
  return id;
}

function latestDocumentHead(documentId: string) {
  return getDb().query<{ export_id: string; document_state_hash: string }, [string]>(`
    SELECT export_id, document_state_hash FROM document_transfer_history
    WHERE local_document_id = ? ORDER BY transferred_at DESC, rowid DESC LIMIT 1
  `).get(documentId);
}

async function copyDocumentFiles(projectDir: string, payload: string, state: TransferState) {
  const copied = new Set<string>();
  const copyRelative = async (relativePath: string) => {
    const safe = safeArchivePath(relativePath);
    if (copied.has(safe)) return;
    const source = join(projectDir, safe);
    if (!existsSync(source)) return;
    await cp(source, join(payload, safe), { recursive: true, force: true });
    copied.add(safe);
  };
  for (const source of state.tables.project_sources) {
    await copyRelative(`sources/${String(source.id)}`);
    const imported = portablePath(projectDir, source.imported_file_path);
    if (imported?.startsWith("source_folders/")) await copyRelative(imported.split("/").slice(0, 2).join("/"));
  }
  for (const material of state.tables.learning_materials) await copyRelative(`materials/${String(material.id)}`);
  for (const session of state.tables.learning_sessions) await copyRelative(`sessions/${String(session.id)}`);
  for (const document of state.tables.project_documents) {
    const cover = document.cover_image_path ? portablePath(projectDir, document.cover_image_path) : null;
    if (cover) await copyRelative(cover);
  }
}

function validateManifest(value: unknown): DocumentTransferManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid document transfer manifest");
  const manifest = value as DocumentTransferManifest;
  if (manifest.format !== "learnie-document-transfer" || manifest.schemaVersion !== 1 || manifest.minimumReaderSchemaVersion > 1) throw new Error("Unsupported document transfer schema");
  if (![manifest.exportId, manifest.originProjectId, manifest.originDocumentId, manifest.documentTitle, manifest.deviceId]
    .every((item) => typeof item === "string" && item.length > 0)) throw new Error("Document transfer identity is incomplete");
  if (!Array.isArray(manifest.files) || !manifest.counts || !Number.isFinite(Date.parse(manifest.exportedAt))) throw new Error("Document transfer manifest is incomplete");
  return manifest;
}

function validateState(value: unknown, manifest: DocumentTransferManifest) {
  if (!value || typeof value !== "object") throw new Error("Document transfer state is invalid");
  const state = value as TransferState;
  if (state.schemaVersion !== 1 || !state.tables || typeof state.tables !== "object") throw new Error("Document transfer state schema is invalid");
  for (const table of TABLE_ORDER) if (!Array.isArray(state.tables[table])) throw new Error(`Missing document transfer table: ${table}`);
  if (state.tables.project_documents.length !== 1 || state.tables.project_documents[0]?.id !== manifest.originDocumentId) throw new Error("Document state does not match its manifest");
  const sourceIds = new Set(state.tables.project_sources.map((row) => String(row.id)));
  const materialIds = new Set(state.tables.learning_materials.map((row) => String(row.id)));
  for (const source of state.tables.project_sources) if (source.document_id !== manifest.originDocumentId) throw new Error("Document transfer contains a source from another document");
  for (const membership of state.tables.material_sources) {
    if (!sourceIds.has(String(membership.source_id)) || !materialIds.has(String(membership.material_id))) throw new Error("Document transfer material graph is incomplete");
  }
  return state;
}

function replacementsFor(state: TransferState, destinationProjectId: string) {
  const replacements = new Map<string, string>();
  const addRows = (table: TransferTable) => {
    for (const row of state.tables[table]) if (typeof row.id === "string") replacements.set(row.id, crypto.randomUUID());
  };
  for (const table of ["project_documents", "project_sources", "learning_materials", "learning_message_sets", "prepared_learning_messages", "learning_sessions", "learning_messages", "learner_signals", "material_annotations"] as TransferTable[]) addRows(table);
  const originProjectId = String(state.tables.project_documents[0]?.project_id || "");
  if (originProjectId && originProjectId !== destinationProjectId) replacements.set(originProjectId, destinationProjectId);
  return new Map([...replacements.entries()].sort(([a], [b]) => b.length - a.length));
}

function remapState(state: TransferState, destinationProjectId: string, replacements: Map<string, string>, projectDir: string) {
  const remapped = rewritePortableValue(state, "import", projectDir, replacements) as TransferState;
  for (const table of TABLE_ORDER) {
    for (const row of remapped.tables[table]) {
      if ("project_id" in row) row.project_id = destinationProjectId;
      if (table === "project_documents") {
        row.original_file_path = null;
        if (row.cover_image_path) row.cover_image_path = join(projectDir, safeArchivePath(String(row.cover_image_path)));
      }
      if (table === "project_sources") {
        row.original_file_path = null;
        row.imported_file_path = join(projectDir, safeArchivePath(String(row.imported_file_path)));
        if (row.manifest_path) row.manifest_path = join(projectDir, safeArchivePath(String(row.manifest_path)));
        if (row.chunks_path) row.chunks_path = join(projectDir, safeArchivePath(String(row.chunks_path)));
      }
      if (table === "learning_materials") {
        for (const column of ["manifest_path", "concept_map_path", "course_plan_path", "overview_path", "lecture_plan_path", "presentation_plan_path", "critic_report_path", "visual_specs_path", "source_index_path"]) {
          if (row[column]) row[column] = join(projectDir, safeArchivePath(String(row[column])));
        }
        if (typeof row.overview_json === "string" && row.overview_json) {
          try {
            row.overview_json = JSON.stringify(rewritePortableValue(JSON.parse(row.overview_json), "import", projectDir, replacements));
          } catch {
            // Keep malformed legacy inline JSON unchanged; the artifact loader will use adjacent files.
          }
        }
      }
    }
  }
  return remapped;
}

function quoted(identifier: string) { return `"${identifier.replaceAll('"', '""')}"`; }

function insertState(state: TransferState) {
  for (const table of TABLE_ORDER) {
    const allowed = new Set(getDb().query<{ name: string }, []>(`PRAGMA table_info(${quoted(table)})`).all().map((column) => column.name));
    for (const row of state.tables[table]) {
      const columns = Object.keys(row);
      if (!columns.length || columns.some((column) => !allowed.has(column))) throw new Error(`Invalid columns in transferred ${table} data`);
      getDb().query(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => row[column]) as never[]);
    }
  }
}

export class DocumentTransferService {
  private readonly settings = new SettingsService();

  preview(projectId: string, documentId: string): DocumentTransferPreview {
    const document = getDb().query<DocumentRow, [string, string]>("SELECT id, project_id, title, document_type FROM project_documents WHERE project_id = ? AND id = ?").get(projectId, documentId);
    if (!document) throw new Error("Document not found");
    const state = tableRows(documentId);
    const crossDocumentMaterials = crossDocumentMaterialCount(documentId);
    return { documentId, documentTitle: document.title, documentType: document.document_type,
      classification: crossDocumentMaterials ? "cross_document_blocked" : "ready",
      counts: counts(state, 0, crossDocumentMaterials),
      warnings: crossDocumentMaterials ? ["다른 자료의 source를 함께 사용하는 학습 자료가 있어 이 자료만 안전하게 내보낼 수 없습니다. Project 전체 transfer를 사용하세요."] : [] };
  }

  async export(projectId: string, documentId: string, destinationFolder?: string): Promise<DocumentTransferExport> {
    const preview = this.preview(projectId, documentId);
    if (preview.classification !== "ready") throw new Error(preview.warnings[0]);
    const rawState = tableRows(documentId);
    const projectRoot = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId)?.root_path || dataPath("projects");
    const projectDir = join(projectRoot, projectId);
    const outputFolder = destinationFolder || (await this.settings.get()).defaultDownloadFolder;
    const staging = await mkdtemp(join(tmpdir(), "learnie-document-transfer-"));
    try {
      const payload = join(staging, "document");
      await mkdir(payload, { recursive: true });
      await copyDocumentFiles(projectDir, payload, rawState);
      await rewriteJsonFiles(payload, "export", projectDir);
      await refreshMaterialArtifactChecksums(join(payload, "materials"));
      await enrichSourceManifests(payload, rawState);
      const state = normalizeStatePaths(rawState, projectDir);
      await writeFile(join(payload, "state.json"), `${stringify(state)}\n`, "utf8");
      const assetCount = (await filesUnder(payload)).filter((path) => path !== "state.json").length;
      const finalCounts = counts(state, assetCount, 0);
      const exportId = crypto.randomUUID();
      const head = latestDocumentHead(documentId);
      const exportedAt = new Date().toISOString();
      const manifest: DocumentTransferManifest = {
        format: "learnie-document-transfer", schemaVersion: 1, minimumReaderSchemaVersion: 1, exportId,
        parentExportId: head?.export_id || null, deviceId: await deviceId(), originProjectId: projectId,
        originDocumentId: documentId, documentTitle: preview.documentTitle, documentType: preview.documentType,
        exportedAt, documentStateHash: hash(stringify(state)), counts: finalCounts,
        files: (await manifestFiles(payload)).map((file) => ({ ...file, path: `document/${file.path}` })),
      };
      await writeFile(join(staging, "document-transfer.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await mkdir(outputFolder, { recursive: true });
      const zipPath = collisionSafePath(outputFolder, `${safePart(preview.documentTitle)}-learnie-document-${stamp()}.zip`);
      const partialPath = `${zipPath}.partial`;
      await writeZipFromDirectory(staging, partialPath);
      await this.validateExport(partialPath, manifest);
      await rename(partialPath, zipPath);
      getDb().query(`INSERT INTO document_transfer_history
        (id, export_id, local_document_id, origin_document_id, origin_project_id, parent_export_id, device_id, direction, document_state_hash, transferred_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'export', ?, ?, ?)`)
        .run(crypto.randomUUID(), exportId, documentId, documentId, projectId, manifest.parentExportId, manifest.deviceId, manifest.documentStateHash, Date.parse(exportedAt), Date.now());
      return { ...preview, counts: finalCounts, zipPath, fileName: basename(zipPath), exportId, validated: true };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async exportAll(projectId: string, destinationFolder?: string) {
    const documents = getDb().query<{ id: string }, [string]>("SELECT id FROM project_documents WHERE project_id = ? ORDER BY imported_at, id").all(projectId);
    const exported: DocumentTransferExport[] = [];
    const blocked: string[] = [];
    for (const document of documents) {
      const preview = this.preview(projectId, document.id);
      if (preview.classification !== "ready") { blocked.push(preview.documentTitle); continue; }
      exported.push(await this.export(projectId, document.id, destinationFolder));
    }
    if (blocked.length) throw new Error(`${exported.length}개 자료는 내보냈지만 교차 자료 material이 있는 ${blocked.length}개 자료는 건너뛰었습니다: ${blocked.join(", ")}`);
    return exported;
  }

  async prepareImport(path: string, destinationProjectId: string): Promise<DocumentTransferImportPreview> {
    if (!getDb().query("SELECT id FROM projects WHERE id = ?").get(destinationProjectId)) throw new Error("Destination project not found");
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) throw new Error("Document transfer ZIP is too large or is not a file");
    const rawFiles = readZipEntries(await Bun.file(path).bytes(), { maxFileCount: MAX_FILE_COUNT, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
    const files = new Map<string, Uint8Array>();
    for (const [rawPath, bytes] of rawFiles) files.set(safeArchivePath(rawPath), bytes);
    const manifestBytes = files.get("document-transfer.json");
    if (!manifestBytes) throw new Error("This ZIP does not contain document-transfer.json");
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const listed = new Set(manifest.files.map((file) => safeArchivePath(file.path)));
    if (listed.size !== manifest.files.length) throw new Error("Document transfer manifest contains duplicate file entries");
    for (const entry of files.keys()) if (entry !== "document-transfer.json" && !listed.has(entry)) throw new Error(`Unlisted file in document transfer: ${entry}`);
    for (const expected of manifest.files) {
      const bytes = files.get(safeArchivePath(expected.path));
      if (!bytes || bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error(`Document transfer checksum failed: ${expected.path}`);
    }
    const stateBytes = files.get("document/state.json");
    if (!stateBytes) throw new Error("Document transfer state is missing");
    const state = validateState(JSON.parse(new TextDecoder().decode(stateBytes)), manifest);
    validateTransferredMaterialArtifacts(
      files,
      state.tables.learning_materials.map((material) => String(material.id)),
      "document",
    );
    if (hash(stringify(state)) !== manifest.documentStateHash) throw new Error("Document transfer state hash does not match its manifest");
    const actualAssets = manifest.files.filter((file) => safeArchivePath(file.path) !== "document/state.json").length;
    const calculatedCounts = counts(state, actualAssets, 0);
    if (stringify(calculatedCounts) !== stringify(manifest.counts)) throw new Error("Document transfer counts do not match its payload");

    const dir = await mkdtemp(join(tmpdir(), "learnie-document-transfer-import-"));
    try {
      for (const [name, bytes] of files) {
        if (name === "document-transfer.json") continue;
        const target = resolve(dir, name);
        if (!target.startsWith(`${resolve(dir)}/`)) throw new Error(`Unsafe document transfer path: ${name}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const applied = getDb().query<{ local_document_id: string | null }, [string, string]>(`
        SELECT h.local_document_id FROM document_transfer_history h
        JOIN project_documents d ON d.id = h.local_document_id
        WHERE h.export_id = ? AND d.project_id = ? ORDER BY h.transferred_at DESC LIMIT 1
      `).get(manifest.exportId, destinationProjectId);
      const lineage = getDb().query<{ local_document_id: string | null; document_state_hash: string }, [string, string]>(`
        SELECT h.local_document_id, h.document_state_hash FROM document_transfer_history h
        JOIN project_documents d ON d.id = h.local_document_id
        WHERE h.origin_document_id = ? AND d.project_id = ? ORDER BY h.transferred_at DESC LIMIT 1
      `).get(manifest.originDocumentId, destinationProjectId);
      const classification = applied ? "no_changes" : lineage ? "diverged" : "create_document";
      const warnings = classification === "diverged"
        ? ["같은 자료의 학습 상태가 대상 project에서 이미 변경되었습니다. 자동으로 덮어쓰지 않습니다."]
        : [];
      const preview: DocumentTransferImportPreview = {
        importId: crypto.randomUUID(), fileName: basename(path), destinationProjectId,
        documentTitle: manifest.documentTitle, documentType: manifest.documentType, exportedAt: manifest.exportedAt,
        classification, counts: manifest.counts, warnings,
      };
      preparedTransfers.set(preview.importId, { dir, manifest, state, preview });
      return preview;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async commitImport(importId: string): Promise<DocumentTransferImportResult> {
    const prepared = preparedTransfers.get(importId);
    if (!prepared) throw new Error("Prepared document transfer expired; choose the ZIP again");
    const { dir, manifest, state, preview } = prepared;
    if (preview.classification === "diverged" || preview.classification === "invalid") throw new Error(preview.warnings[0] || "Document transfer cannot be imported");
    if (preview.classification === "no_changes") {
      const existing = getDb().query<{ local_document_id: string | null }, [string, string]>(`
        SELECT h.local_document_id FROM document_transfer_history h JOIN project_documents d ON d.id = h.local_document_id
        WHERE h.export_id = ? AND d.project_id = ? ORDER BY h.transferred_at DESC LIMIT 1
      `).get(manifest.exportId, preview.destinationProjectId);
      await this.cancelImport(importId);
      return { projectId: preview.destinationProjectId, documentId: existing?.local_document_id || null, classification: "no_changes", imported: false };
    }
    const project = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(preview.destinationProjectId);
    if (!project) throw new Error("Destination project no longer exists");
    const root = project.root_path || dataPath("projects");
    const projectDir = join(root, preview.destinationProjectId);
    const replacements = replacementsFor(state, preview.destinationProjectId);
    const sourceFolderIds = new Set<string>();
    for (const path of await filesUnder(join(dir, "document"))) {
      const match = /^source_folders\/([^/]+)/.exec(path);
      if (match?.[1]) sourceFolderIds.add(match[1]);
    }
    for (const id of sourceFolderIds) replacements.set(id, crypto.randomUUID());
    const remapped = remapState(state, preview.destinationProjectId, replacements, projectDir);
    const localDocumentId = String(remapped.tables.project_documents[0]!.id);
    const mappedFiles = await mkdtemp(join(tmpdir(), "learnie-document-transfer-mapped-"));
    const installed: string[] = [];
    try {
      const payload = join(dir, "document");
      for (const path of await filesUnder(payload)) {
        if (path === "state.json") continue;
        let mappedPath = path;
        for (const [before, after] of replacements) mappedPath = mappedPath.replaceAll(before, after);
        const target = join(mappedFiles, safeArchivePath(mappedPath));
        await mkdir(dirname(target), { recursive: true });
        if (path.endsWith(".json")) {
          try {
            const parsed = JSON.parse(await readFile(join(payload, path), "utf8"));
            await writeFile(target, `${JSON.stringify(rewritePortableValue(parsed, "import", projectDir, replacements), null, 2)}\n`, "utf8");
            continue;
          } catch { /* preserve non-JSON bytes below */ }
        }
        await cp(join(payload, path), target, { force: false });
      }
      await refreshMaterialArtifactChecksums(join(mappedFiles, "materials"));
      await mkdir(projectDir, { recursive: true });
      for (const top of await readdir(mappedFiles)) {
        const source = join(mappedFiles, top);
        const target = join(projectDir, top);
        if (existsSync(target) && !(await stat(target)).isDirectory()) throw new Error(`Document import target already exists: ${top}`);
        if (!existsSync(target)) {
          await cp(source, target, { recursive: true, force: false, errorOnExist: true });
          installed.push(target);
        } else {
          for (const child of await readdir(source)) {
            const childTarget = join(target, child);
            if (existsSync(childTarget)) throw new Error(`Document import target already exists: ${top}/${child}`);
            await cp(join(source, child), childTarget, { recursive: true, force: false, errorOnExist: true });
            installed.push(childTarget);
          }
        }
      }
      getDb().transaction(() => {
        insertState(remapped);
        getDb().query(`INSERT INTO document_transfer_history
          (id, export_id, local_document_id, origin_document_id, origin_project_id, parent_export_id, device_id, direction, document_state_hash, transferred_at, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`)
          .run(crypto.randomUUID(), manifest.exportId, localDocumentId, manifest.originDocumentId, manifest.originProjectId,
            manifest.parentExportId, manifest.deviceId, manifest.documentStateHash, Date.parse(manifest.exportedAt), Date.now());
      })();
      await writeProjectDocumentIndex(preview.destinationProjectId, root).catch(() => undefined);
      await this.cancelImport(importId);
      return { projectId: preview.destinationProjectId, documentId: localDocumentId, classification: "create_document", imported: true };
    } catch (error) {
      for (const path of installed.reverse()) await rm(path, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(mappedFiles, { recursive: true, force: true });
    }
  }

  async cancelImport(importId: string) {
    const prepared = preparedTransfers.get(importId);
    if (!prepared) return false;
    preparedTransfers.delete(importId);
    await rm(prepared.dir, { recursive: true, force: true });
    return true;
  }

  private async validateExport(path: string, manifest: DocumentTransferManifest) {
    const files = readZipEntries(await Bun.file(path).bytes());
    const rawManifest = files.get("document-transfer.json");
    if (!rawManifest) throw new Error("Document export validation failed: manifest is missing");
    const parsed = validateManifest(JSON.parse(new TextDecoder().decode(rawManifest)));
    if (parsed.exportId !== manifest.exportId) throw new Error("Document export validation failed: manifest identity mismatch");
    const listed = new Set(manifest.files.map((entry) => safeArchivePath(entry.path)));
    for (const entry of files.keys()) if (entry !== "document-transfer.json" && !listed.has(safeArchivePath(entry))) throw new Error(`Document export validation failed: unlisted file ${entry}`);
    for (const entry of manifest.files) {
      const bytes = files.get(entry.path);
      if (!bytes || bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Document export validation failed: ${entry.path}`);
    }
    const state = files.get("document/state.json");
    if (!state || hash(new TextDecoder().decode(state).trim()) !== manifest.documentStateHash) throw new Error("Document export validation failed: state checksum mismatch");
  }
}
