import { getDb } from "./project-db";
import type {
  AnnotationAttachment,
  HighlightResult,
  ImageLookupResult,
  LookupResult,
  LookupSourceMeta,
  MaterialAnnotation,
  MaterialAnnotationKind,
  MaterialAnnotationSurface,
  NoteResult,
  QuestionThreadResult,
  TextSelectionAnchor,
} from "../shared/artifact-types";

type AnnotationResult = LookupResult | QuestionThreadResult | ImageLookupResult | NoteResult | HighlightResult;
const SELECTED_TEXT_MAX_CHARS = 4000;

type MaterialAnnotationRow = {
  id: string;
  project_id: string;
  material_id: string;
  source_id: string | null;
  chunk_id: string;
  surface: MaterialAnnotationSurface;
  scope: "material" | "session";
  session_id: string | null;
  anchor_message_id: string | null;
  anchor_block_id: string | null;
  anchor_json: string | null;
  kind: MaterialAnnotationKind;
  selected_text: string;
  normalized_text: string;
  result_json: string;
  source_meta_json: string;
  attachments_json: string;
  created_at: number;
  updated_at: number;
};

export type SaveMaterialAnnotationInput = {
  id?: string;
  materialId: string;
  chunkId: string;
  sourceId?: string | null;
  surface?: MaterialAnnotationSurface;
  scope?: "material" | "session";
  sessionId?: string | null;
  anchorMessageId?: string | null;
  anchorBlockId?: string | null;
  textAnchor?: TextSelectionAnchor | null;
  kind: MaterialAnnotationKind;
  selectedText: string;
  result: AnnotationResult;
  sourceMeta?: LookupSourceMeta[];
};

function normalizeSelectedText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeExternalHtmlAttachment(value: unknown): AnnotationAttachment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.kind !== "external_html"
    || item.schemaVersion !== 1
    || typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id)
    || typeof item.title !== "string" || item.title.length === 0 || item.title.length > 120
    || typeof item.originalFileName !== "string" || item.originalFileName.length === 0 || item.originalFileName.length > 120
    || typeof item.originalByteSize !== "number" || !Number.isInteger(item.originalByteSize) || item.originalByteSize < 0 || item.originalByteSize > 2 * 1024 * 1024
    || typeof item.runnableByteSize !== "number" || !Number.isInteger(item.runnableByteSize) || item.runnableByteSize < 0 || item.runnableByteSize > 5 * 1024 * 1024
    || typeof item.originalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.originalSha256)
    || typeof item.runnableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.runnableSha256)
    || (item.compatibility !== "self_contained" && item.compatibility !== "localized")
    || item.importerVersion !== 1
    || !Array.isArray(item.dependencies)
    || typeof item.importedAt !== "number" || !Number.isFinite(item.importedAt)) return null;
  const dependencies = item.dependencies.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const dependency = value as Record<string, unknown>;
    if (typeof dependency.name !== "string" || !dependency.name || dependency.name.length > 80
      || typeof dependency.version !== "string" || !dependency.version || dependency.version.length > 40
      || typeof dependency.originalUrl !== "string" || !/^https:\/\//.test(dependency.originalUrl) || dependency.originalUrl.length > 500
      || typeof dependency.bundledAssetId !== "string" || !dependency.bundledAssetId || dependency.bundledAssetId.length > 120
      || typeof dependency.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(dependency.sha256)
      || typeof dependency.license !== "string" || !dependency.license || dependency.license.length > 80) return [];
    return [{
      name: dependency.name,
      version: dependency.version,
      originalUrl: dependency.originalUrl,
      bundledAssetId: dependency.bundledAssetId,
      sha256: dependency.sha256,
      license: dependency.license,
    }];
  });
  if (dependencies.length !== item.dependencies.length) return null;
  return {
    kind: "external_html",
    schemaVersion: 1,
    id: item.id,
    title: item.title,
    originalFileName: item.originalFileName,
    originalByteSize: item.originalByteSize,
    runnableByteSize: item.runnableByteSize,
    originalSha256: item.originalSha256,
    runnableSha256: item.runnableSha256,
    compatibility: item.compatibility,
    importerVersion: 1,
    dependencies,
    importedAt: item.importedAt,
  };
}

