import { describe, expect, test } from "bun:test";
import { normalizeSelectedPaths } from "./file-dialog-selection";

function exists(paths: string[]) {
  const available = new Set(paths);
  return (path: string) => available.has(path);
}

describe("file dialog selection normalization", () => {
  test("keeps a single selected path intact when the filename contains semicolons and commas", () => {
    const path = "/Books/Invisible Illness; Covid, CFS.pdf";

    expect(normalizeSelectedPaths(path, exists([path]))).toEqual([path]);
  });

  test("accepts array selections without delimiter parsing", () => {
    const first = "/Books/Invisible Illness; Covid, CFS.pdf";
    const second = "/Books/Other.pdf";

    expect(normalizeSelectedPaths([first, second], exists([first, second]))).toEqual([first, second]);
  });

  test("preserves the legacy comma-delimited fallback when the full string is not a path", () => {
    const first = "/Books/First.pdf";
    const second = "/Books/Second.pdf";

    expect(normalizeSelectedPaths(`${first}, ${second}`, exists([first, second]))).toEqual([first, second]);
  });
});
