import { describe, expect, test } from "bun:test";
import type { SourceFigure } from "../../shared/artifact-types";
import { stripFigureMarkdown } from "./figure-text";

const figure = {
  id: "figure-opening",
  assetUrl: "file:///Volumes/Aquatope/_LEARNIE_/source/assets/fig-0001.png",
  caption: "Figure from source",
} as SourceFigure;

describe("stripFigureMarkdown", () => {
  test("keeps prose that follows a matching image on the same line", () => {
    const content = `![](${figure.assetUrl}) The earth to be spann'd, connected by network.`;
    expect(stripFigureMarkdown(content, [figure])).toBe("The earth to be spann'd, connected by network.");
  });

  test("removes image tokens even when no figure metadata is attached", () => {
    expect(stripFigureMarkdown(`![](${figure.assetUrl}) Quoted prose`, [])).toBe("Quoted prose");
  });
});
