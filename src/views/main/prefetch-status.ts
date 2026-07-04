import type { TutorPrefetchStatus } from "../../shared/tutor-types";

export function nextPrefetchStatusForSession(
  current: TutorPrefetchStatus | null,
  incoming: TutorPrefetchStatus,
  activeSessionId: string | null | undefined,
) {
  if (!activeSessionId || incoming.sessionId !== activeSessionId) return current;
  return incoming;
}
