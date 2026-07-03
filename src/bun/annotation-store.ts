import { getDb } from "./project-db";
import type {
  HighlightResult,
  ImageLookupResult,
  LookupResult,
  LookupSourceMeta,
  MaterialAnnotation,
  MaterialAnnotationKind,
  NoteResult,
} from "../shared/artifact-types";

type AnnotationResult = LookupResult | ImageLookupResult | NoteResult | HighlightResult;

type MaterialAnnotationRow = {
  id: string;
  project_id: string;
  material_id: string;
  source_id: string | null;
  chunk_id: string;
  kind: MaterialAnnotationKind;
  selected_text: string;
  normalized_text: string;
  result_json: string;
  source_meta_json: string;
  created_at: number;
  updated_at: number;
};

export type SaveMaterialAnnotationInput = {
  materialId: string;
  chunkId: string;
  sourceId?: string | null;
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

function rowToAnnotation(row: MaterialAnnotationRow): MaterialAnnotation {
  return {
    id: row.id,
    projectId: row.project_id,
    materialId: row.material_id,
    sourceId: row.source_id,
    chunkId: row.chunk_id,
    kind: row.kind,
    selectedText: row.selected_text,
    normalizedText: row.normalized_text,
    result: parseJson<AnnotationResult>(row.result_json, { kind: row.kind as "highlight" }),
    sourceMeta: parseJson<LookupSourceMeta[]>(row.source_meta_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export function saveMaterialAnnotation(input: SaveMaterialAnnotationInput) {
  const material = getDb()
    .query<{ project_id: string }, [string]>("SELECT project_id FROM learning_materials WHERE id = ?")
    .get(input.materialId);
  if (!material) throw new Error("Material not found");

  const id = crypto.randomUUID();
  const now = Date.now();
  const selectedText = input.selectedText.replace(/\s+/g, " ").trim().slice(0, 420);
  if (!selectedText) throw new Error("Selected text is empty");

  getDb()
    .query(
      `INSERT INTO material_annotations
       (id, project_id, material_id, source_id, chunk_id, kind, selected_text, normalized_text,
        result_json, source_meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      material.project_id,
      input.materialId,
      input.sourceId || null,
      input.chunkId,
      input.kind,
      selectedText,
      normalizeSelectedText(selectedText),
      JSON.stringify(input.result),
      JSON.stringify(input.sourceMeta || []),
      now,
      now
    );

  const row = getDb().query<MaterialAnnotationRow, [string]>("SELECT * FROM material_annotations WHERE id = ?").get(id);
  if (!row) throw new Error("Saved annotation could not be loaded");
  return rowToAnnotation(row);
}

export function deleteMaterialAnnotation(annotationId: string) {
  return getDb().query("DELETE FROM material_annotations WHERE id = ?").run(annotationId).changes > 0;
}
