// Keyboard shortcuts for the "계속해줘" (continue to the next chunk) action.
//
// - Space: the original habit. It used to work only when the continue button happened to have
//   focus (autofocus fires only once prefetch is ready and the learner is idle), so it silently
//   did nothing whenever focus was on the page body or elsewhere. Now it works whenever the
//   learner is not typing or operating another control.
// - ⌘+Enter (Ctrl+Enter on Windows/Linux): a dedicated shortcut that also works from an empty
//   chat composer. Ctrl+Space is avoided on purpose: macOS uses it to switch input sources
//   (한/영), so the app would never see it on most Korean setups.

export type ContinueShortcutFocus =
  | "none" // body / document root / non-interactive content
  | "continue-button" // the button itself handles Space natively
  | "empty-composer"
  | "text-entry" // composer with text, other inputs, textareas, contenteditable
  | "other-control"; // other buttons, links, selects, menus

export type ContinueShortcutInput = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  focus: ContinueShortcutFocus;
  hasTextSelection: boolean;
  protectedSurfaceOpen: boolean;
};

export function isDedicatedContinueShortcut(event: Pick<ContinueShortcutInput, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

export function shouldTriggerContinueShortcut(input: ContinueShortcutInput): boolean {
  if (input.repeat || input.isComposing || input.protectedSurfaceOpen) return false;
  if (isDedicatedContinueShortcut(input)) {
    return input.focus === "none" || input.focus === "continue-button" || input.focus === "empty-composer";
  }
  const plainSpace = input.key === " " && !input.metaKey && !input.ctrlKey && !input.altKey && !input.shiftKey;
  if (!plainSpace) return false;
  // Space on the focused button already clicks it; handling it here would advance twice.
  // A text selection means the learner is about to use the selection toolbar.
  return input.focus === "none" && !input.hasTextSelection;
}

export function classifyContinueShortcutFocus(
  active: Element | null,
  continueButton: Element | null,
): ContinueShortcutFocus {
  if (!active || active === document.body || active === document.documentElement) return "none";
  if (continueButton && active === continueButton) return "continue-button";
  if (active instanceof HTMLTextAreaElement && active.closest(".composer")) {
    return active.value.trim() ? "text-entry" : "empty-composer";
  }
  if (
    active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable)
  ) return "text-entry";
  if (active.closest("button, a[href], select, summary, [role='button'], [role='menuitem'], [role='tab'], [role='option'], [role='checkbox'], [role='switch'], [role='slider']")) {
    return "other-control";
  }
  return "none";
}
