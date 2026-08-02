import { describe, expect, test } from "bun:test";
import { BookMetadataService, selectConfidentTitleVolume, selectExactIsbnVolume, titleQueryFromFilename } from "./book-metadata-service";

describe("book metadata lookup", () => {
  test("uses an exact ISBN match rather than the first Google Books result", () => {
    const volumes = [
      { id: "near", volumeInfo: { title: "Near", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000000" }] } },
      { id: "exact", volumeInfo: { title: "Exact", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }] } },
    ];
    expect(selectExactIsbnVolume(volumes, "9780306406157")?.id).toBe("exact");
  });
  test("canonicalizes provider ISBN punctuation before exact matching", () => {
    const volumes = [
      { id: "exact", volumeInfo: { title: "Exact", industryIdentifiers: [{ type: "ISBN_13", identifier: "978-0-306-40615-7" }] } },
    ];
    expect(selectExactIsbnVolume(volumes, "9780306406157")?.id).toBe("exact");
  });
  test("keeps lookup optional when no exact match exists", async () => {
    const service = new BookMetadataService(async () => new Response(JSON.stringify({ items: [{ id: "near", volumeInfo: { title: "Near" } }] }), { status: 200 }));
    await expect(service.lookupByIsbn("9780306406157", "test-key")).resolves.toBeNull();
  });
  test("extracts a valid filename ISBN before querying", () => {
    expect(new BookMetadataService().isbnFromFilename("book ISBN 978-0-306-40615-7.pdf")).toEqual({ value: "9780306406157", kind: "isbn13" });
  });
  test("uses a clean title query and accepts a strongly matching result", async () => {
    let requestUrl = "";
    const service = new BookMetadataService(async (input) => {
      requestUrl = input.toString();
      return new Response(JSON.stringify({ items: [{ id: "volume", volumeInfo: { title: "Dimensions and Contexts of Selfhood", imageLinks: { thumbnail: "http://books.google.test/cover.jpg" } } }] }), { status: 200 });
    });
    const result = await service.lookupByFilename("003-1-dimensions-and-contexts-of-selfhood.pdf", "test-key");
    const url = new URL(requestUrl);
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("q")).toBe("intitle:dimensions and contexts of selfhood");
    expect(result?.coverUrl).toBe("https://books.google.test/cover.jpg");
  });
  test("removes source ordering noise from title queries", () => {
    expect(titleQueryFromFilename("003-1-dimensions-and-contexts-of-selfhood.pdf")).toBe("dimensions and contexts of selfhood");
  });
  test("rejects a weakly matching first result instead of inventing bibliography", async () => {
    const service = new BookMetadataService(async () => new Response(JSON.stringify({ items: [
      { id: "wrong", volumeInfo: { title: "Racial Dimensions of Life Writing in Education" } },
    ] }), { status: 200 }));
    await expect(service.lookupByFilename("003-1-dimensions-and-contexts-of-selfhood.pdf", "test-key")).resolves.toBeNull();
  });
  test("requires substantial title overlap for a non-ISBN match", () => {
    expect(selectConfidentTitleVolume([
      { id: "wrong", volumeInfo: { title: "Racial Dimensions of Life Writing in Education" } },
      { id: "right", volumeInfo: { title: "The Idea of the Self", subtitle: "Thought and Experience in Western Europe since the Seventeenth Century" } },
    ], "The Idea of the Self Thought and Experience in Western Europe")).toMatchObject({ id: "right" });
  });
  test("manual title search returns candidates for the learner to choose", async () => {
    let requestUrl = "";
    const service = new BookMetadataService(async (input) => {
      requestUrl = input.toString();
      return new Response(JSON.stringify({ items: [
        { id: "first", volumeInfo: { title: "The Idea of the Self", subtitle: "An Earlier Edition" } },
        { id: "second", volumeInfo: { title: "The Idea of the Self", subtitle: "Thought and Experience in Western Europe" } },
      ] }), { status: 200 });
    });
    const results = await service.searchManually({ title: "The Idea of the Self" }, "test-key");
    expect(new URL(requestUrl).searchParams.get("q")).toBe("intitle:The Idea of the Self");
    expect(results.map((result) => result.providerVolumeId)).toEqual(["first", "second"]);
  });
  test("manual ISBN search keeps only the exact ISBN result", async () => {
    const service = new BookMetadataService(async () => new Response(JSON.stringify({ items: [
      { id: "near", volumeInfo: { title: "Near", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000000" }] } },
      { id: "exact", volumeInfo: { title: "Exact", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }] } },
    ] }), { status: 200 }));
    await expect(service.searchManually({ isbn: "978-0-306-40615-7" }, "test-key")).resolves.toMatchObject([{ providerVolumeId: "exact" }]);
  });
});
