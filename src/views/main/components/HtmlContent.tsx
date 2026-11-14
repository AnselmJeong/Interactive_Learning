import { memo, useId, useLayoutEffect, useMemo, useRef } from "react";
import { sanitizeRichHtml, stripRepeatedHtmlHeading } from "../../../shared/rich-html";

export const HtmlContent = memo(function HtmlContent({ html, source = false, headingTitles = [] }: { html: string; source?: boolean; headingTitles?: string[] }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const safeHtml = useMemo(() => stripRepeatedHtmlHeading(sanitizeRichHtml(html, { source, idPrefix: id }), headingTitles), [html, source, id, headingTitles]);
  useLayoutEffect(() => {
    if (source || !root.current) return;
    let cancelled = false;
    const fit = () => {
      if (cancelled) return;
      for (const svg of root.current?.querySelectorAll("svg") || []) {
        try {
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", svg.querySelector("title")?.textContent || "학습 도식");
          const bounds = svg.getBBox();
          const original = svg.viewBox.baseVal;
          const x = Math.min(original.x, bounds.x - 12);
          const y = Math.min(original.y, bounds.y - 12);
          const width = Math.max(original.x + original.width, bounds.x + bounds.width + 12) - x;
          const height = Math.max(original.y + original.height, bounds.y + bounds.height + 12) - y;
          if (width > 0 && height > 0 && width < 10_000 && height < 10_000) {
            svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
            svg.style.minWidth = `${Math.min(1000, Math.max(480, width))}px`;
          }
          // Keep wide diagrams readable and reachable from the keyboard.
          if (svg.parentElement?.tagName === "FIGURE") {
            svg.parentElement.removeAttribute("role");
            svg.parentElement.tabIndex = 0;
          }
        } catch { /* A non-renderable vector leaves the readable explanation intact. */ }
      }
    };
    fit();
    void document.fonts.ready.then(fit);
    return () => { cancelled = true; };
  }, [safeHtml, source]);
  return <div ref={root} className={`rich-html ${source ? "source-html" : "learning-html"}`} dangerouslySetInnerHTML={{ __html: safeHtml }} />;
});
