import { describe, expect, test } from "bun:test";
import { shouldHighlightSelection } from "./highlight-shortcut";

function keyboardEvent(overrides: Partial<Parameters<typeof shouldHighlightSelection>[0]> = {}) {
  return {
    code: "KeyU",
    key: "u",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

describe("selection highlight shortcut", () => {
  test("accepts the physical U key outside a text entry control", () => {
    expect(shouldHighlightSelection(keyboardEvent())).toBe(true);
    expect(shouldHighlightSelection(keyboardEvent({ key: "U" }))).toBe(true);
  });

  test("uses the physical U key when the Korean keyboard layout reports ㅕ", () => {
    expect(shouldHighlightSelection(keyboardEvent({ code: "KeyU", key: "ㅕ" }))).toBe(true);
  });

  test("does not take over modified shortcuts, key repeat, or IME input", () => {
    expect(shouldHighlightSelection(keyboardEvent({ metaKey: true }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ ctrlKey: true }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ shiftKey: true }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ altKey: true }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ repeat: true }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ isComposing: true }))).toBe(false);
  });

  test("does not trigger while typing in an editable control", () => {
    const editableTarget = { closest: () => ({}) } as unknown as EventTarget;
    expect(shouldHighlightSelection(keyboardEvent({ target: editableTarget }))).toBe(false);
  });

  test("ignores unrelated and already handled keys", () => {
    expect(shouldHighlightSelection(keyboardEvent({ code: "KeyH", key: "h" }))).toBe(false);
    expect(shouldHighlightSelection(keyboardEvent({ defaultPrevented: true }))).toBe(false);
  });
});
