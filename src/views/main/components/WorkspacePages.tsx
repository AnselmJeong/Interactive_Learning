import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { ArrowRight, BookOpen, Download, Search, Trash2, Upload } from "lucide-react";
import type { DocumentProgressSnapshot, DocumentSummary, LearningActivityDay, ProjectProgressSnapshot, ProjectSummary, SourceSummary } from "../../../shared/rpc-types";
import type { MaterialAnnotation, NoteImageUpload } from "../../../shared/artifact-types";
import type { TutorMessage } from "../../../shared/tutor-types";
import { AnnotationInlineScope } from "./AnnotationInlineScope";
import { MarkdownContent } from "./MarkdownContent";
import { TutorBlockRenderer } from "./TutorBlockRenderer";
import { MAX_NOTE_IMAGES, NoteImageGallery, noteImageUpload, readPastedNoteImages, type PendingNoteImage } from "./NoteImages";
import { AnnotationExternalHtmlAttachment } from "./AnnotationExternalHtmlAttachment";

type LibraryPageProps = {
  project: ProjectSummary | null;
  documents: DocumentSummary[];
  sources: SourceSummary[];
  selectedDocumentId: string | null;
  progress: ProjectProgressSnapshot | null;
  busy: boolean;
  onImport: () => void;
  onExportProject: (project: ProjectSummary) => void;
  onOpenDocument: (documentId: string) => void;
  onFindMetadata: (document: DocumentSummary) => void;
  onDeleteDocument: (document: DocumentSummary) => void;
};

function formatRelativeTime(timestamp: number | null) {
  if (!timestamp) return "아직 학습하지 않음";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  return `${days}일 전`;
}

function documentProgress(document: DocumentSummary, sources: SourceSummary[], progress?: ProjectProgressSnapshot | null) {
  const snapshot = progress?.documents.find((item) => item.documentId === document.id);
  if (snapshot) return snapshot.percent;
  if (document.learning.totalChunks > 0) return document.learning.percent;
  const children = sources.filter((source) => source.documentId === document.id);
  if (!children.length) return 0;
  const score = children.reduce((sum, source) => sum + (source.learningStatus === "completed" ? 100 : source.learningStatus === "in_progress" ? 13 : 0), 0);
  return Math.round(score / children.length);
}

function coverTone(index: number) {
  return ["ink", "forest", "clay", "ochre"][index % 4];
}

function withoutLeadingIndex(title: string) {
  return title.replace(/^\s*\d+[.)]?\s+/, "").trim() || title;
}

