import { memo, type ReactNode } from "react";
import { displayableOutlineTitle } from "../../../shared/display-title";
import { renderTex, splitMathText } from "../math-text";
import { wrapBareSubscriptIdentifiers } from "./MarkdownContent";

/**
 * Headings, captions and labels are rendered as plain text, so model output
 * such as "DC 계수는 평균의 $N$배다" used to show raw `$N$`. These helpers
 * render the math in such short strings while the surrounding text still goes
 * through the usual title clean-up.
 */

const PLACEHOLDER = /\uE000(\d+)\uE001/gu;

type TitlePart = { kind: "text"; value: string } | { kind: "math"; tex: string };

/** Apply a text formatter to the prose of `value` without touching its math. */
export function formatAroundMath(value: string, format: (text: string) => string = (text) => text): TitlePart[] {
  // Undelimited subscripts (`f_i`, `V_syn`) are math here just as in lesson bodies.
  const delimited = splitMathText(value, { bareLatex: false })
    .map((segment) => (segment.kind === "math" ? segment.value : wrapBareSubscriptIdentifiers(segment.value)))
    .join("");
  const segments = splitMathText(delimited);
  const math = segments.flatMap((segment) => (segment.kind === "math" ? [segment.tex] : []));
  if (!math.length) return [{ kind: "text", value: format(value) }];
  let index = 0;
  const masked = segments.map((segment) => (segment.kind === "math" ? `\uE000${index++}\uE001` : segment.value)).join("");
  const formatted = format(masked);
  const parts: TitlePart[] = [];
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  for (let match = PLACEHOLDER.exec(formatted); match; match = PLACEHOLDER.exec(formatted)) {
    if (match.index > cursor) parts.push({ kind: "text", value: formatted.slice(cursor, match.index) });
    const tex = math[Number(match[1])];
    if (tex !== undefined) parts.push({ kind: "math", tex });
    cursor = match.index + match[0].length;
  }
  if (cursor < formatted.length) parts.push({ kind: "text", value: formatted.slice(cursor) });
  return parts;
}

/** Plain text for aria-labels and tooltips: math keeps its TeX without `$`. */
export function plainMathText(value: string, format?: (text: string) => string) {
  return formatAroundMath(value, format).map((part) => (part.kind === "math" ? part.tex : part.value)).join("");
}

function renderParts(parts: TitlePart[]): ReactNode {
  return parts.map((part, index) => (part.kind === "math"
    ? <span key={index} className="inline-math" dangerouslySetInnerHTML={{ __html: renderTex(part.tex) }} />
    : part.value));
}

export const MathText = memo(function MathText({ text, format }: { text: string; format?: (text: string) => string }) {
  return <>{renderParts(formatAroundMath(text, format))}</>;
});

export const MathTitle = memo(function MathTitle({ title }: { title: string }) {
  return <MathText text={title} format={displayableOutlineTitle} />;
});
