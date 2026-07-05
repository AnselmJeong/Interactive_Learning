import { describe, expect, test } from "bun:test";
import { prefetchConsumeWaitMs, tutorLanguageInstruction } from "./tutor-service";

describe("prefetch consume wait policy", () => {
  test("does not wait the full consume window when provider timeout is nearly exhausted", () => {
    expect(prefetchConsumeWaitMs(0, 115_000, 100_000, 120_000)).toBe(6_000);
  });

  test("uses the consume cap for a fresh prefetch", () => {
    expect(prefetchConsumeWaitMs(0, 1_000, 100_000, 120_000)).toBe(100_000);
  });
});

describe("tutor language instruction", () => {
  test("requires Korean for every learner-facing JSON field", () => {
    const instruction = tutorLanguageInstruction("ko");

    expect(instruction).toContain("Reply in Korean");
    expect(instruction).toContain("every learner-facing JSON field");
    expect(instruction).toContain("Do not switch to English");
  });

  test("preserves source schema while keeping original spellings visible", () => {
    const instruction = tutorLanguageInstruction("ko");

    expect(instruction).toContain("Keep JSON keys");
    expect(instruction).toContain("source_quote.quote");
    expect(instruction).toContain("original spelling in parentheses");
  });
});
