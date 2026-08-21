import { describe, expect, test } from "bun:test";
import { restoreLegacyDisplayMathFlow, splitMarkdownPipes } from "./markdown-pipes";

describe("Markdown structural pipes", () => {
  test("does not split conditional-probability pipes inside display math", () => {
    const equation = String.raw`$$p(s|x) = \frac{p(x|s)\,p(s)}{p(x)}$$`;
    expect(splitMarkdownPipes(equation)).toEqual([equation]);
  });

  test("still splits structural pipes around protected inline math", () => {
    expect(splitMarkdownPipes(String.raw`relation | $p(x|s)$ | explanation`)).toEqual(["relation ", " $p(x|s)$ ", " explanation"]);
  });

  test("reassembles a legacy math flow without changing an ordinary flow", () => {
    expect(restoreLegacyDisplayMathFlow(
      "$$p(s",
      [String.raw`x) = \frac{p(x`, String.raw`s)\,p(s)}{p(x)}$$`],
    )).toBe(String.raw`$$p(s|x) = \frac{p(x|s)\,p(s)}{p(x)}$$`);
    expect(restoreLegacyDisplayMathFlow("추론 과정", ["관찰", "갱신"])).toBeNull();
  });
});
