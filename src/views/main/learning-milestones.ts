export const LEARNING_MILESTONES = [30, 50, 85, 100] as const;

export type LearningMilestone = (typeof LEARNING_MILESTONES)[number];

export const LEARNING_MILESTONE_COPY: Record<LearningMilestone, { title: string; detail: string }> = {
  30: { title: "첫 고비 통과", detail: "이제 흐름이 잡히기 시작했어요" },
  50: { title: "반환점 도착", detail: "절반의 지도가 펼쳐졌어요" },
  85: { title: "끝이 보여요", detail: "핵심 연결만 남았습니다" },
  100: { title: "완주", detail: "한 권의 흐름을 완성했어요" },
};

export function crossedLearningMilestone(previousPercent: number, currentPercent: number): LearningMilestone | null {
  if (currentPercent <= previousPercent) return null;
  const crossed = LEARNING_MILESTONES.filter(
    (milestone) => previousPercent < milestone && currentPercent >= milestone,
  );
  return crossed.at(-1) || null;
}
