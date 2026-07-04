import { describe, expect, test } from "bun:test";
import { canReuseMaterialForGeneration } from "./course-artifact-service";

describe("material generation dedupe", () => {
  test("does not reuse interrupted generating material rows", () => {
    expect(canReuseMaterialForGeneration("ready")).toBe(true);
    expect(canReuseMaterialForGeneration("generating")).toBe(false);
    expect(canReuseMaterialForGeneration("failed")).toBe(false);
  });
});
