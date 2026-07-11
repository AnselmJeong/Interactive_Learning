import type { ImageLookupItem } from "../shared/artifact-types";

type BraveImageSearchResult = {
  title?: string;
  url?: string;
  source?: string;
  thumbnail?: { src?: string; width?: number; height?: number };
  properties?: { url?: string; width?: number; height?: number };
  meta_url?: { hostname?: string };
  confidence?: "low" | "medium" | "high" | string;
};

type BraveImageSearchResponse = {
  query?: { original?: string; altered?: string | null };
  results?: BraveImageSearchResult[];
};

const BRAVE_IMAGE_SEARCH_URL = "https://api.search.brave.com/res/v1/images/search";
const MAX_RESULT_CANDIDATES = 12;
const MAX_IMAGE_RESULTS = 3;
const MAX_THUMBNAIL_BYTES = 1_500_000;

function safeHttpUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function searchLanguage(query: string) {
  if (/[가-힣]/u.test(query)) return "ko";
  if (/[぀-ヿ]/u.test(query)) return "ja";
  if (/[一-鿿]/u.test(query)) return "zh-hans";
  return "en";
}

async function fetchThumbnailDataUrl(url: string, fetchImpl: typeof fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return null;
  const response = await fetchImpl(parsed.toString(), {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "user-agent": "Learnie/0.7.2 desktop learning app",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const contentType = (response.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
  if (!contentType.startsWith("image/")) return null;
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_THUMBNAIL_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_THUMBNAIL_BYTES) return null;
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

export async function searchBraveImages(query: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ImageLookupItem[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!normalizedQuery || !apiKey.trim()) return [];

  const url = new URL(BRAVE_IMAGE_SEARCH_URL);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("country", "ALL");
  url.searchParams.set("search_lang", searchLanguage(normalizedQuery));
  url.searchParams.set("count", String(MAX_RESULT_CANDIDATES));
  url.searchParams.set("safesearch", "strict");
  url.searchParams.set("spellcheck", "true");

  const response = await fetchImpl(url.toString(), {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey.trim(),
      "user-agent": "Learnie/0.7.2 desktop learning app",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`Brave Image Search failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const payload = await response.json() as BraveImageSearchResponse;
  const ordered = [...(payload.results || [])].sort((left, right) => {
    const score = (value: BraveImageSearchResult) => value.confidence === "high" ? 2 : value.confidence === "medium" ? 1 : 0;
    return score(right) - score(left);
  });
  const images: ImageLookupItem[] = [];
  const seen = new Set<string>();

  for (const result of ordered) {
    if (images.length >= MAX_IMAGE_RESULTS) break;
    const thumbnailSource = safeHttpUrl(result.thumbnail?.src);
    const imageUrl = safeHttpUrl(result.properties?.url);
    const pageUrl = safeHttpUrl(result.url);
    if (!thumbnailSource || !imageUrl || !pageUrl || seen.has(imageUrl)) continue;
    const thumbnailUrl = await fetchThumbnailDataUrl(thumbnailSource, fetchImpl).catch(() => null);
    if (!thumbnailUrl) continue;
    seen.add(imageUrl);
    const source = result.source?.trim() || result.meta_url?.hostname?.trim() || new URL(pageUrl).hostname;
    images.push({
      title: result.title?.replace(/\s+/g, " ").trim().slice(0, 500) || normalizedQuery,
      thumbnailUrl,
      imageUrl,
      pageUrl,
      sourceTitle: source,
      provider: "brave",
      width: result.properties?.width || result.thumbnail?.width,
      height: result.properties?.height || result.thumbnail?.height,
    });
  }

  return images;
}
