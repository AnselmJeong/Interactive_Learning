import type { SourceFigure } from "../../shared/artifact-types";

const MIN_AUTO_RENDER_MAX_EDGE_PX = 180;
const MIN_AUTO_RENDER_AREA_PX = 20_000;
const UNLABELED_ICON_MAX_EDGE_PX = 1200;
const UNLABELED_ICON_MAX_ASPECT_RATIO = 1.35;

function hasCaption(figure: SourceFigure) {
  return Boolean(figure.caption?.trim());
}

function hasKnownSize(figure: SourceFigure): figure is SourceFigure & { width: number; height: number } {
  return typeof figure.width === "number" && typeof figure.height === "number" && figure.width > 0 && figure.height > 0;
}

function isUnlabeledIconLike(figure: SourceFigure) {
  if (hasCaption(figure) || !hasKnownSize(figure)) return false;
  const maxEdge = Math.max(figure.width, figure.height);
  const minEdge = Math.min(figure.width, figure.height);
  const area = figure.width * figure.height;
  const aspectRatio = maxEdge / minEdge;

  return (
    maxEdge < MIN_AUTO_RENDER_MAX_EDGE_PX ||
    area < MIN_AUTO_RENDER_AREA_PX ||
    (maxEdge <= UNLABELED_ICON_MAX_EDGE_PX && aspectRatio <= UNLABELED_ICON_MAX_ASPECT_RATIO)
  );
}

export function shouldAutoRenderSourceFigure(figure: SourceFigure) {
  return !isUnlabeledIconLike(figure);
}
