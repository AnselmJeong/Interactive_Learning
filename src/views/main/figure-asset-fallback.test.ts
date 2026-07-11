import { describe, expect, test } from "bun:test";
import { figureAssetFallbackAction } from "./figure-asset-fallback";

describe("source figure asset fallback", () => {
  test("coalesces duplicate error and completion checks while RPC fallback is loading", () => {
    expect(figureAssetFallbackAction("material:figure", null, null)).toBe("start");
    expect(figureAssetFallbackAction("material:figure", "material:figure", "material:figure")).toBe("wait");
  });

  test("reports failure only after the one fallback attempt has finished", () => {
    expect(figureAssetFallbackAction("material:figure", "material:figure", null)).toBe("failed");
  });

  test("does not let an earlier figure request block a newly rendered figure", () => {
    expect(figureAssetFallbackAction("material:figure-2", "material:figure-1", "material:figure-1")).toBe("start");
  });
});
