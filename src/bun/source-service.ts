import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "./project-db";
import { orderNumberedSeries } from "./source-order";
import { dataPath, sourceDirAt } from "./paths";
import { buildPreppySourcePack } from "./preppy-service";
import { SettingsService } from "./settings-service";
import { attachHtmlToExistingChunks, htmlChunksCoverMarkdown, normalizeHtmlChunks, readSourceHtml } from "./source-html";
import { writeProjectDocumentIndex } from "./project-bundle-sync";
import type { DocumentType, SourceChunk, SourceFigure, SourceManifest, SourceType } from "../shared/artifact-types";
import type { DocumentRemovalImpact, PreparedSourceImport, PreparedSourceImportItem, SourceImportSelection, SourceRemovalImpact, SourceSummary } from "../shared/rpc-types";

type SourceRow = {
  id: string;
  project_id: string;
  document_id: string | null;
  source_ordinal: number | null;
  title: string;
  source_type: SourceType;
  document_type: DocumentType;
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
  source_count: number;
};

type DocumentMaterialDeletionRow = MaterialDeletionRow & {
  document_source_count: number;
};

type DocumentDeletionRow = {
  id: string;
  title: string;
  document_type: DocumentType;
  cover_image_path: string | null;
};

type SourceLearningStatus = SourceSummary["learningStatus"];

type SourceLearningStatusRow = {
  source_id: string;
  status: "active" | "completed" | "archived";
};

type PreppyManifest = {
  source?: {
    document_type?: DocumentType;
  };
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

type ImportInput =
  | { kind: "file" | "folder"; path: string }
  | { kind: "pdf-folder"; path: string; pdfs: string[] };

type PdfFolder = { path: string; files: { id: string; path: string }[] };
type PdfProgress = (current: number, total: number, name: string) => void;

type PreparedImportEntry = {
  id: string;
  projectId: string;
  sourceName: string;
  sourcePath: string;
  documentType: DocumentType;
  // When set, everything imported is attached to this existing document (the "add source" button in
  // the learning workspace) instead of becoming a new book/article in the library.
  targetDocumentId?: string;
  targetDocumentTitle?: string;
  committing: boolean;
  pdfFolders: PdfFolder[];
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
    documentId: row.document_id,
    title: row.title,
    sourceType: row.source_type,
    documentType: row.document_type || "book",
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

async function walkFiles(root: string, visibleOnly = false): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || (visibleOnly && entry.name.startsWith("."))) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path, visibleOnly)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort((a, b) => naturalPathSorter.compare(relative(root, a), relative(root, b)));
}

async function resolveImportInputs(paths: string[]): Promise<ImportInput[]> {
  const inputs: ImportInput[] = [];
  for (const path of new Set(paths.map((path) => resolve(path)))) {
    const info = await stat(path);
    if (info.isFile()) {
      inputs.push({ kind: "file", path });
    } else if (info.isDirectory()) {
      // An exported source pack can itself contain PDF assets.
      const manifest = await readPackManifest(path);
      const pdfs = Array.isArray(manifest?.chapters) ? []
        : (await walkFiles(path, true)).filter((file) => extname(file).toLowerCase() === ".pdf");
      inputs.push(pdfs.length ? { kind: "pdf-folder", path, pdfs } : { kind: "folder", path });
    }
  }
  // A file picked alongside its parent folder must only be imported once.
  const covered = new Set(inputs.flatMap((input) => input.kind === "pdf-folder" ? input.pdfs : []));
  const seen = new Set<string>();
  return inputs.flatMap((input): ImportInput[] => {
    if (input.kind === "file" && covered.has(input.path)) return [];
    if (input.kind !== "pdf-folder") return [input];
    const pdfs = input.pdfs.filter((pdf) => !seen.has(pdf));
    for (const pdf of pdfs) seen.add(pdf);
    return pdfs.length ? [{ ...input, pdfs }] : [];
  });
}

