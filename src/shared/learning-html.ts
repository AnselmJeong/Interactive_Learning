import { richHtmlText, sanitizeRichHtml } from "./rich-html";
import type { TutorContentBlock } from "./tutor-types";
import { DIAGRAM_RULE } from "./diagram-spec";

export function normalizeLearningHtml(raw: Record<string, unknown>): Extract<TutorContentBlock, { type: "rich_html" }> | null {
  if (typeof raw.html !== "string" || raw.html.length > 32_000) return null;
  const html = sanitizeRichHtml(raw.html);
  const body = richHtmlText(html);
  if (!body || body.length > 8000) return null;
  return { type: "rich_html", html, body, title: typeof raw.title === "string" ? raw.title.trim().slice(0, 120) || undefined : undefined };
}

export const LEARNING_HTML_RULE = `When comparing alternatives on a shared question, show the comparison in a compare_table or a semantic HTML table, one shared dimension per row or column. When explaining a sequence, use a flow block with ordered, concise steps. When paths branch, converge or loop, or a process has side conditions, use a diagram block and describe the actual topology. ${DIAGRAM_RULE} An arrow may express temporal order, implication or mechanism; make the meaning clear. Do not imply causation from association. Keep simple exposition in prose. Choose one representation of each relationship; never repeat the same comparison or process as a second illustration.
rich_html schema: {"type":"rich_html","title":"specific optional title","html":"semantic HTML fragment","grounding":{...}}. The app derives plain text from the HTML; do not duplicate it in body. Use at most one rich_html block per response and keep its visible explanation concise.
Available HTML: section, article, aside, p, h3/h4, strong/em, ul/ol/li, dl/dt/dd, table with caption/thead/tbody/th/td and rowspan/colspan, figure/figcaption, details/summary, sub/sup and MathML. Native details/summary provides keyboard-accessible interaction; keep the main explanation visible. No scripts, event handlers, iframes, external images, style tags or inline CSS. Never emit Markdown inside HTML. Escape < and & in ordinary text.
Use these classes when useful: learn-lead (one strong opening sentence), learn-compare (two contrasting sections), learn-process or learn-steps (an ordered mechanism), learn-concept (definition with dl), learn-aside (limitation or assumption), learn-equation (equation plus explanation), learn-caption, learn-contrast, learn-takeaway (one implication). Do not stack equal-sized boxed cards or label every block 'key point'.
Never hand-draw diagrams as SVG inside rich_html; a diagram block replaces them. Never invent measured values or recreate a source figure you have not seen. Label conceptual schematics and illustrative examples as such. Keep meaningful text selectable. Maximum 6000 HTML characters per block. Use at most one disclosure for optional depth, with a specific descriptive summary. Preserve exact source grounding for the whole explanation, and distinguish source from interpretation.`;
