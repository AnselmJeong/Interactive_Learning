import { describe, expect, test } from "bun:test";
import type { TutorPrefetchStatus } from "../../shared/tutor-types";
import { nextPrefetchStatusForSession } from "./prefetch-status";

function status(sessionId: string, state: TutorPrefetchStatus["status"]): TutorPrefetchStatus {
  return { sessionId, kind: "default_continue", status: state, updatedAt: Date.now() };
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
