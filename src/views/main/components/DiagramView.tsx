import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { mount, register, render, type MathMarkup, type Mounted } from "pele/core";
import flowchart from "pele/diagrams/flowchart";
import { diagramPlainText, diagramToMermaid, sanitizeDiagramSpec, type DiagramSpec } from "../../../shared/diagram-spec";
import { MarkdownContent } from "./MarkdownContent";

register(flowchart);

const mathCache = new Map<string, MathMarkup | null>();
let measureHost: HTMLDivElement | null = null;

/** Render TeX with KaTeX (same output as prose math) and measure it so Pele can size the node. */
export function renderDiagramMath(tex: string, size: number): MathMarkup | null {
  const key = `${size}\u0000${tex}`;
  if (mathCache.has(key)) return mathCache.get(key)!;
  let result: MathMarkup | null = null;
  try {
    const html = katex.renderToString(tex, { throwOnError: false, displayMode: false, output: "htmlAndMathml" });
    if (typeof document !== "undefined") {
      if (!measureHost || !measureHost.isConnected) {
        measureHost = document.createElement("div");
        measureHost.setAttribute("aria-hidden", "true");
        measureHost.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap;line-height:normal;";
        document.body.appendChild(measureHost);
      }
      measureHost.style.fontSize = `${size}px`;
      measureHost.innerHTML = html;
      const rect = (measureHost.firstElementChild || measureHost).getBoundingClientRect();
      const width = Math.ceil(rect.width) + 2;
      const height = Math.ceil(rect.height) + 2;
      measureHost.innerHTML = "";
      result = width > 2 ? { html, width, height } : { html, width: Math.ceil(tex.length * size * 0.55), height: Math.ceil(size * 1.4) };
    } else {
      result = { html, width: Math.ceil(tex.length * size * 0.55), height: Math.ceil(size * 1.4) };
    }
  } catch {
    result = null;
  }
  mathCache.set(key, result);
  return result;
}

function DiagramFallback({ spec }: { spec: DiagramSpec }) {
  const lines = diagramPlainText(spec).split("\n").filter(Boolean);
  return <MarkdownContent content={lines.map((line) => `- ${line}`).join("\n")} compact />;
}

/** Lays out and renders a structured diagram with Pele (Mermaid flowchart engine). */
export function DiagramView({ spec: rawSpec, label }: { spec: DiagramSpec; label?: string }) {
  const spec = useMemo(() => sanitizeDiagramSpec(rawSpec), [rawSpec]);
  const source = useMemo(() => (spec ? diagramToMermaid(spec) : ""), [spec]);
  // Synchronous first paint (also used for static markup); mount() then re-measures with real fonts and width.
  const initialSvg = useMemo(() => {
    if (!source) return "";
    try {
      return render(source, { math: renderDiagramMath }).svg;
    } catch {
      return "";
    }
  }, [source]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(!initialSvg);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !source) return;
    let mounted: Mounted | null = null;
    try {
      mounted = mount(host, source, { zoom: false, math: renderDiagramMath, onError: () => setFailed(true) });
      setFailed(Boolean(mounted.error));
    } catch {
      setFailed(true);
    }
    return () => mounted?.destroy();
  }, [source]);

  if (!spec) return null;
  return (
    <div className="learn-diagram-canvas" role={failed ? undefined : "img"} aria-label={failed ? undefined : label || diagramPlainText(spec).replace(/\n/g, "; ")}>
      <div ref={hostRef} className="learn-diagram-host" hidden={failed} dangerouslySetInnerHTML={{ __html: initialSvg }} />
      {failed ? <DiagramFallback spec={spec} /> : null}
    </div>
  );
}
