import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "./project-db";
import { dataPath, sourceDirAt } from "./paths";
import { buildPreppySourcePack } from "./preppy-service";
import { SettingsService } from "./settings-service";
import type { SourceChunk, SourceFigure, SourceManifest, SourceType } from "../shared/artifact-types";
import type { PreparedSourceImport, PreparedSourceImportItem, SourceSummary } from "../shared/rpc-types";

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

type MaterialDeletionRow = {
  id: string;
  manifest_path: string | null;
};

type SourceLearningStatus = SourceSummary["learningStatus"];

type SourceLearningStatusRow = {
  source_id: string;
  status: "active" | "completed" | "archived";
};

type PreppyManifest = {
  output?: {
    chapters_dir?: string;
    assets_dir?: string;
  };
  chapters?: Array<{
    title?: string;
    path?: string;
    index?: number;
    kind?: string;
    char_count?: number;
  }>;
};

type PreppyFigure = {
  id?: string;
  asset_path?: string;
  source_type?: string;
  chapter_index?: number | null;
  caption?: string | null;
  caption_status?: string;
  source_locator?: {
    page_start?: number | null;
    page_end?: number | null;
    page?: number | null;
    epub_href?: string | null;
    anchor?: string | null;
    docling_ref?: string | null;
  };
  width?: number | null;
  height?: number | null;
};

type PreparedImportEntry = {
  id: string;
  projectId: string;
  sourceName: string;
  sourcePath: string;
  folders: Array<{ path: string; originalSourcePath: string; cleanup?: () => Promise<void> }>;
  files: Array<{ path: string }>;
  items: PreparedSourceImportItem[];
  itemRefs: Map<string, { kind: "folder"; folderIndex: number; relativePath: string } | { kind: "file"; fileIndex: number }>;
};

const preparedImports = new Map<string, PreparedImportEntry>();

function toSource(row: SourceRow, learningStatus: SourceLearningStatus = "not_started"): SourceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourceType: row.source_type,
    originalFileName: row.original_file_name,
    qualityStatus: row.quality_status,
    learningStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceTypeForPath(path: string): SourceType {
  const ext = extname(path).toLowerCase();
  if (ext === ".md") return "markdown";
  if (ext === ".txt") return "text";
  throw new Error("Only Markdown (.md) and TXT files can be imported directly. Choose a folder to preserve PDFs, EPUBs, and assets.");
}

function isImportableFile(path: string) {
  return [".md", ".txt"].includes(extname(path).toLowerCase());
}

function isPreppyInputFile(path: string) {
  return [".pdf", ".epub"].includes(extname(path).toLowerCase());
}

function isFolderTextFile(path: string) {
  return [".md", ".txt"].includes(extname(path).toLowerCase());
}

const naturalPathSorter = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const MARKDOWN_IMAGE_LINK_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
const URL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

function titleForPath(path: string) {
  return basename(path).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || basename(path);
}

function relativePortable(from: string, to: string) {
  return relative(from, to).replaceAll("\\", "/");
}

function decodePathPart(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function rewriteLocalMarkdownImageLinks(markdownPath: string, text: string) {
  const baseDir = dirname(markdownPath);
  return text.replace(MARKDOWN_IMAGE_LINK_RE, (match, alt: string, link: string, title: string | undefined) => {
    if (!link || URL_SCHEME_RE.test(link)) return match;
    const hashIndex = link.indexOf("#");
    const pathPart = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
    const fragment = hashIndex >= 0 ? link.slice(hashIndex) : "";
    if (!pathPart) return match;
    const filePath = pathPart.startsWith("/") ? decodePathPart(pathPart) : resolve(baseDir, decodePathPart(pathPart));
    const url = `${pathToFileURL(filePath).href}${fragment}`;
    const titlePart = title ? ` "${title}"` : "";
    return `![${alt}](${url}${titlePart})`;
  });
}

async function sourceChildPath(sourcePath: string, relativePath: string) {
  try {
    if ((await stat(sourcePath)).isDirectory()) return join(sourcePath, relativePath);
  } catch {
    // Fall through to source-pack provenance notation.
  }
  return `${sourcePath}#${relativePath}`;
}

const SEMANTIC_CHUNK_MIN_CHARS = 360;
const SEMANTIC_CHUNK_TARGET_CHARS = 900;
const SEMANTIC_CHUNK_MAX_CHARS = 1500;

function cleanSourceBlock(block: string) {
  return block.replace(/^>\s?/gm, "").replace(/\s+\n/g, "\n").trim();
}

function sourceChunkKind(block: string): SourceChunk["kind"] {
  const trimmed = block.trim();
  if (trimmed.startsWith(">")) return "quote";
  if (/^\s*\|.+\|\s*$/m.test(trimmed)) return "table";
  if (/^!\[[^\]]*]/.test(trimmed)) return "caption";
  if (/^(note|주|참고)\s*[:：]/i.test(trimmed)) return "note";
  return "body";
}

