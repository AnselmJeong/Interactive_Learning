import { describe, expect, test } from "bun:test";
import { sessionDeletionTransition } from "./session-deletion-transition";

describe("session deletion transition", () => {
  test("loads the most recently updated remaining session after deleting the active one", () => {
    expect(sessionDeletionTransition("active", "active", ["previous", "older"]))
      .toEqual({ kind: "load_previous", sessionId: "previous" });
  });

  test("returns to material preview after deleting the last active session", () => {
    expect(sessionDeletionTransition("active", "active", [])).toEqual({ kind: "show_preview" });
  });

  test("keeps the current session when a different history row is deleted", () => {
    expect(sessionDeletionTransition("active", "history", ["active"]))
      .toEqual({ kind: "keep_current" });
  });

  test("leaves preview mode by loading the latest remaining session", () => {
    expect(sessionDeletionTransition(null, "history", ["latest"]))
      .toEqual({ kind: "load_previous", sessionId: "latest" });
  });
});
