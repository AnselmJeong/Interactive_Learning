/**
 * TeX → pure SVG for diagram labels.
 *
 * Pele places math either as HTML in a <foreignObject> or as nested SVG. KaTeX HTML relies on
 * CSS-positioned spans, which WebKit (the macOS app's WKWebView) mis-positions inside
 * <foreignObject>: glyphs pile on top of each other and drift away from their node. MathJax's
 * SVG output is plain paths with an exact viewBox, so it lays out identically in every engine,
 * needs no DOM measurement, and gives Pele exact sizes.
 */
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";

export type DiagramMathMarkup = { svg: string; width: number; height: number };

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const document = mathjax.document("", {
  InputJax: new TeX({ packages: ["base", "ams", "boldsymbol", "newcommand", "noundefined"] }),
  // Inline paths (no shared <defs>), so many diagrams on one page never share or collide on ids.
  OutputJax: new SVG({ fontCache: "none" }),
});

const cache = new Map<string, DiagramMathMarkup | null>();
const round = (value: number) => Math.round(value * 100) / 100;

/** Render inline TeX at the given font size (px) to standalone SVG with its pixel size. */
export function renderDiagramMath(tex: string, size: number): DiagramMathMarkup | null {
  const key = `${size}\u0000${tex}`;
  if (cache.has(key)) return cache.get(key)!;
  let result: DiagramMathMarkup | null = null;
  try {
    const container = document.convert(tex, { display: false });
    const svg = adaptor.firstChild(container) as Parameters<typeof adaptor.getAttribute>[0];
    const viewBox = String(adaptor.getAttribute(svg, "viewBox") || "").split(/\s+/).map(Number);
    if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0) {
      // MathJax viewBox units are 1/1000 em.
      const width = round((viewBox[2]! / 1000) * size);
      const height = round((viewBox[3]! / 1000) * size);
      adaptor.setAttribute(svg, "width", String(width));
      adaptor.setAttribute(svg, "height", String(height));
      adaptor.removeAttribute(svg, "style");
      adaptor.setAttribute(svg, "aria-hidden", "true");
      result = { svg: adaptor.outerHTML(svg), width, height };
    }
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}
