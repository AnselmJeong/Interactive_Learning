export const LEARNING_MILESTONES = [30, 50, 85, 100] as const;

export type LearningMilestone = (typeof LEARNING_MILESTONES)[number];

export function crossedLearningMilestone(previousPercent: number, currentPercent: number): LearningMilestone | null {
  if (currentPercent <= previousPercent) return null;
  return LEARNING_MILESTONES.filter(
    (milestone) => previousPercent < milestone && currentPercent >= milestone,
  ).at(-1) || null;
}

export function reachedLearningMilestone(progressPercent: number): LearningMilestone | null {
  return LEARNING_MILESTONES.filter((milestone) => progressPercent >= milestone).at(-1) || null;
}

// The bar counts the chunk being taught as "reached", so entering the last chunk (or rounding
// 199/200) would otherwise read 100% and fire the completion celebration early. 100% is reserved
// for every chunk actually being covered.
export function learningProgressPercent(reachedChunks: number, coveredChunks: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0;
  if (coveredChunks >= totalChunks) return 100;
  return Math.min(99, Math.round((Math.min(reachedChunks, totalChunks) / totalChunks) * 100));
}
