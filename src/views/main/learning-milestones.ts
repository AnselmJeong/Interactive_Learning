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
