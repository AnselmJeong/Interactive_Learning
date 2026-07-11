import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_INFO } from "../shared/app-info";
import type {
  ProjectTransferClassification,
  ProjectTransferExport,
  ProjectTransferImportResult,
  ProjectTransferManifest,
  ProjectTransferPreview,
} from "../shared/project-transfer-types";
import { writeZipFromDirectory } from "./archive-writer";
import { readZipEntries } from "./archive-reader";
import { dataPath } from "./paths";
import { getDb } from "./project-db";
import { SettingsService } from "./settings-service";

const TRANSFER_SCHEMA_VERSION = 1;
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const MAX_FILE_COUNT = 10_000;
const MAX_FILE_BYTES = 500_000_000;
const MAX_TOTAL_BYTES = 4_000_000_000;

const TABLE_QUERIES = {
  projects: "SELECT * FROM projects WHERE id = ?",
  project_sources: "SELECT * FROM project_sources WHERE project_id = ? ORDER BY id",
  learning_materials: "SELECT * FROM learning_materials WHERE project_id = ? ORDER BY id",
  material_sources: "SELECT ms.* FROM material_sources ms JOIN learning_materials m ON m.id = ms.material_id WHERE m.project_id = ? ORDER BY ms.material_id, ms.ordinal",
  learning_message_sets: "SELECT s.* FROM learning_message_sets s JOIN learning_materials m ON m.id = s.material_id WHERE m.project_id = ? ORDER BY s.id",
  prepared_learning_messages: "SELECT p.* FROM prepared_learning_messages p JOIN learning_message_sets s ON s.id = p.message_set_id JOIN learning_materials m ON m.id = s.material_id WHERE m.project_id = ? ORDER BY p.message_set_id, p.route_index",
  learning_sessions: "SELECT * FROM learning_sessions WHERE project_id = ? ORDER BY id",
  learning_messages: "SELECT msg.* FROM learning_messages msg JOIN learning_sessions s ON s.id = msg.session_id WHERE s.project_id = ? AND msg.delivery_state = 'visible' ORDER BY msg.session_id, msg.ordinal",
  session_module_progress: "SELECT p.* FROM session_module_progress p JOIN learning_sessions s ON s.id = p.session_id WHERE s.project_id = ? ORDER BY p.session_id, p.module_id",
  learner_signals: "SELECT l.* FROM learner_signals l JOIN learning_sessions s ON s.id = l.session_id WHERE s.project_id = ? ORDER BY l.id",
  module_progress: "SELECT p.* FROM module_progress p JOIN learning_sessions s ON s.id = p.session_id WHERE s.project_id = ? ORDER BY p.session_id, p.module_id",
  material_annotations: "SELECT * FROM material_annotations WHERE project_id = ? ORDER BY id",
} as const;

type TransferTable = keyof typeof TABLE_QUERIES;
type TransferState = { schemaVersion: number; tables: Record<TransferTable, Array<Record<string, unknown>>> };
type PreparedTransfer = { dir: string; manifest: ProjectTransferManifest; state: TransferState; preview: ProjectTransferPreview };

