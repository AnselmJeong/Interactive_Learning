import { parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { comparableHeadingTitle } from "./display-title";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const HTML_TAGS = new Set("a abbr article aside b blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var".split(" "));
const SVG_TAGS = new Set("svg g path rect circle ellipse line polyline polygon text tspan title desc defs marker linearGradient radialGradient stop clipPath".split(" "));
const MATH_TAGS = new Set("math mrow mi mn mo ms mtext mspace msqrt mroot mfrac msup msub msubsup munder mover munderover mtable mtr mtd mfenced menclose mstyle mpadded mphantom semantics".split(" "));
const DROP_TAGS = new Set("script style iframe frame object embed template noscript link meta base form input button textarea select foreignObject annotation annotation-xml".split(" "));
const ATTRS = new Set("title alt lang dir colspan rowspan scope start reversed value open datetime width height viewBox preserveAspectRatio d x y x1 x2 y1 y2 cx cy r rx ry points fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline offset stop-color stop-opacity markerWidth markerHeight refX refY orient markerUnits display mathvariant mathsize mathcolor mathbackground columnalign rowalign columnspacing rowspacing stretchy fence separator lspace rspace notation encoding".split(" "));
const STYLE = new Set("font-weight font-style text-align text-decoration text-indent vertical-align white-space font-variant font-size line-height".split(" "));

export function isHtmlElement(node: Node): node is Element {
  return "tagName" in node;
}

/** Remove only opening headings supplied by the enclosing reader/block title.
 * Stop at the first distinct heading or content; later sections keep their titles.
 * Keep anchor IDs even when their visible heading is redundant.
 */
export function stripRepeatedHtmlHeading(html: string, titles: string[]): string {
  const keys = new Set(titles.map(comparableHeadingTitle).filter(Boolean));
  if (!keys.size) return html;
  const root = parseFragment(html);
  let changed = false;
  const visit = (parent: DefaultTreeAdapterTypes.ParentNode): boolean => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeName === "#comment" || ("value" in node && !node.value.trim())) continue;
      if (!isHtmlElement(node)) return false;
      if (/^(article|section|div|header)$/.test(node.tagName)) {
        if (node.attrs.some((attr) => attr.name === "class" && /\blearn-/.test(attr.value))) return false;
        if (!visit(node)) return false;
        continue;
      }
      if (!/^h[1-6]$/.test(node.tagName) || !keys.has(comparableHeadingTitle(richHtmlText(serialize(node))))) return false;
      // Empty spans retain fragment targets without creating blank headings.
      const anchors: Element[] = [];
      const collect = (element: Element) => {
        const id = element.attrs.find((attr) => attr.name === "id");
        if (id) anchors.push({ nodeName: "span", tagName: "span", namespaceURI: element.namespaceURI, attrs: [id], childNodes: [], parentNode: parent });
        element.childNodes.filter(isHtmlElement).forEach(collect);
      };
      collect(node);
      parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...anchors);
      changed = true;
    }
    return true;
  };
  visit(root);
  return changed ? serialize(root) : html;
}

/** Text for search, prompts and accessibility; never sends markup to speech/history. */
export function richHtmlText(html: string): string {
  const walk = (node: Node): string => {
    if ("value" in node) return node.value;
    if (!isHtmlElement(node)) return "childNodes" in node ? node.childNodes.map(walk).join("") : "";
    if (DROP_TAGS.has(node.tagName)) return "";
    const text = node.childNodes.map(walk).join("");
    return /^(p|div|section|article|li|tr|td|th|h[1-6]|br|figcaption|summary)$/.test(node.tagName) ? `${text}\n` : text;
  };
  return walk(parseFragment(html)).replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function safeImage(url: string) {
  // Local source assets are embedded by the importer after checking their location.
  return /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url);
}

