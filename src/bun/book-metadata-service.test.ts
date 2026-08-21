import { describe, expect, test } from "bun:test";
import { BookMetadataService, selectExactIsbnVolume } from "./book-metadata-service";

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
  test("uses a filename ISBN and never falls back to a title-only Google Books query", async () => {
    let requestUrl = "";
    const service = new BookMetadataService(async (input) => {
      requestUrl = input.toString();
      return new Response(JSON.stringify({ items: [{ id: "volume", volumeInfo: { title: "Exact", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }] } }] }), { status: 200 });
    });
    const result = await service.lookupByFilename("book-ISBN-978-0-306-40615-7.pdf", "test-key");
    const url = new URL(requestUrl);
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("q")).toBe("isbn:9780306406157");
    expect(result?.provider).toBe("google_books");
    await expect(service.lookupByFilename("dimensions-and-contexts-of-selfhood.pdf", "test-key")).resolves.toBeNull();
  });
  test("manual ISBN search keeps only the exact ISBN result", async () => {
    const service = new BookMetadataService(async () => new Response(JSON.stringify({ items: [
      { id: "near", volumeInfo: { title: "Near", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000000" }] } },
      { id: "exact", volumeInfo: { title: "Exact", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780306406157" }] } },
    ] }), { status: 200 }));
    await expect(service.searchByIsbn("978-0-306-40615-7", "test-key")).resolves.toMatchObject([{ providerRecordId: "exact" }]);
  });
});
