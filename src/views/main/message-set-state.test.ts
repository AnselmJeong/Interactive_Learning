import { describe, expect, test } from "bun:test";
import type { LearningMessageSetSummary } from "../../shared/tutor-types";
import { isMessageSetPreparationComplete } from "./message-set-state";

function messageSet(overrides: Partial<LearningMessageSetSummary> = {}): LearningMessageSetSummary {
  return {
    id: "set-1",
    materialId: "material-1",
    status: "partial",
    provider: "openai",
    model: "model-1",
    tutorLanguage: "ko",
    learningLevel: "medium",
    totalMessages: 160,
    completedMessages: 160,
    nextRouteIndex: 160,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("prepared message completion", () => {
  test("treats a full partial set as complete for learner-facing actions", () => {
    expect(isMessageSetPreparationComplete(messageSet())).toBe(true);
  });

  test("keeps an incomplete partial set resumable", () => {
    expect(isMessageSetPreparationComplete(messageSet({ completedMessages: 159 }))).toBe(false);
  });

  test("does not call an unknown-size set complete", () => {
    expect(isMessageSetPreparationComplete(messageSet({ totalMessages: 0, completedMessages: 0 }))).toBe(false);
  });
});
