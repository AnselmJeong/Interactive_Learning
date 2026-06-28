import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { getDb } from "./project-db";
import { dataPath, sourceDirAt } from "./paths";
import type { SourceChunk, SourceManifest, SourceType } from "../shared/artifact-types";
import type { SourceSummary } from "../shared/rpc-types";

type SourceRow = {
  id: string;
  project_id: string;
  title: string;
  source_type: SourceType;
  original_file_name: string;
  original_file_path: string | null;
  imported_file_path: string;
  content_hash: string;
  manifest_path: string | null;
  chunks_path: string | null;
  quality_status: "good" | "warning" | "poor";
  created_at: number;
  updated_at: number;
};

function toSource(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourceType: row.source_type,
    originalFileName: row.original_file_name,
    qualityStatus: row.quality_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceTypeForPath(path: string): SourceType {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".pdf") return "pdf";
  return "text";
}

function titleForPath(path: string) {
  return basename(path).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || basename(path);
}

function normalizeMarkdownChunks(sourceId: string, text: string): SourceChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings: string[] = [];
  const chunks: SourceChunk[] = [];
  let buffer: string[] = [];
  let chunkIndex = 1;

  function flush(locator: string) {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    const paragraphs = body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      chunks.push({
        id: `${sourceId}-chunk-${String(chunkIndex).padStart(3, "0")}`,
        headingPath: [...headings],
        locator,
        kind: paragraph.startsWith(">") ? "quote" : "body",
        text: paragraph.replace(/^>\s?/gm, "").trim(),
        confidence: 0.95,
      });
      chunkIndex += 1;
    }
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush(`before ${heading[2]}`);
      headings.length = heading[1]!.length - 1;
      headings.push(heading[2]!.trim());
    } else {
      buffer.push(line);
    }
  }
  flush(headings.at(-1) || "document");

  if (!chunks.length && text.trim()) {
    chunks.push({
      id: `${sourceId}-chunk-001`,
      headingPath: [titleForPath(sourceId)],
      locator: "document",
      kind: "body",
      text: text.trim(),
      confidence: 0.85,
    });
  }
  return chunks;
}

async function hashFile(path: string) {
  const bytes = await readFile(path);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { digest, bytes };
}

export class SourceService {
  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  async importPaths(projectId: string, paths: string[]) {
    const imported: SourceSummary[] = [];
    for (const path of paths) {
      const { digest, bytes } = await hashFile(path);
      const existing = getDb()
        .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND content_hash = ?")
        .get(projectId, digest);
      if (existing) {
        imported.push(toSource(existing));
        continue;
      }

      const id = crypto.randomUUID();
      const type = sourceTypeForPath(path);
      const dir = sourceDirAt(this.projectRoot(projectId), projectId, id);
      await mkdir(dir, { recursive: true });
      const originalFileName = basename(path);
      const importedPath = join(dir, `original${extname(path).toLowerCase() || ".txt"}`);
      await copyFile(path, importedPath);

      let manifest: SourceManifest;
      let chunks: SourceChunk[] = [];
      const warnings: string[] = [];
      if (type === "pdf") {
        warnings.push("PDF ingestion is scaffolded; add Python text-layer extraction before using this source for production learning.");
      } else {
        chunks = normalizeMarkdownChunks(id, bytes.toString("utf8"));
      }
      const status = type === "pdf" ? "warning" : chunks.length ? "good" : "poor";
      manifest = {
        id,
        projectId,
        title: titleForPath(path),
        sourceType: type,
        originalPath: path,
        importedAt: new Date().toISOString(),
        extractionMethod: type === "pdf" ? "pending-python-pdf-extraction" : "typescript-markdown-normalizer",
        language: "ko",
        quality: { status, warnings },
      };

      const manifestPath = join(dir, "source_manifest.json");
      const chunksPath = join(dir, "source_chunks.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeFile(chunksPath, `${JSON.stringify(chunks, null, 2)}\n`, "utf8");

      const now = Date.now();
      getDb()
        .query(
          `INSERT INTO project_sources
           (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path,
            content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, projectId, manifest.title, type, originalFileName, path, importedPath, digest, manifestPath, chunksPath, status, now, now);
      imported.push(toSource(this.getRow(id)));
    }
    return imported;
  }

  list(projectId: string) {
    return getDb()
      .query<SourceRow, [string]>("SELECT * FROM project_sources WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId)
      .map(toSource);
  }

  getRow(sourceId: string) {
    const row = getDb().query<SourceRow, [string]>("SELECT * FROM project_sources WHERE id = ?").get(sourceId);
    if (!row) throw new Error("Source not found");
    return row;
  }

  async loadChunks(sourceId: string) {
    const row = this.getRow(sourceId);
    if (!row.chunks_path) return [];
    return JSON.parse(await readFile(row.chunks_path, "utf8")) as SourceChunk[];
  }
}
