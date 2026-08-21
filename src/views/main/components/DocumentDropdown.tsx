import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, Download, FolderInput, Search } from "lucide-react";
import type { DocumentSummary } from "../../../shared/rpc-types";

function bibliographicLabel(document: DocumentSummary) {
  if (document.metadataStatus !== "found" && document.metadataStatus !== "manual") return "서지 정보 없음";
  return [document.authors.join(", "), document.documentType === "article" ? document.journal : document.publisher, document.publishedDate?.slice(0, 4)].filter(Boolean).join(" · ") || "서지 정보 없음";
}

function displayDocumentTitle(document: DocumentSummary) {
  return document.documentType === "article" || document.metadataStatus === "found" || document.metadataStatus === "manual"
    ? document.title
    : "서지 정보 없는 책";
}

export function DocumentDropdown({
  documents,
  activeDocumentId,
  busy,
  onSelect,
  onImport,
  onExport,
  onFindMetadata,
}: {
  documents: DocumentSummary[];
  activeDocumentId: string | null;
  busy: boolean;
  onSelect: (document: DocumentSummary) => void;
  onImport: () => void;
  onExport: (document: DocumentSummary) => void;
  onFindMetadata: (document: DocumentSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = documents.find((document) => document.id === activeDocumentId) || documents[0] || null;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="project-dropdown document-dropdown" ref={ref}>
      <button type="button" className="pd-trigger" onClick={() => setOpen((value) => !value)} disabled={busy} aria-expanded={open}>
        <span className="pd-label">{active ? displayDocumentTitle(active) : "책·논문 선택"}</span>
        <ChevronDown size={16} className={`pd-chevron ${open ? "open" : ""}`} />
      </button>
      {open ? (
        <div className="pd-panel">
          <div className={`pd-list ${documents.length > 4 ? "scrollable" : ""}`}>
            {documents.length ? documents.map((document) => (
              <button
                key={document.id}
                type="button"
                className={`document-dropdown-item ${active?.id === document.id ? "active" : ""}`}
                disabled={busy}
                onClick={() => { onSelect(document); setOpen(false); }}
              >
                <BookOpen size={15} aria-hidden="true" />
                <span><strong>{displayDocumentTitle(document)}</strong><small>{bibliographicLabel(document)}</small></span>
              </button>
            )) : <p className="pd-empty">이 프로젝트에 아직 책·논문이 없습니다.</p>}
          </div>
          <div className="pd-transfer-actions" role="group" aria-label="책·논문 가져오기 및 내보내기">
            <button type="button" className="pd-transfer-action" aria-label="다른 프로젝트의 책·논문 가져오기" disabled={busy} onClick={() => { onImport(); setOpen(false); }}>
              <FolderInput size={17} aria-hidden="true" />
              <span className="pd-action-tooltip" role="tooltip">책·논문 가져오기</span>
            </button>
            {active ? (
              <button type="button" className="pd-transfer-action" aria-label="이 책·논문 내보내기" disabled={busy} onClick={() => { onExport(active); setOpen(false); }}>
                <Download size={17} aria-hidden="true" />
                <span className="pd-action-tooltip" role="tooltip">이 책·논문 내보내기</span>
              </button>
            ) : null}
            {active ? (
              <button type="button" className="pd-transfer-action" aria-label={`${active.documentType === "book" ? "Google Books" : "Crossref"}에서 서지 정보 찾기`} disabled={busy} onClick={() => { onFindMetadata(active); setOpen(false); }}>
                <Search size={17} aria-hidden="true" />
                <span className="pd-action-tooltip" role="tooltip">서지 정보 설정</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
