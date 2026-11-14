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

  test("passes language, location, purpose and research-paper options and keeps paper citations", async () => {
    let requestUrl = "";
    const sources = await searchTinyFishWeb("free will review", "key", {
      language: "en",
      location: "us",
      domainType: "research_paper",
      purpose: "Find scholarly literature",
      fetchImpl: (async (url: string | URL | Request) => {
        requestUrl = String(url);
        return new Response(JSON.stringify({
          results: [{
            title: "Free will and the brain",
            url: "https://doi.org/10.1/x",
            authors: ["A. Author", "B. Author", "C. Author", "D. Author"],
            venue: "Neuron",
            year: 2021,
            snippet: "A review.",
          }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    const params = new URL(requestUrl).searchParams;
    expect(params.get("language")).toBe("en");
    expect(params.get("location")).toBe("US");
    expect(params.get("domain_type")).toBe("research_paper");
    expect(params.get("purpose")).toBe("Find scholarly literature");
    expect(sources[0]).toMatchObject({
      provider: "TinyFish research papers",
      snippet: "A. Author, B. Author, C. Author et al. · Neuron · 2021 — A review.",
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
