import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "./project-db";
import { BookMetadataService } from "./book-metadata-service";
import { CrossrefMetadataService } from "./crossref-metadata-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { SourceService } from "./source-service";
import { titleQueryFromFilename } from "./document-metadata-text";
import { writeProjectDocumentIndex } from "./project-bundle-sync";
import { dataPath } from "./paths";
import type {
  DocumentSummary,
  DocumentMetadataCandidate,
  DocumentMetadataSearchInput,
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
  cover_image_path: string | null;
  metadata_status: DocumentSummary["metadataStatus"];
  original_file_name: string;
  original_file_path: string | null;
  imported_at: number;
  updated_at: number;
};

type SourceRow = {
  id: string;
  project_id: string;
  document_id: string | null;
  title: string;
  source_type: SourceType;
  document_type: DocumentType;
  original_file_name: string;
  quality_status: SourceSummary["qualityStatus"];
  created_at: number;
  updated_at: number;
};

type AggregateRow = {
  document_id?: string;
  source_count: number;
  annotation_count: number;
  active_session_id: string | null;
  last_studied_at: number | null;
  completed_messages: number;
  total_messages: number;
};

function aggregatesForProject(projectId: string) {
  const rows = getDb().query<AggregateRow, [string]>(`
    SELECT d.id AS document_id,
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
    WHERE d.project_id = ?
  `).all(projectId);
  return new Map(rows.map((row) => [row.document_id!, row]));
}

function jsonStringList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function metadataFilename(row: DocumentRow) {
  const originalPath = row.original_file_path?.split("#", 1)[0] || "";
  return originalPath ? basename(originalPath) : row.original_file_name;
}

