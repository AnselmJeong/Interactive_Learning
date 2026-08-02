import { getDb } from "./project-db";
import type {
  DocumentSummary,
  LearningProgressSummary,
  PreparationProgressSummary,
  SourceSummary,
} from "../shared/rpc-types";
import type { DocumentType, SourceType } from "../shared/artifact-types";

type DocumentRow = {
  id: string;
  project_id: string;
  document_type: DocumentType;
  title: string;
  subtitle: string | null;
  description: string | null;
  authors_json: string;
  publisher: string | null;
  published_date: string | null;
  isbn_10: string | null;
  isbn_13: string | null;
  journal: string | null;
  doi: string | null;
  language: string | null;
  metadata_status: DocumentSummary["metadataStatus"];
  original_file_name: string;
  imported_at: number;
  updated_at: number;
};

type SourceRow = {
  id: string;
  project_id: string;
  title: string;
  source_type: SourceType;
  document_type: DocumentType;
  original_file_name: string;
  quality_status: SourceSummary["qualityStatus"];
  created_at: number;
  updated_at: number;
};

type AggregateRow = {
  source_count: number;
  annotation_count: number;
  active_session_id: string | null;
  last_studied_at: number | null;
  completed_messages: number;
  total_messages: number;
};

function jsonStringList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toSource(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourceType: row.source_type,
    documentType: row.document_type,
    originalFileName: row.original_file_name,
    qualityStatus: row.quality_status,
    // Document views calculate full progress from sessions/chunks.  Keep this
    // compatibility field conservative until a source is opened in Learning.
    learningStatus: "not_started",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emptyLearning(activeSessionId: string | null): LearningProgressSummary {
  return {
    status: activeSessionId ? "in_progress" : "not_started",
    coveredChunks: 0,
    totalChunks: 0,
    percent: 0,
    currentSourceId: null,
    activeSessionId,
  };
}

function toSummary(row: DocumentRow, aggregate: AggregateRow): DocumentSummary {
  const preparation: PreparationProgressSummary = {
    completedMessages: aggregate.completed_messages || 0,
    totalMessages: aggregate.total_messages || 0,
    percent: aggregate.total_messages ? Math.round((aggregate.completed_messages / aggregate.total_messages) * 100) : 0,
  };
  return {
    id: row.id,
    projectId: row.project_id,
    documentType: row.document_type,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    authors: jsonStringList(row.authors_json),
    publisher: row.publisher,
    publishedDate: row.published_date,
    isbn10: row.isbn_10,
    isbn13: row.isbn_13,
    journal: row.journal,
    doi: row.doi,
    language: row.language,
    coverUrl: null,
    metadataStatus: row.metadata_status,
    sourceCount: aggregate.source_count || 0,
    learning: emptyLearning(aggregate.active_session_id),
    preparation,
    annotationCount: aggregate.annotation_count || 0,
    lastStudiedAt: aggregate.last_studied_at,
    originalFileName: row.original_file_name,
    createdAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

function aggregateFor(documentId: string): AggregateRow {
  return getDb().query<AggregateRow, [string]>(`
    SELECT
      (SELECT COUNT(*) FROM project_sources s WHERE s.document_id = d.id) AS source_count,
      (SELECT COUNT(*) FROM material_annotations a
       WHERE a.source_id IN (SELECT id FROM project_sources WHERE document_id = d.id)) AS annotation_count,
      (SELECT s.id FROM learning_sessions s
       JOIN material_sources ms ON ms.material_id = s.material_id
       JOIN project_sources ps ON ps.id = ms.source_id
       WHERE ps.document_id = d.id AND s.status = 'active'
       ORDER BY s.updated_at DESC LIMIT 1) AS active_session_id,
      (SELECT MAX(s.updated_at) FROM learning_sessions s
       JOIN material_sources ms ON ms.material_id = s.material_id
       JOIN project_sources ps ON ps.id = ms.source_id
       WHERE ps.document_id = d.id) AS last_studied_at,
      (SELECT COALESCE(MAX(lms.completed_messages), 0) FROM learning_message_sets lms
       JOIN material_sources ms ON ms.material_id = lms.material_id
       JOIN project_sources ps ON ps.id = ms.source_id
       WHERE ps.document_id = d.id) AS completed_messages,
      (SELECT COALESCE(MAX(lms.total_messages), 0) FROM learning_message_sets lms
       JOIN material_sources ms ON ms.material_id = lms.material_id
       JOIN project_sources ps ON ps.id = ms.source_id
       WHERE ps.document_id = d.id) AS total_messages
    FROM project_documents d
    WHERE d.id = ?
  `).get(documentId) || {
    source_count: 0,
    annotation_count: 0,
    active_session_id: null,
    last_studied_at: null,
    completed_messages: 0,
    total_messages: 0,
  };
}

export class DocumentService {
  list(projectId: string) {
    const documents = getDb()
      .query<DocumentRow, [string]>("SELECT * FROM project_documents WHERE project_id = ? ORDER BY imported_at ASC, id ASC")
      .all(projectId);
    return documents.map((row) => toSummary(row, aggregateFor(row.id)));
  }

  get(projectId: string, documentId: string) {
    const row = getDb()
      .query<DocumentRow, [string, string]>("SELECT * FROM project_documents WHERE project_id = ? AND id = ?")
      .get(projectId, documentId);
    if (!row) throw new Error("Document not found");
    return toSummary(row, aggregateFor(row.id));
  }

  listSources(projectId: string, documentId: string) {
    this.get(projectId, documentId);
    return getDb()
      .query<SourceRow, [string]>(`
        SELECT id, project_id, title, source_type, document_type, original_file_name,
               quality_status, created_at, updated_at
        FROM project_sources
        WHERE document_id = ?
        ORDER BY COALESCE(source_ordinal, 2147483647), created_at ASC, id ASC
      `)
      .all(documentId)
      .map(toSource);
  }
}
