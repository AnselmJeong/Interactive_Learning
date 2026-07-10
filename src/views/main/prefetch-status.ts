import type { LearningMessageBatchStatus, LearningMessageSetSummary, TutorPrefetchStatus } from "../../shared/tutor-types";

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

export function continuePrefetchStateForPreparedRoute(
  prefetchStatus: TutorPrefetchStatus | null,
  messageSet: LearningMessageSetSummary | null,
  unreadPreparedMessages: number,
  activeSessionId: string | null | undefined,
): ContinuePrefetchState {
  if (unreadPreparedMessages > 0) return "ready";
  const currentPrefetchStatus = prefetchStatus && prefetchStatus.sessionId === activeSessionId ? prefetchStatus.status : null;
  if (currentPrefetchStatus === "ready") return "ready";
  if (messageSet?.status === "generating" || messageSet?.status === "queued" || messageSet?.status === "interrupted") {
    return "generating";
  }
  if (messageSet?.status === "failed" || messageSet?.status === "waiting_for_provider") return "failed";
  if (currentPrefetchStatus === "generating" || currentPrefetchStatus === "failed") {
    return currentPrefetchStatus;
  }
  return "idle";
}

export function continueReadyFocusKeyForPreparedRoute(input: {
  prefetchStatus: TutorPrefetchStatus | null;
  messageSet: LearningMessageSetSummary | null;
  activeSessionId: string | null | undefined;
  lastRevealedRouteIndex: number;
  unreadPreparedMessages: number;
  latestAssistantId: string | null;
  action: "continue" | "return";
}) {
  const { prefetchStatus, messageSet, activeSessionId, lastRevealedRouteIndex, unreadPreparedMessages, latestAssistantId, action } = input;
  if (!activeSessionId || !latestAssistantId) return null;
  if (messageSet && unreadPreparedMessages > 0) {
    return [
      "message-set",
      activeSessionId,
      messageSet.id,
      lastRevealedRouteIndex,
      unreadPreparedMessages,
      latestAssistantId,
      action,
    ].join(":");
  }
  if (prefetchStatus?.sessionId === activeSessionId && prefetchStatus.status === "ready") {
    return ["prefetch", activeSessionId, prefetchStatus.updatedAt ?? "ready", latestAssistantId, action].join(":");
  }
  return null;
}
