import { describe, expect, test } from "bun:test";
import { bottomSpacerHeight } from "./scroll-anchor";

describe("bottomSpacerHeight", () => {
  test("adds room when the new message is shorter than the viewport", () => {
    expect(bottomSpacerHeight({ targetOffset: 2000, clientHeight: 800, contentHeight: 2300 })).toBe(500);
  });

  test("adds nothing when the content already reaches past the viewport", () => {
    expect(bottomSpacerHeight({ targetOffset: 2000, clientHeight: 800, contentHeight: 3500 })).toBe(0);
  });

  test("rounds up fractional layout values", () => {
    expect(bottomSpacerHeight({ targetOffset: 100.4, clientHeight: 800, contentHeight: 900 })).toBe(1);
  });
});
