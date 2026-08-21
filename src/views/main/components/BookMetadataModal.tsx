import { useState } from "react";
import { BookOpen, Check, FileText, Loader2, Pencil, Search, X } from "lucide-react";
import type { DocumentMetadataCandidate, DocumentMetadataSearchInput, DocumentSummary } from "../../../shared/rpc-types";

function candidateDetails(candidate: DocumentMetadataCandidate) {
  const publication = candidate.provider === "crossref" ? candidate.journal : candidate.publisher;
  return [candidate.authors.join(", "), publication, candidate.publishedDate?.slice(0, 4)].filter(Boolean).join(" · ");
}

export function BookMetadataModal({
  document,
  busy,
  onClose,
  onSearch,
  onApply,
  onApplyManual,
}: {
  document: DocumentSummary;
  busy: boolean;
  onClose: () => void;
  onSearch: (input: DocumentMetadataSearchInput) => Promise<DocumentMetadataCandidate[]>;
  onApply: (candidate: DocumentMetadataCandidate) => Promise<void>;
  onApplyManual: (title: string) => Promise<void>;
}) {
  const isBook = document.documentType === "book";
  const [title, setTitle] = useState(document.title);
  const [isbn, setIsbn] = useState(document.isbn13 || document.isbn10 || "");
  const [results, setResults] = useState<DocumentMetadataCandidate[]>([]);
  const [error, setError] = useState("");

  async function search() {
    setError("");
    setResults([]);
    try {
      const found = await onSearch(isBook ? { isbn } : { title });
      setResults(found);
      if (!found.length) {
        setError(isBook
          ? "이 ISBN과 일치하는 도서를 찾지 못했습니다. 제목을 직접 입력해 사용할 수 있습니다."
          : "Crossref에서 일치하는 논문을 찾지 못했습니다. 제목을 다듬어 다시 검색하거나 직접 사용할 수 있습니다.");
      }
    } catch (searchError) {
      setError((searchError as Error).message);
    }
  }

  async function applyManualTitle() {
    setError("");
    try {
      await onApplyManual(title);
    } catch (applyError) {
      setError((applyError as Error).message);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal book-metadata-modal" role="dialog" aria-modal="true" aria-labelledby="book-metadata-title">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{isBook ? "Book metadata" : "Article metadata"}</p>
            <h2 id="book-metadata-title">서지 정보 설정</h2>
            <p>{isBook
              ? "ISBN이 있는 도서는 Google Books에서 판본을 찾습니다. 등록되지 않은 자료는 입력한 제목을 그대로 사용할 수 있습니다."
              : "파일명에서 가져온 제목이나 직접 입력한 제목으로 Crossref를 검색합니다. 등록되지 않은 논문도 제목을 직접 저장할 수 있습니다."}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="닫기" aria-label="닫기"><X size={18} /></button>
        </header>

        <div className={`book-metadata-search-fields ${isBook ? "" : "single"}`}>
          <label>{isBook ? "직접 사용할 제목" : "논문 제목"}<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder={isBook ? "예: The Idea of the Self" : "파일명 또는 논문의 정확한 제목"} disabled={busy} /></label>
          {isBook ? <label>ISBN<input value={isbn} onChange={(event) => setIsbn(event.currentTarget.value)} placeholder="ISBN-10 또는 ISBN-13" disabled={busy} /></label> : null}
        </div>
        <p className="book-metadata-search-note">{isBook
          ? "Google Books 검색에는 ISBN이 필요합니다. ISBN이 없다면 왼쪽 제목을 확인한 뒤 직접 사용하세요."
          : "가져온 파일명을 바탕으로 제목을 채웠습니다. 검색 정확도를 높이려면 실제 논문 제목과 같도록 다듬어 주세요."}</p>
        {error ? <p className="book-metadata-error" role="alert">{error}</p> : null}

        <div className="book-metadata-results" aria-live="polite">
          {results.map((candidate) => (
            <article key={`${candidate.provider}:${candidate.providerRecordId}`} className="book-metadata-result">
              <div>
                <span className="book-metadata-result-icon">{candidate.provider === "crossref" ? <FileText size={18} /> : <BookOpen size={18} />}</span>
                <section>
                  <h3>{candidate.title}</h3>
                  {candidate.subtitle ? <p>{candidate.subtitle}</p> : null}
                  <small>{candidateDetails(candidate) || "출판 정보 없음"}</small>
                  {candidate.doi ? <em>DOI {candidate.doi}</em> : candidate.isbn13 || candidate.isbn10 ? <em>ISBN {candidate.isbn13 || candidate.isbn10}</em> : null}
                </section>
              </div>
              <button type="button" className="renovation-primary" disabled={busy} onClick={() => void onApply(candidate)}>
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} 이 서지 정보 적용
              </button>
            </article>
          ))}
        </div>

        <footer className="modal-actions book-metadata-actions">
          <button type="button" className="wide-button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="wide-button" onClick={() => void applyManualTitle()} disabled={busy || !title.trim()}>
            {busy ? <Loader2 size={16} className="spin" /> : <Pencil size={16} />} 입력한 제목 사용
          </button>
          <button type="button" className="wide-button primary" onClick={() => void search()} disabled={busy || (isBook ? !isbn.trim() : !title.trim())}>
            {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />} {isBook ? "Google Books 검색" : "Crossref 검색"}
          </button>
        </footer>
      </div>
    </div>
  );
}
