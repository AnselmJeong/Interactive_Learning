import type { LearningMessageSetSummary } from "../../shared/tutor-types";

export function isMessageSetPreparationComplete(messageSet: LearningMessageSetSummary | null | undefined) {
  return Boolean(
    messageSet
      && messageSet.totalMessages > 0
      && messageSet.completedMessages >= messageSet.totalMessages,
  );
}
