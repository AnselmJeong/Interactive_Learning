type HighlightShortcutEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
};

function isTextEntryTarget(target: EventTarget | null | undefined) {
  if (!target || typeof target !== "object" || !("closest" in target)) return false;
  const closest = (target as { closest?: (selector: string) => Element | null }).closest;
  if (typeof closest !== "function") return false;
  return Boolean(closest.call(target, "input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

export function shouldHighlightSelection(event: HighlightShortcutEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (event.key.toLowerCase() !== "u") return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return !isTextEntryTarget(event.target);
}
