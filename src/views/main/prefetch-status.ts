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
