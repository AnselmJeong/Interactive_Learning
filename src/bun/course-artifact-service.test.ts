import { describe, expect, test } from "bun:test";
import { canReuseMaterialForGeneration, materialGenerationKey } from "./course-artifact-service";

describe("material generation dedupe", () => {
  test("does not reuse interrupted generating material rows", () => {
    expect(canReuseMaterialForGeneration("ready")).toBe(true);
    expect(canReuseMaterialForGeneration("generating")).toBe(false);
    expect(canReuseMaterialForGeneration("failed")).toBe(false);
  });

  test("uses a stable key for the same project and source set", () => {
    expect(materialGenerationKey("project-a", ["source-b", "source-a", "source-a"])).toBe(
      materialGenerationKey("project-a", ["source-a", "source-b"])
    );
    expect(materialGenerationKey("project-b", ["source-a", "source-b"])).not.toBe(materialGenerationKey("project-a", ["source-a", "source-b"]));
  });
});
