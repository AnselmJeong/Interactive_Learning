import type { LookupResult, MaterialAnnotation, SourceFigure } from "../../shared/artifact-types";

const FIGURE_EXPLANATION_PROVIDER = "learnie.figure-explanation";

export function figureAnnotationSourceMeta(figure: SourceFigure, retrievedAt: string) {
  return [
    {
      title: figure.id,
      provider: FIGURE_EXPLANATION_PROVIDER,
      retrievedAt,
    },
  ];
}

export function isFigureExplanationAnnotation(annotation: MaterialAnnotation) {
  return annotation.kind === "lookup" && annotation.result.kind === "lookup" && annotation.sourceMeta.some((source) => source.provider === FIGURE_EXPLANATION_PROVIDER);
}

export function figureIdForExplanationAnnotation(annotation: MaterialAnnotation) {
  if (!isFigureExplanationAnnotation(annotation)) return null;
  return annotation.sourceMeta.find((source) => source.provider === FIGURE_EXPLANATION_PROVIDER)?.title || null;
}

export function figureExplanationLookupResult(figure: SourceFigure, explanation: string, model?: string): LookupResult {
  const retrievedAt = new Date().toISOString();
  const label = figure.caption?.trim() || figure.title || figure.locator || figure.id;
  return {
    kind: "lookup",
    title: "그림 설명",
    body: explanation,
    query: label,
    provider: "ai",
    model,
    sourceTitle: figure.title || undefined,
    retrievedAt,
    sourceMeta: figureAnnotationSourceMeta(figure, retrievedAt),
  };
}
