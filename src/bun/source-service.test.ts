import { describe, expect, test } from "bun:test";
import { normalizeMarkdownChunks, sanitizeHeadingPath } from "./source-service";

describe("markdown chunk heading paths", () => {
  test("does not create sparse heading paths when a document starts at h2", () => {
    const chunks = normalizeMarkdownChunks("source", "## Opening\n\nFirst body.");
    expect(chunks[0]?.headingPath).toEqual(["Opening"]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("does not create sparse heading paths when heading levels are skipped", () => {
    const chunks = normalizeMarkdownChunks("source", "# Top\n\nIntro.\n\n### Deep\n\nDetail.");
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([["Top"], ["Top", "Deep"]]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("sanitizes stored null and non-string heading path parts", () => {
    expect(sanitizeHeadingPath(["Top", null, 42, "  Deep  ", ""])).toEqual(["Top", "Deep"]);
  });
});
