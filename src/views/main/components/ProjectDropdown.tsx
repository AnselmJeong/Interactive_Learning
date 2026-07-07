import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { ProjectSummary } from "../../../shared/rpc-types";

export function ProjectDropdown({
  projects,
  activeProject,
  busy,
  onSelect,
  onCreate,
  onDelete,
}: {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  busy: boolean;
  onSelect: (project: ProjectSummary) => void;
  onCreate: () => void;
  onDelete: (project: ProjectSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="project-dropdown" ref={ref}>
      <button
        type="button"
        className="pd-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-expanded={open}
      >
        <span className="pd-label">{activeProject?.title || "프로젝트 선택"}</span>
        <ChevronDown size={16} className={`pd-chevron ${open ? "open" : ""}`} />
      </button>

      {open ? (
        <div className="pd-panel">
          <div className="pd-list">
            {projects.length ? (
              projects.map((project) => (
                <div
                  key={project.id}
                  className={`pd-row ${activeProject?.id === project.id ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="pd-item"
                    disabled={busy}
                    onClick={() => {
                      onSelect(project);
                      setOpen(false);
                    }}
                  >
                    <span>{project.title}</span>
                    <small>{new Date(project.updatedAt).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })}</small>
                  </button>
                  <button
                    type="button"
                    className="pd-delete"
                    title="프로젝트 삭제"
                    aria-label={`${project.title} 프로젝트 삭제`}
                    disabled={busy}
                    onClick={() => {
                      onDelete(project);
                      setOpen(false);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            ) : (
              <p className="pd-empty">아직 프로젝트가 없습니다.</p>
            )}
          </div>
          <div className="pd-actions">
            <button type="button" className="pd-action pd-create" disabled={busy} onClick={() => { onCreate(); setOpen(false); }}>
              <Plus size={15} /> 새 프로젝트
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
