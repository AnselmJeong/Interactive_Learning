import { useState } from "react";
import { BookOpen, Check, Loader2, Search, X } from "lucide-react";
import type { BookMetadataCandidate, BookMetadataSearchInput, DocumentSummary } from "../../../shared/rpc-types";

function candidateDetails(candidate: BookMetadataCandidate) {
  return [candidate.authors.join(", "), candidate.publisher, candidate.publishedDate?.slice(0, 4)].filter(Boolean).join(" · ");
}

export function BookMetadataModal({
  document,
  busy,
  onClose,
  onSearch,
  onApply,
}: {
  document: DocumentSummary;
  busy: boolean;
  onClose: () => void;
  onSearch: (input: BookMetadataSearchInput) => Promise<BookMetadataCandidate[]>;
  onApply: (candidate: BookMetadataCandidate) => Promise<void>;
}) {
  const [title, setTitle] = useState(document.metadataStatus === "found" || document.metadataStatus === "manual" ? document.title : "");
  const [isbn, setIsbn] = useState(document.isbn13 || document.isbn10 || "");
  const [results, setResults] = useState<BookMetadataCandidate[]>([]);
  const [error, setError] = useState("");

  async function search() {
    setError("");
    setResults([]);
    try {
      const found = await onSearch({ title, isbn });
      setResults(found);
      if (!found.length) setError("일치하는 책을 찾지 못했습니다. 제목을 더 정확히 입력하거나 ISBN을 확인해 보세요.");
    } catch (searchError) {
      setError((searchError as Error).message);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal book-metadata-modal" role="dialog" aria-modal="true" aria-labelledby="book-metadata-title">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Book metadata</p>
            <h2 id="book-metadata-title">서지 정보 찾기</h2>
            <p>제목이나 ISBN으로 Google Books를 검색한 뒤, 맞는 판본을 직접 선택합니다.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="닫기" aria-label="닫기"><X size={18} /></button>
        </header>

        <div className="book-metadata-search-fields">
          <label>책 제목<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="예: The Idea of the Self" disabled={busy} /></label>
          <label>ISBN<input value={isbn} onChange={(event) => setIsbn(event.currentTarget.value)} placeholder="ISBN-10 또는 ISBN-13" disabled={busy} /></label>
        </div>
        <p className="book-metadata-search-note">ISBN을 입력하면 제목보다 ISBN을 우선하여 정확히 조회합니다.</p>
        {error ? <p className="book-metadata-error" role="alert">{error}</p> : null}

        <div className="book-metadata-results" aria-live="polite">
          {results.map((candidate) => (
            <article key={candidate.providerVolumeId} className="book-metadata-result">
              <div>
                <span className="book-metadata-result-icon"><BookOpen size={18} /></span>
                <section>
                  <h3>{candidate.title}</h3>
                  {candidate.subtitle ? <p>{candidate.subtitle}</p> : null}
                  <small>{candidateDetails(candidate) || "출판 정보 없음"}</small>
                  {candidate.isbn13 || candidate.isbn10 ? <em>ISBN {candidate.isbn13 || candidate.isbn10}</em> : null}
                </section>
              </div>
              <button type="button" className="renovation-primary" disabled={busy} onClick={() => void onApply(candidate)}>
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} 이 판본 적용
              </button>
            </article>
          ))}
        </div>

        <footer className="modal-actions">
          <button type="button" className="wide-button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="wide-button primary" onClick={() => void search()} disabled={busy || (!title.trim() && !isbn.trim())}>
            {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />} Google Books 검색
          </button>
        </footer>
      </div>
    </div>
  );
}