const preparedTransfers = new Map<string, PreparedTransfer>();
const INSERT_ORDER: TransferTable[] = [
  "projects", "project_sources", "learning_materials", "material_sources", "learning_message_sets",
  "prepared_learning_messages", "learning_sessions", "learning_messages", "session_module_progress",
  "learner_signals", "module_progress", "material_annotations",
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableStringify(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(data: string | Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

function safeFilePart(value: string, fallback = "project") {
  return value.replace(/[\\/:*?"<>|#{}\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

function stamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function collisionSafePath(folder: string, baseName: string) {
  const stem = baseName.endsWith(".zip") ? baseName.slice(0, -4) : baseName;
  let candidate = join(folder, `${stem}.zip`);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(folder, `${stem}-${index}.zip`);
  return candidate;
}

function portablePath(root: string, path: unknown) {
  if (typeof path !== "string" || !path) return "";
  const rel = relative(root, path).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("A project source is outside its portable project folder");
  return rel;
}

function normalizeStatePaths(state: TransferState, projectDir: string) {
  const project = state.tables.projects[0];
  if (project) {
    project.root_path = null;
    project.last_opened_at = null;
  }
  for (const source of state.tables.project_sources) {
    source.imported_file_path = portablePath(projectDir, source.imported_file_path);
    source.manifest_path = source.manifest_path ? portablePath(projectDir, source.manifest_path) : null;
    source.chunks_path = source.chunks_path ? portablePath(projectDir, source.chunks_path) : null;
    source.original_file_path = null;
  }
  const materialPathColumns = [
    "manifest_path", "concept_map_path", "course_plan_path", "overview_path", "lecture_plan_path",
    "presentation_plan_path", "critic_report_path", "visual_specs_path", "source_index_path",
  ];
  for (const material of state.tables.learning_materials) {
    for (const column of materialPathColumns) material[column] = material[column] ? portablePath(projectDir, material[column]) : null;
  }
  for (const set of state.tables.learning_message_sets) {
    if (["queued", "generating", "waiting_for_provider"].includes(String(set.status))) set.status = "interrupted";
    set.generation_owner_id = null;
    set.lease_expires_at = null;
  }
  return state;
}

async function collectState(projectId: string) {
  const tables = {} as TransferState["tables"];
  for (const [table, sql] of Object.entries(TABLE_QUERIES) as Array<[TransferTable, string]>) {
    tables[table] = getDb().query<Record<string, unknown>, [string]>(sql).all(projectId).map((row) => ({ ...row }));
  }
  const project = tables.projects[0];
  if (!project) throw new Error("Project not found");
  const root = String(project.root_path || dataPath("projects"));
  const projectDir = join(root, projectId);
  return { state: normalizeStatePaths({ schemaVersion: TRANSFER_SCHEMA_VERSION, tables }, projectDir), projectDir };
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Project transfer cannot contain symbolic links");
    if (entry.isDirectory()) output.push(...await listFiles(root, path));
    else if (entry.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
  }
  return output.sort();
}

async function fileManifest(root: string) {
  const paths = await listFiles(root);
  const forbidden = paths.find((path) => /(?:\.sqlite(?:3)?|-(?:wal|shm))$/i.test(path));
  if (forbidden) throw new Error(`Database files cannot be included in a project transfer: ${forbidden}`);
  return Promise.all(paths.map(async (path) => {
    const bytes = await readFile(join(root, path));
    return { path, size: bytes.length, sha256: sha256(bytes) };
  }));
}

function rewritePortableJsonValue(value: unknown, mode: "export" | "import", projectDir: string, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => rewritePortableJsonValue(item, mode, projectDir));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === "originalPath") continue;
      output[childKey] = rewritePortableJsonValue(childValue, mode, projectDir, childKey);
    }
    return output;
  }
  if (typeof value !== "string") return value;
  if (key === "assetPath") {
    return mode === "export" ? portablePath(projectDir, value) : join(projectDir, safeArchivePath(value));
  }
  if (key === "assetUrl" && value.startsWith("file:")) {
    const portable = mode === "export" ? portablePath(projectDir, fileURLToPath(value)) : value;
    return mode === "export" ? portable : pathToFileURL(join(projectDir, safeArchivePath(portable))).href;
  }
  if (key === "assetUrl" && mode === "import" && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return pathToFileURL(join(projectDir, safeArchivePath(value))).href;
  }
  return value;
}

async function rewritePortableJsonFiles(filesDir: string, mode: "export" | "import", projectDir: string) {
  for (const relativePath of await listFiles(filesDir)) {
    if (!relativePath.endsWith(".json")) continue;
    const path = join(filesDir, relativePath);
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const rewritten = rewritePortableJsonValue(parsed, mode, projectDir);
    await writeFile(path, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
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

function validateManifest(value: unknown): ProjectTransferManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid project transfer manifest");
  const manifest = value as ProjectTransferManifest;
  if (manifest.format !== "learnie-project-transfer") {
    throw new Error("This is a readable learning archive, not a project transfer. Open its Markdown files to read it, or export a project transfer from the source computer.");
  }
  if (manifest.schemaVersion !== TRANSFER_SCHEMA_VERSION || manifest.minimumReaderSchemaVersion > TRANSFER_SCHEMA_VERSION) throw new Error("This project transfer schema is not supported by this Learnie version");
  if (![manifest.projectId, manifest.projectTitle, manifest.exportId, manifest.deviceId, manifest.projectStateHash].every((item) => typeof item === "string" && item.length > 0)) throw new Error("Project transfer identity is incomplete");
  if (!Array.isArray(manifest.files) || !manifest.counts || !Number.isFinite(Date.parse(manifest.exportedAt))) throw new Error("Project transfer manifest is incomplete");
  return manifest;
}

function safeArchivePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..") || normalized.split("/").includes(".")) throw new Error(`Unsafe path in project transfer: ${path}`);
  if (normalized.split("/").length > 12) throw new Error(`Project transfer path is nested too deeply: ${path}`);
  return normalized;
}

function validateState(value: unknown, projectId: string): TransferState {
  if (!value || typeof value !== "object") throw new Error("Project transfer state is invalid");
  const state = value as TransferState;
  if (state.schemaVersion !== TRANSFER_SCHEMA_VERSION || !state.tables || typeof state.tables !== "object") throw new Error("Project transfer state schema is invalid");
  const allowed = new Set(Object.keys(TABLE_QUERIES));
  for (const key of Object.keys(state.tables)) if (!allowed.has(key)) throw new Error(`Unsupported data table in transfer: ${key}`);
  for (const table of Object.keys(TABLE_QUERIES) as TransferTable[]) if (!Array.isArray(state.tables[table])) throw new Error(`Missing transfer data table: ${table}`);
  if (state.tables.projects.length !== 1 || state.tables.projects[0]?.id !== projectId) throw new Error("Project transfer state does not match its manifest");
  return state;
}

function tableCounts(state: TransferState) {
  return {
    sources: state.tables.project_sources.length,
    materials: state.tables.learning_materials.length,
    sessions: state.tables.learning_sessions.length,
    messages: state.tables.learning_messages.length,
    annotations: state.tables.material_annotations.length,
    preparedMessages: state.tables.prepared_learning_messages.length,
  };
}

function latestHead(projectId: string) {
  return getDb().query<{ export_id: string; project_state_hash: string }, [string]>(`
    SELECT export_id, project_state_hash FROM project_transfer_history
    WHERE project_id = ? ORDER BY transferred_at DESC, rowid DESC LIMIT 1
  `).get(projectId);
}

function quoted(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function importRows(state: TransferState, root: string, mode: "create_new" | "fast_forward") {
  const finalDir = join(root, String(state.tables.projects[0]!.id));
  for (const table of INSERT_ORDER) {
    const allowedColumns = new Set(getDb().query<{ name: string }, []>(`PRAGMA table_info(${quoted(table)})`).all().map((column) => column.name));
    for (const original of state.tables[table]) {
      const row = { ...original };
      if (table === "projects") {
        row.root_path = root;
        row.last_opened_at = Date.now();
      }
      if (table === "project_sources") {
        row.imported_file_path = join(finalDir, safeArchivePath(String(row.imported_file_path)));
        if (row.manifest_path) row.manifest_path = join(finalDir, safeArchivePath(String(row.manifest_path)));
        if (row.chunks_path) row.chunks_path = join(finalDir, safeArchivePath(String(row.chunks_path)));
        row.original_file_path = null;
      }
      if (table === "learning_materials") {
        for (const column of ["manifest_path", "concept_map_path", "course_plan_path", "overview_path", "lecture_plan_path", "presentation_plan_path", "critic_report_path", "visual_specs_path", "source_index_path"]) {
          if (row[column]) row[column] = join(finalDir, safeArchivePath(String(row[column])));
        }
      }
      const columns = Object.keys(row);
      if (!columns.length || columns.some((column) => !allowedColumns.has(column))) throw new Error(`Invalid columns in transferred ${table} data`);
      const updates = columns.filter((column) => !["id"].includes(column)).map((column) => `${quoted(column)} = excluded.${quoted(column)}`).join(", ");
      const sql = `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${mode === "fast_forward" ? ` ON CONFLICT DO UPDATE SET ${updates}` : ""}`;
      getDb().query(sql).run(...columns.map((column) => row[column]) as never[]);
    }
  }
}

export class ProjectTransferService {
  private readonly settings = new SettingsService();

  async exportTransfer(projectId: string, destinationFolder?: string): Promise<ProjectTransferExport> {
    const { state, projectDir } = await collectState(projectId);
    const project = state.tables.projects[0]!;
    const stateHash = sha256(stableStringify(state));
    const settings = await this.settings.get();
    const outDir = destinationFolder || settings.defaultDownloadFolder;
    await mkdir(outDir, { recursive: true });
    const staging = await mkdtemp(join(tmpdir(), "learnie-project-transfer-export-"));
    try {
      const payload = join(staging, "project");
      const filesDir = join(payload, "files");
      await mkdir(payload, { recursive: true });
      if (existsSync(projectDir)) await cp(projectDir, filesDir, { recursive: true, force: true });
      else await mkdir(filesDir, { recursive: true });
      await rewritePortableJsonFiles(filesDir, "export", projectDir);
      await writeFile(join(payload, "state.json"), `${stableStringify(state)}\n`, "utf8");
      const head = latestHead(projectId);
      const exportId = crypto.randomUUID();
      const manifest: ProjectTransferManifest = {
        format: "learnie-project-transfer",
        schemaVersion: TRANSFER_SCHEMA_VERSION,
        minimumReaderSchemaVersion: TRANSFER_SCHEMA_VERSION,
        appVersion: APP_INFO.version,
        projectId,
        projectTitle: String(project.title),
        exportId,
        parentExportId: head?.export_id || null,
        deviceId: await deviceId(),
        exportedAt: new Date().toISOString(),
        projectStateHash: stateHash,
        counts: tableCounts(state),
        files: await fileManifest(payload).then((files) => files.map((file) => ({ ...file, path: `project/${file.path}` }))),
      };
      await writeFile(join(staging, "transfer.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const desiredName = `${safeFilePart(String(project.title))}-project-transfer-${stamp()}.zip`;
      const zipPath = collisionSafePath(outDir, desiredName);
      const temporaryZip = `${zipPath}.partial`;
      await writeZipFromDirectory(staging, temporaryZip);
      await rename(temporaryZip, zipPath);
      getDb().query(`INSERT INTO project_transfer_history (export_id, project_id, parent_export_id, device_id, direction, project_state_hash, transferred_at, applied_at) VALUES (?, ?, ?, ?, 'export', ?, ?, ?)`)
        .run(exportId, projectId, manifest.parentExportId, manifest.deviceId, stateHash, Date.parse(manifest.exportedAt), Date.now());
      return { zipPath, fileName: basename(zipPath), projectId, exportId, counts: manifest.counts };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async prepareImport(path: string): Promise<ProjectTransferPreview> {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) throw new Error("Project transfer ZIP is too large or is not a file");
    const rawFiles = readZipEntries(await Bun.file(path).bytes(), { maxFileCount: MAX_FILE_COUNT, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
    const files = new Map<string, Uint8Array>();
    for (const [rawPath, bytes] of rawFiles) files.set(safeArchivePath(rawPath), bytes);
    const manifestBytes = files.get("transfer.json");
    if (!manifestBytes) throw new Error("This ZIP does not contain transfer.json");
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const listed = new Set(manifest.files.map((file) => safeArchivePath(file.path)));
    if (listed.size !== manifest.files.length) throw new Error("Project transfer manifest contains duplicate file entries");
    const forbidden = [...files.keys()].find((entry) => /(?:\.sqlite(?:3)?|-(?:wal|shm))$/i.test(entry));
    if (forbidden) throw new Error(`Database files are not allowed in a project transfer: ${forbidden}`);
    for (const entry of files.keys()) if (entry !== "transfer.json" && !listed.has(entry)) throw new Error(`Unlisted file in project transfer: ${entry}`);
    for (const expected of manifest.files) {
      const bytes = files.get(safeArchivePath(expected.path));
      if (!bytes || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new Error(`Project transfer checksum failed: ${expected.path}`);
    }
    const stateBytes = files.get("project/state.json");
    if (!stateBytes) throw new Error("Project transfer state is missing");
    const state = validateState(JSON.parse(new TextDecoder().decode(stateBytes)), manifest.projectId);
    if (sha256(stableStringify(state)) !== manifest.projectStateHash) throw new Error("Project transfer state hash does not match its manifest");
    if (stableStringify(tableCounts(state)) !== stableStringify(manifest.counts)) throw new Error("Project transfer counts do not match its payload");

    const dir = await mkdtemp(join(tmpdir(), "learnie-project-transfer-import-"));
    for (const [name, bytes] of files) {
      if (name === "transfer.json") continue;
      const target = resolve(dir, name);
      if (!target.startsWith(`${resolve(dir)}/`)) throw new Error(`Unsafe transfer path: ${name}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const localProject = getDb().query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?").get(manifest.projectId);
    const alreadyApplied = getDb().query<{ export_id: string }, [string]>("SELECT export_id FROM project_transfer_history WHERE export_id = ?").get(manifest.exportId);
    let classification: ProjectTransferClassification = "create_new";
    const warnings: string[] = [];
    if (localProject) {
      const local = await collectState(manifest.projectId);
      const localHash = sha256(stableStringify(local.state));
      const head = latestHead(manifest.projectId);
      if (alreadyApplied || localHash === manifest.projectStateHash) classification = "no_changes";
      else if (manifest.parentExportId && head?.export_id === manifest.parentExportId && head.project_state_hash === localHash) classification = "fast_forward";
      else {
        classification = head ? "diverged" : "unrelated_or_legacy";
        warnings.push("이 프로젝트는 양쪽에서 달라졌거나 공통 transfer 기록이 없습니다. 로컬 프로젝트를 덮어쓰지 않습니다.");
      }
    }
    const itemCount = Object.values(manifest.counts).reduce((sum, count) => sum + count, 0);
    const preview: ProjectTransferPreview = {
      importId: crypto.randomUUID(),
      fileName: basename(path),
      projectId: manifest.projectId,
      projectTitle: manifest.projectTitle,
      exportedAt: manifest.exportedAt,
      sourceDeviceLabel: `Learnie ${manifest.deviceId.slice(0, 8)}`,
      classification,
      counts: manifest.counts,
      changes: {
        added: classification === "create_new" ? itemCount : 0,
        updated: classification === "fast_forward" ? itemCount : 0,
        unchanged: classification === "no_changes" ? itemCount : 0,
        conflicted: classification === "diverged" || classification === "unrelated_or_legacy" ? itemCount : 0,
      },
      warnings,
    };
    preparedTransfers.set(preview.importId, { dir, manifest, state, preview });
    return preview;
  }

  async commitImport(importId: string, mode: "create_new" | "fast_forward"): Promise<ProjectTransferImportResult> {
    const prepared = preparedTransfers.get(importId);
    if (!prepared) throw new Error("Prepared project transfer expired; choose the ZIP again");
    const { manifest, state, preview, dir } = prepared;
    if (preview.classification === "no_changes") {
      getDb().query(`INSERT OR IGNORE INTO project_transfer_history (export_id, project_id, parent_export_id, device_id, direction, project_state_hash, transferred_at, applied_at) VALUES (?, ?, ?, ?, 'import', ?, ?, ?)`)
        .run(manifest.exportId, manifest.projectId, manifest.parentExportId, manifest.deviceId, manifest.projectStateHash, Date.parse(manifest.exportedAt), Date.now());
      await this.cancelImport(importId);
      return { projectId: manifest.projectId, classification: "no_changes", imported: false };
    }
    if (preview.classification !== mode) throw new Error("The selected import action no longer matches the prepared transfer");
    const settings = await this.settings.get();
    const root = settings.projectRootFolder || dataPath("projects");
    const finalDir = join(root, manifest.projectId);
    const incomingDir = join(dir, "project", "files");
    await mkdir(root, { recursive: true });
    const backupDir = await mkdtemp(join(tmpdir(), "learnie-project-transfer-backup-"));
    let installedFiles = false;
    try {
      if (mode === "create_new") {
        if (existsSync(finalDir) || getDb().query("SELECT id FROM projects WHERE id = ?").get(manifest.projectId)) throw new Error("Project already exists; prepare the transfer again");
        await cp(incomingDir, finalDir, { recursive: true, force: false, errorOnExist: true });
      } else {
        const current = await collectState(manifest.projectId);
        const head = latestHead(manifest.projectId);
        if (sha256(stableStringify(current.state)) !== head?.project_state_hash || manifest.parentExportId !== head.export_id) throw new Error("Local project changed after preview; prepare the transfer again");
        await cp(finalDir, join(backupDir, "project"), { recursive: true, force: true });
        await cp(incomingDir, finalDir, { recursive: true, force: true });
      }
      await rewritePortableJsonFiles(finalDir, "import", finalDir);
      installedFiles = true;
      getDb().transaction(() => {
        importRows(state, root, mode);
        getDb().query(`INSERT INTO project_transfer_history (export_id, project_id, parent_export_id, device_id, direction, project_state_hash, transferred_at, applied_at) VALUES (?, ?, ?, ?, 'import', ?, ?, ?)`)
          .run(manifest.exportId, manifest.projectId, manifest.parentExportId, manifest.deviceId, manifest.projectStateHash, Date.parse(manifest.exportedAt), Date.now());
      })();
      await this.cancelImport(importId);
      return { projectId: manifest.projectId, classification: mode, imported: true };
    } catch (error) {
      if (installedFiles) {
        if (mode === "create_new") await rm(finalDir, { recursive: true, force: true });
        else if (existsSync(join(backupDir, "project"))) {
          await rm(finalDir, { recursive: true, force: true });
          await cp(join(backupDir, "project"), finalDir, { recursive: true, force: true });
        }
      }
      throw error;
    } finally {
      await rm(backupDir, { recursive: true, force: true });
    }
  }

  async cancelImport(importId: string) {
    const prepared = preparedTransfers.get(importId);
    if (!prepared) return false;
    preparedTransfers.delete(importId);
    await rm(prepared.dir, { recursive: true, force: true });
    return true;
  }
}
