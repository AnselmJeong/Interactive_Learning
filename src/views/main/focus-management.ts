export type ReadyActionFocusContext = {
  pointerDown: boolean;
  hasTextSelection: boolean;
  activeElementIsIdle: boolean;
  protectedSurfaceOpen: boolean;
};

export function hasExpandedTextSelection(selection: Pick<Selection, "rangeCount" | "isCollapsed"> | null | undefined) {
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
}

export function shouldAutoFocusReadyAction(context: ReadyActionFocusContext) {
  return !context.pointerDown
    && !context.hasTextSelection
    && context.activeElementIsIdle
    && !context.protectedSurfaceOpen;
}
