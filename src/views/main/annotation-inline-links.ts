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

function hasIgnoredTextNode(root: HTMLElement, resolved: ResolvedTextAnchor) {
  return textNodesForOffsets(root, resolved.startOffset, resolved.endOffset).some((node) =>
    Boolean(elementFromNode(node)?.closest(ANNOTATION_SELECTION_IGNORE_SELECTOR))
  );
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
    const style = annotation.result.kind === "highlight" ? annotation.result.style || "yellow" : "yellow";
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
      if (range.intersectsNode(mark) && mark.dataset.annotationId) ids.add(mark.dataset.annotationId);
    } catch {
      // Ignore detached nodes while React is reconciling annotation wrappers.
    }
  }
  return [...ids];
}

export function focusAnnotationInline(root: HTMLElement, annotationId: string) {
  const target = root.querySelector<HTMLElement>(`[data-annotation-id="${cssEscape(annotationId)}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  return Boolean(target);
}

export function applyAnnotationInlineLinks(input: {
  root: HTMLElement;
  annotations: MaterialAnnotation[];
  activeAnnotationId?: string | null;
  onActivateAnnotation?: (annotation: MaterialAnnotation) => void;
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

  const accepted: ResolvedTextAnchor[] = [];
  let applied = 0;

  for (const item of resolved) {
    if (accepted.some((anchor) => rangesOverlap(anchor, item.anchor))) continue;
    if (hasIgnoredTextNode(input.root, item.anchor)) continue;
    const range = rangeForTextOffsets(input.root, item.anchor.startOffset, item.anchor.endOffset);
    if (!range || !range.toString().trim()) continue;
    if (!rangeIsInlineSafe(input.root, range)) {
      range.detach();
      continue;
    }

    const interactive = isInteractiveInlineAnnotation(item.annotation);
    const wrapper = input.root.ownerDocument.createElement(inlineAnnotationTagName(item.annotation));
    wrapper.id = annotationInlineId(item.annotation.id);
    wrapper.className = inlineClasses(item.annotation, input.activeAnnotationId);
    wrapper.dataset.annotationId = item.annotation.id;
    wrapper.dataset.annotationKind = item.annotation.kind;
    if (interactive) {
      wrapper.setAttribute("href", annotationHasCard(item.annotation) ? `#${annotationCardId(item.annotation.id)}` : `#${annotationInlineId(item.annotation.id)}`);
      wrapper.addEventListener("click", (event) => {
        event.preventDefault();
        input.onActivateAnnotation?.(item.annotation);
      });
    }

    try {
      const fragment = range.extractContents();
      wrapper.appendChild(fragment);
      range.insertNode(wrapper);
      accepted.push(item.anchor);
      applied += 1;
    } catch {
      wrapper.remove();
    } finally {
      range.detach();
    }
  }

  return applied;
}
