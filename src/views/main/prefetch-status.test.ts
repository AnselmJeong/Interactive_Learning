import { describe, expect, test } from "bun:test";
import type { LearningMessageBatchStatus, TutorPrefetchStatus } from "../../shared/tutor-types";
import { continuePrefetchStateForSession, continueReadyFocusKey, hasPreparedBatchMessage, nextPrefetchStatusForSession } from "./prefetch-status";

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
