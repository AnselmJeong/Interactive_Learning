export type SessionDeletionTransition =
  | { kind: "keep_current" }
  | { kind: "load_previous"; sessionId: string }
  | { kind: "start_new" };

export function sessionDeletionTransition(
  activeSessionId: string | null | undefined,
  deletedSessionId: string,
  remainingSessionIds: string[]
): SessionDeletionTransition {
  if (activeSessionId && activeSessionId !== deletedSessionId) return { kind: "keep_current" };
  const previousSessionId = remainingSessionIds[0];
  return previousSessionId
    ? { kind: "load_previous", sessionId: previousSessionId }
    : { kind: "start_new" };
}