export async function describeImportSelection(paths: string[]): Promise<SourceImportSelection> {
  const inputs = await resolveImportInputs(paths);
  return {
    paths,
    pdfFolderCount: inputs.filter((input) => input.kind === "pdf-folder").length,
    supportsArticles: inputs.length > 0 && inputs.every((input) =>
      input.kind === "pdf-folder" || (input.kind === "file" && extname(input.path).toLowerCase() === ".pdf")),
  };
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

async function readPackManifest(root: string): Promise<PreppyManifest | null> {
  try {
    return JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as PreppyManifest;
  } catch {
    return null;
  }
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
      documentType: manifest.source?.document_type === "article" ? "article" as const : "book" as const,
      chaptersDir: manifest.output?.chapters_dir || "chapters",
      assetsDir: manifest.output?.assets_dir || "assets",
      chapterTitleByPath,
      chapterIndexByPath,
    };
  } catch {
    return {
      documentType: "book" as const,
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

const figureAssetBase64Cache = new Map<string, string | null>();

function figureAssetBase64(assetPath: string) {
  if (!figureAssetBase64Cache.has(assetPath)) {
    let encoded: string | null = null;
    try {
      encoded = readFileSync(assetPath).toString("base64");
    } catch {
      encoded = null;
    }
    figureAssetBase64Cache.set(assetPath, encoded);
    if (figureAssetBase64Cache.size > 64) figureAssetBase64Cache.delete(figureAssetBase64Cache.keys().next().value!);
  }
  return figureAssetBase64Cache.get(assetPath) ?? null;
}

// HTML chunks carry figures as inlined data URIs (readSourceHtml), so their
// text has no asset path; match the inlined bytes instead.
function chunkHtmlContainsFigureAsset(chunk: SourceChunk, figure: Pick<SourceFigure, "assetPath">) {
  if (!chunk.html || !/<img\b/.test(chunk.html) || !figure.assetPath) return false;
  const encoded = figureAssetBase64(figure.assetPath);
  return Boolean(encoded && encoded.length >= 64 && chunk.html.includes(encoded));
}

function chunkContainsFigureAsset(chunk: SourceChunk, figure: Pick<SourceFigure, "assetPath" | "assetUrl">) {
  if (chunkHtmlContainsFigureAsset(chunk, figure)) return true;
  const rawText = chunk.text.replaceAll("\\", "/");
  const decodedText = decodePathPart(rawText);
  const references = [figure.assetUrl, pathToFileURL(figure.assetPath).href, figure.assetPath]
    .filter(Boolean)
    .flatMap((value) => {
      const normalized = value.replaceAll("\\", "/");
      return [normalized, decodePathPart(normalized)];
    });
  return references.some((reference) => rawText.includes(reference) || decodedText.includes(reference));
}

function sourceChunkIdsForFigure(figure: SourceFigure, chunks: SourceChunk[]) {
  if (!chunks.length) return [];
  const ids: string[] = [];
  const canonicalImageChunk = chunks.find((chunk) => chunkContainsFigureAsset(chunk, figure));
  if (canonicalImageChunk) ids.push(canonicalImageChunk.id);

  const label = normalizedNeedle(figureLabel(figure.caption || figure.title));
  if (label) {
    const mention = chunks.find((chunk) => chunk.kind !== "caption" && normalizedNeedle(chunk.text).includes(label));
    if (mention) ids.push(mention.id);
  }
  const caption = normalizedNeedle(figure.caption);
  if (caption.length >= 12) {
    const match = chunks.find((chunk) => normalizedNeedle(chunk.text).includes(caption));
    if (match) ids.push(match.id);
  }
  if (!canonicalImageChunk) {
    const validChunkIds = new Set(chunks.map((chunk) => chunk.id));
    for (const chunkId of Array.isArray(figure.sourceChunkIds) ? figure.sourceChunkIds : []) {
      if (validChunkIds.has(chunkId)) ids.push(chunkId);
    }
  }
  return [...new Set(ids.length ? ids : [chunks[0]!.id])];
}

// The first sourceChunkId is the figure's canonical reading-order position.
// Later ids are contextual text mentions that let tutor messages show the same
// figure while discussing it without moving the figure in the source reader.
export function normalizeSourceFigureChunkIds(figures: SourceFigure[], chunks: SourceChunk[]) {
  return figures.map((figure) => ({
    ...figure,
    sourceChunkIds: sourceChunkIdsForFigure(figure, chunks),
  }));
}

function toSourceFigures(input: {
  sourceId: string;
  importedRoot: string;
  manifestPath: string;
  chapterIndex: number | undefined;
  figures: PreppyFigure[];
  chunks: SourceChunk[];
}) {
  const figures = input.figures
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
        sourceChunkIds: [],
      };
    });
  return normalizeSourceFigureChunkIds(figures, input.chunks);
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
    documentType: entry.documentType,
    targetDocumentId: entry.targetDocumentId,
    targetDocumentTitle: entry.targetDocumentTitle,
    itemCount: entry.items.length,
    pdfFolderFileCount: entry.pdfFolders.reduce((sum, folder) => sum + folder.files.length, 0),
    items: entry.items,
  };
}

export class SourceService {
  private readonly settings = new SettingsService();

  constructor(private readonly convertPdf = buildPreppySourcePack) {}

  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  async importPaths(projectId: string, paths: string[], documentType: DocumentType = "book", targetDocumentId?: string) {
    const prepared = await this.prepareImport(projectId, paths, documentType, targetDocumentId);
    try {
      return await this.commitPreparedImport(projectId, prepared.id, prepared.items.map((item) => item.id));
    } finally {
      await this.cancelPreparedImport(projectId, prepared.id);
    }
  }

