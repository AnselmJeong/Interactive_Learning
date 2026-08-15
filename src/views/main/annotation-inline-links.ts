import type { MaterialAnnotation } from "../../shared/artifact-types";
import {
  ANNOTATION_SELECTION_IGNORE_SELECTOR,
  resolveTextSelectionAnchor,
  type ResolvedTextAnchor,
} from "./selection-anchor";

export function annotationCardId(annotationId: string) {
  return `annotation-card-${annotationId}`;
}

export function annotationInlineId(annotationId: string) {
  return `annotation-inline-${annotationId}`;
}

function cssEscape(value: string) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function elementFromNode(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function allTextNodes(root: HTMLElement) {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

export function resolveTextNodeRangeOffsets(textLengths: number[], startOffset: number, endOffset: number) {
  if (endOffset <= startOffset) return null;

  let cursor = 0;
  let start: { nodeIndex: number; nodeOffset: number } | null = null;
  let end: { nodeIndex: number; nodeOffset: number } | null = null;

  for (let nodeIndex = 0; nodeIndex < textLengths.length; nodeIndex += 1) {
    const length = Math.max(0, textLengths[nodeIndex] || 0);
    const next = cursor + length;

    if (!start && length > 0 && startOffset >= cursor && startOffset < next) {
      start = { nodeIndex, nodeOffset: startOffset - cursor };
    }
    if (!end && length > 0 && endOffset > cursor && endOffset <= next) {
      end = { nodeIndex, nodeOffset: endOffset - cursor };
      break;
    }

    cursor = next;
  }

  return start && end ? { start, end } : null;
}

export function resolveTextNodeRangeSegments(
  textLengths: number[],
  skippedNodeIndices: ReadonlySet<number>,
  startOffset: number,
  endOffset: number
) {
  if (endOffset <= startOffset) return [];

  const segments: Array<{
    start: { nodeIndex: number; nodeOffset: number };
    end: { nodeIndex: number; nodeOffset: number };
  }> = [];
  let current: (typeof segments)[number] | null = null;
  let cursor = 0;

  for (let nodeIndex = 0; nodeIndex < textLengths.length; nodeIndex += 1) {
    const length = Math.max(0, textLengths[nodeIndex] || 0);
    const next = cursor + length;
    const nodeStartOffset = Math.max(0, startOffset - cursor);
    const nodeEndOffset = Math.min(length, endOffset - cursor);
    const intersectsSelection = length > 0 && nodeStartOffset < nodeEndOffset;

    if (intersectsSelection && skippedNodeIndices.has(nodeIndex)) {
      if (current) segments.push(current);
      current = null;
    } else if (intersectsSelection) {
      if (!current) {
        current = {
          start: { nodeIndex, nodeOffset: nodeStartOffset },
          end: { nodeIndex, nodeOffset: nodeEndOffset },
        };
      } else {
        current.end = { nodeIndex, nodeOffset: nodeEndOffset };
      }
    }

    cursor = next;
    if (cursor >= endOffset) break;
  }

  if (current) segments.push(current);
  return segments;
}

function textNodesForOffsets(root: HTMLElement, startOffset: number, endOffset: number) {
  const nodes: Text[] = [];
  let cursor = 0;
  for (const node of allTextNodes(root)) {
    const next = cursor + node.data.length;
    if (next > startOffset && cursor < endOffset) nodes.push(node);
    cursor = next;
  }
  return nodes;
}

function rangeForTextOffsets(root: HTMLElement, startOffset: number, endOffset: number) {
  if (endOffset <= startOffset) return null;
  const textNodes = allTextNodes(root);
  const offsets = resolveTextNodeRangeOffsets(textNodes.map((node) => node.data.length), startOffset, endOffset);
  const startNode = offsets ? textNodes[offsets.start.nodeIndex] : null;
  const endNode = offsets ? textNodes[offsets.end.nodeIndex] : null;

  if (!startNode || !endNode) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startNode, offsets!.start.nodeOffset);
  range.setEnd(endNode, offsets!.end.nodeOffset);
  return range;
}

function hasUnsupportedIgnoredTextNode(root: HTMLElement, resolved: ResolvedTextAnchor, allowKatex: boolean) {
  return textNodesForOffsets(root, resolved.startOffset, resolved.endOffset).some((node) => {
    const element = elementFromNode(node);
    if (!element?.closest(ANNOTATION_SELECTION_IGNORE_SELECTOR)) return false;
    return !allowKatex || !element.closest(".katex");
  });
}

function rangesForTextOffsetsExcludingKatex(root: HTMLElement, startOffset: number, endOffset: number) {
  const textNodes = allTextNodes(root);
  const skippedNodeIndices = new Set<number>();
  textNodes.forEach((node, nodeIndex) => {
    if (elementFromNode(node)?.closest(".katex")) skippedNodeIndices.add(nodeIndex);
  });

  return resolveTextNodeRangeSegments(
    textNodes.map((node) => node.data.length),
    skippedNodeIndices,
    startOffset,
    endOffset
  ).map((segment) => {
    const startNode = textNodes[segment.start.nodeIndex];
    const endNode = textNodes[segment.end.nodeIndex];
    if (!startNode || !endNode) return null;
    const range = root.ownerDocument.createRange();
    range.setStart(startNode, segment.start.nodeOffset);
    range.setEnd(endNode, segment.end.nodeOffset);
    return range;
  }).filter((range): range is Range => Boolean(range));
}

const INLINE_ANNOTATION_CONTAINER_SELECTOR = [
  "li",
  "td",
  "th",
  "blockquote",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
].join(",");

const INLINE_ANNOTATION_TEXT_BOUNDARY_SELECTOR = "p";

function inlineAnnotationBoundary(root: HTMLElement, node: Node) {
  const element = elementFromNode(node);
  const container = element?.closest<HTMLElement>(INLINE_ANNOTATION_CONTAINER_SELECTOR);
  if (container && root.contains(container)) return container;
  const boundary = element?.closest<HTMLElement>(INLINE_ANNOTATION_TEXT_BOUNDARY_SELECTOR);
  return boundary && root.contains(boundary) ? boundary : root;
}

function rangeIsInlineSafe(root: HTMLElement, range: Range) {
  return inlineAnnotationBoundary(root, range.startContainer) === inlineAnnotationBoundary(root, range.endContainer);
}

function annotationHasCard(annotation: MaterialAnnotation) {
  return annotation.kind !== "highlight";
}

export function isInteractiveInlineAnnotation(annotation: MaterialAnnotation) {
  return annotation.kind !== "highlight";
}

export function inlineAnnotationTagName(annotation: MaterialAnnotation) {
  return isInteractiveInlineAnnotation(annotation) ? "a" : "mark";
}

export function inlineClasses(annotation: MaterialAnnotation, activeAnnotationId: string | null | undefined) {
  const classes = [
    isInteractiveInlineAnnotation(annotation) ? "annotation-inline-link" : "annotation-inline-mark",
    `annotation-kind-${annotation.kind}`,
  ];
  if (annotation.kind === "highlight") {
    const style = annotation.result.kind === "highlight" ? annotation.result.style || "red-underline" : "red-underline";
    classes.push(`annotation-highlight-${style}`);
  }
  if (activeAnnotationId === annotation.id) classes.push("active");
  return classes.join(" ");
}

function rangesOverlap(left: ResolvedTextAnchor, right: ResolvedTextAnchor) {
  return left.startOffset < right.endOffset && right.startOffset < left.endOffset;
}

export function unwrapAnnotationInlineLinks(root: HTMLElement) {
  const links = [...root.querySelectorAll<HTMLElement>(".annotation-inline-link, .annotation-inline-mark")];
  for (const link of links) {
    const parent = link.parentNode;
    if (!parent) continue;
    const fragment = root.ownerDocument.createDocumentFragment();
    while (link.firstChild) fragment.appendChild(link.firstChild);
    parent.replaceChild(fragment, link);
    parent.normalize();
  }
}

export function highlightAnnotationIdsForRange(root: HTMLElement, range: Range) {
  const ids = new Set<string>();
  const marks = root.querySelectorAll<HTMLElement>(".annotation-inline-mark[data-annotation-kind='highlight'][data-annotation-id]");
  for (const mark of marks) {
    try {
      if (range.intersectsNode(mark)) {
        for (const id of (mark.dataset.annotationIds || mark.dataset.annotationId || "").split(" ").filter(Boolean)) ids.add(id);
      }
    } catch {
      // Ignore detached nodes while React is reconciling annotation wrappers.
    }
  }
  return [...ids];
}

export function focusAnnotationInline(root: HTMLElement, annotationId: string) {
  const target = root.querySelector<HTMLElement>(`[data-annotation-id="${cssEscape(annotationId)}"]`)
    || [...root.querySelectorAll<HTMLElement>("[data-annotation-ids]")]
      .find((element) => (element.dataset.annotationIds || "").split(" ").includes(annotationId));
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  return Boolean(target);
}

export function applyAnnotationInlineLinks(input: {
  root: HTMLElement;
  annotations: MaterialAnnotation[];
  activeAnnotationId?: string | null;
  onActivateAnnotation?: (annotation: MaterialAnnotation) => void;
  onActivateHighlight?: (annotation: MaterialAnnotation, rect: DOMRect) => void;
}) {
  unwrapAnnotationInlineLinks(input.root);
  if (!input.annotations.length) return 0;

  const resolved = input.annotations
    .map((annotation) => {
      const anchor = resolveTextSelectionAnchor({ root: input.root, annotation });
      return anchor ? { annotation, anchor } : null;
    })
    .filter((item): item is { annotation: MaterialAnnotation; anchor: ResolvedTextAnchor } => Boolean(item))
    .sort((a, b) => b.anchor.startOffset - a.anchor.startOffset || b.anchor.endOffset - a.anchor.endOffset);

  const groups = new Map<string, Array<{ annotation: MaterialAnnotation; anchor: ResolvedTextAnchor }>>();
  for (const item of resolved) {
    const key = `${item.anchor.startOffset}:${item.anchor.endOffset}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const grouped = [...groups.values()].sort((a, b) => b[0]!.anchor.startOffset - a[0]!.anchor.startOffset || b[0]!.anchor.endOffset - a[0]!.anchor.endOffset);
  const accepted: ResolvedTextAnchor[] = [];
  let applied = 0;

  for (const group of grouped) {
    const item = [...group].sort((a, b) => Number(isInteractiveInlineAnnotation(b.annotation)) - Number(isInteractiveInlineAnnotation(a.annotation))
      || b.annotation.updatedAt - a.annotation.updatedAt)[0]!;
    if (accepted.some((anchor) => rangesOverlap(anchor, item.anchor))) continue;
    const splitHighlightAroundKatex = item.annotation.kind === "highlight";
    if (hasUnsupportedIgnoredTextNode(input.root, item.anchor, splitHighlightAroundKatex)) continue;
    const fullRange = rangeForTextOffsets(input.root, item.anchor.startOffset, item.anchor.endOffset);
    if (!fullRange || !fullRange.toString().trim()) continue;
    if (!rangeIsInlineSafe(input.root, fullRange)) {
      fullRange.detach();
      continue;
    }
    const ranges = (splitHighlightAroundKatex
      ? rangesForTextOffsetsExcludingKatex(input.root, item.anchor.startOffset, item.anchor.endOffset)
      : [fullRange])
      .filter((range) => {
        const keep = Boolean(range.toString().trim()) && rangeIsInlineSafe(input.root, range);
        if (!keep) range.detach();
        return keep;
      });
    if (splitHighlightAroundKatex) fullRange.detach();
    if (!ranges.length) continue;

    const interactive = isInteractiveInlineAnnotation(item.annotation);
    const activeAnnotationId = group.some(({ annotation }) => annotation.id === input.activeAnnotationId)
      ? item.annotation.id
      : null;
    const annotationIds = group.map(({ annotation }) => annotation.id).join(" ");
    let appliedFragments = 0;

    for (let fragmentIndex = ranges.length - 1; fragmentIndex >= 0; fragmentIndex -= 1) {
      const range = ranges[fragmentIndex]!;
      const wrapper = input.root.ownerDocument.createElement(inlineAnnotationTagName(item.annotation));
      if (fragmentIndex === 0) wrapper.id = annotationInlineId(item.annotation.id);
      wrapper.className = [
        inlineClasses(item.annotation, activeAnnotationId),
        ...new Set(group.map(({ annotation }) => `annotation-kind-${annotation.kind}`)),
      ].join(" ");
      wrapper.dataset.annotationId = item.annotation.id;
      wrapper.dataset.annotationIds = annotationIds;
      wrapper.dataset.annotationKind = item.annotation.kind;
      if (ranges.length > 1) wrapper.dataset.annotationFragment = `${fragmentIndex + 1}/${ranges.length}`;
      if (group.length > 1 && fragmentIndex === ranges.length - 1) {
        wrapper.dataset.annotationCount = String(group.length);
        wrapper.setAttribute("aria-label", `${range.toString().trim()} · 저장된 기록 ${group.length}개`);
      }
      if (interactive) {
        wrapper.setAttribute("href", annotationHasCard(item.annotation) ? `#${annotationCardId(item.annotation.id)}` : `#${annotationInlineId(item.annotation.id)}`);
        wrapper.addEventListener("click", (event) => {
          const selection = wrapper.ownerDocument.defaultView?.getSelection();
          if (selection && !selection.isCollapsed) return;
          event.preventDefault();
          input.onActivateAnnotation?.(item.annotation);
        });
      } else if (input.onActivateHighlight) {
        wrapper.tabIndex = fragmentIndex === 0 ? 0 : -1;
        wrapper.setAttribute("role", "button");
        wrapper.setAttribute("aria-label", "표시 삭제 메뉴 열기");
        const activateHighlight = () => {
          input.onActivateHighlight?.(item.annotation, wrapper.getBoundingClientRect());
        };
        wrapper.addEventListener("click", (event) => {
          const selection = wrapper.ownerDocument.defaultView?.getSelection();
          if (selection && !selection.isCollapsed) return;
          event.preventDefault();
          activateHighlight();
        });
        wrapper.addEventListener("keydown", (event) => {
          const keyboardEvent = event as KeyboardEvent;
          if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
          event.preventDefault();
          activateHighlight();
        });
      }

      try {
        const fragment = range.extractContents();
        wrapper.appendChild(fragment);
        range.insertNode(wrapper);
        appliedFragments += 1;
      } catch {
        wrapper.remove();
      } finally {
        range.detach();
      }
    }

    if (appliedFragments > 0) {
      accepted.push(item.anchor);
      applied += 1;
    }
  }

  return applied;
}
