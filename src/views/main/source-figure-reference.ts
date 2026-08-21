import type { SourceFigure } from "../../shared/artifact-types";

const NUMBERED_FIGURE_REFERENCE = /(?:figure|fig\.?|그림)\s*(\d+(?:\.\d+)*)(?!\d|\.\d)/giu;

function normalizedFigureNumber(value: string) {
  return value
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
}

export function numberedFigureReferences(text: string) {
  return Array.from(
    text.matchAll(NUMBERED_FIGURE_REFERENCE),
    (match) => normalizedFigureNumber(match[1] || "")
  ).filter(Boolean);
}

function figureNumbers(figure: Pick<SourceFigure, "title" | "caption">) {
  return new Set(numberedFigureReferences([figure.title, figure.caption].filter(Boolean).join("\n")));
}

export function sourceFiguresReferencedByText<T extends Pick<SourceFigure, "title" | "caption">>(
  text: string,
  figures: readonly T[]
) {
  const mentioned = new Set(numberedFigureReferences(text));
  if (!mentioned.size) return [];
  return figures.filter((figure) => Array.from(figureNumbers(figure)).some((number) => mentioned.has(number)));
}
