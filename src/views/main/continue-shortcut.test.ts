import { describe, expect, test } from "bun:test";
import { shouldTriggerContinueShortcut, type ContinueShortcutInput } from "./continue-shortcut";

const base: ContinueShortcutInput = {
  key: " ",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  focus: "none",
  hasTextSelection: false,
  protectedSurfaceOpen: false,
};

describe("continue shortcut", () => {
  test("Space continues when nothing interactive has focus", () => {
    expect(shouldTriggerContinueShortcut(base)).toBe(true);
  });

  test("Space is left to the focused button so it does not advance twice", () => {
    expect(shouldTriggerContinueShortcut({ ...base, focus: "continue-button" })).toBe(false);
  });

  test("Space never fires while typing or on other controls", () => {
    expect(shouldTriggerContinueShortcut({ ...base, focus: "empty-composer" })).toBe(false);
    expect(shouldTriggerContinueShortcut({ ...base, focus: "text-entry" })).toBe(false);
    expect(shouldTriggerContinueShortcut({ ...base, focus: "other-control" })).toBe(false);
  });

  test("Space with a text selection or an open popover is ignored", () => {
    expect(shouldTriggerContinueShortcut({ ...base, hasTextSelection: true })).toBe(false);
    expect(shouldTriggerContinueShortcut({ ...base, protectedSurfaceOpen: true })).toBe(false);
  });

  test("Ctrl+Space is not a shortcut (macOS input-source switch)", () => {
    expect(shouldTriggerContinueShortcut({ ...base, ctrlKey: true })).toBe(false);
  });

  test("Cmd/Ctrl+Enter continues from the page or an empty composer", () => {
    const cmdEnter = { ...base, key: "Enter", metaKey: true };
    expect(shouldTriggerContinueShortcut(cmdEnter)).toBe(true);
    expect(shouldTriggerContinueShortcut({ ...cmdEnter, focus: "empty-composer" })).toBe(true);
    expect(shouldTriggerContinueShortcut({ ...cmdEnter, focus: "continue-button" })).toBe(true);
    expect(shouldTriggerContinueShortcut({ ...base, key: "Enter", ctrlKey: true })).toBe(true);
  });

  test("Cmd+Enter in a composer with text stays the send shortcut", () => {
    expect(shouldTriggerContinueShortcut({ ...base, key: "Enter", metaKey: true, focus: "text-entry" })).toBe(false);
  });

  test("IME composition and key repeat are ignored", () => {
    expect(shouldTriggerContinueShortcut({ ...base, isComposing: true })).toBe(false);
    expect(shouldTriggerContinueShortcut({ ...base, repeat: true })).toBe(false);
  });
});
