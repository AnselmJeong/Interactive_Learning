import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { DocumentTransferCounts, DocumentTransferExport, DocumentTransferManifest, DocumentTransferPreview } from "../shared/document-transfer-types";
import { readZipEntries } from "./archive-reader";
import { writeZipFromDirectory } from "./archive-writer";
import { getDb } from "./project-db";
import { dataPath } from "./paths";
import { SettingsService } from "./settings-service";

const TABLE_ORDER = [
  "project_documents", "project_sources", "learning_materials", "material_sources", "learning_message_sets",
  "prepared_learning_messages", "learning_sessions", "learning_messages", "session_module_progress",
  "learner_signals", "module_progress", "material_annotations",
] as const;
type TransferTable = typeof TABLE_ORDER[number];
type TransferState = { schemaVersion: 1; tables: Record<TransferTable, Array<Record<string, unknown>>> };
type DocumentRow = { id: string; project_id: string; title: string; document_type: "book" | "article" };

function hash(data: string | Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}

function stringify(value: unknown) { return JSON.stringify(stable(value)); }
function safePart(value: string) { return value.replace(/[\\/:*?"<>|#{}\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "document"; }
function stamp() { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
function collisionSafePath(folder: string, name: string) { const stem = name.replace(/\.zip$/, ""); let path = join(folder, `${stem}.zip`); for (let i = 2; existsSync(path); i += 1) path = join(folder, `${stem}-${i}.zip`); return path; }

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
      warnings: crossDocumentMaterials ? ["다른 자료의 source를 함께 사용하는 학습 자료가 있어 이 자료만 안전하게 내보낼 수 없습니다. Project 전체 transfer를 사용하세요."] : [],
    };
  }

  async export(projectId: string, documentId: string, destinationFolder?: string): Promise<DocumentTransferExport> {
    const preview = this.preview(projectId, documentId);
    if (preview.classification !== "ready") throw new Error(preview.warnings[0]);
    const state = tableRows(documentId);
    const projectRoot = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId)?.root_path || dataPath("projects");
    const projectDir = join(projectRoot, projectId);
    const outputFolder = destinationFolder || (await this.settings.get()).defaultDownloadFolder;
    const staging = await mkdtemp(join(tmpdir(), "learnie-document-transfer-"));
    try {
      const payload = join(staging, "document");
      await mkdir(payload, { recursive: true });
      for (const source of state.tables.project_sources) {
        const id = String(source.id);
        const path = join(projectDir, "sources", id);
        if (existsSync(path)) await cp(path, join(payload, "sources", id), { recursive: true, force: true });
      }
      for (const material of state.tables.learning_materials) {
        const id = String(material.id);
        const path = join(projectDir, "materials", id);
        if (existsSync(path)) await cp(path, join(payload, "materials", id), { recursive: true, force: true });
      }
      for (const session of state.tables.learning_sessions) {
        const id = String(session.id);
        const path = join(projectDir, "sessions", id);
        if (existsSync(path)) await cp(path, join(payload, "sessions", id), { recursive: true, force: true });
      }
      await writeFile(join(payload, "state.json"), `${stringify(state)}\n`, "utf8");
      const assetCount = (await filesUnder(payload)).length;
      const finalCounts = counts(state, assetCount, 0);
      const exportId = crypto.randomUUID();
      const manifest: DocumentTransferManifest = {
        format: "learnie-document-transfer", schemaVersion: 1, minimumReaderSchemaVersion: 1, exportId,
        originProjectId: projectId, originDocumentId: documentId, documentTitle: preview.documentTitle,
        documentType: preview.documentType, exportedAt: new Date().toISOString(), documentStateHash: hash(stringify(state)),
        counts: finalCounts, files: (await manifestFiles(payload)).map((file) => ({ ...file, path: `document/${file.path}` })),
      };
      await writeFile(join(staging, "document-transfer.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await mkdir(outputFolder, { recursive: true });
      const zipPath = collisionSafePath(outputFolder, `${safePart(preview.documentTitle)}-learnie-document-${stamp()}.zip`);
      await writeZipFromDirectory(staging, `${zipPath}.partial`);
      await rename(`${zipPath}.partial`, zipPath);
      await this.validateExport(zipPath, manifest);
      return { ...preview, counts: finalCounts, zipPath, fileName: basename(zipPath), exportId, validated: true };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async exportAll(projectId: string, destinationFolder?: string) {
    const documents = getDb().query<{ id: string }, [string]>("SELECT id FROM project_documents WHERE project_id = ? ORDER BY imported_at, id").all(projectId);
    const exported: DocumentTransferExport[] = [];
    for (const document of documents) exported.push(await this.export(projectId, document.id, destinationFolder));
    return exported;
  }

  private async validateExport(path: string, manifest: DocumentTransferManifest) {
    const files = readZipEntries(await Bun.file(path).bytes());
    const rawManifest = files.get("document-transfer.json");
    if (!rawManifest) throw new Error("Document export validation failed: manifest is missing");
    const parsed = JSON.parse(new TextDecoder().decode(rawManifest)) as DocumentTransferManifest;
    if (parsed.format !== manifest.format || parsed.exportId !== manifest.exportId) throw new Error("Document export validation failed: manifest identity mismatch");
    for (const entry of manifest.files) {
      const bytes = files.get(entry.path);
      if (!bytes || bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Document export validation failed: ${entry.path}`);
    }
    const state = files.get("document/state.json");
    if (!state || hash(new TextDecoder().decode(state).trim()) !== manifest.documentStateHash) throw new Error("Document export validation failed: state checksum mismatch");
  }
}