function parseAttachments(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return { attachments: [] as AnnotationAttachment[], invalid: true };
    const attachments = value.flatMap((item) => {
      const normalized = normalizeExternalHtmlAttachment(item);
      return normalized ? [normalized] : [];
    });
    return { attachments, invalid: attachments.length !== value.length };
  } catch {
    return { attachments: [] as AnnotationAttachment[], invalid: true };
  }
}

function safeTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function annotationSurface(input: { surface?: string | null; anchorMessageId?: string | null; anchorBlockId?: string | null; kind?: MaterialAnnotationKind }) {
  if (input.surface === "chat" || input.surface === "source") return input.surface;
  if (input.kind === "highlight" || input.kind === "note") return "source";
  return input.anchorMessageId || input.anchorBlockId ? "chat" : "source";
}

function rowToAnnotation(row: MaterialAnnotationRow): MaterialAnnotation {
  const parsedAttachments = parseAttachments(row.attachments_json);
  return {
    id: row.id,
    projectId: row.project_id,
    materialId: row.material_id,
    sourceId: row.source_id,
    chunkId: row.chunk_id,
    surface: annotationSurface({
      surface: row.surface,
      anchorMessageId: row.anchor_message_id,
      anchorBlockId: row.anchor_block_id,
      kind: row.kind,
    }),
    scope: row.scope || "material",
    sessionId: row.session_id,
    anchorMessageId: row.anchor_message_id,
    anchorBlockId: row.anchor_block_id,
    textAnchor: row.anchor_json ? parseJson<TextSelectionAnchor | null>(row.anchor_json, null) : null,
    kind: row.kind,
    selectedText: row.selected_text,
    normalizedText: row.normalized_text,
    result: parseJson<AnnotationResult>(row.result_json, { kind: row.kind as "highlight" }),
    sourceMeta: parseJson<LookupSourceMeta[]>(row.source_meta_json, []),
    attachments: parsedAttachments.attachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(parsedAttachments.invalid ? { syncWarning: "일부 annotation attachment metadata를 읽지 못했습니다." } : {}),
  };
}

export function getMaterialAnnotation(annotationId: string) {
  const row = getDb().query<MaterialAnnotationRow, [string]>("SELECT * FROM material_annotations WHERE id = ?").get(annotationId);
  return row ? rowToAnnotation(row) : null;
}

export function listMaterialAnnotations(materialId: string) {
  return getDb()
    .query<MaterialAnnotationRow, [string]>(
      `SELECT * FROM material_annotations
       WHERE material_id = ?
       ORDER BY created_at ASC`
    )
    .all(materialId)
    .map(rowToAnnotation);
}

export function listProjectAnnotations(projectId: string) {
  return getDb()
    .query<MaterialAnnotationRow, [string]>(
      `SELECT * FROM material_annotations
       WHERE project_id = ?
       ORDER BY updated_at DESC, created_at DESC, rowid DESC`
    )
    .all(projectId)
    .map(rowToAnnotation);
}

