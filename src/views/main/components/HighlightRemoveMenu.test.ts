import { describe, expect, test } from "bun:test";
import { highlightRemoveMenuPosition } from "./HighlightRemoveMenu";

describe("highlight remove menu position", () => {
  test("opens below a highlight when there is room", () => {
    expect(highlightRemoveMenuPosition({ top: 100, bottom: 120, left: 200, width: 80 }, 800, 600)).toEqual({
      left: 240,
      top: 130,
      placement: "below",
    });
  });

  test("opens above a highlight near the bottom edge", () => {
    expect(highlightRemoveMenuPosition({ top: 550, bottom: 570, left: 200, width: 80 }, 800, 600)).toEqual({
      left: 240,
      top: 498,
      placement: "above",
    });
  });

  test("keeps the menu inside narrow viewport edges", () => {
    expect(highlightRemoveMenuPosition({ top: 100, bottom: 120, left: 2, width: 10 }, 320, 600).left).toBe(75);
    expect(highlightRemoveMenuPosition({ top: 100, bottom: 120, left: 310, width: 10 }, 320, 600).left).toBe(245);
  });
});
