import { describe, expect, test } from "bun:test";
import { normalizeLearningLevel, tutorLevelInstruction } from "./learning-levels";

describe("learning levels", () => {
  test("normalizes unknown values to medium", () => {
    expect(normalizeLearningLevel("casual")).toBe("casual");
    expect(normalizeLearningLevel("hard")).toBe("hard");
    expect(normalizeLearningLevel("unknown")).toBe("medium");
    expect(normalizeLearningLevel(null)).toBe("medium");
  });

  test("hard profile preserves invariant guard while allowing rigor", () => {
    const instruction = tutorLevelInstruction("hard");

    expect(instruction).toContain("LEARNER LEVEL - HARD");
    expect(instruction).toContain("technical and original-language terms");
    expect(instruction).toContain("It never overrides the invariants");
    expect(instruction).toContain("return the required schema");
  });

  test("casual profile preserves invariant guard while asking for lighter pacing", () => {
    const instruction = tutorLevelInstruction("casual");

    expect(instruction).toContain("LEARNER LEVEL - CASUAL");
    expect(instruction).toContain("Minimize jargon");
    expect(instruction).toContain("short and breezy");
    expect(instruction).toContain("teach one source chunk at a time");
  });
});