function speakerLabel(block: string) {
  return /^(speaker\s+[a-z]|화자\s*[가-힣a-z]|[AB]\s*[:：])/i.exec(block.trim())?.[1]?.toLowerCase() || null;
}

function startsNewSemanticBeat(block: string) {
  return /^(however|but|by contrast|on the other hand|therefore|so|the problem|the point|그런데|하지만|반면|따라서|그러므로|문제는|여기서|결국|즉|다시 말해)\b/i.test(block.trim());
}

function splitLongSemanticBlock(text: string, maxChars = SEMANTIC_CHUNK_MAX_CHARS) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return [normalized];
  const sentences = normalized.match(/[^.!?。…]*[.!?。…]+["'”’)\]]?|[^.!?。…]+$/g) || [normalized];
  const chunks: string[] = [];
  let buffer = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (buffer && buffer.length + 1 + sentence.length > maxChars) {
      chunks.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

function piecesForSourceBlock(text: string, kind: SourceChunk["kind"]) {
  if (kind === "caption" || kind === "table") return [text];
  return splitLongSemanticBlock(text);
}

function semanticChunksFromBody(body: string): Array<{ text: string; kind: SourceChunk["kind"]; confidence: number }> {
  const blocks = body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: Array<{ text: string; kind: SourceChunk["kind"]; confidence: number }> = [];
  let buffer: string[] = [];
  let bufferKind: SourceChunk["kind"] = "body";
  let speakerTurns = 0;

  function bufferText(next = "") {
    return [...buffer, next].filter(Boolean).join("\n\n").trim();
  }

  function flush(confidence = 0.9) {
    const text = bufferText();
    buffer = [];
    speakerTurns = 0;
    if (!text) return;
    for (const piece of piecesForSourceBlock(text, bufferKind)) {
      chunks.push({ text: piece, kind: bufferKind, confidence });
    }
    bufferKind = "body";
  }

  for (const rawBlock of blocks) {
    const kind = sourceChunkKind(rawBlock);
    const block = cleanSourceBlock(rawBlock);
    if (!block) continue;
    const current = bufferText();
    const candidate = bufferText(block);
    const label = speakerLabel(block);
    const isSpecialBlock = kind === "table" || kind === "caption";

    if (buffer.length && isSpecialBlock) flush(0.92);
    else if (buffer.length && kind !== bufferKind && (kind !== "body" || bufferKind !== "quote")) flush(0.9);
    else if (buffer.length && candidate.length > SEMANTIC_CHUNK_MAX_CHARS) flush(0.88);
    else if (buffer.length && current.length >= SEMANTIC_CHUNK_TARGET_CHARS && startsNewSemanticBeat(rawBlock)) flush(0.9);
    else if (buffer.length && label && speakerTurns >= 2 && current.length >= SEMANTIC_CHUNK_MIN_CHARS) flush(0.9);
    else if (buffer.length && current.length >= SEMANTIC_CHUNK_TARGET_CHARS && !label) flush(0.88);

    if (!buffer.length) bufferKind = kind;
    buffer.push(block);
    if (label) speakerTurns += 1;

    if (isSpecialBlock) flush(0.92);
  }

  flush(0.9);
  return chunks;
}

export function sanitizeHeadingPath(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean);
}

export function normalizeMarkdownChunks(sourceId: string, text: string): SourceChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings: string[] = [];
  const chunks: SourceChunk[] = [];
  let buffer: string[] = [];
  let chunkIndex = 1;

  function flush(locator: string) {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    for (const chunk of semanticChunksFromBody(body)) {
      chunks.push({
        id: `${sourceId}-chunk-${String(chunkIndex).padStart(3, "0")}`,
        headingPath: [...headings],
        locator,
        kind: chunk.kind,
        text: chunk.text,
        confidence: chunk.confidence,
      });
      chunkIndex += 1;
    }
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush(`before ${heading[2]}`);
      const insertAt = Math.min(heading[1]!.length - 1, headings.length);
      headings.splice(insertAt);
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

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort((a, b) => naturalPathSorter.compare(relative(root, a), relative(root, b)));
}

async function existingDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hashDirectory(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  const files = await walkFiles(path);
  for (const file of files) {
    hasher.update(relative(path, file));
    hasher.update(await readFile(file));
  }
  if (!files.length) hasher.update(path);
  return hasher.digest("hex");
}

async function readPreppyManifest(importedRoot: string) {
  try {
    const manifest = JSON.parse(await readFile(join(importedRoot, "manifest.json"), "utf8")) as PreppyManifest;
    const chapterTitleByPath = new Map<string, string>();
    const chapterIndexByPath = new Map<string, number>();
    for (const chapter of manifest.chapters ?? []) {
      if (!chapter.path) continue;
      const normalized = chapter.path.replaceAll("\\", "/");
      if (chapter.title) chapterTitleByPath.set(normalized, chapter.title);
      if (typeof chapter.index === "number") chapterIndexByPath.set(normalized, chapter.index);
    }
    return {
      chaptersDir: manifest.output?.chapters_dir || "chapters",
      assetsDir: manifest.output?.assets_dir || "assets",
      chapterTitleByPath,
      chapterIndexByPath,
    };
  } catch {
    return {
      chaptersDir: "chapters",
      assetsDir: "assets",
      chapterTitleByPath: new Map<string, string>(),
      chapterIndexByPath: new Map<string, number>(),
    };
  }
}

async function readPreppyFigures(importedRoot: string) {
  try {
    const data = JSON.parse(await readFile(join(importedRoot, "figures.json"), "utf8")) as { figures?: PreppyFigure[] };
    return Array.isArray(data.figures) ? data.figures : [];
  } catch {
    return [];
  }
}

function mimeTypeForPath(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

function locatorForFigure(figure: PreppyFigure, fallback: string) {
  const locator = figure.source_locator || {};
  const pageStart = locator.page_start ?? locator.page ?? null;
  const pageEnd = locator.page_end ?? pageStart;
  if (pageStart && pageEnd && pageStart !== pageEnd) return `pages ${pageStart}-${pageEnd}`;
  if (pageStart) return `page ${pageStart}`;
  if (locator.epub_href) return locator.anchor ? `${locator.epub_href}#${locator.anchor}` : locator.epub_href;
  if (locator.docling_ref) return locator.docling_ref;
  return fallback;
}

function pageRangeForFigure(figure: PreppyFigure): [number, number] | undefined {
  const locator = figure.source_locator || {};
  const start = locator.page_start ?? locator.page ?? null;
  const end = locator.page_end ?? start;
  return start && end ? [start, end] : undefined;
}

function normalizedNeedle(text: string | null | undefined) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function figureLabel(caption: string | null | undefined) {
  return /figure\s+\d+(?:\.\d+)*/i.exec(caption || "")?.[0] || null;
}

function chunkIdsForFigure(figure: PreppyFigure, chunks: SourceChunk[]) {
  if (!chunks.length) return [];
  const ids: string[] = [];
  const label = normalizedNeedle(figureLabel(figure.caption));
  if (label) {
    const mention = chunks.find((chunk) => chunk.kind !== "caption" && normalizedNeedle(chunk.text).includes(label));
    if (mention) ids.push(mention.id);
  }
  const caption = normalizedNeedle(figure.caption);
  if (caption.length >= 12) {
    const match = chunks.find((chunk) => normalizedNeedle(chunk.text).includes(caption));
    if (match) ids.push(match.id);
  }
  const captionChunk = chunks.find((chunk) => chunk.kind === "caption");
  if (captionChunk) ids.push(captionChunk.id);
  return [...new Set(ids.length ? ids : [chunks[0]!.id])];
}

function toSourceFigures(input: {
  sourceId: string;
  importedRoot: string;
  manifestPath: string;
  chapterIndex: number | undefined;
  figures: PreppyFigure[];
  chunks: SourceChunk[];
}) {
  return input.figures
    .filter((figure) => figure.id && figure.asset_path && figure.chapter_index === input.chapterIndex)
    .map((figure, index): SourceFigure => {
      const assetPath = resolve(input.importedRoot, figure.asset_path!);
      const caption = figure.caption?.trim() || null;
      const locator = locatorForFigure(figure, input.manifestPath);
      const pageRange = pageRangeForFigure(figure);
      return {
        id: `${input.sourceId}-figure-${figure.id}`,
        sourceId: input.sourceId,
        title: caption ? caption.slice(0, 80) : `Figure ${index + 1}`,
        assetPath,
        assetUrl: pathToFileURL(assetPath).href,
        mimeType: mimeTypeForPath(assetPath),
        caption,
        captionStatus: figure.caption_status || "missing",
        width: typeof figure.width === "number" ? figure.width : null,
        height: typeof figure.height === "number" ? figure.height : null,
        locator,
        pageRange,
        sourceChunkIds: chunkIdsForFigure(figure, input.chunks),
      };
    });
}

function sourcePackRelativePath(row: SourceRow) {
  const original = row.original_file_path || "";
  const marker = original.indexOf("#");
  if (marker >= 0) return original.slice(marker + 1).replaceAll("\\", "/");
  const parts = row.imported_file_path.replaceAll("\\", "/").split("/source_folders/");
  if (parts.length < 2) return null;
  const originalIndex = parts[1]!.indexOf("/original/");
  if (originalIndex < 0) return null;
  return parts[1]!.slice(originalIndex + "/original/".length);
}

function isInsidePath(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.match(/^[A-Za-z]:/));
}

function sourceFolderDirFor(projectRoot: string, projectId: string, path: string) {
  const foldersRoot = join(projectRoot, projectId, "source_folders");
  if (!isInsidePath(foldersRoot, path)) return null;
  const rel = relative(foldersRoot, path);
  const folderId = rel.split(/[\\/]/).find(Boolean);
  return folderId ? join(foldersRoot, folderId) : null;
}

function previewText(text: string, max = 5200) {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trim()}\n\n...`;
}

function defaultSelected(kind: string | null, charCount: number, minChars: number) {
  if (kind && ["frontmatter", "backmatter", "notes", "bibliography", "index"].includes(kind)) return false;
  if (charCount < minChars) return false;
  return true;
}

function toPrepared(entry: PreparedImportEntry): PreparedSourceImport {
  return {
    id: entry.id,
    projectId: entry.projectId,
    sourceName: entry.sourceName,
    sourcePath: entry.sourcePath,
    itemCount: entry.items.length,
    items: entry.items,
  };
}

export class SourceService {
  private readonly settings = new SettingsService();

  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  async importPaths(projectId: string, paths: string[]) {
    const imported: SourceSummary[] = [];
    for (const path of paths) {
      const info = await stat(path);
      if (info.isDirectory()) {
        imported.push(...(await this.importFolder(projectId, path)));
      } else if (info.isFile() && isPreppyInputFile(path)) {
        const sourcePack = await buildPreppySourcePack(path);
        try {
          imported.push(...(await this.importFolder(projectId, sourcePack.outputPath, path)));
        } finally {
          await sourcePack.cleanup();
        }
      } else if (info.isFile() && isImportableFile(path)) {
        imported.push(await this.importFile(projectId, path));
      }
    }
    return imported;
  }

  async prepareImport(projectId: string, paths: string[]) {
    const id = crypto.randomUUID();
    const settings = await this.settings.get();
    const entry: PreparedImportEntry = {
      id,
      projectId,
      sourceName: paths.length === 1 ? titleForPath(paths[0]!) : `${paths.length} selected sources`,
      sourcePath: paths.join(", "),
      folders: [],
      files: [],
      items: [],
      itemRefs: new Map(),
    };

    try {
      for (const path of paths) {
        const info = await stat(path);
        if (info.isDirectory()) {
          await this.addPreparedFolder(entry, path, path, settings.sourceImportMinChars);
        } else if (info.isFile() && isPreppyInputFile(path)) {
          const sourcePack = await buildPreppySourcePack(path);
          await this.addPreparedFolder(entry, sourcePack.outputPath, path, settings.sourceImportMinChars, sourcePack.cleanup);
        } else if (info.isFile() && isImportableFile(path)) {
          await this.addPreparedFile(entry, path, settings.sourceImportMinChars);
        }
      }
      preparedImports.set(id, entry);
      return toPrepared(entry);
    } catch (error) {
      await this.cleanupPrepared(entry);
      throw error;
    }
  }

  async commitPreparedImport(projectId: string, importId: string, selectedItemIds: string[]) {
    const entry = preparedImports.get(importId);
    if (!entry || entry.projectId !== projectId) throw new Error("Prepared import not found");
    const selected = new Set(selectedItemIds);
    const imported: SourceSummary[] = [];
    try {
      for (let index = 0; index < entry.files.length; index += 1) {
        const itemIds = [...entry.itemRefs.entries()]
          .filter(([, ref]) => ref.kind === "file" && ref.fileIndex === index)
          .map(([itemId]) => itemId);
        if (itemIds.some((itemId) => selected.has(itemId))) imported.push(await this.importFile(projectId, entry.files[index]!.path));
      }

      for (let index = 0; index < entry.folders.length; index += 1) {
        const selectedRelativePaths = [...entry.itemRefs.entries()]
          .filter(([itemId, ref]) => selected.has(itemId) && ref.kind === "folder" && ref.folderIndex === index)
          .map(([, ref]) => (ref.kind === "folder" ? ref.relativePath : ""));
        if (!selectedRelativePaths.length) continue;
        const folder = entry.folders[index]!;
        imported.push(...(await this.importFolder(projectId, folder.path, folder.originalSourcePath, selectedRelativePaths)));
      }
      return imported;
    } finally {
      preparedImports.delete(importId);
      await this.cleanupPrepared(entry);
    }
  }

  async cancelPreparedImport(projectId: string, importId: string) {
    const entry = preparedImports.get(importId);
    if (!entry || entry.projectId !== projectId) return true;
    preparedImports.delete(importId);
    await this.cleanupPrepared(entry);
    return true;
  }

  private async addPreparedFile(entry: PreparedImportEntry, path: string, sourceImportMinChars: number) {
    const fileIndex = entry.files.push({ path }) - 1;
    const text = await readFile(path, "utf8");
    const previewSource = rewriteLocalMarkdownImageLinks(path, text);
    const itemId = crypto.randomUUID();
    entry.items.push({
      id: itemId,
      title: titleForPath(path),
      fileName: basename(path),
      relativePath: basename(path),
      kind: null,
      charCount: text.trim().length,
      preview: previewText(previewSource),
      selected: defaultSelected(null, text.trim().length, sourceImportMinChars),
    });
    entry.itemRefs.set(itemId, { kind: "file", fileIndex });
  }

  private async addPreparedFolder(entry: PreparedImportEntry, path: string, originalSourcePath: string, sourceImportMinChars: number, cleanup?: () => Promise<void>) {
    const folderIndex = entry.folders.push({ path, originalSourcePath, cleanup }) - 1;
    const preppyManifest = await readPreppyManifest(path);
    const chaptersDir = join(path, preppyManifest.chaptersDir);
    const textRoot = (await existingDir(chaptersDir)) ? chaptersDir : path;
    const textFiles = (await walkFiles(textRoot)).filter(isFolderTextFile);
    const manifestByPath = new Map((await this.preppyChapterRows(path)).map((chapter) => [chapter.path, chapter]));
    for (const file of textFiles) {
      const relativePath = relativePortable(path, file);
      const relativeToTextRoot = relativePortable(textRoot, file);
      const text = await readFile(file, "utf8");
      const previewSource = rewriteLocalMarkdownImageLinks(file, text);
      const manifestChapter = manifestByPath.get(relativePath);
      const itemId = crypto.randomUUID();
      const charCount = manifestChapter?.charCount ?? text.trim().length;
      entry.items.push({
        id: itemId,
        title: manifestChapter?.title || preppyManifest.chapterTitleByPath.get(relativePath) || titleForPath(file),
        fileName: basename(file),
        relativePath,
        kind: manifestChapter?.kind || null,
        charCount,
        preview: previewText(previewSource),
        selected: defaultSelected(manifestChapter?.kind || null, charCount, sourceImportMinChars),
      });
      entry.itemRefs.set(itemId, { kind: "folder", folderIndex, relativePath: relativePath || relativeToTextRoot });
    }
  }

  private async preppyChapterRows(root: string) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as PreppyManifest;
      return (manifest.chapters || [])
        .filter((chapter) => chapter.path)
        .map((chapter) => ({
          path: chapter.path!.replaceAll("\\", "/"),
          title: chapter.title || "",
          kind: chapter.kind || null,
          charCount: chapter.char_count || 0,
        }));
    } catch {
      return [];
    }
  }

  private async cleanupPrepared(entry: PreparedImportEntry) {
    await Promise.all(entry.folders.map((folder) => folder.cleanup?.().catch(() => undefined)));
  }

  private async importFile(projectId: string, path: string) {
    const { digest, bytes } = await hashFile(path);
    const existing = getDb()
      .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND content_hash = ?")
      .get(projectId, digest);
    if (existing) return toSource(existing);

    const id = crypto.randomUUID();
    const type = sourceTypeForPath(path);
    const dir = sourceDirAt(this.projectRoot(projectId), projectId, id);
    await mkdir(dir, { recursive: true });
    const originalFileName = basename(path);
    const importedPath = join(dir, `original${extname(path).toLowerCase() || ".txt"}`);
    await copyFile(path, importedPath);

    const chunks = normalizeMarkdownChunks(id, rewriteLocalMarkdownImageLinks(importedPath, bytes.toString("utf8")));
    const status = chunks.length ? "good" : "poor";
    return this.persistSource({
      id,
      projectId,
      title: titleForPath(path),
      type,
      originalPath: path,
      originalFileName,
      importedPath,
      digest,
      chunks,
      extractionMethod: "typescript-markdown-normalizer",
      status,
      warnings: [],
    });
  }

  private async importFolder(projectId: string, path: string, originalSourcePath = path, selectedRelativePaths?: string[]) {
    await this.removeLegacyFolderAggregate(projectId, originalSourcePath);
    const folderImportId = crypto.randomUUID();
    const folderDir = join(this.projectRoot(projectId), projectId, "source_folders", folderImportId);
    const importedRoot = join(folderDir, "original");
    await mkdir(folderDir, { recursive: true });
    await cp(path, importedRoot, { recursive: true });

    const folderDigest = await hashDirectory(path);
    const allCopiedFiles = await walkFiles(importedRoot);
    const preppyManifest = await readPreppyManifest(importedRoot);
    const preppyFigures = await readPreppyFigures(importedRoot);
    const chaptersDir = join(importedRoot, preppyManifest.chaptersDir);
    const textRoot = (await existingDir(chaptersDir)) ? chaptersDir : importedRoot;
    const selectedRelativePathSet = selectedRelativePaths ? new Set(selectedRelativePaths) : null;
    const textFiles = (await walkFiles(textRoot)).filter((file) => {
      if (!isFolderTextFile(file)) return false;
      if (!selectedRelativePathSet) return true;
      return selectedRelativePathSet.has(relativePortable(importedRoot, file));
    });
    const textFilePaths = new Set(textFiles);
    const preservedFiles = allCopiedFiles.filter((file) => !textFilePaths.has(file));
    await writeFile(
      join(folderDir, "folder_manifest.json"),
      `${JSON.stringify(
        {
          id: folderImportId,
          projectId,
          title: titleForPath(originalSourcePath),
          originalPath: originalSourcePath,
          importedPath: importedRoot,
          textRoot,
          chaptersDir: preppyManifest.chaptersDir,
          assetsDir: preppyManifest.assetsDir,
          contentHash: folderDigest,
          importedAt: new Date().toISOString(),
          textFileCount: textFiles.length,
          preservedFileCount: preservedFiles.length,
          sourceOrder: textFiles.map((file) => relativePortable(textRoot, file)),
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const imported: SourceSummary[] = [];
    let createdCount = 0;
    for (const copiedFile of textFiles) {
      const manifestPath = relativePortable(importedRoot, copiedFile);
      const originalPath = await sourceChildPath(originalSourcePath, manifestPath);
      const title = preppyManifest.chapterTitleByPath.get(manifestPath) || titleForPath(copiedFile);
      const result = await this.importTextFileFromCopiedFolder(projectId, originalPath, copiedFile, title, {
        importedRoot,
        manifestPath,
        chapterIndex: preppyManifest.chapterIndexByPath.get(manifestPath),
        figures: preppyFigures,
      });
      imported.push(result.source);
      if (result.created) createdCount += 1;
    }
    if (createdCount === 0) await rm(folderDir, { recursive: true, force: true });
    return imported;
  }

  private async removeLegacyFolderAggregate(projectId: string, originalPath: string) {
    const rows = getDb()
      .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND original_file_path = ?")
      .all(projectId, originalPath);
    for (const row of rows) {
      try {
        if (!(await stat(row.imported_file_path)).isDirectory()) continue;
      } catch {
        continue;
      }
      getDb().query("DELETE FROM project_sources WHERE id = ?").run(row.id);
      getDb()
        .query(
          `DELETE FROM learning_materials
           WHERE project_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM material_sources
               WHERE material_sources.material_id = learning_materials.id
             )`
        )
        .run(projectId);
      if (row.manifest_path) await rm(dirname(row.manifest_path), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async importTextFileFromCopiedFolder(
    projectId: string,
    originalPath: string,
    importedPath: string,
    title: string,
    preppy?: { importedRoot: string; manifestPath: string; chapterIndex: number | undefined; figures: PreppyFigure[] }
  ) {
    const { digest, bytes } = await hashFile(importedPath);
    const existing = getDb()
      .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND content_hash = ?")
      .get(projectId, digest);
    if (existing) return { source: toSource(existing), created: false };

    const id = crypto.randomUUID();
    const type = sourceTypeForPath(importedPath);
    const chunks = normalizeMarkdownChunks(id, rewriteLocalMarkdownImageLinks(importedPath, bytes.toString("utf8")));
    const figures = preppy
      ? toSourceFigures({
          sourceId: id,
          importedRoot: preppy.importedRoot,
          manifestPath: preppy.manifestPath,
          chapterIndex: preppy.chapterIndex,
          figures: preppy.figures,
          chunks,
        })
      : [];
    const source = await this.persistSource({
      id,
      projectId,
      title,
      type,
      originalPath,
      originalFileName: basename(importedPath),
      importedPath,
      digest,
      chunks,
      figures,
      extractionMethod: "typescript-folder-file-normalizer",
      status: chunks.length ? "good" : "poor",
      warnings: [],
    });
    return { source, created: true };
  }

  private async persistSource(input: {
    id: string;
    projectId: string;
    title: string;
    type: SourceType;
    originalPath: string;
    originalFileName: string;
    importedPath: string;
    digest: string;
    chunks: SourceChunk[];
    figures?: SourceFigure[];
    extractionMethod: string;
    status: "good" | "warning" | "poor";
    warnings: string[];
  }) {
    const dir = sourceDirAt(this.projectRoot(input.projectId), input.projectId, input.id);
    await mkdir(dir, { recursive: true });
    const manifest: SourceManifest = {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      updatedAt: new Date().toISOString(),
      sourceType: input.type,
      originalPath: input.originalPath,
      importedAt: new Date().toISOString(),
      extractionMethod: input.extractionMethod,
      language: "ko",
      quality: { status: input.status, warnings: input.warnings },
    };
    const manifestPath = join(dir, "source_manifest.json");
    const chunksPath = join(dir, "source_chunks.json");
    const figuresPath = join(dir, "source_figures.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(chunksPath, `${JSON.stringify(input.chunks, null, 2)}\n`, "utf8");
    await writeFile(figuresPath, `${JSON.stringify(input.figures || [], null, 2)}\n`, "utf8");
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path,
          content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.projectId,
        input.title,
        input.type,
        input.originalFileName,
        input.originalPath,
        input.importedPath,
        input.digest,
        manifestPath,
        chunksPath,
        input.status,
        now,
        now
      );
    return toSource(this.getRow(input.id));
  }

  list(projectId: string) {
    const learningStatusBySourceId = this.learningStatuses(projectId);
    return getDb()
      .query<SourceRow, [string]>("SELECT * FROM project_sources WHERE project_id = ?")
      .all(projectId)
      .map((row) => toSource(row, learningStatusBySourceId.get(row.id) || "not_started"))
      .sort((a, b) => naturalPathSorter.compare(a.originalFileName || a.title, b.originalFileName || b.title));
  }

  async rename(projectId: string, sourceId: string, title: string) {
    const nextTitle = title.replace(/\s+/gu, " ").trim();
    if (!nextTitle) throw new Error("Source title is required");
    if (nextTitle.length > 240) throw new Error("Source title must be 240 characters or fewer");

    const row = getDb()
      .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE id = ? AND project_id = ?")
      .get(sourceId, projectId);
    if (!row) throw new Error("Source not found");
    if (row.title === nextTitle) {
      const learningStatus = this.learningStatuses(projectId).get(sourceId) || "not_started";
      return toSource(row, learningStatus);
    }

    const now = Date.now();
    const previousManifestText = row.manifest_path
      ? await readFile(row.manifest_path, "utf8").catch(() => null)
      : null;
    let previousManifest: Partial<SourceManifest> | null = null;
    if (previousManifestText) {
      try {
        previousManifest = JSON.parse(previousManifestText) as Partial<SourceManifest>;
      } catch {
        previousManifest = null;
      }
    }

    if (row.manifest_path) {
      const nextManifest: SourceManifest = {
        ...previousManifest,
        id: row.id,
        projectId: row.project_id,
        sourceType: row.source_type,
        originalPath: row.original_file_path || undefined,
        importedAt: previousManifest?.importedAt || new Date(row.created_at).toISOString(),
        extractionMethod: previousManifest?.extractionMethod || "learnie-source",
        language: previousManifest?.language || "ko",
        quality: previousManifest?.quality || { status: row.quality_status, warnings: [] },
        title: nextTitle,
        updatedAt: new Date(now).toISOString(),
      };
      await mkdir(dirname(row.manifest_path), { recursive: true });
      await writeFile(row.manifest_path, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
    }

    try {
      getDb()
        .query("UPDATE project_sources SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?")
        .run(nextTitle, now, sourceId, projectId);
    } catch (error) {
      if (row.manifest_path) {
        if (previousManifestText === null) await rm(row.manifest_path, { force: true }).catch(() => undefined);
        else await writeFile(row.manifest_path, previousManifestText, "utf8").catch(() => undefined);
      }
      throw error;
    }

    const learningStatus = this.learningStatuses(projectId).get(sourceId) || "not_started";
    return toSource(this.getRow(sourceId), learningStatus);
  }

  private learningStatuses(projectId: string) {
    const statuses = new Map<string, SourceLearningStatus>();
    const rows = getDb()
      .query<SourceLearningStatusRow, [string]>(
        `SELECT material_sources.source_id, learning_sessions.status
         FROM material_sources
         JOIN learning_materials ON learning_materials.id = material_sources.material_id
         JOIN learning_sessions ON learning_sessions.material_id = learning_materials.id
         WHERE learning_materials.project_id = ?
           AND learning_sessions.status IN ('active', 'completed')`
      )
      .all(projectId);

    for (const row of rows) {
      if (row.status === "active") {
        statuses.set(row.source_id, "in_progress");
      } else if (!statuses.has(row.source_id)) {
        statuses.set(row.source_id, "completed");
      }
    }
    return statuses;
  }

  getRow(sourceId: string) {
    const row = getDb().query<SourceRow, [string]>("SELECT * FROM project_sources WHERE id = ?").get(sourceId);
    if (!row) throw new Error("Source not found");
    return row;
  }

  async delete(projectId: string, sourceId: string) {
    const db = getDb();
    const row = db.query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE id = ? AND project_id = ?").get(sourceId, projectId);
    if (!row) throw new Error("Source not found");

    const root = this.projectRoot(projectId);
    const projectPath = join(root, projectId);
    const materialRows = db
      .query<MaterialDeletionRow, [string]>(
        `SELECT learning_materials.id, learning_materials.manifest_path
         FROM learning_materials
         JOIN material_sources ON material_sources.material_id = learning_materials.id
         WHERE material_sources.source_id = ?`
      )
      .all(sourceId);
    const pathsToRemove = new Set<string>();
    for (const material of materialRows) {
      pathsToRemove.add(material.manifest_path ? dirname(material.manifest_path) : join(projectPath, "materials", material.id));
    }
    pathsToRemove.add(row.manifest_path ? dirname(row.manifest_path) : join(projectPath, "sources", sourceId));

    const sourceFolderDir = sourceFolderDirFor(root, projectId, row.imported_file_path);
    const deleteRows = db.transaction(() => {
      for (const material of materialRows) {
        db.query("DELETE FROM learning_materials WHERE id = ? AND project_id = ?").run(material.id, projectId);
      }
      db.query("DELETE FROM project_sources WHERE id = ? AND project_id = ?").run(sourceId, projectId);
    });
    deleteRows();

    if (sourceFolderDir) {
      const remainingRows = db.query<SourceRow, [string]>("SELECT * FROM project_sources WHERE project_id = ?").all(projectId);
      const folderStillUsed = remainingRows.some((item) => isInsidePath(sourceFolderDir, item.imported_file_path));
      if (folderStillUsed) {
        const exactPathStillUsed = remainingRows.some((item) => resolve(item.imported_file_path) === resolve(row.imported_file_path));
        if (!exactPathStillUsed && isInsidePath(sourceFolderDir, row.imported_file_path)) pathsToRemove.add(row.imported_file_path);
      } else {
        pathsToRemove.add(sourceFolderDir);
      }
    }

    for (const path of [...pathsToRemove].filter((path) => isInsidePath(projectPath, path)).sort((a, b) => b.length - a.length)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }

  async loadChunks(sourceId: string) {
    const row = this.getRow(sourceId);
    if (!row.chunks_path) return [];
    const chunks = JSON.parse(await readFile(row.chunks_path, "utf8")) as SourceChunk[];
    return chunks.map((chunk) => ({
      ...chunk,
      headingPath: sanitizeHeadingPath(chunk.headingPath),
      text: rewriteLocalMarkdownImageLinks(row.imported_file_path, chunk.text),
    }));
  }

  async loadFigures(sourceId: string) {
    const row = this.getRow(sourceId);
    if (!row.chunks_path) return [];
    const figuresPath = join(dirname(row.chunks_path), "source_figures.json");
    try {
      const figures = JSON.parse(await readFile(figuresPath, "utf8")) as SourceFigure[];
      if (figures.length) return figures;
    } catch {
      // Older imports predate source_figures.json.
    }
    const recovered = await this.recoverFiguresFromSourcePack(row);
    if (recovered.length) await writeFile(figuresPath, `${JSON.stringify(recovered, null, 2)}\n`, "utf8").catch(() => undefined);
    return recovered;
  }

  private async recoverFiguresFromSourcePack(row: SourceRow) {
    const relativePath = sourcePackRelativePath(row);
    if (!relativePath) return [];
    const sourceFoldersDir = join(this.projectRoot(row.project_id), row.project_id, "source_folders");
    let folders: string[] = [];
    try {
      folders = (await readdir(sourceFoldersDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sourceFoldersDir, entry.name, "original"));
    } catch {
      return [];
    }
    const chunks = row.chunks_path ? (JSON.parse(await readFile(row.chunks_path, "utf8")) as SourceChunk[]) : [];
    for (const importedRoot of folders) {
      const manifest = await readPreppyManifest(importedRoot);
      const chapterIndex = manifest.chapterIndexByPath.get(relativePath);
      if (chapterIndex == null) continue;
      const figures = await readPreppyFigures(importedRoot);
      return toSourceFigures({
        sourceId: row.id,
        importedRoot,
        manifestPath: relativePath,
        chapterIndex,
        figures,
        chunks,
      });
    }
    return [];
  }
}
