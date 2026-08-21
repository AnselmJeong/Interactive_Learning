import { describe, expect, test } from "bun:test";
import { stripLeadingFigureCaption, stripMarkdownImageTokens } from "./markdown-image-text";

describe("stripMarkdownImageTokens", () => {
  test("removes a leading file image token but preserves prose on the same line", () => {
    expect(stripMarkdownImageTokens(
      "![](file:///Volumes/Aquatope/_LEARNIE_/source/assets/fig-0001.png) The earth to be spann'd, connected by network."
    )).toBe("The earth to be spann'd, connected by network.");
  });

  test("removes image-only Markdown including alt text", () => {
    expect(stripMarkdownImageTokens("![Figure 3.2](assets/fig-0002.png)")).toBe("");
  });

  test("preserves ordinary Markdown links", () => {
    const text = "Read [the source](https://example.com/source).";
    expect(stripMarkdownImageTokens(text)).toBe(text);
  });
});

describe("stripLeadingFigureCaption", () => {
  test("removes a fused PDF caption but preserves the following body prose", () => {
    expect(stripLeadingFigureCaption(
      "| | | Figure 4 : Example decision problem (color perception). A good general introduction follows."
    )).toBe("A good general introduction follows.");
  });

  test("preserves an ordinary prose reference to a figure", () => {
    const text = "Figure 4 shows how the posterior changes with the signal.";
    expect(stripLeadingFigureCaption(text)).toBe(text);
  });
});
