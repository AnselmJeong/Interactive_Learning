import { describe, expect, test } from "bun:test";
import { searchBraveImages } from "./brave-image-search-service";

describe("Brave image search", () => {
  test("uses strict global image search and maps proxied thumbnails with source pages", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("https://api.search.brave.com/")) {
        return Response.json({
          type: "images",
          query: { original: "social contract", altered: null },
          results: [
            {
              title: "The Social Contract",
              url: "https://plato.stanford.edu/entries/contractarianism/",
              source: "plato.stanford.edu",
              thumbnail: { src: "https://imgs.search.brave.com/thumb-a", width: 500, height: 300 },
              properties: { url: "https://plato.stanford.edu/media/social-contract.jpg", width: 1600, height: 960 },
              confidence: "high",
            },
          ],
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;

    const images = await searchBraveImages("social contract", "secret-key", fetchImpl);

    const requestUrl = new URL(requests[0]!.url);
    expect(requestUrl.searchParams.get("country")).toBe("ALL");
    expect(requestUrl.searchParams.get("safesearch")).toBe("strict");
    expect(requestUrl.searchParams.get("spellcheck")).toBe("true");
    expect(new Headers(requests[0]!.init?.headers).get("x-subscription-token")).toBe("secret-key");
    expect(images).toEqual([{
      title: "The Social Contract",
      thumbnailUrl: "data:image/jpeg;base64,AQID",
      imageUrl: "https://plato.stanford.edu/media/social-contract.jpg",
      pageUrl: "https://plato.stanford.edu/entries/contractarianism/",
      sourceTitle: "plato.stanford.edu",
      provider: "brave",
      width: 1600,
      height: 960,
    }]);
  });

  test("does not call Brave when no API key is configured", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;

    expect(await searchBraveImages("photosynthesis", "", fetchImpl)).toEqual([]);
    expect(called).toBe(false);
  });
});
