import { describe, expect, test } from "bun:test";
import { searchOllamaWeb } from "./ollama-web-search-service";

describe("Ollama web search service", () => {
  test("authenticates, bounds results, and normalizes safe source metadata", async () => {
    let request: RequestInit | undefined;
    const sources = await searchOllamaWeb("  current   evidence  ", "secret-key", {
      maxResults: 99,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        request = init;
        return new Response(JSON.stringify({
          results: [
            { title: "Useful result", url: "https://www.example.com/article", content: "  Relevant   excerpt. " },
            { title: "Unsafe result", url: "javascript:alert(1)", content: "ignored" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    expect(request?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret-key",
    });
    expect(JSON.parse(String(request?.body))).toEqual({ query: "current evidence", max_results: 10 });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "S1",
      title: "Useful result",
      url: "https://www.example.com/article",
      provider: "Web search",
      snippet: "Relevant excerpt.",
    });
  });

  test("requires a saved Ollama API key", async () => {
    await expect(searchOllamaWeb("query", "")).rejects.toThrow("Ollama API key");
  });

  test("keeps response details in web search failures", async () => {
    await expect(searchOllamaWeb("query", "key", {
      fetchImpl: (async () => new Response('{"error":"quota exceeded"}', { status: 429 })) as unknown as typeof fetch,
    })).rejects.toThrow('429): {"error":"quota exceeded"}');
  });

  test("reports malformed success responses clearly", async () => {
    await expect(searchOllamaWeb("query", "key", {
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    })).rejects.toThrow("올바르지 않은 응답");
  });
});
