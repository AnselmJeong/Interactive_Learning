import type { LookupSourceMeta } from "../shared/artifact-types";

type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
};

type FetchLike = typeof fetch;

const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 20_000;

function compact(value: string | undefined, maxLength: number) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function safeHttpUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sourceFromResult(result: SearchResult, index: number, retrievedAt: string): LookupSourceMeta | null {
  const url = safeHttpUrl(result.url);
  if (!url) return null;
  let hostname = url;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // URL was already validated. Keep the URL as a defensive fallback label.
  }
  return {
    id: `S${index + 1}`,
    title: compact(result.title, 180) || hostname,
    url,
    provider: "Web search",
    retrievedAt,
    snippet: compact(result.content, 700),
  };
}

export async function searchOllamaWeb(
  query: string,
  apiKey: string,
  options: { maxResults?: number; fetchImpl?: FetchLike } = {}
): Promise<LookupSourceMeta[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!normalizedQuery) throw new Error("웹 검색어가 비어 있습니다.");
  if (!apiKey.trim()) throw new Error("웹 검색을 사용하려면 Settings에 Ollama API key를 저장해야 합니다.");

  const maxResults = Math.min(Math.max(Math.round(options.maxResults || DEFAULT_MAX_RESULTS), 1), MAX_RESULTS);
  const fetchImpl = options.fetchImpl || fetch;
  let response: Response;
  try {
    response = await fetchImpl(OLLAMA_WEB_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      body: JSON.stringify({ query: normalizedQuery, max_results: maxResults }),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("Ollama 웹 검색 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.");
    }
    throw new Error(`Ollama 웹 검색에 연결하지 못했습니다: ${(error as Error).message || String(error)}`);
  }

  if (!response.ok) {
    const details = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Ollama 웹 검색 실패 (${response.status})${suffix}`);
  }

  let payload: { results?: SearchResult[] };
  try {
    payload = await response.json() as { results?: SearchResult[] };
  } catch {
    throw new Error("Ollama 웹 검색이 올바르지 않은 응답을 반환했습니다.");
  }
  const retrievedAt = new Date().toISOString();
  return (payload.results || [])
    .map((result, index) => sourceFromResult(result, index, retrievedAt))
    .filter((source): source is LookupSourceMeta => Boolean(source));
}