export function saveMaterialAnnotation(input: SaveMaterialAnnotationInput) {
  const material = getDb()
    .query<{ project_id: string }, [string]>("SELECT project_id FROM learning_materials WHERE id = ?")
    .get(input.materialId);
  if (!material) throw new Error("Material not found");

  const id = input.id || crypto.randomUUID();
  const now = Date.now();
  const selectedText = input.selectedText.replace(/\s+/g, " ").trim().slice(0, SELECTED_TEXT_MAX_CHARS);
  if (!selectedText) throw new Error("Selected text is empty");
  const anchoredSessionId = input.sessionId || (input.anchorMessageId
    ? getDb().query<{ session_id: string }, [string]>("SELECT session_id FROM learning_messages WHERE id = ?").get(input.anchorMessageId)?.session_id
    : null);
  const scope = input.scope || (anchoredSessionId ? "session" : "material");

  getDb()
    .query(
      `INSERT INTO material_annotations
       (id, project_id, material_id, source_id, chunk_id, surface, scope, session_id, anchor_message_id, anchor_block_id, anchor_json, kind, selected_text, normalized_text,
        result_json, source_meta_json, attachments_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      material.project_id,
      input.materialId,
      input.sourceId || null,
      input.chunkId,
      annotationSurface(input),
      scope,
      anchoredSessionId || null,
      input.anchorMessageId || null,
      input.anchorBlockId || null,
      input.textAnchor ? JSON.stringify(input.textAnchor) : null,
      input.kind,
      selectedText,
      normalizeSelectedText(selectedText),
      JSON.stringify(input.result),
      JSON.stringify(input.sourceMeta || []),
      "[]",
      now,
      now
    );

  const row = getDb().query<MaterialAnnotationRow, [string]>("SELECT * FROM material_annotations WHERE id = ?").get(id);
  if (!row) throw new Error("Saved annotation could not be loaded");
  return rowToAnnotation(row);
}

export function replaceMaterialAnnotations(materialId: string, annotations: MaterialAnnotation[]) {
  const material = getDb()
    .query<{ project_id: string }, [string]>("SELECT project_id FROM learning_materials WHERE id = ?")
    .get(materialId);
  if (!material) return;

  const now = Date.now();
  const db = getDb();
  const insert = db.query(
    `INSERT INTO material_annotations
     (id, project_id, material_id, source_id, chunk_id, surface, scope, session_id, anchor_message_id, anchor_block_id, anchor_json, kind, selected_text, normalized_text,
      result_json, source_meta_json, attachments_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const replace = db.transaction((items: MaterialAnnotation[]) => {
    db.query("DELETE FROM material_annotations WHERE material_id = ?").run(materialId);
    for (const annotation of items) {
      if (!annotation.id || annotation.materialId !== materialId || !annotation.chunkId) continue;
      const selectedText = annotation.selectedText.replace(/\s+/g, " ").trim().slice(0, SELECTED_TEXT_MAX_CHARS);
      if (!selectedText) continue;
      insert.run(
        annotation.id,
        material.project_id,
        materialId,
        annotation.sourceId || null,
        annotation.chunkId,
        annotationSurface(annotation),
        annotation.scope || (annotation.sessionId ? "session" : "material"),
        annotation.sessionId || null,
        annotation.anchorMessageId || null,
        annotation.anchorBlockId || null,
        annotation.textAnchor ? JSON.stringify(annotation.textAnchor) : null,
        annotation.kind,
        selectedText,
        annotation.normalizedText || normalizeSelectedText(selectedText),
        JSON.stringify(annotation.result),
        JSON.stringify(annotation.sourceMeta || []),
        JSON.stringify((annotation.attachments || []).flatMap((item) => {
          const normalized = normalizeExternalHtmlAttachment(item);
          return normalized ? [normalized] : [];
        })),
        safeTimestamp(annotation.createdAt, now),
        safeTimestamp(annotation.updatedAt, safeTimestamp(annotation.createdAt, now))
      );
    }
  });
  replace(annotations);
}

export function updateMaterialAnnotationResult(annotationId: string, result: AnnotationResult, sourceMeta?: LookupSourceMeta[]) {
  const now = Date.now();
  if (sourceMeta) {
    getDb()
      .query("UPDATE material_annotations SET result_json = ?, source_meta_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), JSON.stringify(sourceMeta), now, annotationId);
  } else {
    getDb()
      .query("UPDATE material_annotations SET result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, annotationId);
  }
  const row = getDb().query<MaterialAnnotationRow, [string]>("SELECT * FROM material_annotations WHERE id = ?").get(annotationId);
  return row ? rowToAnnotation(row) : null;
}

export function updateMaterialAnnotationAttachments(
  annotationId: string,
  attachments: AnnotationAttachment[],
  expectedUpdatedAt: number,
) {
  const normalized = attachments.flatMap((item) => {
    const value = normalizeExternalHtmlAttachment(item);
    return value ? [value] : [];
  });
  if (normalized.length !== attachments.length) throw new Error("Invalid annotation attachment metadata");
  const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1);
  const result = getDb()
    .query("UPDATE material_annotations SET attachments_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
    .run(JSON.stringify(normalized), updatedAt, annotationId, expectedUpdatedAt);
  if (result.changes === 0) throw new Error("ANNOTATION_STALE: annotation이 변경되었습니다. 다시 시도해 주세요.");
  return getMaterialAnnotation(annotationId);
}

export function deleteMaterialAnnotation(annotationId: string) {
  return getDb().query("DELETE FROM material_annotations WHERE id = ?").run(annotationId).changes > 0;
}