function toSource(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
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

function toSummary(row: DocumentRow, aggregate: AggregateRow, coverUrl: string | null): DocumentSummary {
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
    coverUrl,
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
  private readonly books = new BookMetadataService();
  private readonly papers = new CrossrefMetadataService();
  private readonly sources = new SourceService();
  private readonly secrets = new AiProviderSettingsService();
  private coverUrlFor: (path: string, documentId?: string) => string = (path) => pathToFileURL(path).href;

  setCoverUrlFor(urlFor: (documentId: string) => string) {
    this.coverUrlFor = (_path, documentId?: string) => documentId ? urlFor(documentId) : _path;
  }

  private summary(row: DocumentRow, aggregate: AggregateRow) {
    return toSummary(row, aggregate, row.cover_image_path ? this.coverUrlFor(row.cover_image_path, row.id) : null);
  }

  coverAsset(documentId: string) {
    const row = getDb().query<{ cover_image_path: string | null }, [string]>("SELECT cover_image_path FROM project_documents WHERE id = ?").get(documentId);
    if (!row?.cover_image_path) return null;
    const extension = extname(row.cover_image_path).toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return { path: row.cover_image_path, mimeType };
  }

  private projectRoot(projectId: string) {
    return getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId)?.root_path || dataPath("projects");
  }
  private async persistDocumentIndex(projectId: string) {
    await writeProjectDocumentIndex(projectId, this.projectRoot(projectId));
  }

  private async renameArticleSources(projectId: string, documentId: string, title: string) {
    const sourceIds = getDb().query<{ id: string }, [string, string]>(
      "SELECT id FROM project_sources WHERE project_id = ? AND document_id = ? ORDER BY source_ordinal, created_at"
    ).all(projectId, documentId);
    await Promise.all(sourceIds.map((source) => this.sources.rename(projectId, source.id, title)));
  }

  private async applyProviderMetadata(current: DocumentSummary, metadata: DocumentMetadataCandidate) {
    const now = Date.now();
    const coverImagePath = current.documentType === "book"
      ? await this.saveCover(current.projectId, current.id, metadata.coverUrl).catch(() => null)
      : null;
    getDb().query(`UPDATE project_documents SET
      title = ?, subtitle = ?, description = ?, authors_json = ?, publisher = ?, published_date = ?,
      isbn_10 = ?, isbn_13 = ?, journal = ?, doi = ?, language = ?,
      cover_image_path = COALESCE(?, cover_image_path), provider = ?, provider_volume_id = ?,
      metadata_status = 'found', metadata_fetched_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`)
      .run(
        metadata.title.trim(), metadata.subtitle, metadata.description, JSON.stringify(metadata.authors), metadata.publisher,
        metadata.publishedDate, metadata.isbn10, metadata.isbn13, metadata.journal, metadata.doi, metadata.language,
        coverImagePath, metadata.provider, metadata.providerRecordId, now, now, current.id, current.projectId,
      );
    if (current.documentType === "article") {
      await this.renameArticleSources(current.projectId, current.id, metadata.title.trim());
    }
    await this.persistDocumentIndex(current.projectId);
    return this.get(current.projectId, current.id);
  }

  private async saveCover(projectId: string, documentId: string, coverUrl: string | null) {
    if (!coverUrl) return null;
    const response = await fetch(coverUrl, {
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "user-agent": "Learnie book metadata" },
      signal: AbortSignal.timeout(8_000),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("image/")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 6_000_000) return null;
    const path = join(this.projectRoot(projectId), projectId, "documents", documentId, "cover");
    await mkdir(path, { recursive: true });
    const file = join(path, contentType.includes("png") ? "cover.png" : contentType.includes("webp") ? "cover.webp" : "cover.jpg");
    await writeFile(file, bytes);
    return file;
  }
  list(projectId: string) {
    const documents = getDb()
      .query<DocumentRow, [string]>("SELECT * FROM project_documents WHERE project_id = ? ORDER BY imported_at ASC, id ASC")
      .all(projectId);
    const aggregates = aggregatesForProject(projectId);
    return documents.map((row) => this.summary(row, aggregates.get(row.id) || {
      source_count: 0,
      annotation_count: 0,
      active_session_id: null,
      last_studied_at: null,
      completed_messages: 0,
      total_messages: 0,
    }));
  }

  get(projectId: string, documentId: string) {
    const row = getDb()
      .query<DocumentRow, [string, string]>("SELECT * FROM project_documents WHERE project_id = ? AND id = ?")
      .get(projectId, documentId);
    if (!row) throw new Error("Document not found");
    return this.summary(row, aggregateFor(row.id));
  }

  listSources(projectId: string, documentId: string) {
    this.get(projectId, documentId);
    return getDb()
      .query<SourceRow, [string]>(`
        SELECT id, project_id, document_id, title, source_type, document_type, original_file_name,
               quality_status, created_at, updated_at
        FROM project_sources
        WHERE document_id = ?
        ORDER BY COALESCE(source_ordinal, 2147483647), created_at ASC, id ASC
      `)
      .all(documentId)
      .map(toSource);
  }

  async refreshMetadata(projectId: string, documentId: string) {
    const current = this.get(projectId, documentId);
    // A Crossref title search can return multiple exact-title records, so an
    // article result is never applied silently. The modal pre-fills its title
    // from the filename and lets the learner select the matching DOI.
    if (current.documentType === "article") return current;
    const apiKey = await this.secrets.getGoogleBooksApiKey();
    if (!apiKey.value) return current;
    try {
      const row = getDb().query<DocumentRow, [string, string]>("SELECT * FROM project_documents WHERE project_id = ? AND id = ?").get(projectId, documentId);
      if (!row) throw new Error("Document not found");
      const metadata = await this.books.lookupByFilename(metadataFilename(row), apiKey.value);
      if (!metadata) {
        getDb().query("UPDATE project_documents SET metadata_status = 'not_found', metadata_fetched_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), documentId);
        await this.persistDocumentIndex(projectId);
        return this.get(projectId, documentId);
      }
      return await this.applyProviderMetadata(current, metadata);
    } catch {
      getDb().query("UPDATE project_documents SET metadata_status = 'failed', metadata_fetched_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), documentId);
    }
    await this.persistDocumentIndex(projectId);
    return this.get(projectId, documentId);
  }

  async refreshProjectMetadata(projectId: string) {
    const documents = this.list(projectId).filter((document) => document.documentType === "book" && document.metadataStatus !== "manual");
    await Promise.all(documents.map((document) => this.refreshMetadata(projectId, document.id)));
    return this.list(projectId);
  }

  async searchMetadata(projectId: string, documentId: string, input: DocumentMetadataSearchInput) {
    const current = this.get(projectId, documentId);
    if (current.documentType === "book") {
      const apiKey = await this.secrets.getGoogleBooksApiKey();
      if (!apiKey.value) throw new Error("Settings에서 Google Books API key를 먼저 입력하세요.");
      return this.books.searchByIsbn(input.isbn || "", apiKey.value);
    }
    const row = getDb().query<DocumentRow, [string, string]>("SELECT * FROM project_documents WHERE project_id = ? AND id = ?").get(projectId, documentId);
    if (!row) throw new Error("Document not found");
    return this.papers.searchByTitle(input.title?.trim() || titleQueryFromFilename(metadataFilename(row)));
  }

  async applyMetadata(projectId: string, documentId: string, metadata: DocumentMetadataCandidate) {
    const current = this.get(projectId, documentId);
    if (!metadata.providerRecordId || !metadata.title.trim()) throw new Error("서지 정보 검색 결과를 다시 선택하세요.");
    if (current.documentType === "book" && metadata.provider !== "google_books") throw new Error("도서는 Google Books 검색 결과만 적용할 수 있습니다.");
    if (current.documentType === "article" && metadata.provider !== "crossref") throw new Error("논문은 Crossref 검색 결과만 적용할 수 있습니다.");
    return this.applyProviderMetadata(current, metadata);
  }

  async applyManualMetadata(projectId: string, documentId: string, value: string) {
    const current = this.get(projectId, documentId);
    const title = value.replace(/\s+/gu, " ").trim();
    if (!title) throw new Error("직접 사용할 제목을 입력하세요.");
    if (title.length > 240) throw new Error("제목은 240자 이하여야 합니다.");
    const now = Date.now();
    getDb().query(`UPDATE project_documents
      SET title = ?, subtitle = NULL, description = NULL, authors_json = '[]', publisher = NULL, published_date = NULL,
          isbn_10 = NULL, isbn_13 = NULL, journal = NULL, doi = NULL, language = NULL, cover_image_path = NULL,
          provider = 'manual', provider_volume_id = NULL, metadata_status = 'manual', metadata_fetched_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`)
      .run(title, now, now, documentId, projectId);
    if (current.documentType === "article") await this.renameArticleSources(projectId, documentId, title);
    await this.persistDocumentIndex(projectId);
    return this.get(projectId, documentId);
  }
}
