import type {
  MaterialAnnotation,
  MaterialAnnotationSurface,
  TextSelectionAnchor,
} from "../../shared/artifact-types";

export const ANNOTATION_SELECTION_IGNORE_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "code",
  "pre",
  "kbd",
  "samp",
  ".katex",
  ".selection-toolbar",
  ".lookup-popover",
  ".modal",
  ".source-annotation-list",
  ".chat-annotation-list",
  ".source-mark-list",
  ".annotation-inline-link",
].join(", ");

export type ResolvedTextAnchor = {
  startOffset: number;
  endOffset: number;
  text: string;
  exact: boolean;
};

type TextMatch = {
  startOffset: number;
  endOffset: number;
};

type NormalizedTextMap = {
  text: string;
  rawIndices: number[];
  rawLengths: number[];
};

function elementFromNode(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export function isIgnoredSelectionElement(element: Element | null) {
  return Boolean(element?.closest(ANNOTATION_SELECTION_IGNORE_SELECTOR));
}

export function normalizeAnchorText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizedAnchorKey(value: string) {
  return normalizeAnchorText(value).toLocaleLowerCase();
}

function normalizeWithMap(value: string): NormalizedTextMap {
  let text = "";
  const rawIndices: number[] = [];
  const rawLengths: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    const length = char.length;
    if (/\s/u.test(char)) {
      if (!previousWasSpace) {
        text += " ";
        rawIndices.push(index);
        rawLengths.push(length);
        previousWasSpace = true;
      }
    } else {
      text += char.toLocaleLowerCase();
      rawIndices.push(index);
      rawLengths.push(length);
      previousWasSpace = false;
    }
    index += length;
  }

  return { text, rawIndices, rawLengths };
}

function findExactMatches(scopeText: string, selectedText: string): TextMatch[] {
  const matches: TextMatch[] = [];
  if (!selectedText) return matches;
  let index = scopeText.indexOf(selectedText);
  while (index >= 0) {
    matches.push({ startOffset: index, endOffset: index + selectedText.length });
    index = scopeText.indexOf(selectedText, index + Math.max(1, selectedText.length));
  }
  return matches;
}

export function findTextMatches(scopeText: string, selectedText: string): TextMatch[] {
  const normalizedNeedle = normalizedAnchorKey(selectedText);
  if (!normalizedNeedle) return [];

  const normalizedScope = normalizeWithMap(scopeText);
  const matches: TextMatch[] = [];
  let matchIndex = normalizedScope.text.indexOf(normalizedNeedle);
  while (matchIndex >= 0) {
    const startOffset = normalizedScope.rawIndices[matchIndex];
    const endNormIndex = matchIndex + normalizedNeedle.length - 1;
    const endOffset = endNormIndex + 1 < normalizedScope.rawIndices.length
      ? normalizedScope.rawIndices[endNormIndex + 1]!
      : (normalizedScope.rawIndices[endNormIndex] ?? scopeText.length) + (normalizedScope.rawLengths[endNormIndex] ?? 0);
    if (startOffset != null && endOffset > startOffset) {
      matches.push({ startOffset, endOffset });
    }
    matchIndex = normalizedScope.text.indexOf(normalizedNeedle, matchIndex + Math.max(1, normalizedNeedle.length));
  }
  return matches.length ? matches : findExactMatches(scopeText, selectedText);
}

function textOffsetForBoundary(root: HTMLElement, container: Node, offset: number) {
  const range = root.ownerDocument.createRange();
  try {
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return null;
  } finally {
    range.detach();
  }
}

function occurrenceForOffset(scopeText: string, selectedText: string, startOffset: number) {
  const matches = findTextMatches(scopeText, selectedText);
  if (!matches.length) return 0;
  const exactIndex = matches.findIndex((match) => match.startOffset === startOffset);
  if (exactIndex >= 0) return exactIndex;
  const before = matches.filter((match) => match.startOffset < startOffset).length;
  return Math.min(before, matches.length - 1);
}

function selectionScope(surface: MaterialAnnotationSurface, messageId?: string | null, blockId?: string | null): TextSelectionAnchor["scope"] {
  if (surface === "source") return "source-chunk";
  return blockId ? "tutor-block" : "chat-message";
}

