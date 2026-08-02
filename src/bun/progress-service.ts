import { readFileSync } from "node:fs";
import { getDb } from "./project-db";
import type { SourceChunk } from "../shared/artifact-types";
import type {
  DocumentProgressSnapshot,
  LearningActivityDay,
  ProjectProgressSnapshot,
  SourceProgressSnapshot,
} from "../shared/rpc-types";

type SessionActivityOwner = {
  project_id: string;
  material_id: string;
};

type SourceProgressRow = {
  id: string;
  document_id: string;
  title: string;
  source_ordinal: number | null;
  chunks_path: string | null;
  document_title: string;
  document_type: "book" | "article";
  document_imported_at: number;
};

type SessionProgressRow = {
  id: string;
  current_chunk_id: string | null;
  covered_chunk_ids_json: string;
  status: "active" | "completed" | "archived";
};

function jsonStringList(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function chunkIds(path: string | null) {
  if (!path) return [];
  try {
    const chunks = JSON.parse(readFileSync(path, "utf8")) as SourceChunk[];
    return chunks.map((chunk) => chunk.id).filter(Boolean);
  } catch {
    return [];
  }
}

function statusFor(covered: number, total: number, active: boolean): SourceProgressSnapshot["status"] {
  if (total > 0 && covered >= total) return "completed";
  if (covered > 0 || active) return "in_progress";
  return "not_started";
}

function percent(covered: number, total: number) {
  return total ? Math.round((covered / total) * 100) : 0;
}

/**
 * Records only newly opened source passages.  The project/chunk primary key
 * deliberately makes revisits free: a calendar square answers "how many
 * distinct passages did I open today?", not "how many clicks did I make?".
 */
export function recordChunkViews(
  sessionId: string,
  previouslyViewed: Iterable<string>,
  coveredAfter: Iterable<string>,
  currentChunkId: string | null,
  occurredAt = Date.now(),
) {
  const known = new Set(previouslyViewed);
  const next = new Set(coveredAfter);
  if (currentChunkId) next.add(currentChunkId);
  const newlyViewed = [...next].filter((chunkId) => chunkId && !known.has(chunkId));
  if (!newlyViewed.length) return;

  const owner = getDb()
    .query<SessionActivityOwner, [string]>("SELECT project_id, material_id FROM learning_sessions WHERE id = ?")
    .get(sessionId);
  if (!owner) return;
  const insert = getDb().query(
    `INSERT OR IGNORE INTO learning_chunk_activity
     (project_id, session_id, material_id, chunk_id, occurred_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const chunkId of newlyViewed) insert.run(owner.project_id, sessionId, owner.material_id, chunkId, occurredAt);
}

export class ProgressService {
  getProjectSnapshot(projectId: string): ProjectProgressSnapshot {
    const project = getDb().query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found");

    const sourceRows = getDb().query<SourceProgressRow, [string]>(`
      SELECT s.id, s.document_id, s.title, s.source_ordinal, s.chunks_path,
             d.title AS document_title, d.document_type, d.imported_at AS document_imported_at
      FROM project_sources s
      JOIN project_documents d ON d.id = s.document_id
      WHERE s.project_id = ?
      ORDER BY d.imported_at ASC, d.id ASC, COALESCE(s.source_ordinal, 2147483647), s.created_at ASC, s.id ASC
    `).all(projectId);
    const sessions = getDb().query<SessionProgressRow, [string]>(`
      SELECT DISTINCT s.id, s.current_chunk_id, s.covered_chunk_ids_json, s.status
      FROM learning_sessions s
      WHERE s.project_id = ?
      ORDER BY s.updated_at DESC
    `).all(projectId);

    const coveredAcrossSessions = new Set<string>();
    const activeSessionByChunk = new Map<string, string>();
    let mostRecentActive: SessionProgressRow | null = null;
    for (const session of sessions) {
      for (const chunkId of jsonStringList(session.covered_chunk_ids_json)) coveredAcrossSessions.add(chunkId);
      if (session.status === "active" && session.current_chunk_id && !activeSessionByChunk.has(session.current_chunk_id)) {
        activeSessionByChunk.set(session.current_chunk_id, session.id);
      }
      if (session.status === "active" && !mostRecentActive) mostRecentActive = session;
    }

    const allValidChunks = new Set<string>();
    const sourceChunks = new Map<string, string[]>();
    for (const source of sourceRows) {
      const ids = chunkIds(source.chunks_path);
      sourceChunks.set(source.id, ids);
      for (const id of ids) allValidChunks.add(id);
    }
    let orphanCoveredChunkCount = 0;
    for (const id of coveredAcrossSessions) if (!allValidChunks.has(id)) orphanCoveredChunkCount += 1;

    const currentChunkId = mostRecentActive?.current_chunk_id || null;
    const sourceSnapshots = sourceRows.map((source): SourceProgressSnapshot => {
      const ids = sourceChunks.get(source.id) || [];
      const covered = ids.filter((id) => coveredAcrossSessions.has(id)).length;
      const current = currentChunkId && ids.includes(currentChunkId) ? currentChunkId : null;
      return {
        sourceId: source.id,
        documentId: source.document_id,
        title: source.title,
        ordinal: source.source_ordinal ?? 0,
        status: statusFor(covered, ids.length, Boolean(current)),
        coveredChunks: covered,
        totalChunks: ids.length,
        percent: percent(covered, ids.length),
        currentChunkId: current,
        activeSessionId: current ? activeSessionByChunk.get(current) || mostRecentActive?.id || null : null,
      };
    });

    const documents: DocumentProgressSnapshot[] = [];
    for (const source of sourceRows) {
      if (documents.some((document) => document.documentId === source.document_id)) continue;
      const children = sourceSnapshots.filter((item) => item.documentId === source.document_id);
      const covered = children.reduce((sum, item) => sum + item.coveredChunks, 0);
      const total = children.reduce((sum, item) => sum + item.totalChunks, 0);
      const current = children.find((item) => item.currentChunkId);
      documents.push({
        documentId: source.document_id,
        title: source.document_title,
        documentType: source.document_type,
        status: statusFor(covered, total, Boolean(current)),
        coveredChunks: covered,
        totalChunks: total,
        percent: percent(covered, total),
        currentSourceId: current?.sourceId || null,
        activeSessionId: current?.activeSessionId || null,
        sources: children,
      });
    }

    const activityDays = getDb().query<LearningActivityDay, [string]>(`
      SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', 'localtime') AS date,
             COUNT(*) AS viewedChunks
      FROM learning_chunk_activity
      WHERE project_id = ?
        AND occurred_at >= (CAST(strftime('%s', 'now', 'localtime', 'start of day', '-364 days') AS INTEGER) * 1000)
      GROUP BY date
      ORDER BY date ASC
    `).all(projectId);
    const covered = sourceSnapshots.reduce((sum, item) => sum + item.coveredChunks, 0);
    const total = sourceSnapshots.reduce((sum, item) => sum + item.totalChunks, 0);
    const currentSource = sourceSnapshots.find((item) => item.currentChunkId) || null;
    return {
      projectId,
      status: statusFor(covered, total, Boolean(currentSource)),
      coveredChunks: covered,
      totalChunks: total,
      percent: percent(covered, total),
      currentDocumentId: currentSource?.documentId || null,
      currentSourceId: currentSource?.sourceId || null,
      activeSessionId: currentSource?.activeSessionId || mostRecentActive?.id || null,
      documents,
      activityDays,
      orphanCoveredChunkCount,
    };
  }

  getDocumentSnapshot(projectId: string, documentId: string) {
    const document = this.getProjectSnapshot(projectId).documents.find((item) => item.documentId === documentId);
    if (!document) throw new Error("Document not found");
    return document;
  }
}
