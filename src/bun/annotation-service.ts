import type { AiChatClient } from "./openai-compatible-client";
import type { CourseArtifactService } from "./course-artifact-service";
import { deleteMaterialAnnotation, getMaterialAnnotation, saveMaterialAnnotation, updateMaterialAnnotationResult } from "./annotation-store";
import { writeMaterialAnnotationsSnapshot } from "./project-bundle-sync";
import type {
  ImageLookupItem,
  ImageLookupResult,
  LookupResult,
  LookupSourceMeta,
  MaterialAnnotationKind,
  MaterialAnnotationSurface,
  MaterialArtifacts,
  NoteResult,
  HighlightResult,
  SourceChunk,
} from "../shared/artifact-types";
import type { AppSettings } from "../shared/settings-types";

type ProviderClientContext = {
  publicSettings: AppSettings;
  apiKey: { value: string; source: string | null };
  client: AiChatClient;
};

type ProviderClientFactory = () => Promise<ProviderClientContext>;

type SelectionLookupInput = {
  materialId: string;
  chunkId: string;
  selectedText: string;
};

type SelectionQuestionInput = SelectionLookupInput & {
  question: string;
};

type SaveLookupInput = {
  materialId: string;
  chunkId: string;
  surface?: MaterialAnnotationSurface;
  anchorMessageId?: string | null;
  anchorBlockId?: string | null;
  kind: MaterialAnnotationKind;
  selectedText: string;
  result: LookupResult | ImageLookupResult | NoteResult | HighlightResult;
  sourceMeta: LookupSourceMeta[];
};

type UpdateNoteInput = {
  annotationId: string;
  note: string;
};

async function writeAnnotationsSnapshotRecoverable(materialId: string) {
  try {
    await writeMaterialAnnotationsSnapshot(materialId);
    return undefined;
  } catch (error) {
    const message = `Annotation change was saved in the database, but the project bundle snapshot could not be updated: ${(error as Error).message}`;
    console.warn(`[annotations] ${message}`);
    return message;
  }
}

type WikipediaSummary = {
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source?: string; width?: number; height?: number };
  originalimage?: { source?: string; width?: number; height?: number };
};

type WikipediaLang = "en" | "ko";

type WikipediaLookup = {
  lang: WikipediaLang;
  title: string;
  extract: string;
  pageUrl: string;
  thumbnail?: WikipediaSummary["thumbnail"];
  originalimage?: WikipediaSummary["originalimage"];
};

type WikipediaSearchPage = {
  pageid?: number;
  title?: string;
};

type WikipediaPageInfo = {
  pageid?: number;
  title?: string;
  missing?: unknown;
  langlinks?: Array<{ lang?: string; title?: string }>;
  pageprops?: { wikibase_item?: string };
};

type WikipediaQueryPagesResponse = {
  query?: { pages?: Record<string, WikipediaPageInfo> };
};

type WikidataEntitiesResponse = {
  entities?: Record<string, {
    sitelinks?: {
      enwiki?: { title?: string };
    };
  }>;
};

type WikidataSearchResponse = {
  search?: Array<{ id?: string; label?: string; description?: string }>;
};

type WikipediaMediaItem = {
  title?: string;
  type?: string;
  showInGallery?: boolean;
  srcset?: Array<{ src?: string }>;
  thumbnail?: { source?: string; width?: number; height?: number };
  original?: { source?: string; width?: number; height?: number };
};

const MAX_LOOKUP_IMAGE_BYTES = 1_500_000;
const MAX_LOOKUP_IMAGE_RESULTS = 3;
const SELECTION_QUESTION_CONTEXT_CHARS = 4000;
const SELECTION_QUESTION_CHARS = 2000;
const SELECTION_QUESTION_ANSWER_CHARS = 8000;
const SELECTION_QUESTION_ANSWER_TOKENS = 3200;
const TERM_RENDERING_RULE = [
  "When writing in Korean, do not replace romanized proper nouns or culturally specific technical terms with Korean-only transliterations.",
  "If the source or lookup result gives a romanized original form, preserve that form.",
  "If a Korean gloss or transliteration helps, put the original form in parentheses on first mention, e.g. 알마문(al-Ma'mun), 무타질라(Mu'tazila), 이성('aql).",
].join(" ");