export function LibraryPage({ project, documents, sources, selectedDocumentId, progress, busy, onImport, onExportProject, onOpenDocument, onFindMetadata, onDeleteDocument }: LibraryPageProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredDocuments = documents.filter((document) => {
    if (!normalizedQuery) return true;
    const sourceTitles = sources.filter((source) => source.documentId === document.id).map((source) => source.title).join(" ");
    return [document.title, document.subtitle, document.authors.join(" "), document.publisher, document.isbn10, document.isbn13, sourceTitles]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const activeDocument = documents.find((document) => document.id === selectedDocumentId)
    || documents.find((document) => document.learning.status === "in_progress")
    || documents[0]
    || null;
  const activeProgress = activeDocument ? documentProgress(activeDocument, sources, progress) : 0;
  const heroTitle = project?.title || "새로운 프로젝트";

  return (
    <div className="renovation-page library-page">
      <header className="renovation-header">
        <div>
          <p className="renovation-kicker">Project</p>
          <h2>나의 프로젝트</h2>
          <span>책 {documents.filter((document) => document.documentType === "book").length}권 · 논문 {documents.filter((document) => document.documentType === "article").length}편 · 마지막 학습 {formatRelativeTime(activeDocument?.lastStudiedAt || null)}</span>
        </div>
        <label className="library-search">
          <Search size={19} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="제목이나 저자로 검색" aria-label="프로젝트 자료 검색" />
        </label>
      </header>

      <div className="renovation-scroll">
        <section className="library-hero">
          <div>
            <p>Current project</p>
            <h3>{heroTitle}</h3>
          </div>
          <button type="button" className="library-project-export" disabled={!project || busy} onClick={() => { if (project) onExportProject(project); }}>
            <Download size={17} aria-hidden="true" /> 프로젝트 내보내기
          </button>
        </section>

        <section className="library-collection">
          <div className="renovation-section-heading">
            <div>
              <h3>학습 중인 책·논문</h3>
              <p>읽은 양보다 이해한 지점을 기준으로 정리합니다.</p>
            </div>
            <button type="button" className="text-action" onClick={onImport}><Upload size={15} /> 새 책·논문 가져오기</button>
          </div>
          {filteredDocuments.length ? (
            <div className="document-grid">
              {filteredDocuments.map((document, index) => {
                const progressValue = documentProgress(document, sources, progress);
                const hasBibliography = document.documentType !== "book" || document.metadataStatus === "found" || document.metadataStatus === "manual";
                const title = hasBibliography ? document.title : "서지 정보 없음";
                const bibliographicLine = document.documentType === "book"
                  ? [document.authors.join(", "), document.publisher, document.publishedDate?.slice(0, 4)].filter(Boolean).join(" · ")
                  : [document.authors.join(", "), document.journal, document.publishedDate?.slice(0, 4)].filter(Boolean).join(" · ");
                return (
                  <article key={document.id} className={`document-tile ${selectedDocumentId === document.id ? "selected" : ""}`}>
                    <button type="button" className="document-tile-open" onClick={() => onOpenDocument(document.id)} aria-label={`${title} 학습 열기`}>
                      <span className={`book-cover ${coverTone(index)}`}>
                        {document.coverUrl ? <img src={document.coverUrl} alt={`${title} 표지`} /> : hasBibliography ? <em>{title}</em> : null}
                      </span>
                      <span className="document-copy">
                        <strong>{title}</strong>
                        <span className="document-kind-line">{document.documentType === "book" ? "책" : "논문"} · Source {document.sourceCount}개</span>
                        {hasBibliography && document.subtitle ? <span className="document-subtitle">{document.subtitle}</span> : null}
                        <small>{bibliographicLine || "서지 정보 없음"}</small>
                        <b>{progressValue ? `${progressValue}% learned` : document.preparation.percent >= 100 ? "학습 준비 완료" : "아직 시작하지 않음"}</b>
                      </span>
                    </button>
                    <div className="document-tile-actions">
                      <button
                        type="button"
                        className="document-tile-action document-metadata-action"
                        onClick={() => onFindMetadata(document)}
                        aria-label={`${title} 서지 정보 설정`}
                        title="서지 정보 설정"
                      ><Search size={16} aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="document-tile-action document-delete-action"
                        onClick={() => onDeleteDocument(document)}
                        aria-label={`${title} ${document.documentType === "book" ? "책" : "논문"} 삭제`}
                        title={`${document.documentType === "book" ? "책" : "논문"} 전체 삭제`}
                      ><Trash2 size={16} aria-hidden="true" /></button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="renovation-empty">
              <BookOpen size={28} />
              <h3>{query ? "검색 결과가 없습니다" : "첫 자료를 가져오세요"}</h3>
              <p>{query ? "다른 제목이나 저자로 검색해 보세요." : "PDF, EPUB, Markdown 또는 Learnie 내보내기 ZIP을 가져올 수 있습니다."}</p>
              {!query ? <button type="button" className="renovation-primary" onClick={onImport}><Upload size={16} /> 책·논문 가져오기</button> : null}
            </div>
          )}
        </section>

        {activeDocument?.documentType === "article" ? (
          <section className="library-article-overview">
            <p className="renovation-kicker">Article</p>
            <h3>{activeDocument.title}</h3>
            <p>{activeDocument.description || activeDocument.subtitle || [activeDocument.authors.join(", "), activeDocument.journal, activeDocument.publishedDate].filter(Boolean).join(" · ") || "이 논문은 하나의 Source로 바로 학습할 수 있습니다."}</p>
            <button type="button" className="renovation-primary" onClick={() => {
              onOpenDocument(activeDocument.id);
            }}>논문 {activeProgress ? "계속 학습하기" : "학습 시작"} <ArrowRight size={16} /></button>
          </section>
        ) : null}
      </div>
    </div>
  );
}

type AnnotationPageProps = {
  project: ProjectSummary | null;
  annotations: MaterialAnnotation[];
  documents: DocumentSummary[];
  sources: SourceSummary[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (annotationId: string) => void;
  onLoadLearningMessage: (messageId: string) => Promise<TutorMessage>;
  onOpenAnnotation: (annotation: MaterialAnnotation) => void;
  onExport: (annotationIds: string[]) => void;
  exporting: boolean;
  onDelete: (annotation: MaterialAnnotation) => void;
  onUpdateNote: (annotationId: string, note: string, imagesToAdd?: NoteImageUpload[], imageIdsToRemove?: string[]) => Promise<void>;
};

type AnnotationFilter = "all" | "highlight" | "note" | "question" | "lookup" | "image";

function isQuestionAnnotation(annotation: MaterialAnnotation) {
  return annotation.kind === "question" || annotation.result.kind === "question_thread";
}

function isLookupAnnotation(annotation: MaterialAnnotation) {
  return annotation.kind === "lookup" || annotation.kind === "define" || annotation.result.kind === "lookup" || annotation.result.kind === "define";
}

export function lookupKeyword(annotation: MaterialAnnotation): string {
  const result = annotation.result;
  if (result.kind === "lookup" || result.kind === "define") return result.query || annotation.selectedText;
  return annotation.selectedText;
}

export function questionPrompt(annotation: MaterialAnnotation): string {
  const result = annotation.result;
  if (result.kind === "question_thread") {
    return result.messages.find((message) => message.role === "user")?.content || result.title || "질문";
  }
  if (result.kind === "question") return result.question || result.query || result.title || "질문";
  return annotation.selectedText || "질문";
}

export function questionAnswer(annotation: MaterialAnnotation): string {
  const result = annotation.result;
  if (result.kind === "question_thread") {
    return result.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n\n").trim();
  }
  if (result.kind === "question") return result.body;
  return "";
}

function annotationTitle(annotation: MaterialAnnotation): string {
  const result = annotation.result;
  if (isQuestionAnnotation(annotation)) return questionPrompt(annotation);
  if (isLookupAnnotation(annotation)) return lookupKeyword(annotation);
  if (result.kind === "note") return result.note.split("\n")[0]?.slice(0, 72) || "내 노트";
  if (result.kind === "define" || result.kind === "lookup") return result.title;
  return annotation.selectedText.slice(0, 72) || "하이라이트";
}

function annotationBody(annotation: MaterialAnnotation): string {
  const result = annotation.result;
  if (result.kind === "note") return result.note;
  if (isQuestionAnnotation(annotation)) return questionAnswer(annotation);
  if (result.kind === "define" || result.kind === "lookup") return result.body;
  if (result.kind === "image") return result.body || result.warning || result.query;
  return annotation.selectedText;
}

export function annotationListPreview(annotation: MaterialAnnotation) {
  // A highlight is already represented by its selected text as the list title.
  // Rendering it again as a preview creates a visually identical second line.
  if (annotation.kind === "highlight") return null;
  if (isQuestionAnnotation(annotation)) return annotation.selectedText.replace(/\s+/g, " ").slice(0, 120);
  if (isLookupAnnotation(annotation)) return null;
  return annotationBody(annotation).replace(/\s+/g, " ").slice(0, 120);
}

export function AnnotationPage({ project, annotations, documents, sources, selectedAnnotationId, onSelectAnnotation, onLoadLearningMessage, onOpenAnnotation, onExport, exporting, onDelete, onUpdateNote }: AnnotationPageProps) {
  const [filter, setFilter] = useState<AnnotationFilter>("all");
  const [query, setQuery] = useState("");
  const [documentId, setDocumentId] = useState("all");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [pendingNoteImages, setPendingNoteImages] = useState<PendingNoteImage[]>([]);
  const [removedNoteImageIds, setRemovedNoteImageIds] = useState<string[]>([]);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [learningMessage, setLearningMessage] = useState<TutorMessage | null>(null);
  const [learningMessageStatus, setLearningMessageStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = annotations.filter((annotation) => {
    if (filter !== "all") {
      if (filter === "lookup" && annotation.kind !== "lookup" && annotation.kind !== "define") return false;
      if (filter !== "lookup" && annotation.kind !== filter) return false;
    }
    const source = annotation.sourceId ? sources.find((item) => item.id === annotation.sourceId) : null;
    if (documentId !== "all" && source?.documentId !== documentId) return false;
    if (normalizedQuery && ![annotation.selectedText, annotationTitle(annotation), annotationBody(annotation), source?.title]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedQuery)) return false;
    return true;
  });
  const selected = annotations.find((annotation) => annotation.id === selectedAnnotationId) || filtered[0] || null;
  const selectedSource = selected?.sourceId ? sources.find((source) => source.id === selected.sourceId) : null;

  async function pasteNoteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = await readPastedNoteImages(event.clipboardData);
    if (!pasted.length) return;
    const existingCount = selected?.result.kind === "note"
      ? (selected.result.images || []).filter((image) => !removedNoteImageIds.includes(image.id)).length
      : 0;
    if (existingCount + pendingNoteImages.length + pasted.length > MAX_NOTE_IMAGES) {
      throw new Error(`노트에는 이미지를 최대 ${MAX_NOTE_IMAGES}개까지 저장할 수 있습니다.`);
    }
    setPendingNoteImages((current) => [...current, ...pasted]);
  }

  useEffect(() => {
    let cancelled = false;
    setLearningMessage(null);
    if (!selected || selected.kind !== "highlight" || !selected.anchorMessageId) {
      setLearningMessageStatus("idle");
      return () => { cancelled = true; };
    }
    setLearningMessageStatus("loading");
    void onLoadLearningMessage(selected.anchorMessageId)
      .then((message) => {
        if (cancelled) return;
        setLearningMessage(message);
        setLearningMessageStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setLearningMessageStatus("unavailable");
      });
    return () => { cancelled = true; };
  }, [onLoadLearningMessage, selected?.anchorMessageId, selected?.id, selected?.kind]);

  const inlineAnnotationsByBlockId = useMemo(() => {
    const blocks = new Map<string, MaterialAnnotation[]>();
    if (!selected || selected.kind !== "highlight" || !learningMessage?.blocks?.length) return blocks;
    if (selected.anchorBlockId) {
      blocks.set(selected.anchorBlockId, [selected]);
      return blocks;
    }
    learningMessage.blocks.forEach((_, index) => blocks.set(`${learningMessage.id}:block-${index}`, [selected]));
    return blocks;
  }, [learningMessage?.blocks, learningMessage?.id, selected]);

  return (
    <div className="renovation-page annotation-page">
      <header className="renovation-header">
        <div><p className="renovation-kicker">Reading traces</p><h2>하이라이트 · 노트</h2><span>{project?.title || "Project"} · {annotations.length}개의 기록</span></div>
        <button type="button" className="renovation-secondary" onClick={() => onExport(filtered.map((annotation) => annotation.id))} disabled={!filtered.length || exporting}><Download size={16} /> {exporting ? "내보내는 중" : `${filtered.length}개 내보내기`}</button>
      </header>
      <div className="annotation-layout">
        <section className="annotation-index">
          <div className="annotation-filters" aria-label="기록 필터">
            {([['all', '전체'], ['highlight', '하이라이트'], ['note', '내 노트'], ['question', '질문'], ['lookup', '찾아보기'], ['image', '이미지']] as const).map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <div className="annotation-search-row">
            <label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="기록 검색" aria-label="Annotation 검색" /></label>
            <select value={documentId} onChange={(event) => setDocumentId(event.currentTarget.value)} aria-label="자료별 필터">
              <option value="all">모든 자료</option>
              {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
            </select>
          </div>
          <div className="annotation-list">
            {filtered.map((annotation) => {
              const source = annotation.sourceId ? sources.find((item) => item.id === annotation.sourceId) : null;
              const question = isQuestionAnnotation(annotation);
              const lookup = isLookupAnnotation(annotation);
              return (
                <button key={annotation.id} type="button" className={selected?.id === annotation.id ? "active" : ""} onClick={() => onSelectAnnotation(annotation.id)}>
                  {!lookup ? <small>{new Date(annotation.updatedAt).toLocaleDateString("ko-KR")} · {source?.title || "학습 기록"}</small> : null}
                  <strong className={question ? "annotation-list-question-title" : undefined}>{annotationTitle(annotation)}</strong>
                  {annotationListPreview(annotation) ? <span className={question ? "annotation-list-selected-text" : undefined}>{annotationListPreview(annotation)}</span> : null}
                </button>
              );
            })}
            {!filtered.length ? <div className="renovation-empty compact"><h3>아직 기록이 없습니다</h3><p>학습 공간에서 문장을 선택해 하이라이트하거나 노트를 남겨 보세요.</p></div> : null}
          </div>
        </section>
        <article className="annotation-detail">
          {selected ? (
            <div>
              {!isLookupAnnotation(selected) ? <p className="renovation-kicker">{selected.kind === "note" ? "내 노트" : selected.kind === "highlight" ? "하이라이트" : isQuestionAnnotation(selected) ? "질문" : "AI 대화"} · {new Date(selected.updatedAt).toLocaleString("ko-KR")}</p> : null}
              {selected.kind === "highlight" ? (
                <div className="annotation-learning-context">
                  {learningMessageStatus === "loading" ? <p className="annotation-source-context-status">학습 자료를 불러오는 중입니다.</p> : null}
                  {learningMessage?.blocks?.length ? (
                    <TutorBlockRenderer
                      blocks={learningMessage.blocks}
                      messageId={learningMessage.id}
                      inlineAnnotationsByBlockId={inlineAnnotationsByBlockId}
                      activeAnnotationId={selected.id}
                    />
                  ) : learningMessage ? (
                    <AnnotationInlineScope annotations={[selected]} activeAnnotationId={selected.id}>
                      <MarkdownContent content={learningMessage.content} />
                    </AnnotationInlineScope>
                  ) : null}
                  {learningMessageStatus === "unavailable" ? <p className="annotation-source-context-status">이 하이라이트가 속한 학습 자료를 찾을 수 없습니다.</p> : null}
                </div>
              ) : isLookupAnnotation(selected) ? (
                <div className="annotation-lookup-detail">
                  <p className="annotation-lookup-keyword">{lookupKeyword(selected)}</p>
                  <div className="annotation-body"><MarkdownContent content={annotationBody(selected)} /></div>
                </div>
              ) : isQuestionAnnotation(selected) ? (
                <div className="annotation-question-detail">
                  <section>
                    <p className="annotation-detail-label">질문</p>
                    <p className="annotation-question-prompt">{questionPrompt(selected)}</p>
                  </section>
                  <section>
                    <p className="annotation-detail-label">선택한 문장</p>
                    <p className="annotation-question-selected-text">{selected.selectedText}</p>
                  </section>
                  <section>
                    <p className="annotation-detail-label">답변</p>
                    <div className="annotation-body"><MarkdownContent content={questionAnswer(selected) || "아직 답변이 없습니다."} /></div>
                  </section>
                </div>
              ) : (
                <>
                  <h3>{annotationTitle(selected)}</h3>
                  <blockquote>“{selected.selectedText}”</blockquote>
                </>
              )}
              {editingNoteId === selected.id && selected.result.kind === "note" ? (
                <div className="annotation-note-editor">
                  <textarea
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.currentTarget.value)}
                    onPaste={(event) => void pasteNoteImages(event).then(() => setNoteEditError(null)).catch((error) => setNoteEditError((error as Error).message || String(error)))}
                    aria-label="노트 편집"
                    placeholder="Markdown을 편집하거나 그림을 붙여넣으세요."
                    autoFocus
                  />
                  <NoteImageGallery
                    images={(selected.result.images || []).filter((image) => !removedNoteImageIds.includes(image.id))}
                    onRemove={(imageId) => setRemovedNoteImageIds((current) => [...current, imageId])}
                  />
                  <NoteImageGallery
                    images={pendingNoteImages}
                    onRemove={(imageId) => setPendingNoteImages((current) => current.filter((image) => image.id !== imageId))}
                  />
                  {noteEditError ? <p className="lookup-error">{noteEditError}</p> : null}
                  <div className="annotation-note-editor-actions"><button type="button" className="renovation-secondary" onClick={() => setEditingNoteId(null)} disabled={noteBusy}>취소</button><button type="button" className="renovation-primary" disabled={noteBusy || (!noteDraft.trim() && !pendingNoteImages.length && !(selected.result.images || []).some((image) => !removedNoteImageIds.includes(image.id)))} onClick={() => {
                    setNoteBusy(true);
                    void onUpdateNote(selected.id, noteDraft, pendingNoteImages.map(noteImageUpload), removedNoteImageIds)
                      .then(() => setEditingNoteId(null)).catch((error) => setNoteEditError((error as Error).message || String(error))).finally(() => setNoteBusy(false));
                  }}>저장</button></div>
                </div>
              ) : isQuestionAnnotation(selected) || isLookupAnnotation(selected) ? null : (
                <div className="annotation-body">
                  <MarkdownContent content={annotationBody(selected)} />
                  {selected.result.kind === "note" ? <NoteImageGallery images={selected.result.images || []} /> : null}
                </div>
              )}
              <AnnotationExternalHtmlAttachment annotation={selected} />
              <div className="annotation-detail-actions">
                {selectedSource ? <button type="button" className="renovation-primary" onClick={() => onOpenAnnotation(selected)}>본문에서 보기 <ArrowRight size={16} /></button> : null}
                {selected.result.kind === "note" ? <button type="button" className="renovation-secondary" onClick={() => {
                  setEditingNoteId(selected.id);
                  setNoteDraft(selected.result.kind === "note" ? selected.result.note : "");
                  setPendingNoteImages([]);
                  setRemovedNoteImageIds([]);
                  setNoteEditError(null);
                }}>편집</button> : null}
                <button type="button" className="annotation-delete-action" onClick={() => onDelete(selected)}>삭제</button>
              </div>
            </div>
          ) : <div className="renovation-empty"><h3>기록을 선택하세요</h3><p>왼쪽 목록에서 하이라이트, 노트 또는 AI 대화를 선택할 수 있습니다.</p></div>}
        </article>
      </div>
    </div>
  );
}

type ProgressPageProps = {
  project: ProjectSummary | null;
  documents: DocumentSummary[];
  sources: SourceSummary[];
  progress: ProjectProgressSnapshot | null;
  onContinue: () => void;
};

type ActivityCalendarCell = {
  date: string;
  count: number;
  level: number;
};

type ActivityCalendar = {
  weeks: Array<{ start: Date; monthLabel: string | null }>;
  cells: ActivityCalendarCell[][];
};

const KOREAN_WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

function calendarDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mondayOf(date: Date) {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
}

export function activityCalendar(days: LearningActivityDay[], today = new Date()): ActivityCalendar {
  const counts = new Map(days.map((day) => [day.date, day.viewedChunks]));
  const end = mondayOf(today);
  const start = new Date(end);
  start.setDate(start.getDate() - (51 * 7));
  const nonzeroCounts = days.map((day) => day.viewedChunks).filter((count) => count > 0);
  const max = Math.max(...nonzeroCounts, 1);
  const weeks: ActivityCalendar["weeks"] = [];
  const cells: ActivityCalendarCell[][] = [];
  let previousMonth = -1;
  for (let weekIndex = 0; weekIndex < 52; weekIndex += 1) {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + weekIndex * 7);
    const monthDate = Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + dayIndex);
      return date;
    }).find((date) => date.getMonth() !== previousMonth) || weekStart;
    const monthLabel = monthDate.getMonth() !== previousMonth ? `${monthDate.getMonth() + 1}월` : null;
    previousMonth = monthDate.getMonth();
    weeks.push({ start: weekStart, monthLabel });
    cells.push(Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + dayIndex);
      const count = counts.get(calendarDateKey(date)) || 0;
      const level = count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
      return { date: calendarDateKey(date), count, level };
    }));
  }
  return { weeks, cells };
}

