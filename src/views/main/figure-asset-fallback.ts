export type FigureAssetFallbackAction = "start" | "wait" | "failed";

export function figureAssetFallbackAction(
  cacheKey: string,
  attemptedCacheKey: string | null,
  loadingCacheKey: string | null
): FigureAssetFallbackAction {
  if (loadingCacheKey === cacheKey) return "wait";
  if (attemptedCacheKey === cacheKey) return "failed";
  return "start";
}
