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
  test("keeps lookup optional when no exact match exists", async () => {
    const service = new BookMetadataService(async () => new Response(JSON.stringify({ items: [{ id: "near", volumeInfo: { title: "Near" } }] }), { status: 200 }));
    await expect(service.lookup("9780306406157")).resolves.toBeNull();
  });
  test("extracts a valid filename ISBN before querying", () => {
    expect(new BookMetadataService().isbnFromFilename("book ISBN 978-0-306-40615-7.pdf")).toEqual({ value: "9780306406157", kind: "isbn13" });
  });
});
