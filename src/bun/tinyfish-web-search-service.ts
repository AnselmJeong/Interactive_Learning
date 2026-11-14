import type { LookupSourceMeta } from "../shared/artifact-types";

type TinyFishSearchResult = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
};

type TinyFishSearchResponse = {
  results?: unknown;
};

type FetchLike = typeof fetch;

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 20_000;

function compact(value: string | undefined, maxLength: number) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function safeHttpUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sourceFromResult(result: TinyFishSearchResult, index: number, retrievedAt: string): LookupSourceMeta | null {
  const url = safeHttpUrl(result.url);
  if (!url) return null;
  const title = typeof result.title === "string" ? compact(result.title, 180) : undefined;
  const snippet = typeof result.snippet === "string" ? compact(result.snippet, 700) : undefined;
  let hostname = url;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // The URL was validated above; retain it as a defensive display fallback.
  }
  return {
    id: `S${index + 1}`,
    title: title || hostname,
    url,
    provider: "TinyFish web search",
    retrievedAt,
    ...(snippet ? { snippet } : {}),
  };
}

function errorDetail(raw: string) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function searchTinyFishWeb(
  query: string,
  apiKey: string,
  options: { maxResults?: number; fetchImpl?: FetchLike } = {},
): Promise<LookupSourceMeta[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!normalizedQuery) throw new Error("웹 검색어가 비어 있습니다.");
  if (!apiKey.trim()) throw new Error("웹 검색을 사용하려면 Settings에 TinyFish API key를 저장해야 합니다.");

  const maxResults = Math.min(Math.max(Math.round(options.maxResults || DEFAULT_MAX_RESULTS), 1), MAX_RESULTS);
  const fetchImpl = options.fetchImpl || fetch;
  const params = new URLSearchParams({ query: normalizedQuery });

  let response: Response;
  try {
    response = await fetchImpl(`${TINYFISH_SEARCH_URL}?${params}`, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey.trim() },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("TinyFish 웹 검색 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.");
    }
    throw new Error(`TinyFish 웹 검색에 연결하지 못했습니다: ${(error as Error).message || String(error)}`);
  }

  if (!response.ok) {
    const details = errorDetail(await response.text().catch(() => ""));
    throw new Error(`TinyFish 웹 검색 실패 (${response.status})${details ? `: ${details}` : ""}`);
  }

  let payload: TinyFishSearchResponse;
  try {
    payload = await response.json() as TinyFishSearchResponse;
  } catch {
    throw new Error("TinyFish 웹 검색이 올바르지 않은 응답을 반환했습니다.");
  }
  if (!Array.isArray(payload.results)) throw new Error("TinyFish 웹 검색이 올바르지 않은 응답을 반환했습니다.");

  const retrievedAt = new Date().toISOString();
  return payload.results
    .slice(0, maxResults)
    .flatMap((result, index) => {
      if (typeof result !== "object" || result === null) return [];
      const source = sourceFromResult(result as TinyFishSearchResult, index, retrievedAt);
      return source ? [source] : [];
    });
}
