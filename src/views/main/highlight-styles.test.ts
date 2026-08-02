import { describe, expect, test } from "bun:test";
import { DEFAULT_SHORTCUT_HIGHLIGHT_STYLE, HIGHLIGHT_STYLE_OPTIONS } from "./highlight-styles";

describe("highlight styles", () => {
  test("keeps the U shortcut mapped to a red underline", () => {
    expect(DEFAULT_SHORTCUT_HIGHLIGHT_STYLE).toBe("red-underline");
  });

  test("offers three fluorescent colors and the shortcut underline in the picker", () => {
    expect(HIGHLIGHT_STYLE_OPTIONS.map((option) => option.style)).toEqual([
      "marker-yellow",
      "marker-green",
      "marker-blue",
      "red-underline",
    ]);
  });
});
