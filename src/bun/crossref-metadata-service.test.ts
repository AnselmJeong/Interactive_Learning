import { describe, expect, test } from "bun:test";
import { CrossrefMetadataService } from "./crossref-metadata-service";
import { titleQueryFromFilename } from "./document-metadata-text";

function crossrefResponse(items: unknown[]) {
  return new Response(JSON.stringify({ message: { items } }), { status: 200 });
}

describe("Crossref article metadata", () => {
  test("searches by title and maps article-specific bibliography", async () => {
    let requestUrl = "";
    let userAgent = "";
    const service = new CrossrefMetadataService(async (input, init) => {
      requestUrl = input.toString();
      userAgent = new Headers(init?.headers).get("user-agent") || "";
      return crossrefResponse([{
        DOI: "10.5555/example.42",
        title: ["Interactive learning from feedback"],
        subtitle: ["A practical account"],
        author: [{ given: "Ada", family: "Lovelace" }, { name: "Research Group" }],
        publisher: "Example Press",
        "published-online": { "date-parts": [[2025, 7, 4]] },
        "container-title": ["Journal of Useful Systems"],
        language: "en",
      }]);
    });

    const results = await service.searchByTitle("Interactive learning from feedback");

    expect(new URL(requestUrl).searchParams.get("query.title")).toBe("Interactive learning from feedback");
    expect(new URL(requestUrl).searchParams.get("rows")).toBe("5");
    expect(userAgent).toContain("Learnie/0.10.0");
    expect(results).toMatchObject([{
      title: "Interactive learning from feedback",
      authors: ["Ada Lovelace", "Research Group"],
      journal: "Journal of Useful Systems",
      doi: "10.5555/example.42",
      publishedDate: "2025-07-04",
      provider: "crossref",
      providerRecordId: "10.5555/example.42",
    }]);
  });

  test("derives a clean user-editable search title from an imported filename", () => {
    expect(titleQueryFromFilename("003-1-dimensions-and-contexts-of-selfhood.pdf")).toBe("dimensions and contexts of selfhood");
  });

  test("reports Crossref rate limiting without hiding the provider", async () => {
    const service = new CrossrefMetadataService(async () => new Response("", { status: 429 }));
    await expect(service.searchByTitle("A paper title")).rejects.toThrow("Crossref 조회 요청이 많습니다");
  });
});