function normalizeSelectedText(value: string, max = 160) {
  return cleanupLookupQuery(value.replace(/\s+/g, " ").trim()).slice(0, max);
}

function normalizeSelectedPassage(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function compactText(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function normalizeMarkdownText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactMarkdownText(value: string, max: number) {
  const normalized = normalizeMarkdownText(value);
  if (normalized.length <= max) return normalized;
  const candidate = normalized.slice(0, max).trimEnd();
  const minUsefulLength = Math.floor(max * 0.55);
  const paragraphBoundary = candidate.lastIndexOf("\n\n");
  if (paragraphBoundary >= minUsefulLength) {
    return `${candidate.slice(0, paragraphBoundary).trimEnd()}...`;
  }

  const sentenceBoundaries = [...candidate.matchAll(/[.!?。！？](?:["'”’)\]]+)?/gu)];
  const lastSentence = sentenceBoundaries.at(-1);
  if (lastSentence?.index != null && lastSentence.index + lastSentence[0].length >= minUsefulLength) {
    return `${candidate.slice(0, lastSentence.index + lastSentence[0].length).trimEnd()}...`;
  }

  // If there is no usable boundary, prefer a longer result over a visibly broken sentence.
  return normalized;
}

function splitSentences(value: string) {
  return value
    .replace(/\s+/g, " ")
    .match(/[^.!?。！？]+[.!?。！？]+(?:["'”’)\]]+)?|[^.!?。！？]+$/gu)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function isStructuredMarkdownBlock(value: string) {
  return /(^|\n)\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|\|.+\|)/m.test(value);
}

function paragraphizeLongBlock(value: string) {
  if (value.length <= 420 || isStructuredMarkdownBlock(value)) return [value];

  const sentences = splitSentences(value);
  if (sentences.length <= 2) return [value];

  const paragraphs: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const targetLength = paragraphs.length === 0 ? 260 : 360;
    const next = current ? `${current} ${sentence}` : sentence;
    if (current && next.length > targetLength) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) paragraphs.push(current);
  if (paragraphs.length <= 5) return paragraphs;

  return [
    ...paragraphs.slice(0, 4),
    paragraphs.slice(4).join(" "),
  ];
}

function formatWikipediaSummaryBody(value: string, max = 2400) {
  const normalized = normalizeMarkdownText(sanitizeWikipediaSummaryBody(value));
  const paragraphs = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraphizeLongBlock(paragraph.trim()))
    .filter(Boolean);
  return compactMarkdownText(paragraphs.join("\n\n"), max);
}

function sourceTitleOf(artifacts: MaterialArtifacts, chunkId: string) {
  const meta = artifacts.sourceIndex[chunkId];
  return meta?.title || artifacts.manifest.title;
}

function chunkContext(artifacts: MaterialArtifacts, chunkId: string) {
  const index = artifacts.sourceChunks.findIndex((chunk) => chunk.id === chunkId);
  if (index < 0) throw new Error("Source chunk not found");

  const chunk = artifacts.sourceChunks[index]!;
  const previous = artifacts.sourceChunks[index - 1];
  const next = artifacts.sourceChunks[index + 1];
  const contextParts = [
    previous ? `Before:\n${compactText(previous.text, 600)}` : "",
    `Current:\n${compactText(chunk.text, 1800)}`,
    next ? `After:\n${compactText(next.text, 600)}` : "",
  ].filter(Boolean);

  return {
    chunk,
    index,
    sourceTitle: sourceTitleOf(artifacts, chunkId),
    locator: artifacts.sourceIndex[chunkId]?.locator || chunk.locator,
    context: contextParts.join("\n\n"),
  };
}

function moduleForChunk(artifacts: MaterialArtifacts, chunkId: string) {
  let last = artifacts.coursePlan.modules[0];
  for (const chunk of artifacts.sourceChunks) {
    const owner = artifacts.coursePlan.modules.find((module) => module.sourceChunkIds.includes(chunk.id));
    if (owner) last = owner;
    if (chunk.id === chunkId) return last || owner || artifacts.coursePlan.modules[0];
  }
  return artifacts.coursePlan.modules[0];
}

function moduleQuestionContext(artifacts: MaterialArtifacts, chunkId: string, question: string) {
  const focus = chunkContext(artifacts, chunkId);
  const module = moduleForChunk(artifacts, chunkId);
  const moduleChunkIds = new Set(module?.sourceChunkIds || []);
  const focusChunk = focus.chunk;
  const moduleChunks = artifacts.sourceChunks.filter((chunk) => moduleChunkIds.has(chunk.id));
  const relatedTokens = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3).slice(0, 20);
  const related = artifacts.sourceChunks
    .filter((chunk) => chunk.id !== chunkId && !moduleChunkIds.has(chunk.id))
    .map((chunk) => {
      const haystack = `${chunk.headingPath.join(" ")} ${chunk.text}`.toLowerCase();
      const score = relatedTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => item.chunk);
  const contextChunks = [
    focusChunk,
    ...moduleChunks.filter((chunk) => chunk.id !== chunkId),
    ...related,
  ].slice(0, 6);

  return {
    ...focus,
    module,
    context: contextChunks
      .map((chunk) => {
        const label = chunk.id === chunkId ? "Selected text chunk" : "Module context chunk";
        const heading = chunk.headingPath.length ? ` (${chunk.headingPath.join(" > ")})` : "";
        return `${label}${heading}:\n${compactText(chunk.text, chunk.id === chunkId ? 1800 : 900)}`;
      })
      .join("\n\n"),
  };
}

async function fetchJson<T>(url: string, timeoutMs = 10000): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Learnie/0.5.5 desktop learning app",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchImageDataUrl(value: string, timeoutMs = 10000): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const response = await fetch(url.toString(), {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "user-agent": "Learnie/0.5.5 desktop learning app",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;

  const contentType = (response.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
  if (!contentType.startsWith("image/")) return null;

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_LOOKUP_IMAGE_BYTES) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_LOOKUP_IMAGE_BYTES) return null;
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function cleanupLookupQuery(value: string) {
  return value
    .trim()
    .replace(/^[\s"'“”‘’`()[\]{}<>.,;:!?，。！？]+/u, "")
    .replace(/[\s"'“”‘’`()[\]{}<>.,;:!?，。！？]+$/u, "");
}

function canonicalLookupText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wikipediaSearchUrl(lang: WikipediaLang, query: string) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", "5");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  return url.toString();
}

function wikipediaTitleInfoUrl(lang: WikipediaLang, title: string) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("titles", title);
  url.searchParams.set("prop", "langlinks|pageprops");
  url.searchParams.set("lllang", "en");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  return url.toString();
}

function wikidataEntityUrl(entityId: string) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", entityId);
  url.searchParams.set("props", "sitelinks");
  url.searchParams.set("sitefilter", "enwiki");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  return url.toString();
}

function wikidataEntitySearchUrl(query: string, language: "ko" | "en" = "ko") {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", query);
  url.searchParams.set("language", language);
  url.searchParams.set("uselang", language);
  url.searchParams.set("limit", "5");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  return url.toString();
}

function wikipediaSummaryUrl(lang: WikipediaLang, title: string) {
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function wikipediaMediaListUrl(lang: WikipediaLang, title: string) {
  return `https://${lang}.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function normalizeHttpsUrl(value: string | undefined) {
  if (!value) return null;
  const normalized = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function commonsFilePageUrl(title: string) {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_")).replace(/%3A/gi, ":")}`;
}

function cleanImageTitle(title: string) {
  return title
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function isLikelyDecorativeImage(title: string) {
  return /(?:symbol|icon|logo|question|wikimedia|commons|red\s*rectangle|crystal\s*clear|edit-clear|OOjs|ambox)/i.test(title);
}

function wikipediaLookupFromSummary(lang: WikipediaLang, summary: WikipediaSummary, fallbackTitle: string): WikipediaLookup | null {
  const title = summary.title || fallbackTitle;
  const extract = compactText(summary.extract || "", 1800);
  const pageUrl = summary.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
  if (!extract && !summary.thumbnail?.source) return null;
  return {
    lang,
    title,
    extract,
    pageUrl,
    thumbnail: summary.thumbnail,
    originalimage: summary.originalimage,
  };
}

function isRelevantWikipediaLookup(query: string, page: WikipediaLookup) {
  const normalizedQuery = canonicalLookupText(query);
  if (!normalizedQuery) return false;
  const normalizedTitle = canonicalLookupText(page.title);
  const normalizedExtract = canonicalLookupText(page.extract);
  return (
    normalizedTitle === normalizedQuery ||
    normalizedTitle.includes(normalizedQuery) ||
    normalizedExtract.includes(normalizedQuery)
  );
}

function selectedTextLooksKorean(value: string) {
  return /[가-힣]/u.test(value);
}

function isPlausibleKoreanSearchHit(query: string, title: string) {
  const normalizedQuery = canonicalLookupText(query);
  const normalizedTitle = canonicalLookupText(title);
  if (!normalizedQuery || !normalizedTitle) return false;
  if (normalizedTitle === normalizedQuery || normalizedTitle.includes(normalizedQuery)) return true;
  return normalizedQuery.includes(normalizedTitle) && normalizedTitle.length / normalizedQuery.length >= 0.6;
}

function firstPage(response: WikipediaQueryPagesResponse) {
  return Object.values(response.query?.pages || {}).find((page) => !page.missing) || null;
}

function englishTitleFromPageInfo(page: WikipediaPageInfo | null) {
  return page?.langlinks?.find((link) => link.lang === "en" && link.title)?.title || null;
}

async function englishTitleFromWikidata(entityId: string | undefined) {
  if (!entityId) return null;
  try {
    const data = await fetchJson<WikidataEntitiesResponse>(wikidataEntityUrl(entityId));
    return data.entities?.[entityId]?.sitelinks?.enwiki?.title || null;
  } catch {
    return null;
  }
}

async function englishTitleFromWikidataSearch(query: string) {
  try {
    const data = await fetchJson<WikidataSearchResponse>(wikidataEntitySearchUrl(query, selectedTextLooksKorean(query) ? "ko" : "en"));
    const ids = data.search?.map((result) => result.id).filter((id): id is string => Boolean(id)) || [];
    for (const id of ids) {
      const title = await englishTitleFromWikidata(id);
      if (title) return title;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveEnglishTitleFromKoreanPage(title: string) {
  try {
    const data = await fetchJson<WikipediaQueryPagesResponse>(wikipediaTitleInfoUrl("ko", title));
    const page = firstPage(data);
    return englishTitleFromPageInfo(page) || await englishTitleFromWikidata(page?.pageprops?.wikibase_item);
  } catch {
    return null;
  }
}

async function resolveEnglishWikipediaTitleFromKorean(query: string) {
  const direct = await resolveEnglishTitleFromKoreanPage(query);
  if (direct) return direct;

  const wikidata = await englishTitleFromWikidataSearch(query);
  if (wikidata) return wikidata;

  try {
    const search = await fetchJson<{ query?: { search?: WikipediaSearchPage[] } }>(wikipediaSearchUrl("ko", query));
    const titles = search.query?.search
      ?.map((result) => result.title)
      .filter((title): title is string => Boolean(title))
      .filter((title) => isPlausibleKoreanSearchHit(query, title)) || [];
    for (const title of titles) {
      const resolved = await resolveEnglishTitleFromKoreanPage(title);
      if (resolved) return resolved;
    }
  } catch {
    // Fall back to direct English lookup/search.
  }

  return null;
}

async function fetchEnglishWikipediaSummary(title: string, query: string, trustedTitle = false) {
  try {
    const summary = await fetchJson<WikipediaSummary>(wikipediaSummaryUrl("en", title));
    const page = wikipediaLookupFromSummary("en", summary, title);
    if (page && (trustedTitle || isRelevantWikipediaLookup(query, page))) return page;
  } catch {
    // Try search below.
  }
  return null;
}

async function lookupWikipedia(query: string): Promise<WikipediaLookup | null> {
  const cleanedQuery = cleanupLookupQuery(query);
  if (!cleanedQuery) return null;

  const resolvedEnglishTitle = selectedTextLooksKorean(cleanedQuery)
    ? await resolveEnglishWikipediaTitleFromKorean(cleanedQuery)
    : null;
  if (resolvedEnglishTitle) {
    const resolvedPage = await fetchEnglishWikipediaSummary(resolvedEnglishTitle, cleanedQuery, true);
    if (resolvedPage) return resolvedPage;
  }

  const directPage = await fetchEnglishWikipediaSummary(cleanedQuery, cleanedQuery);
  if (directPage) return directPage;

  try {
    const searchQuery = resolvedEnglishTitle || cleanedQuery;
    const search = await fetchJson<{ query?: { search?: WikipediaSearchPage[] } }>(wikipediaSearchUrl("en", searchQuery));
    const titles = search.query?.search?.map((result) => result.title).filter((title): title is string => Boolean(title)) || [];
    for (const title of titles) {
      try {
        const summary = await fetchJson<WikipediaSummary>(wikipediaSummaryUrl("en", title));
        const page = wikipediaLookupFromSummary("en", summary, title);
        if (page && (resolvedEnglishTitle || isRelevantWikipediaLookup(cleanedQuery, page))) return page;
      } catch {
        // Try the next English search result.
      }
    }
  } catch {
    // Fall back to AI.
  }

  return null;
}

type ImageCandidate = {
  title: string;
  thumbnailSource: string;
  imageSource: string;
  pageUrl: string;
  width?: number;
  height?: number;
};

async function wikipediaImageCandidates(page: WikipediaLookup, limit = MAX_LOOKUP_IMAGE_RESULTS * 3) {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();

  function addCandidate(candidate: ImageCandidate | null) {
    if (!candidate) return;
    const key = `${canonicalLookupText(candidate.title)}|${candidate.imageSource}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  }

  try {
    const media = await fetchJson<{ items?: WikipediaMediaItem[] }>(wikipediaMediaListUrl(page.lang, page.title));
    for (const item of media.items || []) {
      if (candidates.length >= limit) break;
      if (item.type !== "image" || item.showInGallery === false || !item.title || isLikelyDecorativeImage(item.title)) continue;
      const thumbnailSource = normalizeHttpsUrl(item.thumbnail?.source || item.srcset?.[0]?.src || item.original?.source);
      const imageSource = normalizeHttpsUrl(item.original?.source || item.srcset?.at(-1)?.src || item.srcset?.[0]?.src || item.thumbnail?.source);
      if (!thumbnailSource || !imageSource) continue;
      addCandidate({
        title: cleanImageTitle(item.title),
        thumbnailSource,
        imageSource,
        pageUrl: commonsFilePageUrl(item.title),
        width: item.thumbnail?.width || item.original?.width,
        height: item.thumbnail?.height || item.original?.height,
      });
    }
  } catch {
    // Fall back to the summary thumbnail below.
  }

  const summaryThumbnail = normalizeHttpsUrl(page.thumbnail?.source);
  if (summaryThumbnail) {
    const imageSource = normalizeHttpsUrl(page.originalimage?.source) || summaryThumbnail;
    addCandidate({
      title: page.title,
      thumbnailSource: summaryThumbnail,
      imageSource,
      pageUrl: page.pageUrl,
      width: page.thumbnail?.width,
      height: page.thumbnail?.height,
    });
  }

  return candidates.slice(0, limit);
}

async function wikipediaImageItems(page: WikipediaLookup) {
  const candidates = await wikipediaImageCandidates(page);
  const images: ImageLookupItem[] = [];

  for (const candidate of candidates) {
    if (images.length >= MAX_LOOKUP_IMAGE_RESULTS) break;
    const thumbnailDataUrl = await fetchImageDataUrl(candidate.thumbnailSource);
    if (!thumbnailDataUrl) continue;
    images.push({
      title: candidate.title,
      thumbnailUrl: thumbnailDataUrl,
      imageUrl: candidate.imageSource,
      pageUrl: candidate.pageUrl,
      sourceTitle: page.title,
      provider: "wikipedia",
      width: candidate.width,
      height: candidate.height,
    });
  }

  return images;
}

function wikipediaSourceMeta(page: WikipediaLookup): LookupSourceMeta[] {
  return [{ title: page.title, url: page.pageUrl, provider: `Wikipedia (${page.lang})`, retrievedAt: new Date().toISOString() }];
}

function wikipediaFallbackResult(term: string, wiki: WikipediaLookup, reason?: string): LookupResult {
  const normalizedReason = reason?.toLowerCase() || "";
  const reasonNote = normalizedReason.includes("empty message")
    ? "요약 모델이 빈 응답을 반환했습니다."
    : reason
      ? "요약 모델이 응답하지 못했습니다."
      : "한국어 AI 요약을 사용할 수 없습니다.";
  const note = `${reasonNote} 아래에는 Wikipedia (${wiki.lang}) 요약을 그대로 보여줍니다.`;
  return {
    kind: "lookup",
    title: wiki.title,
    body: `${note}\n\n${wiki.extract}`,
    query: term,
    provider: "wikipedia",
    url: wiki.pageUrl,
    sourceTitle: wiki.title,
    retrievedAt: new Date().toISOString(),
    sourceMeta: wikipediaSourceMeta(wiki),
  };
}

function shouldRetryWikipediaSummary(error: unknown) {
  const message = ((error as Error)?.message || String(error)).toLowerCase();
  return (
    message.includes("empty message") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("output token limit") ||
    message.includes("finish_reason=length") ||
    message.includes("stop_reason=max_tokens") ||
    message.includes("finishreason=max_tokens")
  );
}

function sanitizeWikipediaSummaryBody(value: string) {
  return value
    .replace(/(?:이\s*)?(?:본문|원문|학습\s*자료|자료|문맥|context)\s*(?:에 따르면|에서는|에서)\s*,?\s*/giu, "")
    .replace(/현재\s*학습(?:\s*중인)?\s*(?:본문|자료|문맥|context)\s*(?:에 따르면|에서는|에서)\s*,?\s*/giu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class AnnotationService {
  constructor(
    private readonly materials: CourseArtifactService,
    private readonly providerClient: ProviderClientFactory
  ) {}

  async define(input: SelectionLookupInput): Promise<LookupResult> {
    const term = normalizeSelectedText(input.selectedText);
    if (!term) throw new Error("Selected text is empty");
    const artifacts = await this.materials.getArtifacts(input.materialId);
    const context = chunkContext(artifacts, input.chunkId);
    return this.aiLookup("define", term, context.chunk, context.sourceTitle, context.locator, context.context);
  }

  async ask(input: SelectionQuestionInput): Promise<LookupResult> {
    const selectedText = normalizeSelectedPassage(input.selectedText, SELECTION_QUESTION_CONTEXT_CHARS);
    const question = input.question.replace(/\s+/g, " ").trim().slice(0, SELECTION_QUESTION_CHARS);
    if (!selectedText) throw new Error("Selected text is empty");
    if (!question) throw new Error("Question is empty");

    const artifacts = await this.materials.getArtifacts(input.materialId);
    const context = moduleQuestionContext(artifacts, input.chunkId, question);
    return this.aiAnswerSelectionQuestion(selectedText, question, context);
  }

  async lookup(input: SelectionLookupInput): Promise<LookupResult> {
    const term = normalizeSelectedText(input.selectedText);
    if (!term) throw new Error("Selected text is empty");

    const wiki = await lookupWikipedia(term);
    if (wiki?.extract) {
      try {
        return await this.aiSummarizeWikipediaLookup(term, wiki);
      } catch (error) {
        return wikipediaFallbackResult(term, wiki, (error as Error).message || String(error));
      }
    }

    const artifacts = await this.materials.getArtifacts(input.materialId);
    const context = chunkContext(artifacts, input.chunkId);
    return this.aiLookup("lookup", term, context.chunk, context.sourceTitle, context.locator, context.context);
  }

  async findImages(input: SelectionLookupInput): Promise<ImageLookupResult> {
    const term = normalizeSelectedText(input.selectedText);
    if (!term) throw new Error("Selected text is empty");

    const wiki = await lookupWikipedia(term);
    const images = wiki ? await wikipediaImageItems(wiki) : [];

    return {
      kind: "image",
      title: images.length && wiki ? `Image result for ${wiki.title}` : "No image result",
      query: term,
      provider: "wikipedia",
      images,
      retrievedAt: new Date().toISOString(),
      sourceMeta: wiki ? wikipediaSourceMeta(wiki) : [],
    };
  }

  async save(input: SaveLookupInput) {
    const artifacts = await this.materials.getArtifacts(input.materialId);
    if (!artifacts.sourceChunks.some((chunk) => chunk.id === input.chunkId)) throw new Error("Source chunk not found");
    const sourceId = artifacts.sourceIndex[input.chunkId]?.sourceId || null;
    const saved = saveMaterialAnnotation({
      materialId: input.materialId,
      chunkId: input.chunkId,
      sourceId,
      surface: input.surface,
      anchorMessageId: input.anchorMessageId || null,
      anchorBlockId: input.anchorBlockId || null,
      kind: input.kind,
      selectedText: input.selectedText,
      result: input.result,
      sourceMeta: input.sourceMeta,
    });
    const syncWarning = await writeAnnotationsSnapshotRecoverable(saved.materialId);
    return syncWarning ? { ...saved, syncWarning } : saved;
  }

  async updateNote(input: UpdateNoteInput) {
    const existing = getMaterialAnnotation(input.annotationId);
    if (!existing) throw new Error("Annotation not found");
    if (existing.kind !== "note") throw new Error("Only note annotations can be edited");
    const updated = updateMaterialAnnotationResult(input.annotationId, { kind: "note", note: input.note.slice(0, 5000) });
    if (!updated) throw new Error("Annotation update failed");
    const syncWarning = await writeAnnotationsSnapshotRecoverable(updated.materialId);
    return syncWarning ? { ...updated, syncWarning } : updated;
  }

  async delete(annotationId: string) {
    const existing = getMaterialAnnotation(annotationId);
    const deleted = deleteMaterialAnnotation(annotationId);
    if (existing) {
      const syncWarning = await writeAnnotationsSnapshotRecoverable(existing.materialId);
      return { deleted, syncWarning };
    }
    return { deleted };
  }

  private async aiLookup(
    kind: "define" | "lookup",
    term: string,
    chunk: SourceChunk,
    sourceTitle: string,
    locator: string,
    context: string
  ): Promise<LookupResult> {
    const { publicSettings, apiKey, client } = await this.providerClient();
    const model = publicSettings.providers[publicSettings.aiProvider].selectedModel;
    if (!apiKey.value || !model) throw new Error("AI provider is not configured");

    const system = kind === "define"
      ? `You are Learnie, a source-grounded tutor. Define the selected term for a learner. Use the provided source context first. If the context is insufficient, say that the definition is general. Keep the answer under 80 Korean words. Do not expose internal app terminology. ${TERM_RENDERING_RULE}`
      : `You are Learnie, a concise encyclopedia-style tutor. Explain the selected term for a learner. Prefer stable facts and explain why it matters in this source context. If uncertain, say what is uncertain. Keep the answer under 140 Korean words. Do not expose internal app terminology. ${TERM_RENDERING_RULE}`;
    const prompt = [
      `Selected term: ${term}`,
      `Source title: ${sourceTitle}`,
      locator ? `Locator: ${locator}` : "",
      chunk.headingPath.length ? `Heading path: ${chunk.headingPath.join(" > ")}` : "",
      `Bounded source context:\n${context}`,
    ].filter(Boolean).join("\n\n");

    const body = await client.chatText({
      model,
      temperature: 0.2,
      maxTokens: kind === "define" ? 500 : 800,
      timeoutMs: 45000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    const providerLabel = publicSettings.aiProvider;
    const retrievedAt = new Date().toISOString();
    return {
      kind,
      title: kind === "define" ? `${term} 정의` : `${term} lookup`,
      body: compactText(body, kind === "define" ? 700 : 1100),
      query: term,
      provider: "ai",
      model,
      sourceTitle,
      retrievedAt,
      sourceMeta: [{ title: `${providerLabel} ${model}`, provider: "AI provider", retrievedAt }],
    };
  }

  private async aiAnswerSelectionQuestion(
    selectedText: string,
    question: string,
    context: ReturnType<typeof moduleQuestionContext>
  ): Promise<LookupResult> {
    const { publicSettings, apiKey, client } = await this.providerClient();
    const model = publicSettings.providers[publicSettings.aiProvider].selectedModel;
    if (!apiKey.value || !model) throw new Error("AI provider is not configured");

    const prompt = [
      `Selected text: ${selectedText}`,
      `Learner question: ${question}`,
      `Source title: ${context.sourceTitle}`,
      context.module ? `Current module: ${context.module.title}` : "",
      context.module?.learningGoal ? `Module learning goal: ${context.module.learningGoal}` : "",
      context.locator ? `Locator: ${context.locator}` : "",
      `Module-bounded source context:\n${context.context}`,
    ].filter(Boolean).join("\n\n");

    const body = await client.chatText({
      model,
      temperature: 0.35,
      maxTokens: SELECTION_QUESTION_ANSWER_TOKENS,
      timeoutMs: 90000,
      messages: [
        {
          role: "system",
          content: [
            "You are Learnie, a guided tutor answering a learner's follow-up about selected text.",
            "Use the current module context as the main basis. If broader background is needed, add it clearly as background.",
            "Answer the learner's exact question first, then connect it back to the selected text.",
            "Write in Korean unless the learner's question is clearly in another language.",
            TERM_RENDERING_RULE,
            "Use 2-4 short paragraphs or a compact bullet list when that is clearer.",
            "Do not mention internal app terms such as module ids, chunks, annotations, or lookup.",
            "Keep the answer complete and substantive; do not stop mid-sentence.",
          ].join(" "),
        },
        { role: "user", content: prompt },
      ],
    });

    const providerLabel = publicSettings.aiProvider;
    const retrievedAt = new Date().toISOString();
    return {
      kind: "question",
      title: question,
      body: compactMarkdownText(body, SELECTION_QUESTION_ANSWER_CHARS),
      query: selectedText,
      question,
      provider: "ai",
      model,
      sourceTitle: context.sourceTitle,
      retrievedAt,
      sourceMeta: [{ title: `${providerLabel} ${model}`, provider: "AI tutor", retrievedAt }],
    };
  }

  private async aiSummarizeWikipediaLookup(
    term: string,
    wiki: WikipediaLookup
  ): Promise<LookupResult> {
    const { publicSettings, apiKey, client } = await this.providerClient();
    const model = publicSettings.providers[publicSettings.aiProvider].selectedModel;
    if (!apiKey.value || !model) throw new Error("AI provider is not configured for Korean lookup summaries");

    const prompt = [
      `Selected term: ${term}`,
      `Wikipedia language: ${wiki.lang}`,
      `Wikipedia title: ${wiki.title}`,
      `Wikipedia URL: ${wiki.pageUrl}`,
      `Wikipedia extract:\n${wiki.extract}`,
    ].filter(Boolean).join("\n\n");

    let body = "";
    try {
      body = await client.chatText({
        model,
        temperature: 0.15,
        maxTokens: 2200,
        timeoutMs: 70000,
        thinking: "disabled",
        messages: [
          {
            role: "system",
            content: [
              "You are Learnie, a Korean learning assistant.",
              "Write a deeper lookup note, not a one-line definition.",
              "Use the Wikipedia extract as the factual basis and explain the selected term in Korean.",
              TERM_RENDERING_RULE,
              "Structure the answer as separated short paragraphs.",
              "The first paragraph must be the most important takeaway: one compact paragraph explaining the core meaning and why it matters.",
              "After a blank line, add one supporting paragraph covering only the most useful background, example, distinction, or common confusion.",
              "Do not make a single long paragraph. Do not use numbered section labels unless they are genuinely helpful.",
              "Do not introduce unrelated concepts. If the extract does not match the selected term, say that the lookup result is unreliable.",
              "Do not mention learner materials, source context, original text, current text, or phrases like '본문에 따르면', '원문에 따르면', '자료에 따르면', or '문맥상'.",
              "If you need to name the basis, call it the Wikipedia article, not '본문'.",
              "Use 2 short paragraphs total. Avoid bullets unless they genuinely improve readability. Keep the answer to 4-6 Korean sentences total.",
            ].join(" "),
          },
          { role: "user", content: prompt },
        ],
      });
    } catch (error) {
      if (!shouldRetryWikipediaSummary(error)) throw error;
      body = await client.chatText({
        model,
        temperature: 0.1,
        maxTokens: 700,
        timeoutMs: 45000,
        messages: [
          {
            role: "system",
            content: [
              "You are Learnie. Summarize the provided Wikipedia extract in Korean.",
              TERM_RENDERING_RULE,
              "Return 2 short paragraphs only.",
              "Paragraph 1: who or what the term is and why it matters.",
              "Paragraph 2: one key background point or common confusion.",
              "Do not mention source text, learner materials, or internal app wording.",
              "Never return an empty response.",
            ].join(" "),
          },
          { role: "user", content: prompt },
        ],
      });
    }
    const providerLabel = publicSettings.aiProvider;
    const retrievedAt = new Date().toISOString();
    return {
      kind: "lookup",
      title: wiki.title,
      body: formatWikipediaSummaryBody(body),
      query: term,
      provider: "ai",
      model,
      url: wiki.pageUrl,
      sourceTitle: wiki.title,
      retrievedAt,
      sourceMeta: [
        ...wikipediaSourceMeta(wiki),
        { title: `${providerLabel} ${model}`, provider: "AI Korean summarizer", retrievedAt },
      ],
    };
  }
}
