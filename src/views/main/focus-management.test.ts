import { describe, expect, test } from "bun:test";
import { hasExpandedTextSelection, isReadyActionActiveElementIdle, shouldAutoFocusReadyAction } from "./focus-management";

describe("ready action autofocus guard", () => {
  const idle = {
    pointerDown: false,
    hasTextSelection: false,
    activeElementIsIdle: true,
    protectedSurfaceOpen: false,
  };

  test("allows autofocus only when the learner is idle", () => {
    expect(shouldAutoFocusReadyAction(idle)).toBe(true);
  });

  test("does not steal focus from either composer or another control", () => {
    expect(shouldAutoFocusReadyAction({ ...idle, activeElementIsIdle: false })).toBe(false);
  });

  test("does not interrupt pointer selection or an expanded text selection", () => {
    expect(shouldAutoFocusReadyAction({ ...idle, pointerDown: true })).toBe(false);
    expect(shouldAutoFocusReadyAction({ ...idle, hasTextSelection: true })).toBe(false);
  });

  test("does not move focus behind an open dialog or selection surface", () => {
    expect(shouldAutoFocusReadyAction({ ...idle, protectedSurfaceOpen: true })).toBe(false);
  });

  test("recognizes only non-collapsed DOM selections", () => {
    expect(hasExpandedTextSelection({ rangeCount: 1, isCollapsed: false })).toBe(true);
    expect(hasExpandedTextSelection({ rangeCount: 1, isCollapsed: true })).toBe(false);
    expect(hasExpandedTextSelection({ rangeCount: 0, isCollapsed: false })).toBe(false);
    expect(hasExpandedTextSelection(null)).toBe(false);
  });

  test("treats an empty focused composer as idle after a successful send", () => {
    expect(isReadyActionActiveElementIdle({
      hasActiveElement: true,
      isDocumentRoot: false,
      isTarget: false,
      isComposer: true,
      composerValue: "",
    })).toBe(true);
  });

  test("keeps protecting a composer that contains learner text", () => {
    expect(isReadyActionActiveElementIdle({
      hasActiveElement: true,
      isDocumentRoot: false,
      isTarget: false,
      isComposer: true,
      composerValue: "새 질문을 입력하는 중",
    })).toBe(false);
  });
});