export function buildTextSelectionAnchor(input: {
  range: Range;
  root: HTMLElement;
  surface: MaterialAnnotationSurface;
  chunkId: string;
  messageId?: string | null;
  blockId?: string | null;
}): TextSelectionAnchor | null {
  const startElement = elementFromNode(input.range.startContainer);
  const endElement = elementFromNode(input.range.endContainer);
  if (!startElement || !endElement || !input.root.contains(startElement) || !input.root.contains(endElement)) return null;
  if (isIgnoredSelectionElement(startElement) || isIgnoredSelectionElement(endElement)) return null;

  const rawSelectedText = input.range.toString();
  const selectedText = normalizeAnchorText(rawSelectedText);
  if (!selectedText) return null;

  const startOffset = textOffsetForBoundary(input.root, input.range.startContainer, input.range.startOffset);
  const endOffset = textOffsetForBoundary(input.root, input.range.endContainer, input.range.endOffset);
  if (startOffset == null || endOffset == null || endOffset <= startOffset) return null;

  const scopeText = input.root.textContent || "";
  return {
    version: 1,
    surface: input.surface,
    scope: selectionScope(input.surface, input.messageId, input.blockId),
    chunkId: input.chunkId,
    messageId: input.messageId || null,
    blockId: input.blockId || null,
    selectedText,
    normalizedText: normalizedAnchorKey(selectedText),
    occurrence: occurrenceForOffset(scopeText, rawSelectedText, startOffset),
    startOffset,
    endOffset,
    prefix: normalizeAnchorText(scopeText.slice(Math.max(0, startOffset - 80), startOffset)),
    suffix: normalizeAnchorText(scopeText.slice(endOffset, Math.min(scopeText.length, endOffset + 80))),
    scopeTextLength: scopeText.length,
  };
}

function candidateScore(scopeText: string, match: TextMatch, matchIndex: number, anchor: TextSelectionAnchor) {
  let score = 0;
  if (matchIndex === anchor.occurrence) score += 80;
  const distance = Math.abs(match.startOffset - anchor.startOffset);
  score += Math.max(0, 40 - distance / 8);

  const prefix = normalizeAnchorText(scopeText.slice(Math.max(0, match.startOffset - 100), match.startOffset));
  const suffix = normalizeAnchorText(scopeText.slice(match.endOffset, Math.min(scopeText.length, match.endOffset + 100)));
  if (anchor.prefix && prefix.endsWith(anchor.prefix)) score += 35;
  else if (anchor.prefix && prefix.includes(anchor.prefix.slice(-30))) score += 12;
  if (anchor.suffix && suffix.startsWith(anchor.suffix)) score += 35;
  else if (anchor.suffix && suffix.includes(anchor.suffix.slice(0, 30))) score += 12;
  return score;
}

export function resolveTextSelectionAnchor(input: {
  root: HTMLElement;
  annotation: MaterialAnnotation;
}): ResolvedTextAnchor | null {
  const scopeText = input.root.textContent || "";
  const anchor = input.annotation.textAnchor || null;
  const selectedText = anchor?.selectedText || input.annotation.selectedText;
  const normalizedText = anchor?.normalizedText || input.annotation.normalizedText || normalizedAnchorKey(selectedText);
  if (!selectedText || !normalizedText) return null;

  if (anchor && anchor.startOffset >= 0 && anchor.endOffset > anchor.startOffset && anchor.endOffset <= scopeText.length) {
    const candidateText = scopeText.slice(anchor.startOffset, anchor.endOffset);
    if (normalizedAnchorKey(candidateText) === normalizedText) {
      return {
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        text: candidateText,
        exact: true,
      };
    }
  }

  const matches = findTextMatches(scopeText, selectedText)
    .filter((match) => normalizedAnchorKey(scopeText.slice(match.startOffset, match.endOffset)) === normalizedText);
  if (!matches.length) return null;

  if (!anchor) {
    const match = matches[0]!;
    return {
      startOffset: match.startOffset,
      endOffset: match.endOffset,
      text: scopeText.slice(match.startOffset, match.endOffset),
      exact: matches.length === 1,
    };
  }

  const best = matches
    .map((match, index) => ({ match, score: candidateScore(scopeText, match, index, anchor) }))
    .sort((a, b) => b.score - a.score)[0]?.match;
  if (!best) return null;
  return {
    startOffset: best.startOffset,
    endOffset: best.endOffset,
    text: scopeText.slice(best.startOffset, best.endOffset),
    exact: normalizedAnchorKey(scopeText.slice(best.startOffset, best.endOffset)) === normalizedText,
  };
}
