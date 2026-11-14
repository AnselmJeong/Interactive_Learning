import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { isHtmlElement } from "../../shared/rich-html";
import { renderTex, splitMathText } from "./math-text";

type Node = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SKIP_TAGS = new Set(["code", "pre", "kbd", "samp", "script", "style", "textarea", "math", "svg"]);

/**
 * Render TeX that appears as text inside sanitized HTML. Learning HTML blocks
 * are written by the model, which often uses `$…$` (or bare `\frac{}`) even in
 * HTML; without this pass learners see raw TeX.
 */
export function renderMathInHtml(html: string, options: { bareLatex?: boolean } = {}): string {
  if (!/[$\\]/u.test(html)) return html;
  const root = parseFragment(html);
  let changed = false;
  const visit = (parent: ParentNode) => {
    const next: Node[] = [];
    for (const node of parent.childNodes) {
      if (isHtmlElement(node)) {
        if (node.namespaceURI === HTML_NS && !SKIP_TAGS.has(node.tagName) && !node.attrs.some((attr) => attr.name === "class" && /\bkatex\b/u.test(attr.value))) visit(node);
        next.push(node);
        continue;
      }
      if (node.nodeName !== "#text" || !("value" in node) || !/[$\\]/u.test(node.value)) {
        next.push(node);
        continue;
      }
      const segments = splitMathText(node.value, options);
      if (!segments.some((segment) => segment.kind === "math")) {
        next.push(node);
        continue;
      }
      changed = true;
      for (const segment of segments) {
        if (segment.kind === "text") {
          next.push({ nodeName: "#text", value: segment.value, parentNode: parent } as DefaultTreeAdapterTypes.TextNode);
          continue;
        }
        const rendered = parseFragment(renderTex(segment.tex, segment.display));
        for (const child of rendered.childNodes) {
          child.parentNode = parent;
          next.push(child);
        }
      }
    }
    parent.childNodes = next;
  };
  visit(root);
  return changed ? serialize(root) : html;
}
