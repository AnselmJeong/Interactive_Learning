import type { SourceChunk } from "../shared/artifact-types";
import { richHtmlBlocks, richHtmlText, sanitizeRichHtml } from "../shared/rich-html";
import { parseFragment, serialize, serializeOuter } from "parse5";
import { isHtmlElement } from "../shared/rich-html";
import { dirname, resolve, extname } from "node:path";
import { readFile, realpath } from "node:fs/promises";

export async function readSourceHtml(markdownPath: string): Promise<string | null> {
  const path = markdownPath.slice(0, -extname(markdownPath).length) + ".html";
  const html = await readFile(path, "utf8").catch(() => null);
  if (!html) return null;
  const root = parseFragment(html);
  const packRoot = await realpath(resolve(dirname(path), "..")).catch(() => resolve(dirname(path), ".."));
  const visit = async (node: import("parse5").DefaultTreeAdapterTypes.Node): Promise<void> => {
    if (isHtmlElement(node) && node.tagName === "img") {
      const attr = node.attrs.find((a) => a.name === "src");
      if (attr && !/^[a-z][a-z0-9+.-]*:/i.test(attr.value)) {
        let relativePath: string;
        try { relativePath = decodeURIComponent(attr.value); } catch { relativePath = attr.value; }
        const imagePath = await realpath(resolve(dirname(path), relativePath)).catch(() => "");
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[extname(imagePath).toLowerCase()];
        if (mime && imagePath.startsWith(`${packRoot}/`)) {
          const bytes = await readFile(imagePath).catch(() => null);
          if (bytes) attr.value = `data:${mime};base64,${bytes.toString("base64")}`;
        }
      }
    }
    if ("childNodes" in node) await Promise.all(node.childNodes.map(visit));
  };
  await visit(root);
  return serialize(root);
}

function coverageKey(text: string) {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Safety net for HTML sidecars that end early (e.g. a mis-sliced serializer
 * export). Math and markup make HTML and Markdown text differ somewhat, so only
 * a sidecar carrying well under the Markdown's text is treated as truncated.
 */
export function htmlChunksCoverMarkdown(chunks: SourceChunk[], markdown: string, minRatio = 0.6) {
  const markdownLength = coverageKey(markdown).length;
  if (markdownLength < 200) return true;
  const htmlLength = coverageKey(chunks.map((chunk) => chunk.text).join(" ")).length;
  return htmlLength >= markdownLength * minRatio;
}

/** HTML is authoritative for new imports. Never reassign existing chunk IDs. */
export function normalizeHtmlChunks(sourceId: string, html: string): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  const headings: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    const content = pending.join("\n");
    const text = richHtmlText(content);
    if (text || /<img\b/.test(content)) chunks.push({
      id: `${sourceId}-chunk-${String(chunks.length + 1).padStart(3, "0")}`,
      headingPath: [...headings], locator: headings.at(-1) || "document", kind: /<table\b/.test(content) ? "table" : "body",
      text: text || "[Figure]", html: content, confidence: 0.95,
    });
    pending = [];
  };
  for (const block of richHtmlBlocks(sanitizeRichHtml(html, { source: true, idPrefix: sourceId }))) {
    const heading = /^<h([1-6])\b/.exec(block);
    if (heading) {
      flush();
      headings.splice(Math.min(Number(heading[1]) - 1, headings.length));
      headings.push(richHtmlText(block));
      continue;
    }
    if (pending.length && richHtmlText(pending.join("\n")).length + richHtmlText(block).length > 1500) flush();
    pending.push(block);
    if (richHtmlText(pending.join("\n")).length >= 900) flush();
  }
  flush();
  return chunks;
}

function sourceTextKey(text: string) {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Only exact, monotonic text matches are enriched. Existing text/IDs are immutable. */
export function attachHtmlToExistingChunks(chunks: SourceChunk[], html: string): SourceChunk[] {
  type Node = import("parse5").DefaultTreeAdapterTypes.Node;
  const root = parseFragment(sanitizeRichHtml(html, { source: true }));
  const ranges = new Map<Node, { start: number; end: number }>();
  let canonical = "";
  const index = (node: Node) => {
    const start = canonical.length;
    if (isHtmlElement(node) && /^h[1-6]$/.test(node.tagName)) { ranges.set(node, { start, end: start }); return; }
    if ("value" in node) canonical += node.value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    else if ("childNodes" in node) node.childNodes.forEach(index);
    ranges.set(node, { start, end: canonical.length });
  };
  index(root);
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const slice = (node: Node, start: number, end: number): string => {
    const range = ranges.get(node);
    if (!range || (isHtmlElement(node) && /^h[1-6]$/.test(node.tagName))) return "";
    if (range.start === range.end) return range.start >= start && range.start < end ? serializeOuter(node) : "";
    if (range.end <= start || range.start >= end) return "";
    if ("value" in node) {
      let position = range.start;
      let value = "";
      for (const char of node.value) {
        const size = char.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").length;
        const leadingBoundaryPunctuation = range.start < start && position === start && !size && !value.length;
        if (!leadingBoundaryPunctuation && ((position >= start && position < end) || (position === end && !size && value.length))) value += char;
        position += size;
      }
      return escape(range.end > end ? value.trimEnd() : value);
    }
    if (!isHtmlElement(node)) return "childNodes" in node ? node.childNodes.map((n) => slice(n, start, end)).join("") : "";
    const content = node.childNodes.map((n) => slice(n, start, end)).join("");
    if (!content) return "";
    const shell = serializeOuter({ ...node, childNodes: [] });
    return shell.replace(`</${node.tagName}>`, `${content}</${node.tagName}>`);
  };
  let cursor = 0;
  return chunks.map((chunk) => {
    if (chunk.html) return chunk;
    const key = sourceTextKey(chunk.text);
    if (key.length < 12) return chunk;
    const start = canonical.indexOf(key, cursor);
    if (start < 0) return chunk;
    const end = start + key.length;
    cursor = end;
    const content = slice(root, start, end);
    return content ? { ...chunk, html: content } : chunk;
  });
}