  async prepareImport(projectId: string, paths: string[], documentType: DocumentType = "book", targetDocumentId?: string) {
    const id = crypto.randomUUID();
    let targetDocumentTitle: string | undefined;
    if (targetDocumentId) {
      const target = getDb()
        .query<{ document_type: DocumentType; title: string }, [string, string]>(
          "SELECT document_type, title FROM project_documents WHERE id = ? AND project_id = ?"
        )
        .get(targetDocumentId, projectId);
      if (!target) throw new Error("소스를 추가할 문서를 찾을 수 없습니다.");
      documentType = target.document_type === "article" ? "article" : "book";
      targetDocumentTitle = target.title;
    }
    const settings = await this.settings.get();
    const inputs = await resolveImportInputs(paths);
    const singleInput = inputs.length === 1 ? inputs[0] : undefined;
    const entry: PreparedImportEntry = {
      id,
      projectId,
      sourceName: singleInput ? (singleInput.kind === "file" ? titleForPath(singleInput.path) : basename(singleInput.path)) : `선택한 항목 ${inputs.length}개`,
      sourcePath: paths.join(", "),
      documentType,
      targetDocumentId,
      targetDocumentTitle,
      committing: false,
      pdfFolders: [],
      folders: [],
      files: [],
      items: [],
      itemRefs: new Map(),
    };

    try {
      for (const input of inputs) {
        const { path } = input;
        if (input.kind === "pdf-folder") {
          const files = input.pdfs.map((pdf) => ({ id: crypto.randomUUID(), path: pdf }));
          entry.pdfFolders.push({ path, files });
          for (const file of files) {
            entry.items.push({
              id: file.id, title: titleForPath(file.path), fileName: basename(file.path),
              relativePath: relativePortable(path, file.path), kind: "pdf", charCount: null,
              selected: true, preview: "",
            });
          }
          continue;
        }
        if (documentType === "article" && input.kind === "file" && extname(path).toLowerCase() !== ".pdf") {
          throw new Error("논문으로 가져올 수 있는 파일은 PDF입니다.");
        }
        if (input.kind === "folder") {
          await this.addPreparedFolder(entry, path, path, settings.sourceImportMinChars);
        } else if (isPreppyInputFile(path)) {
          const sourcePack = await buildPreppySourcePack(path, documentType);
          await this.addPreparedFolder(entry, sourcePack.outputPath, path, settings.sourceImportMinChars, sourcePack.cleanup);
        } else if (isImportableFile(path)) {
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

  async commitPreparedImport(projectId: string, importId: string, selectedItemIds: string[], onPdfProgress?: PdfProgress) {
    const entry = preparedImports.get(importId);
    if (!entry || entry.projectId !== projectId) throw new Error("Prepared import not found");
    if (entry.committing) throw new Error("이미 가져오는 중입니다.");
    entry.committing = true;
    const selected = new Set(selectedItemIds);
    const imported: SourceSummary[] = [];
    try {
      for (let index = 0; index < entry.files.length; index += 1) {
        const itemIds = [...entry.itemRefs.entries()]
          .filter(([, ref]) => ref.kind === "file" && ref.fileIndex === index)
          .map(([itemId]) => itemId);
        if (itemIds.some((itemId) => selected.has(itemId))) imported.push(await this.importFile(projectId, entry.files[index]!.path, entry.documentType, entry.targetDocumentId));
      }

      for (let index = 0; index < entry.folders.length; index += 1) {
        const selectedRelativePaths = [...entry.itemRefs.entries()]
          .filter(([itemId, ref]) => selected.has(itemId) && ref.kind === "folder" && ref.folderIndex === index)
          .map(([, ref]) => (ref.kind === "folder" ? ref.relativePath : ""));
        if (!selectedRelativePaths.length) continue;
        const folder = entry.folders[index]!;
        imported.push(...(await this.importFolder(projectId, folder.path, folder.originalSourcePath, selectedRelativePaths, entry.documentType, entry.targetDocumentId)));
      }
      const folders = entry.pdfFolders.map((folder) => ({
        path: folder.path,
        files: folder.files.filter((file) => selected.has(file.id)),
      })).filter((folder) => folder.files.length);
      imported.push(...await this.importPdfFolders(projectId, folders, entry.documentType, onPdfProgress, entry.targetDocumentId));
      if (entry.targetDocumentId && imported.length) {
        this.placeAddedSources(entry.targetDocumentId);
        await writeProjectDocumentIndex(projectId, this.projectRoot(projectId));
      }
      await this.cleanupPrepared(entry);
      preparedImports.delete(importId);
      return imported;
    } catch (error) {
      // Completed legacy items cannot be re-submitted on a retry.
      if (imported.length) {
        preparedImports.delete(importId);
        await this.cleanupPrepared(entry);
      }
      throw error;
    } finally {
      entry.committing = false;
    }
  }

  async cancelPreparedImport(projectId: string, importId: string) {
    const entry = preparedImports.get(importId);
    if (!entry || entry.projectId !== projectId) return true;
    if (entry.committing) throw new Error("이미 가져오는 중입니다.");
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
      const manifest = await readPackManifest(root);
      return (manifest?.chapters || [])
        .filter((chapter) => chapter.path)
        .map((chapter) => ({
          path: chapter.path!.replaceAll("\\", "/"),
          index: chapter.index,
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

  private createDocument(projectId: string, documentType: DocumentType, title: string, originalPath: string, originalFileName: string, contentHash: string) {
    const id = crypto.randomUUID();
    const now = Date.now();
    getDb().query(`
      INSERT INTO project_documents
      (id, project_id, document_type, title, original_file_name, original_file_path, content_hash, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, documentType, title, originalFileName, originalPath, contentHash, now, now);
    return id;
  }

  // Next free position at the end of an existing document, so added sources sort after the ones
  // already there.
  private nextSourceOrdinal(documentId: string) {
    const row = getDb()
      .query<{ next: number }, [string]>("SELECT COALESCE(MAX(source_ordinal), -1) + 1 AS next FROM project_sources WHERE document_id = ?")
      .get(documentId);
    return row?.next ?? 0;
  }

  // Sources added to an existing book are first appended. When the whole book is one numbered
  // series ("Chapter 02" … "Chapter 35"), they move to their place by number, so a re-imported
  // "Chapter 13" lands between 12 and 14. Any other book keeps its order and gets them at the end.
  private placeAddedSources(documentId: string) {
    orderNumberedSeries(getDb(), documentId);
  }

  private touchDocument(documentId: string) {
    getDb().query("UPDATE project_documents SET updated_at = ? WHERE id = ?").run(Date.now(), documentId);
  }

  private async importFile(projectId: string, path: string, documentType: DocumentType = "book", targetDocumentId?: string) {
    const { digest, bytes } = await hashFile(path);
    const existing = getDb()
      .query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND content_hash = ?")
      .get(projectId, digest);
    if (existing) return toSource(existing);

    const id = crypto.randomUUID();
    const type = sourceTypeForPath(path);
    const title = titleForPath(path);
    const documentId = targetDocumentId ?? this.createDocument(projectId, documentType, title, path, basename(path), digest);
    const sourceOrdinal = targetDocumentId ? this.nextSourceOrdinal(targetDocumentId) : 0;
    const dir = sourceDirAt(this.projectRoot(projectId), projectId, id);
    try {
      await mkdir(dir, { recursive: true });
      const originalFileName = basename(path);
      const importedPath = join(dir, `original${extname(path).toLowerCase() || ".txt"}`);
      await copyFile(path, importedPath);
      const chunks = normalizeMarkdownChunks(id, rewriteLocalMarkdownImageLinks(importedPath, bytes.toString("utf8")));
      const status = chunks.length ? "good" : "poor";
      return await this.persistSource({
        id, projectId, title, type, documentType, documentId, sourceOrdinal, originalPath: path, originalFileName,
        importedPath, digest, chunks, extractionMethod: "typescript-markdown-normalizer", status, warnings: [],
      });
    } catch (error) {
      if (!targetDocumentId) getDb().query("DELETE FROM project_documents WHERE id = ?").run(documentId);
      await rm(dir, { recursive: true, force: true });
      await writeProjectDocumentIndex(projectId, this.projectRoot(projectId)).catch(() => undefined);
      throw error;
    }
  }

  private async importPdfFolders(projectId: string, folders: PdfFolder[], documentType: DocumentType, onProgress?: PdfProgress, targetDocumentId?: string) {
    const total = folders.reduce((sum, folder) => sum + folder.files.length, 0);
    if (!total) return [];
    const root = this.projectRoot(projectId);
    const sources: SourceSummary[] = [];
    const newDocuments: string[] = [];
    const newDirectories: string[] = [];
    let current = 0;
    try {
      for (const folder of folders) {
        let bookId: string | undefined;
        const bookHash = createHash("sha256");
        for (const [index, file] of folder.files.entries()) {
          onProgress?.(++current, total, basename(file.path));
          try {
            const pack = await this.convertPdf(file.path, documentType, documentType === "book");
            try {
              const chapters = await this.preppyChapterRows(pack.outputPath);
              if (chapters.length !== 1) throw new Error("PDF에서 하나의 학습 소스를 만들 수 없습니다.");
              const chapter = chapters[0]!;
              const packDir = join(root, projectId, "source_folders", crypto.randomUUID());
              newDirectories.push(packDir);
              const importedRoot = join(packDir, "original");
              await cp(pack.outputPath, importedRoot, { recursive: true });
              const hasher = createHash("sha256");
              for await (const bytes of createReadStream(file.path)) hasher.update(bytes);
              const digest = hasher.digest("hex");
              let documentId: string;
              let sourceOrdinal = documentType === "book" ? index : 0;
              if (targetDocumentId) {
                documentId = targetDocumentId;
                sourceOrdinal = this.nextSourceOrdinal(targetDocumentId);
              } else if (documentType === "book") {
                bookHash.update(relativePortable(folder.path, file.path)).update("\0").update(digest);
                if (!bookId) {
                  bookId = this.createDocument(projectId, "book", basename(folder.path), folder.path, basename(folder.path), "");
                  newDocuments.push(bookId);
                }
                documentId = bookId;
              } else {
                documentId = this.createDocument(projectId, "article", titleForPath(file.path), file.path, basename(file.path), digest);
                newDocuments.push(documentId);
              }
              const sourceId = crypto.randomUUID();
              newDirectories.push(sourceDirAt(root, projectId, sourceId));
              const { source } = await this.importTextFileFromCopiedFolder(projectId, file.path,
                join(importedRoot, chapter.path), titleForPath(file.path), {
                  importedRoot, manifestPath: chapter.path, chapterIndex: chapter.index, figures: await readPreppyFigures(importedRoot),
                  documentType, documentId, sourceOrdinal,
                }, { id: sourceId, originalFileName: basename(file.path) });
              sources.push(source);
            } finally {
              await pack.cleanup();
            }
          } catch (error) {
            throw new Error(`${relativePortable(folder.path, file.path)} 가져오기 실패 · ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (bookId) getDb().query("UPDATE project_documents SET content_hash = ? WHERE id = ?").run(bookHash.digest("hex"), bookId);
      }
      if (targetDocumentId && sources.length) this.touchDocument(targetDocumentId);
      await writeProjectDocumentIndex(projectId, root);
      return sources;
    } catch (error) {
      const db = getDb();
      db.transaction(() => {
        for (const id of newDocuments) db.query("DELETE FROM project_documents WHERE id = ?").run(id);
      })();
      await Promise.all(newDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
      await writeProjectDocumentIndex(projectId, root);
      throw error;
    }
  }

  private async importFolder(projectId: string, path: string, originalSourcePath = path, selectedRelativePaths?: string[], requestedDocumentType?: DocumentType, targetDocumentId?: string) {
    await this.removeLegacyFolderAggregate(projectId, originalSourcePath);
    const folderImportId = crypto.randomUUID();
    const folderDir = join(this.projectRoot(projectId), projectId, "source_folders", folderImportId);
    const importedRoot = join(folderDir, "original");
    await mkdir(folderDir, { recursive: true });
    await cp(path, importedRoot, { recursive: true });

    const folderDigest = await hashDirectory(path);
    const allCopiedFiles = await walkFiles(importedRoot);
    const preppyManifest = await readPreppyManifest(importedRoot);
    // An existing target document decides the type: the pack's own guess must not turn a chapter
    // added to a book into an article (or the reverse).
    const documentType = targetDocumentId
      ? (requestedDocumentType || "book")
      : requestedDocumentType === "article" ? "article" : preppyManifest.documentType;
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
          documentType: preppyManifest.documentType,
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
    const documentId = targetDocumentId ?? this.createDocument(
      projectId,
      documentType,
      titleForPath(originalSourcePath),
      originalSourcePath,
      basename(originalSourcePath),
      folderDigest,
    );
    const ordinalBase = targetDocumentId ? this.nextSourceOrdinal(targetDocumentId) : 0;
    const createdSourceIds: string[] = [];
    try {
      if (documentType === "article" && textFiles.length) {
        const result = await this.importArticleFromCopiedFolder({
          projectId,
          documentId,
          sourceOrdinal: ordinalBase,
          title: titleForPath(originalSourcePath),
          originalSourcePath,
          importedRoot,
          textFiles,
          folderDigest,
          preppyFigures,
          chapterIndexByPath: preppyManifest.chapterIndexByPath,
        });
        imported.push(result.source);
        if (result.created) {
          createdCount += 1;
          createdSourceIds.push(result.source.id);
        }
      } else if (documentType === "book") {
        for (let ordinal = 0; ordinal < textFiles.length; ordinal += 1) {
          const copiedFile = textFiles[ordinal]!;
          const manifestPath = relativePortable(importedRoot, copiedFile);
          const originalPath = await sourceChildPath(originalSourcePath, manifestPath);
          const title = preppyManifest.chapterTitleByPath.get(manifestPath) || titleForPath(copiedFile);
          const result = await this.importTextFileFromCopiedFolder(projectId, originalPath, copiedFile, title, {
            importedRoot, manifestPath, chapterIndex: preppyManifest.chapterIndexByPath.get(manifestPath),
            figures: preppyFigures, documentType, documentId, sourceOrdinal: ordinalBase + ordinal,
          });
          imported.push(result.source);
          if (result.created) {
            createdCount += 1;
            createdSourceIds.push(result.source.id);
          }
        }
      }
    } catch (error) {
      if (targetDocumentId) {
        const db = getDb();
        db.transaction(() => {
          for (const sourceId of createdSourceIds) db.query("DELETE FROM project_sources WHERE id = ?").run(sourceId);
        })();
      } else {
        getDb().query("DELETE FROM project_documents WHERE id = ?").run(documentId);
      }
      await Promise.all(createdSourceIds.map((sourceId) => rm(sourceDirAt(this.projectRoot(projectId), projectId, sourceId), { recursive: true, force: true })));
      await rm(folderDir, { recursive: true, force: true });
      await writeProjectDocumentIndex(projectId, this.projectRoot(projectId)).catch(() => undefined);
      throw error;
    }
    if (createdCount === 0) {
      if (!targetDocumentId) getDb().query("DELETE FROM project_documents WHERE id = ?").run(documentId);
      await rm(folderDir, { recursive: true, force: true });
    } else if (targetDocumentId) {
      this.touchDocument(targetDocumentId);
    }
    return imported;
  }

  private async importArticleFromCopiedFolder(input: {
    projectId: string;
    documentId: string;
    sourceOrdinal: number;
    title: string;
    originalSourcePath: string;
    importedRoot: string;
    textFiles: string[];
    folderDigest: string;
    preppyFigures: PreppyFigure[];
    chapterIndexByPath: Map<string, number>;
  }) {
    const id = crypto.randomUUID();
    const parts = await Promise.all(input.textFiles.map(async (file) =>
      rewriteLocalMarkdownImageLinks(file, await readFile(file, "utf8"))
    ));
    const mergedText = parts.filter((part) => part.trim()).join("\n\n");
    const importedPath = join(input.importedRoot, ".learnie-article-source.md");
    await writeFile(importedPath, `${mergedText.trim()}\n`, "utf8");
    const htmlParts = await Promise.all(input.textFiles.map(readSourceHtml));
    const htmlChunks = htmlParts.every(Boolean) ? normalizeHtmlChunks(id, htmlParts.join("\n")) : [];
    const chunks = htmlChunks.length && htmlChunksCoverMarkdown(htmlChunks, mergedText) ? htmlChunks : normalizeMarkdownChunks(id, mergedText);
    const figures = input.textFiles.flatMap((file) => {
      const manifestPath = relativePortable(input.importedRoot, file);
      return toSourceFigures({
        sourceId: id,
        importedRoot: input.importedRoot,
        manifestPath,
        chapterIndex: input.chapterIndexByPath.get(manifestPath),
        figures: input.preppyFigures,
        chunks,
      });
    });
    const source = await this.persistSource({
      id,
      projectId: input.projectId,
      title: input.title,
      type: "markdown",
      documentType: "article",
      documentId: input.documentId,
      sourceOrdinal: input.sourceOrdinal,
      originalPath: input.originalSourcePath,
      originalFileName: basename(input.originalSourcePath),
      importedPath,
      digest: input.folderDigest,
      chunks,
      figures,
      extractionMethod: "preppy-article-normalizer",
      status: chunks.length ? "good" : "poor",
      warnings: [],
    });
    return { source, created: true };
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
    preppy?: {
      importedRoot: string;
      manifestPath: string;
      chapterIndex: number | undefined;
      figures: PreppyFigure[];
      documentType: DocumentType;
      documentId: string;
      sourceOrdinal: number;
    },
    original?: { id: string; originalFileName: string },
  ) {
    const { digest, bytes } = await hashFile(importedPath);
    const id = original?.id ?? crypto.randomUUID();
    const type = sourceTypeForPath(importedPath);
    const html = await readSourceHtml(importedPath);
    const markdownText = bytes.toString("utf8");
    const htmlChunks = html ? normalizeHtmlChunks(id, html) : [];
    const chunks = htmlChunks.length && htmlChunksCoverMarkdown(htmlChunks, markdownText)
      ? htmlChunks
      : normalizeMarkdownChunks(id, rewriteLocalMarkdownImageLinks(importedPath, markdownText));
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
      documentType: preppy?.documentType || "book",
      documentId: preppy?.documentId,
      sourceOrdinal: preppy?.sourceOrdinal,
      originalPath,
      originalFileName: original?.originalFileName ?? basename(importedPath),
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
    documentType?: DocumentType;
    documentId?: string;
    sourceOrdinal?: number;
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
      documentId: input.documentId,
      sourceOrdinal: input.sourceOrdinal,
      title: input.title,
      updatedAt: new Date().toISOString(),
      sourceType: input.type,
      documentType: input.documentType || "book",
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
          document_type, document_id, source_ordinal, source_kind, content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.projectId,
        input.title,
        input.type,
        input.originalFileName,
        input.originalPath,
        input.importedPath,
        input.documentType || "book",
        input.documentId || null,
        input.sourceOrdinal ?? null,
        input.documentType === "article" ? "article" : "chapter",
        input.digest,
        manifestPath,
        chunksPath,
        input.status,
        now,
        now
      );
    await writeProjectDocumentIndex(input.projectId, this.projectRoot(input.projectId));
    return toSource(this.getRow(input.id));
  }

  list(projectId: string) {
    const learningStatusBySourceId = this.learningStatuses(projectId);
    return getDb()
      .query<SourceRow, [string]>("SELECT * FROM project_sources WHERE project_id = ?")
      .all(projectId)
      // Within a book the stored source order wins; file names only break ties. Sorting by file name
      // alone put a chapter added later (its pack file is "001-….md") at the top of the book.
      .sort((a, b) =>
        (a.document_id || "").localeCompare(b.document_id || "")
        || (a.source_ordinal ?? Number.MAX_SAFE_INTEGER) - (b.source_ordinal ?? Number.MAX_SAFE_INTEGER)
        || naturalPathSorter.compare(a.original_file_name || a.title, b.original_file_name || b.title))
      .map((row) => toSource(row, learningStatusBySourceId.get(row.id) || "not_started"));
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
        documentType: row.document_type || "book",
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

  previewRemoval(projectId: string, documentId: string, sourceId: string): SourceRemovalImpact {
    const db = getDb();
    const row = db.query<SourceRow, [string, string, string]>(
      "SELECT * FROM project_sources WHERE id = ? AND project_id = ? AND document_id = ?"
    ).get(sourceId, projectId, documentId);
    if (!row) throw new Error("Source not found");
    const materialRows = db
      .query<MaterialDeletionRow, [string]>(
        `SELECT learning_materials.id, learning_materials.manifest_path, COUNT(all_sources.source_id) AS source_count
         FROM learning_materials
         JOIN material_sources ON material_sources.material_id = learning_materials.id
         JOIN material_sources all_sources ON all_sources.material_id = learning_materials.id
         WHERE material_sources.source_id = ?
         GROUP BY learning_materials.id, learning_materials.manifest_path`
      )
      .all(sourceId);
    const exclusive = materialRows.filter((material) => material.source_count === 1);
    const shared = materialRows.filter((material) => material.source_count > 1);
    let sessions = 0;
    let messages = 0;
    let preparedMessages = 0;
    let annotations = 0;
    for (const material of exclusive) {
      sessions += db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM learning_sessions WHERE material_id = ?").get(material.id)?.count || 0;
      messages += db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM learning_messages
        WHERE session_id IN (SELECT id FROM learning_sessions WHERE material_id = ?)
      `).get(material.id)?.count || 0;
      preparedMessages += db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM prepared_learning_messages
        WHERE message_set_id IN (SELECT id FROM learning_message_sets WHERE material_id = ?)
      `).get(material.id)?.count || 0;
      annotations += db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM material_annotations WHERE material_id = ?").get(material.id)?.count || 0;
    }
    const tokenPayload = {
      projectId,
      documentId,
      sourceId,
      materialIds: materialRows.map((material) => `${material.id}:${material.source_count}`).sort(),
      sessions,
      messages,
      preparedMessages,
      annotations,
      sourceUpdatedAt: row.updated_at,
    };
    return {
      projectId,
      documentId,
      sourceId,
      sourceTitle: row.title,
      exclusiveMaterials: exclusive.length,
      sharedMaterials: shared.length,
      sessions,
      messages,
      preparedMessages,
      annotations,
      impactToken: createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex").slice(0, 24),
    };
  }

  async removeSource(projectId: string, documentId: string, sourceId: string, impactToken: string) {
    const impact = this.previewRemoval(projectId, documentId, sourceId);
    if (impact.impactToken !== impactToken) throw new Error("Source removal impact changed. Review the updated counts and try again.");
    if (impact.sharedMaterials > 0) throw new Error("This source belongs to a learning material that also uses another source. Remove that material first or use document transfer.");

    const db = getDb();
    const row = db.query<SourceRow, [string, string, string]>(
      "SELECT * FROM project_sources WHERE id = ? AND project_id = ? AND document_id = ?"
    ).get(sourceId, projectId, documentId);
    if (!row) throw new Error("Source not found");
    const materialRows = db.query<MaterialDeletionRow, [string]>(`
      SELECT learning_materials.id, learning_materials.manifest_path, COUNT(all_sources.source_id) AS source_count
      FROM learning_materials
      JOIN material_sources ON material_sources.material_id = learning_materials.id
      JOIN material_sources all_sources ON all_sources.material_id = learning_materials.id
      WHERE material_sources.source_id = ?
      GROUP BY learning_materials.id, learning_materials.manifest_path
    `).all(sourceId);
    const root = this.projectRoot(projectId);
    const projectPath = join(root, projectId);
    const pathsToMove = new Set<string>();
    for (const material of materialRows) pathsToMove.add(material.manifest_path ? dirname(material.manifest_path) : join(projectPath, "materials", material.id));
    pathsToMove.add(row.manifest_path ? dirname(row.manifest_path) : join(projectPath, "sources", sourceId));

    const sourceFolderDir = sourceFolderDirFor(root, projectId, row.imported_file_path);
    if (sourceFolderDir) {
      const remainingRows = db.query<SourceRow, [string, string]>("SELECT * FROM project_sources WHERE project_id = ? AND id != ?").all(projectId, sourceId);
      const folderStillUsed = remainingRows.some((item) => isInsidePath(sourceFolderDir, item.imported_file_path));
      if (folderStillUsed) {
        const exactPathStillUsed = remainingRows.some((item) => resolve(item.imported_file_path) === resolve(row.imported_file_path));
        if (!exactPathStillUsed && isInsidePath(sourceFolderDir, row.imported_file_path)) pathsToMove.add(row.imported_file_path);
      } else {
        pathsToMove.add(sourceFolderDir);
      }
    }

    const safePaths = [...pathsToMove]
      .filter((path) => path !== projectPath && isInsidePath(projectPath, path))
      .sort((a, b) => a.length - b.length)
      .filter((path, index, paths) => !paths.slice(0, index).some((parent) => isInsidePath(parent, path)));
    const quarantineRoot = join(projectPath, ".quarantine", `source-${sourceId}-${Date.now()}`);
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const path of safePaths) {
        if (!(await stat(path).then(() => true).catch(() => false))) continue;
        const target = join(quarantineRoot, relative(projectPath, path));
        await mkdir(dirname(target), { recursive: true });
        await rename(path, target);
        moved.push({ from: path, to: target });
      }
      db.transaction(() => {
        for (const material of materialRows) db.query("DELETE FROM learning_materials WHERE id = ? AND project_id = ?").run(material.id, projectId);
        db.query("DELETE FROM project_sources WHERE id = ? AND project_id = ? AND document_id = ?").run(sourceId, projectId, documentId);
        const remaining = db.query<{ id: string }, [string]>(`
          SELECT id FROM project_sources WHERE document_id = ?
          ORDER BY COALESCE(source_ordinal, 2147483647), created_at ASC, id ASC
        `).all(documentId);
        remaining.forEach((source, ordinal) => db.query("UPDATE project_sources SET source_ordinal = ? WHERE id = ?").run(ordinal, source.id));
      })();
    } catch (error) {
      for (const item of moved.reverse()) {
        await mkdir(dirname(item.from), { recursive: true }).catch(() => undefined);
        await rename(item.to, item.from).catch(() => undefined);
      }
      throw error;
    }
    await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    await writeProjectDocumentIndex(projectId, root);
    return { removed: true, documentId };
  }

  previewDocumentRemoval(projectId: string, documentId: string): DocumentRemovalImpact {
    const db = getDb();
    const document = db.query<DocumentDeletionRow, [string, string]>(
      "SELECT id, title, document_type, cover_image_path FROM project_documents WHERE id = ? AND project_id = ?"
    ).get(documentId, projectId);
    if (!document) throw new Error("Document not found");
    const sources = db.query<Pick<SourceRow, "id" | "updated_at">, [string, string]>(
      "SELECT id, updated_at FROM project_sources WHERE project_id = ? AND document_id = ? ORDER BY id"
    ).all(projectId, documentId);
    const materials = db.query<DocumentMaterialDeletionRow, [string, string]>(`
      SELECT learning_materials.id, learning_materials.manifest_path,
        COUNT(DISTINCT all_sources.source_id) AS source_count,
        COUNT(DISTINCT CASE WHEN all_source_rows.document_id = ? THEN all_sources.source_id END) AS document_source_count
      FROM learning_materials
      JOIN material_sources linked_sources ON linked_sources.material_id = learning_materials.id
      JOIN project_sources linked_source_rows ON linked_source_rows.id = linked_sources.source_id
      JOIN material_sources all_sources ON all_sources.material_id = learning_materials.id
      JOIN project_sources all_source_rows ON all_source_rows.id = all_sources.source_id
      WHERE linked_source_rows.document_id = ?
      GROUP BY learning_materials.id, learning_materials.manifest_path
    `).all(documentId, documentId);
    const exclusive = materials.filter((material) => material.source_count === material.document_source_count);
    const shared = materials.filter((material) => material.source_count > material.document_source_count);
    let sessions = 0;
    let messages = 0;
    let preparedMessages = 0;
    let annotations = 0;
    for (const material of exclusive) {
      sessions += db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM learning_sessions WHERE material_id = ?").get(material.id)?.count || 0;
      messages += db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM learning_messages
        WHERE session_id IN (SELECT id FROM learning_sessions WHERE material_id = ?)
      `).get(material.id)?.count || 0;
      preparedMessages += db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM prepared_learning_messages
        WHERE message_set_id IN (SELECT id FROM learning_message_sets WHERE material_id = ?)
      `).get(material.id)?.count || 0;
      annotations += db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM material_annotations WHERE material_id = ?").get(material.id)?.count || 0;
    }
    const tokenPayload = {
      projectId,
      documentId,
      documentType: document.document_type,
      sourceVersions: sources.map((source) => `${source.id}:${source.updated_at}`),
      materialIds: materials.map((material) => `${material.id}:${material.source_count}:${material.document_source_count}`).sort(),
      sessions,
      messages,
      preparedMessages,
      annotations,
    };
    return {
      projectId,
      documentId,
      documentTitle: document.title,
      documentType: document.document_type,
      sources: sources.length,
      exclusiveMaterials: exclusive.length,
      sharedMaterials: shared.length,
      sessions,
      messages,
      preparedMessages,
      annotations,
      impactToken: createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex").slice(0, 24),
    };
  }

  async removeDocument(projectId: string, documentId: string, impactToken: string) {
    const impact = this.previewDocumentRemoval(projectId, documentId);
    if (impact.impactToken !== impactToken) throw new Error("Document removal impact changed. Review the updated counts and try again.");
    if (impact.sharedMaterials > 0) throw new Error("This document belongs to a learning material that also uses a source from another book or article. Remove that material first.");

    const db = getDb();
    const document = db.query<DocumentDeletionRow, [string, string]>(
      "SELECT id, title, document_type, cover_image_path FROM project_documents WHERE id = ? AND project_id = ?"
    ).get(documentId, projectId);
    if (!document) throw new Error("Document not found");
    const sources = db.query<SourceRow, [string, string]>(
      "SELECT * FROM project_sources WHERE project_id = ? AND document_id = ? ORDER BY id"
    ).all(projectId, documentId);
    const materials = db.query<DocumentMaterialDeletionRow, [string, string]>(`
      SELECT learning_materials.id, learning_materials.manifest_path,
        COUNT(DISTINCT all_sources.source_id) AS source_count,
        COUNT(DISTINCT CASE WHEN all_source_rows.document_id = ? THEN all_sources.source_id END) AS document_source_count
      FROM learning_materials
      JOIN material_sources linked_sources ON linked_sources.material_id = learning_materials.id
      JOIN project_sources linked_source_rows ON linked_source_rows.id = linked_sources.source_id
      JOIN material_sources all_sources ON all_sources.material_id = learning_materials.id
      JOIN project_sources all_source_rows ON all_source_rows.id = all_sources.source_id
      WHERE linked_source_rows.document_id = ?
      GROUP BY learning_materials.id, learning_materials.manifest_path
    `).all(documentId, documentId);

    const root = this.projectRoot(projectId);
    const projectPath = join(root, projectId);
    const pathsToMove = new Set<string>();
    for (const material of materials) pathsToMove.add(material.manifest_path ? dirname(material.manifest_path) : join(projectPath, "materials", material.id));
    for (const source of sources) pathsToMove.add(source.manifest_path ? dirname(source.manifest_path) : join(projectPath, "sources", source.id));
    pathsToMove.add(join(projectPath, "documents", documentId));

    const remainingSources = db.query<SourceRow, [string, string]>(
      "SELECT * FROM project_sources WHERE project_id = ? AND COALESCE(document_id, '') != ?"
    ).all(projectId, documentId);
    const sourceFolders = new Set(sources.map((source) => sourceFolderDirFor(root, projectId, source.imported_file_path)).filter((path): path is string => Boolean(path)));
    for (const sourceFolder of sourceFolders) {
      if (remainingSources.some((source) => isInsidePath(sourceFolder, source.imported_file_path))) continue;
      pathsToMove.add(sourceFolder);
    }

    const safePaths = [...pathsToMove]
      .filter((path) => path !== projectPath && isInsidePath(projectPath, path))
      .sort((a, b) => a.length - b.length)
      .filter((path, index, paths) => !paths.slice(0, index).some((parent) => isInsidePath(parent, path)));
    const quarantineRoot = join(projectPath, ".quarantine", `document-${documentId}-${Date.now()}`);
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const path of safePaths) {
        if (!(await stat(path).then(() => true).catch(() => false))) continue;
        const target = join(quarantineRoot, relative(projectPath, path));
        await mkdir(dirname(target), { recursive: true });
        await rename(path, target);
        moved.push({ from: path, to: target });
      }
      db.transaction(() => {
        for (const material of materials) db.query("DELETE FROM learning_materials WHERE id = ? AND project_id = ?").run(material.id, projectId);
        db.query("DELETE FROM project_documents WHERE id = ? AND project_id = ?").run(documentId, projectId);
      })();
    } catch (error) {
      for (const item of moved.reverse()) {
        await mkdir(dirname(item.from), { recursive: true }).catch(() => undefined);
        await rename(item.to, item.from).catch(() => undefined);
      }
      throw error;
    }
    await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    await writeProjectDocumentIndex(projectId, root);
    return { removed: true, documentId };
  }

  async delete(projectId: string, sourceId: string) {
    const row = this.getRow(sourceId);
    if (!row.document_id) throw new Error("Source has no document context");
    const impact = this.previewRemoval(projectId, row.document_id, sourceId);
    await this.removeSource(projectId, row.document_id, sourceId, impact.impactToken);
    return true;
  }

  async enrichReaderHtml(sourceId: string, chunks: SourceChunk[]): Promise<SourceChunk[]> {
    const row = this.getRow(sourceId);
    if (!row.chunks_path) return chunks;
    const cache = await readFile(join(dirname(row.chunks_path), "reader_html.json"), "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, { text: string; html: string }>).catch(() => null);
    if (!cache) return chunks;
    return chunks.map((chunk) => {
      const saved = cache[chunk.id];
      return !chunk.html && saved?.text === chunk.text && typeof saved.html === "string" ? { ...chunk, html: saved.html } : chunk;
    });
  }

  async refreshReaderHtml(sourceId: string, chunks: SourceChunk[]) {
    const row = this.getRow(sourceId);
    const ownChunks = chunks.filter((chunk) => chunk.id.startsWith(`${sourceId}-chunk-`));
    if (!row.chunks_path || !ownChunks.length) return { formatted: 0, total: ownChunks.length };
    let html = await readSourceHtml(row.imported_file_path);
    let cleanup: (() => Promise<void>) | undefined;
    try {
      if (!html) {
        const document = row.document_id ? getDb().query<{ original_file_path: string | null }, [string]>("SELECT original_file_path FROM project_documents WHERE id = ?").get(row.document_id) : null;
        const candidates = [document?.original_file_path, row.original_file_path].filter((path): path is string => Boolean(path)).map((path) => path.split("#")[0]!);
        let originalPath: string | undefined;
        for (const path of candidates) {
          if (isPreppyInputFile(path) && (await stat(path).catch(() => null))?.isFile()) { originalPath = path; break; }
        }
        if (!originalPath) {
          throw new Error("PDF·EPUB 원본 파일을 찾을 수 없습니다. 원본 파일을 다시 가져오면 원래 서식으로 읽을 수 있습니다. 기존 메모와 진도는 유지됩니다.");
        }
        const singleChapter = row.document_type === "book" && row.original_file_path === originalPath && originalPath !== document?.original_file_path;
        const pack = await buildPreppySourcePack(originalPath, row.document_type, singleChapter);
        cleanup = pack.cleanup;
        const manifest = JSON.parse(await readFile(join(pack.outputPath, "manifest.json"), "utf8")) as PreppyManifest;
        const chapters = await Promise.all((manifest.chapters || []).map((chapter) => chapter.path ? readSourceHtml(join(pack.outputPath, chapter.path)) : null));
        html = chapters.filter(Boolean).join("\n");
      }
      if (!html) throw new Error("원본에서 읽기용 HTML을 만들지 못했습니다. 현재 원문은 그대로 유지됩니다.");
      const enriched = attachHtmlToExistingChunks(ownChunks, html);
      const cachePath = join(dirname(row.chunks_path), "reader_html.json");
      const previous = await readFile(cachePath, "utf8").then((raw) => JSON.parse(raw) as Record<string, { text: string; html: string }>).catch(() => ({}));
      const entries = Object.fromEntries(enriched.filter((chunk) => chunk.html).map((chunk) => [chunk.id, { text: chunk.text, html: chunk.html! }]));
      const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...previous, ...entries }), "utf8");
      await rename(temporary, cachePath);
      return { formatted: Object.keys(entries).length, total: ownChunks.length };
    } finally {
      await cleanup?.();
    }
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
      if (figures.length) {
        const chunks = await this.loadChunks(sourceId);
        const normalized = normalizeSourceFigureChunkIds(figures, chunks);
        if (normalized.some((figure, index) => JSON.stringify(figure.sourceChunkIds) !== JSON.stringify(figures[index]?.sourceChunkIds))) {
          await writeFile(figuresPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8").catch(() => undefined);
        }
        return normalized;
      }
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
    const ownFolder = sourceFolderDirFor(this.projectRoot(row.project_id), row.project_id, row.imported_file_path);
    let folders: string[] = [];
    try {
      folders = ownFolder ? [join(ownFolder, "original")] : (await readdir(sourceFoldersDir, { withFileTypes: true }))
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
