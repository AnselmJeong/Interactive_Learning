export type ReadyActionFocusContext = {
  pointerDown: boolean;
  hasTextSelection: boolean;
  activeElementIsIdle: boolean;
  protectedSurfaceOpen: boolean;
};

export type ReadyActionActiveElementContext = {
  hasActiveElement: boolean;
  isDocumentRoot: boolean;
  isTarget: boolean;
  isComposer: boolean;
  composerValue?: string;
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

export function isReadyActionActiveElementIdle(context: ReadyActionActiveElementContext) {
  return !context.hasActiveElement
    || context.isDocumentRoot
    || context.isTarget
    || (context.isComposer && !context.composerValue?.trim());
}
