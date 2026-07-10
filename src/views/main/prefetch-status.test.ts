import { describe, expect, test } from "bun:test";
import type { LearningMessageBatchStatus, TutorPrefetchStatus } from "../../shared/tutor-types";
import {
  continuePrefetchStateForPreparedRoute,
  continuePrefetchStateForSession,
  continueReadyFocusKey,
  continueReadyFocusKeyForPreparedRoute,
  hasPreparedBatchMessage,
  nextPrefetchStatusForSession,
} from "./prefetch-status";
import type { LearningMessageSetSummary } from "../../shared/tutor-types";

function status(sessionId: string, state: TutorPrefetchStatus["status"]): TutorPrefetchStatus {
  return { sessionId, kind: "default_continue", status: state, updatedAt: Date.now() };
}

function batch(sessionId: string, visiblePreparedRemaining: number): LearningMessageBatchStatus {
  return {
    sessionId,
    materialId: "material-1",
    runId: "run-1",
    status: visiblePreparedRemaining > 0 ? "ready" : "idle",
    preparedCount: visiblePreparedRemaining,
    visiblePreparedRemaining,
    completedSteps: visiblePreparedRemaining,
    totalSteps: visiblePreparedRemaining,
    updatedAt: Date.now(),
    error: null,
  };
}

function messageSet(overrides: Partial<LearningMessageSetSummary> = {}): LearningMessageSetSummary {
  return {
    id: "set-1",
    materialId: "material-1",
    status: "ready",
    provider: "ollama",
    model: "model-1",
    tutorLanguage: "ko",
    learningLevel: "medium",
    completedMessages: 10,
    totalMessages: 10,
    nextRouteIndex: 10,
    createdAt: 100,
    updatedAt: 200,
    error: null,
    ...overrides,
  };
}

describe("prefetch status session guard", () => {
  test("ignores incoming status when there is no active session", () => {
    const current = status("current", "ready");
    expect(nextPrefetchStatusForSession(current, status("other", "generating"), null)).toBe(current);
  });

  test("ignores incoming status for a different active session", () => {
    const current = status("current", "ready");
    expect(nextPrefetchStatusForSession(current, status("other", "generating"), "current")).toBe(current);
  });

  test("accepts incoming status for the active session", () => {
    const incoming = status("current", "generating");
    expect(nextPrefetchStatusForSession(null, incoming, "current")).toBe(incoming);
  });
});

describe("continue prefetch state", () => {
  test("treats prepared batch messages as ready for the active session", () => {
    expect(hasPreparedBatchMessage(batch("current", 2), "current")).toBe(true);
    expect(continuePrefetchStateForSession(status("current", "generating"), batch("current", 2), "current")).toBe("ready");
  });

  test("ignores prepared batch messages from another session", () => {
    expect(hasPreparedBatchMessage(batch("other", 2), "current")).toBe(false);
    expect(continuePrefetchStateForSession(status("current", "generating"), batch("other", 2), "current")).toBe("generating");
  });

  test("creates a focus key for prepared batch messages", () => {
    const batchStatus = { ...batch("current", 2), runId: "run-42", updatedAt: 1234 };
    expect(continueReadyFocusKey(status("current", "generating"), batchStatus, "current")).toBe("batch:current:run-42:2:1234");
  });

  test("creates a focus key for ready default prefetch", () => {
    expect(continueReadyFocusKey({ ...status("current", "ready"), updatedAt: 5678 }, null, "current")).toBe("prefetch:current:5678");
  });

  test("does not create a focus key for non-ready sessions", () => {
    expect(continueReadyFocusKey(status("current", "generating"), batch("other", 2), "current")).toBeNull();
  });
});

describe("prepared route autofocus", () => {
  test("treats unread message-set messages as a ready continue action", () => {
    expect(continuePrefetchStateForPreparedRoute(status("current", "generating"), messageSet(), 3, "current")).toBe("ready");
  });

  test("falls back to a ready legacy prefetch when no prepared route message exists", () => {
    expect(continuePrefetchStateForPreparedRoute(status("current", "ready"), null, 0, "current")).toBe("ready");
  });

  test("ignores a ready legacy prefetch from another session", () => {
    expect(continuePrefetchStateForPreparedRoute(status("other", "ready"), null, 0, "current")).toBe("idle");
  });

  test("changes the focus key after continuing to a new assistant message", () => {
    const base = {
      prefetchStatus: null,
      messageSet: messageSet(),
      activeSessionId: "session-1",
      lastRevealedRouteIndex: 2,
      unreadPreparedMessages: 7,
      action: "continue" as const,
    };
    const before = continueReadyFocusKeyForPreparedRoute({ ...base, latestAssistantId: "assistant-1" });
    const after = continueReadyFocusKeyForPreparedRoute({
      ...base,
      lastRevealedRouteIndex: 3,
      unreadPreparedMessages: 6,
      latestAssistantId: "assistant-2",
    });

    expect(before).not.toBe(after);
  });

  test("changes the focus key when a detour turns continue into return to progress", () => {
    const base = {
      prefetchStatus: null,
      messageSet: messageSet(),
      activeSessionId: "session-1",
      lastRevealedRouteIndex: 2,
      unreadPreparedMessages: 7,
      latestAssistantId: "assistant-detour",
    };

    expect(continueReadyFocusKeyForPreparedRoute({ ...base, action: "continue" })).not.toBe(
      continueReadyFocusKeyForPreparedRoute({ ...base, action: "return" })
    );
  });
});
