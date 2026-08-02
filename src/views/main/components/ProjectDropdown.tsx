import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FolderInput, Plus, Trash2 } from "lucide-react";
import type { ProjectSummary } from "../../../shared/rpc-types";

export function ProjectDropdown({
  projects,
  activeProject,
  busy,
  onSelect,
  onCreate,
  onImport,
  onExport,
  onDelete,
}: {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  busy: boolean;
  onSelect: (project: ProjectSummary) => void;
  onCreate: () => void;
  onImport: () => void;
  onExport: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollable = projects.length > 4;

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
          <div className={`pd-list ${scrollable ? "scrollable" : ""}`}>
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
            <div className="pd-transfer-actions" role="group" aria-label="프로젝트 가져오기 및 내보내기">
              <button
                type="button"
                className="pd-transfer-action"
                aria-label="프로젝트 불러오기"
                disabled={busy}
                onClick={() => { onImport(); setOpen(false); }}
              >
                <FolderInput size={17} aria-hidden="true" />
                <span className="pd-action-tooltip" role="tooltip">프로젝트 불러오기</span>
              </button>
              {activeProject ? (
                <button
                  type="button"
                  className="pd-transfer-action"
                  aria-label="다른 컴퓨터로 내보내기"
                  disabled={busy}
                  onClick={() => { onExport(activeProject); setOpen(false); }}
                >
                  <Download size={17} aria-hidden="true" />
                  <span className="pd-action-tooltip" role="tooltip">다른 컴퓨터로 내보내기</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
