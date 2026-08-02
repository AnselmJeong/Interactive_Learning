import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileText } from "lucide-react";
import type { SourceSummary } from "../../../shared/rpc-types";

function sourceLabel(source: SourceSummary) {
  return source.title.replace(/^\s*\d+[.)]?\s+/, "").trim() || source.title;
}

export function SourceDropdown({
  sources,
  activeSourceId,
  busy,
  onSelect,
}: {
  sources: SourceSummary[];
  activeSourceId: string | null;
  busy: boolean;
  onSelect: (source: SourceSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = sources.find((source) => source.id === activeSourceId) || sources.find((source) => source.learningStatus === "in_progress") || sources[0] || null;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="project-dropdown source-dropdown" ref={ref}>
      <button type="button" className="pd-trigger" onClick={() => setOpen((value) => !value)} disabled={busy || !sources.length} aria-expanded={open}>
        <span className="pd-label">{active ? sourceLabel(active) : "Source 선택"}</span>
        <ChevronDown size={16} className={`pd-chevron ${open ? "open" : ""}`} />
      </button>
      {open ? (
        <div className="pd-panel">
          <div className="pd-list scrollable">
            {sources.map((source, index) => (
              <button
                key={source.id}
                type="button"
                className={`document-dropdown-item ${active?.id === source.id ? "active" : ""}`}
                disabled={busy}
                onClick={() => { onSelect(source); setOpen(false); }}
              >
                <FileText size={15} aria-hidden="true" />
                <span><strong>{index + 1}. {sourceLabel(source)}</strong><small>{source.learningStatus === "completed" ? "학습 완료" : source.learningStatus === "in_progress" ? "학습 중" : "학습 시작"}</small></span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
