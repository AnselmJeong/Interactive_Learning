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
  let cursor = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  for (const node of allTextNodes(root)) {
    const next = cursor + node.data.length;
    if (!startNode && startOffset >= cursor && startOffset <= next) {
      startNode = node;
      startNodeOffset = Math.max(0, Math.min(node.data.length, startOffset - cursor));
    }
    if (!endNode && endOffset >= cursor && endOffset <= next) {
      endNode = node;
      endNodeOffset = Math.max(0, Math.min(node.data.length, endOffset - cursor));
      break;
    }
    cursor = next;
  }

  if (!startNode || !endNode) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

function hasIgnoredTextNode(root: HTMLElement, resolved: ResolvedTextAnchor) {
  return textNodesForOffsets(root, resolved.startOffset, resolved.endOffset).some((node) =>
    Boolean(elementFromNode(node)?.closest(ANNOTATION_SELECTION_IGNORE_SELECTOR))
  );
}

function annotationHasCard(annotation: MaterialAnnotation) {
  return annotation.kind !== "highlight";
}

function inlineClasses(annotation: MaterialAnnotation, activeAnnotationId: string | null | undefined) {
  const classes = [
    "annotation-inline-link",
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
  const links = [...root.querySelectorAll<HTMLElement>(".annotation-inline-link")];
  for (const link of links) {
    const parent = link.parentNode;
    if (!parent) continue;
    const fragment = root.ownerDocument.createDocumentFragment();
    while (link.firstChild) fragment.appendChild(link.firstChild);
    parent.replaceChild(fragment, link);
    parent.normalize();
  }
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

    const wrapper = input.root.ownerDocument.createElement("a");
    wrapper.id = annotationInlineId(item.annotation.id);
    wrapper.href = annotationHasCard(item.annotation) ? `#${annotationCardId(item.annotation.id)}` : `#${annotationInlineId(item.annotation.id)}`;
    wrapper.className = inlineClasses(item.annotation, input.activeAnnotationId);
    wrapper.dataset.annotationId = item.annotation.id;
    wrapper.dataset.annotationKind = item.annotation.kind;
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      input.onActivateAnnotation?.(item.annotation);
    });

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
