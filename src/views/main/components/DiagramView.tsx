import { useEffect, useMemo, useRef, useState } from "react";
import { mount, register, render, type Mounted } from "pele/core";
import flowchart from "pele/diagrams/flowchart";
import { diagramPlainText, diagramToMermaid, sanitizeDiagramSpec, type DiagramSpec } from "../../../shared/diagram-spec";
import { MarkdownContent } from "./MarkdownContent";
import { renderDiagramMath } from "../../../shared/diagram-math";

register(flowchart);

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
