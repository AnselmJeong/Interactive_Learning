import { useMemo, useState } from "react";
import { BookOpen, Check, FileText, Loader2, X } from "lucide-react";
import type { DocumentType } from "../../../shared/artifact-types";

export function SourceDocumentTypeModal({
  paths,
  busy,
  onCancel,
  onContinue,
}: {
  paths: string[];
  busy: boolean;
  onCancel: () => void;
  onContinue: (documentType: DocumentType) => Promise<void>;
}) {
  const [documentType, setDocumentType] = useState<DocumentType>("book");
  const allPdf = useMemo(() => paths.length > 0 && paths.every((path) => path.toLowerCase().endsWith(".pdf")), [paths]);
  const visibleNames = paths.slice(0, 3).map((path) => path.split(/[\\/]/).at(-1) || path);

  return (
    <div className="modal-backdrop">
      <div className="modal source-type-modal" role="dialog" aria-modal="true" aria-labelledby="source-type-title">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Document type</p>
            <h2 id="source-type-title">어떤 문서인가요?</h2>
            <p>선택한 문서에 맞는 방식으로 학습 소스를 준비합니다.</p>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} title="닫기" aria-label="닫기">
            <X size={18} />
          </button>
        </header>

        <div className="source-type-files" aria-label="선택한 파일">
          {visibleNames.map((name, index) => <span key={`${index}:${name}`}>{name}</span>)}
          {paths.length > visibleNames.length ? <small>외 {paths.length - visibleNames.length}개</small> : null}
        </div>

        <div className="source-type-options" role="radiogroup" aria-label="문서 종류">
          <button
            type="button"
            className={`source-type-option ${documentType === "book" ? "active" : ""}`}
            role="radio"
            aria-checked={documentType === "book"}
            onClick={() => setDocumentType("book")}
            disabled={busy}
            autoFocus
          >
            <BookOpen size={22} aria-hidden="true" />
            <span>
              <strong>Book</strong>
              <small>chapter를 나누어 선택하고 가져옵니다.</small>
            </span>
            {documentType === "book" ? <Check size={17} aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            className={`source-type-option ${documentType === "article" ? "active" : ""}`}
            role="radio"
            aria-checked={documentType === "article"}
            aria-disabled={!allPdf || busy}
            onClick={() => allPdf && setDocumentType("article")}
            disabled={!allPdf || busy}
          >
            <FileText size={22} aria-hidden="true" />
            <span>
              <strong>Article</strong>
              <small>PDF 한 편을 source 하나로 가져오고 references를 제외합니다.</small>
            </span>
            {documentType === "article" ? <Check size={17} aria-hidden="true" /> : null}
          </button>
        </div>

        {!allPdf ? <p className="source-type-note">Article mode는 현재 PDF 파일만 지원합니다.</p> : null}

        <footer className="modal-actions">
          <button type="button" className="wide-button" onClick={onCancel} disabled={busy}>취소</button>
          <button type="button" className="wide-button primary" onClick={() => void onContinue(documentType)} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} 가져오기 준비
          </button>
        </footer>
      </div>
    </div>
  );
}
