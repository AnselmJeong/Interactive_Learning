import type { SourceFigure } from "./artifact-types";

export function canonicalFigureChunkId(
  figure: Pick<SourceFigure, "sourceChunkIds">,
  validChunkIds?: ReadonlySet<string>
) {
  if (!validChunkIds) return figure.sourceChunkIds[0] || null;
  return figure.sourceChunkIds.find((chunkId) => validChunkIds.has(chunkId)) || null;
}

export function groupFiguresByCanonicalChunk<T extends Pick<SourceFigure, "sourceChunkIds">>(
  figures: readonly T[],
  chunkIds: readonly string[]
) {
  const validChunkIds = new Set(chunkIds);
  const groups = new Map<string, T[]>();
  for (const figure of figures) {
    const chunkId = canonicalFigureChunkId(figure, validChunkIds);
    if (!chunkId) continue;
    const group = groups.get(chunkId) || [];
    group.push(figure);
    groups.set(chunkId, group);
  }
  return groups;
}