/** A deliberately passive subset: rich layout, vector diagrams, MathML and native disclosures. */
export function sanitizeRichHtml(html: string, options: { source?: boolean; idPrefix?: string } = {}): string {
  const root = parseFragment(html);
  const prefix = (options.idPrefix || "rich").replace(/[^a-zA-Z0-9_-]/g, "-");
  const ids = new Map<string, string>();
  const collect = (node: Node) => {
    if (isHtmlElement(node)) {
      const id = node.attrs.find((a) => a.name === "id")?.value;
      if (id) ids.set(id, `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
    }
    if ("childNodes" in node) node.childNodes.forEach(collect);
  };
  collect(root);
  const clean = (parent: DefaultTreeAdapterTypes.ParentNode) => {
    parent.childNodes = parent.childNodes.flatMap((node) => {
      if (!isHtmlElement(node)) return node.nodeName === "#text" ? [node] : [];
      if (DROP_TAGS.has(node.tagName)) return [];
      const allowed = node.namespaceURI === "http://www.w3.org/2000/svg" ? SVG_TAGS : node.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? MATH_TAGS : HTML_TAGS;
      clean(node);
      if (!allowed.has(node.tagName)) {
        node.childNodes.forEach((child) => { child.parentNode = parent; });
        return node.childNodes;
      }
      node.attrs = node.attrs.flatMap((attr) => {
        const { name, value } = attr;
        if (attr.namespace || name.startsWith("on")) return [];
        if (name === "id") return ids.has(value) ? [{ name, value: ids.get(value)! }] : [];
        if (name === "class") {
          const classes = value.split(/\s+/).filter((c) => /^learn-(?:lead|compare|process|concept|aside|equation|caption|diagram|contrast|takeaway|steps)$/.test(c));
          return classes.length ? [{ name, value: classes.join(" ") }] : [];
        }
        if (name === "href" && node.tagName === "a") {
          if (value.startsWith("#") && ids.has(value.slice(1))) return [{ name, value: `#${ids.get(value.slice(1))}` }];
          return /^https?:\/\/[^\s<>]+$/i.test(value) ? [attr] : [];
        }
        if (name === "src" && node.tagName === "img") return safeImage(value) ? [attr] : [];
        if (name === "style" && options.source) {
          const style = value.split(";").filter((entry) => {
            const [key, val = ""] = entry.split(":");
            return STYLE.has(key?.trim().toLowerCase() || "") && /^[\w\s.%+-]+$/.test(val) && !/expression|url|var\(/i.test(val);
          }).join(";");
          return style ? [{ name, value: style }] : [];
        }
        if (/^(marker-start|marker-end|clip-path)$/.test(name)) {
          const id = /^url\(#([^\s)]+)\)$/.exec(value)?.[1];
          return id && ids.has(id) ? [{ name, value: `url(#${ids.get(id)})` }] : [];
        }
        if (/^(aria-label|aria-hidden|role)$/.test(name)) return [attr];
        if (!ATTRS.has(name) || /url\s*\(|expression|javascript:|[<>]/i.test(value)) return [];
        return [attr];
      });
      if (node.tagName === "a" && node.attrs.some((a) => a.name === "href" && !a.value.startsWith("#"))) {
        node.attrs.push({ name: "target", value: "_blank" }, { name: "rel", value: "noopener noreferrer" });
      }
      if (node.tagName === "img") {
        if (!node.attrs.some((attr) => attr.name === "src")) {
          const alt = node.attrs.find((attr) => attr.name === "alt")?.value;
          return alt ? [{ nodeName: "#text", value: alt, parentNode: parent } as DefaultTreeAdapterTypes.TextNode] : [];
        }
        node.attrs.push({ name: "loading", value: "lazy" });
      }
      return [node];
    });
  };
  clean(root);
  return serialize(root);
}

/** Keep tables, figures, lists and math intact while separating document containers. */
export function richHtmlBlocks(html: string) {
  const blocks: string[] = [];
  const walk = (node: Node) => {
    if (isHtmlElement(node) && /^(article|section|div|main|body|html)$/.test(node.tagName)) node.childNodes.forEach(walk);
    else if (isHtmlElement(node) || ("value" in node && node.value.trim())) blocks.push(serializeOuter(node));
  };
  parseFragment(html).childNodes.forEach(walk);
  return blocks;
}
