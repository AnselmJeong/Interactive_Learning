import type { LearningMessageBatchStatus, TutorPrefetchStatus } from "../../shared/tutor-types";

export type ContinuePrefetchState = "idle" | "generating" | "ready" | "failed";

export function nextPrefetchStatusForSession(
  current: TutorPrefetchStatus | null,
  incoming: TutorPrefetchStatus,
  activeSessionId: string | null | undefined,
) {
  if (!activeSessionId || incoming.sessionId !== activeSessionId) return current;
  return incoming;
}

export function hasPreparedBatchMessage(
  batchStatus: LearningMessageBatchStatus | null,
  activeSessionId: string | null | undefined,
) {
  return Boolean(
    activeSessionId &&
      batchStatus?.sessionId === activeSessionId &&
      batchStatus.visiblePreparedRemaining > 0,
  );
}

export function continuePrefetchStateForSession(
  prefetchStatus: TutorPrefetchStatus | null,
  batchStatus: LearningMessageBatchStatus | null,
  activeSessionId: string | null | undefined,
): ContinuePrefetchState {
  if (hasPreparedBatchMessage(batchStatus, activeSessionId)) return "ready";
  if (prefetchStatus?.status === "generating" || prefetchStatus?.status === "ready" || prefetchStatus?.status === "failed") {
    return prefetchStatus.status;
  }
  return "idle";
}

export function continueReadyFocusKey(
  prefetchStatus: TutorPrefetchStatus | null,
  batchStatus: LearningMessageBatchStatus | null,
  activeSessionId: string | null | undefined,
) {
  if (!activeSessionId) return null;
  if (hasPreparedBatchMessage(batchStatus, activeSessionId)) {
    return [
      "batch",
      activeSessionId,
      batchStatus?.runId || "run",
      batchStatus?.visiblePreparedRemaining ?? 0,
      batchStatus?.updatedAt ?? "ready",
    ].join(":");
  }
  if (prefetchStatus?.sessionId === activeSessionId && prefetchStatus.status === "ready") {
    return ["prefetch", activeSessionId, prefetchStatus.updatedAt ?? "ready"].join(":");
  }
  return null;
}