function fallbackDocumentProgress(documents: DocumentSummary[]) {
  return documents.map((document): DocumentProgressSnapshot => ({
    documentId: document.id,
    title: document.title,
    documentType: document.documentType,
    status: document.learning.status,
    coveredChunks: document.learning.coveredChunks,
    totalChunks: document.learning.totalChunks,
    percent: document.learning.percent,
    currentSourceId: document.learning.currentSourceId,
    activeSessionId: document.learning.activeSessionId,
    sources: [],
  }));
}

export function ProgressPage({ project, documents, sources, progress, onContinue }: ProgressPageProps) {
  const calendar = useMemo(() => activityCalendar(progress?.activityDays || []), [progress?.activityDays]);
  const documentProgressRows = progress?.documents || fallbackDocumentProgress(documents);
  const materialLabel = documentProgressRows.every((document) => document.documentType === "book") ? "책별 진도" : "자료별 진도";

  return (
    <div className="renovation-page progress-page">
      <header className="renovation-header">
        <div><p className="renovation-kicker">Progress</p><h2>학습 진척도</h2><span>읽기 분량이 아니라 이해가 남은 지점을 보여줍니다.</span></div>
        <button type="button" className="renovation-primary" onClick={onContinue} disabled={!sources.length}>학습 계속하기 <ArrowRight size={16} /></button>
      </header>
      <div className="progress-layout renovation-scroll">
        <section className="progress-main">
          <p className="renovation-kicker">{project?.title || "Learning project"}</p>
          <h3>학습 활동</h3>
          <p>지난 1년 동안 새로 연 학습 대목입니다. 같은 대목을 다시 읽어도 한 번만 셉니다.</p>
          <div className="activity-overview" aria-label="최근 1년 학습 활동">
            <div className="activity-calendar-grid" role="grid" aria-label="요일과 주별 학습 대목 열람 기록">
              {calendar.weeks.map((week, index) => week.monthLabel ? (
                <span key={`${week.monthLabel}-${index}`} className="activity-month" style={{ gridColumn: index + 2, gridRow: 1 }}>{week.monthLabel}</span>
              ) : null)}
              {KOREAN_WEEKDAYS.map((weekday, dayIndex) => (
                <span key={weekday} className="activity-weekday" style={{ gridColumn: 1, gridRow: dayIndex + 2 }}>{dayIndex % 2 === 0 ? weekday : ""}</span>
              ))}
              {calendar.cells.map((week, weekIndex) => week.map((cell, dayIndex) => (
                <span
                  key={cell.date}
                  className={`activity-cell level-${cell.level}`}
                  style={{ gridColumn: weekIndex + 2, gridRow: dayIndex + 2 }}
                  role="gridcell"
                  aria-label={`${cell.date}: 새로 연 학습 대목 ${cell.count}개`}
                  title={`${cell.date} · ${cell.count}개 대목`}
                />
              )))}
            </div>
            <div className="activity-legend" aria-label="활동량 범례"><span>적음</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`level-${level}`} />)}<span>많음</span></div>
          </div>
        </section>
        <aside className="document-progress-list">
          <p className="renovation-kicker">Progress</p>
          <h3>{materialLabel}</h3>
          <p>각 자료의 실제 학습 대목 기준</p>
          <ol>
            {documentProgressRows.map((document) => (
              <li key={document.documentId} className={document.status}>
                <div><strong>{document.title}</strong><b>{document.percent}%</b></div>
                <span>{document.totalChunks ? `${document.coveredChunks} / ${document.totalChunks} 대목` : "학습 자료 준비 중"}</span>
                <i aria-hidden="true"><em style={{ width: `${document.percent}%` }} /></i>
              </li>
            ))}
          </ol>
          {!documentProgressRows.length ? <div className="progress-empty">학습 자료를 가져오면 여기에서 자료별 진도를 확인할 수 있습니다.</div> : null}
        </aside>
      </div>
    </div>
  );
}

function sourceLearningLabel(source: SourceSummary) {
  if (source.learningStatus === "completed") return "학습 완료";
  if (source.learningStatus === "in_progress") return "진행 중";
  return "학습 준비";
}
