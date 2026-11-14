// Keeps a freshly revealed tutor message pinned to the top of the learning pane while the
// surrounding layout settles. A single alignment pass is not enough: right after "계속해줘" the
// previous message's 추가 탐색 panel collapses with a CSS transition, figures and diagrams load
// asynchronously, and the thinking bubble disappears. Each of those moves the new message after
// the first alignment, so the learner landed in the middle of the chunk and had to scroll back.

export const SCROLL_ANCHOR_TOP_INSET = 12;
const SETTLE_QUIET_MS = 450;
const MAX_PIN_MS = 2500;

/**
 * Extra space needed below the content so the target can be scrolled flush to the top even when
 * the new message is shorter than the viewport. Without it the browser clamps scrollTop to
 * scrollHeight - clientHeight and the message stays below the top edge.
 */
export function bottomSpacerHeight(input: {
  targetOffset: number;
  clientHeight: number;
  contentHeight: number;
}): number {
  const needed = input.targetOffset + input.clientHeight - input.contentHeight;
  return needed > 0 ? Math.ceil(needed) : 0;
}

/** Keys that scroll the pane; pressing one means the learner took over. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function pinElementToTop(options: {
  surface: HTMLElement;
  getTarget: () => HTMLElement | null;
  spacer?: HTMLElement | null;
  observe?: Array<HTMLElement | null | undefined>;
  topInset?: number;
}): () => void {
  const { surface, getTarget, spacer } = options;
  const topInset = options.topInset ?? SCROLL_ANCHOR_TOP_INSET;
  let stopped = false;
  let frame = 0;
  let quietTimer = 0;
  let resizeObserver: ResizeObserver | null = null;
  const startedAt = performance.now();

  const align = () => {
    frame = 0;
    if (stopped) return;
    const target = getTarget();
    if (!target) return;
    const surfaceRect = surface.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetOffset = surface.scrollTop + targetRect.top - surfaceRect.top - topInset;
    if (spacer) {
      const currentSpacer = spacer.offsetHeight;
      const nextSpacer = bottomSpacerHeight({
        targetOffset,
        clientHeight: surface.clientHeight,
        contentHeight: surface.scrollHeight - currentSpacer,
      });
      if (nextSpacer !== currentSpacer) spacer.style.height = `${nextSpacer}px`;
    }
    const maxTop = Math.max(0, surface.scrollHeight - surface.clientHeight);
    const nextTop = Math.max(0, Math.min(targetOffset, maxTop));
    if (Math.abs(surface.scrollTop - nextTop) > 0.5) surface.scrollTo({ top: nextTop, behavior: "auto" });
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    if (quietTimer) window.clearTimeout(quietTimer);
    resizeObserver?.disconnect();
    surface.removeEventListener("wheel", stop);
    surface.removeEventListener("touchstart", stop);
    surface.removeEventListener("pointerdown", stop);
    surface.removeEventListener("transitionend", schedule, true);
    surface.removeEventListener("load", schedule, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };

  function armQuietTimer() {
    if (quietTimer) window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(stop, SETTLE_QUIET_MS);
  }

  function schedule() {
    if (stopped) return;
    if (performance.now() - startedAt > MAX_PIN_MS) {
      stop();
      return;
    }
    if (!frame) frame = requestAnimationFrame(align);
    armQuietTimer();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (SCROLL_KEYS.has(event.key)) stop();
  }

  surface.addEventListener("wheel", stop, { passive: true });
  surface.addEventListener("touchstart", stop, { passive: true });
  surface.addEventListener("pointerdown", stop);
  surface.addEventListener("transitionend", schedule, true);
  window.addEventListener("keydown", onKeyDown, true);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(schedule);
    for (const element of options.observe || []) if (element) resizeObserver.observe(element);
  }
  // Images load lazily inside messages; a decoded image changes height without a resize of an
  // observed element's box being guaranteed on every engine, so listen for loads as well.
  surface.addEventListener("load", schedule, true);

  schedule();
  return stop;
}
