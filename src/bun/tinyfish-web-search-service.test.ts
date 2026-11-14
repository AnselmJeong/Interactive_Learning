import { describe, expect, test } from "bun:test";
import { searchTinyFishWeb } from "./tinyfish-web-search-service";

describe("TinyFish web search service", () => {
  test("authenticates, bounds results, and normalizes safe source metadata", async () => {
    let request: RequestInit | undefined;
    let requestUrl = "";
    const sources = await searchTinyFishWeb("  current   evidence  ", "secret-key", {
      maxResults: 99,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(url);
        request = init;
        return new Response(JSON.stringify({
          results: [
            { title: "Useful result", url: "https://www.example.com/article", snippet: "  Relevant   excerpt. " },
            { title: "Unsafe result", url: "javascript:alert(1)", snippet: "ignored" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    expect(requestUrl).toBe("https://api.search.tinyfish.ai?query=current+evidence");
    expect(request?.headers).toEqual({ Accept: "application/json", "X-API-Key": "secret-key" });
    expect(request?.body).toBeUndefined();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "S1",
      title: "Useful result",
      url: "https://www.example.com/article",
      provider: "TinyFish web search",
      snippet: "Relevant excerpt.",
    });
  });

  test("requires a saved TinyFish API key", async () => {
    await expect(searchTinyFishWeb("query", "")).rejects.toThrow("TinyFish API key");
  });

  test("keeps response details in search failures", async () => {
    await expect(searchTinyFishWeb("query", "key", {
      fetchImpl: (async () => new Response('{"error":"quota exceeded"}', { status: 429 })) as unknown as typeof fetch,
    })).rejects.toThrow('TinyFish 웹 검색 실패 (429): {"error":"quota exceeded"}');
  });

  test("reports malformed success responses clearly", async () => {
    await expect(searchTinyFishWeb("query", "key", {
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    })).rejects.toThrow("올바르지 않은 응답");
  });
});
