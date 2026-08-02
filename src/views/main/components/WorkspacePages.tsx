import { useMemo, useState } from "react";
import { ArrowRight, BookOpen, Download, Search, Upload } from "lucide-react";
import type { DocumentSummary, ProjectProgressSnapshot, ProjectSummary, SourceSummary } from "../../../shared/rpc-types";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import { MarkdownContent } from "./MarkdownContent";

type LibraryPageProps = {
  project: ProjectSummary | null;
  documents: DocumentSummary[];
  sources: SourceSummary[];
  selectedDocumentId: string | null;
  progress: ProjectProgressSnapshot | null;
  onSelectDocument: (documentId: string) => void;
  onImport: () => void;
  onOpenSource: (sourceId: string) => void;
  onRemoveSource: (source: SourceSummary) => void;
  onContinue: () => void;
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

export function LibraryPage({ project, documents, sources, selectedDocumentId, progress, onSelectDocument, onImport, onOpenSource, onRemoveSource, onContinue }: LibraryPageProps) {
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
  const heroTitle = project?.title || activeDocument?.title || "새로운 배움의 시작";
  const heroDescription = activeDocument?.description || activeDocument?.subtitle || project?.description || "자료를 가져오면 읽을 지점을 정리하고 AI 튜터와 함께 학습할 수 있습니다.";

  return (
    <div className="renovation-page library-page">
      <header className="renovation-header">
        <div>
          <p className="renovation-kicker">Library</p>
          <h2>나의 라이브러리</h2>
          <span>책 {documents.filter((document) => document.documentType === "book").length}권 · 논문 {documents.filter((document) => document.documentType === "article").length}편 · 마지막 학습 {formatRelativeTime(activeDocument?.lastStudiedAt || null)}</span>
        </div>
        <label className="library-search">
          <Search size={19} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="제목이나 저자로 검색" aria-label="라이브러리 검색" />
        </label>
      </header>

      <div className="renovation-scroll">
        <section className="library-hero">
          <p>계속 학습하기</p>
          <h3>{heroTitle}</h3>
          <span>{heroDescription}</span>
          <div className="library-hero-actions">
            <button type="button" className="renovation-primary" onClick={onContinue} disabled={!sources.length}>
              학습 계속하기 <ArrowRight size={17} />
            </button>
            <div className="hero-progress" aria-label={`학습 진도 ${activeProgress}%`}>
              <i><b style={{ width: `${activeProgress}%` }} /></i>
              <strong>{activeProgress}% learned</strong>
            </div>
          </div>
        </section>

        <section className="library-collection">
          <div className="renovation-section-heading">
            <div>
              <h3>{documents.every((document) => document.documentType === "book") ? "학습 중인 책" : "학습 중인 자료"}</h3>
              <p>읽은 양보다 이해한 지점을 기준으로 정리합니다.</p>
            </div>
            <button type="button" className="text-action" onClick={onImport}><Upload size={15} /> 새 소스 가져오기</button>
          </div>
          {filteredDocuments.length ? (
            <div className="document-grid">
              {filteredDocuments.map((document, index) => {
                const progressValue = documentProgress(document, sources, progress);
                const documentSources = sources.filter((source) => source.documentId === document.id);
                return (
                  <button key={document.id} type="button" className={`document-tile ${selectedDocumentId === document.id ? "selected" : ""}`} onClick={() => onSelectDocument(document.id)}>
                    <span className={`book-cover ${coverTone(index)}`}>
                      {document.coverUrl ? <img src={document.coverUrl} alt="" /> : <em>{document.title}</em>}
                    </span>
                    <span className="document-copy">
                      <strong>{document.title}</strong>
                      <small>{document.authors.join(", ") || document.subtitle || document.originalFileName}</small>
                      <b>{progressValue ? `${progressValue}% learned` : document.preparation.percent >= 100 ? "학습 준비 완료" : "아직 시작하지 않음"} · {document.documentType === "article" ? "논문" : `${documentSources.length} source`}</b>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="renovation-empty">
              <BookOpen size={28} />
              <h3>{query ? "검색 결과가 없습니다" : "첫 자료를 가져오세요"}</h3>
              <p>{query ? "다른 제목이나 저자로 검색해 보세요." : "PDF, EPUB, Markdown을 가져오면 하나의 책으로 묶어 정리합니다."}</p>
              {!query ? <button type="button" className="renovation-primary" onClick={onImport}><Upload size={16} /> 자료 가져오기</button> : null}
            </div>
          )}
        </section>

        {activeDocument?.documentType === "article" ? (
          <section className="library-article-overview">
            <p className="renovation-kicker">Article</p>
            <h3>{activeDocument.title}</h3>
            <p>{activeDocument.description || activeDocument.subtitle || [activeDocument.authors.join(", "), activeDocument.journal, activeDocument.publishedDate].filter(Boolean).join(" · ") || "이 논문은 하위 source 단계 없이 바로 학습할 수 있습니다."}</p>
            <button type="button" className="renovation-primary" onClick={() => {
              const source = sources.find((item) => item.documentId === activeDocument.id);
              if (source) onOpenSource(source.id);
            }}>논문 {activeProgress ? "계속 학습하기" : "학습 시작"} <ArrowRight size={16} /></button>
          </section>
        ) : activeDocument ? (
          <section className="library-source-list">
            <div className="renovation-section-heading">
              <div><h3>{activeDocument.title}</h3><p>이 자료에 포함된 학습 소스</p></div>
            </div>
            {sources.filter((source) => source.documentId === activeDocument.id).map((source, index) => (
              <div className="library-source-row" key={source.id}>
                <button type="button" className="library-source-open" onClick={() => onOpenSource(source.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{withoutLeadingIndex(source.title)}</strong>
                  <small>{source.learningStatus === "completed" ? "학습 완료" : source.learningStatus === "in_progress" ? "학습 중" : "학습 시작"}</small>
                  <ArrowRight size={16} />
                </button>
                <button type="button" className="library-source-remove" onClick={() => onRemoveSource(source)} aria-label={`${source.title} Source 제거`}>제거</button>
              </div>
            ))}
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
  onOpenAnnotation: (annotation: MaterialAnnotation) => void;
  onExport: (annotationIds: string[]) => void;
  exporting: boolean;
  onDelete: (annotation: MaterialAnnotation) => void;
  onUpdateNote: (annotationId: string, note: string) => Promise<void>;
};

type AnnotationFilter = "all" | "highlight" | "note" | "question" | "lookup" | "image";

function annotationTitle(annotation: MaterialAnnotation) {
  const result = annotation.result;
  if (result.kind === "note") return result.note.split("\n")[0]?.slice(0, 72) || "내 노트";
  if (result.kind === "question_thread") return result.title || "AI 대화";
  if (result.kind === "define" || result.kind === "lookup" || result.kind === "question") return result.title;
  return annotation.selectedText.slice(0, 72) || "하이라이트";
}

function annotationBody(annotation: MaterialAnnotation) {
  const result = annotation.result;
  if (result.kind === "note") return result.note;
  if (result.kind === "question_thread") return result.messages.map((message) => message.content).join("\n\n");
  if (result.kind === "define" || result.kind === "lookup" || result.kind === "question") return result.body;
  if (result.kind === "image") return result.body || result.warning || result.query;
  return annotation.selectedText;
}

export function AnnotationPage({ project, annotations, documents, sources, selectedAnnotationId, onSelectAnnotation, onOpenAnnotation, onExport, exporting, onDelete, onUpdateNote }: AnnotationPageProps) {
  const [filter, setFilter] = useState<AnnotationFilter>("all");
  const [query, setQuery] = useState("");
  const [documentId, setDocumentId] = useState("all");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
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
              return (
                <button key={annotation.id} type="button" className={selected?.id === annotation.id ? "active" : ""} onClick={() => onSelectAnnotation(annotation.id)}>
                  <small>{new Date(annotation.updatedAt).toLocaleDateString("ko-KR")} · {source?.title || "학습 기록"}</small>
                  <strong>{annotationTitle(annotation)}</strong>
                  <span>{annotationBody(annotation).replace(/\s+/g, " ").slice(0, 120)}</span>
                </button>
              );
            })}
            {!filtered.length ? <div className="renovation-empty compact"><h3>아직 기록이 없습니다</h3><p>학습 공간에서 문장을 선택해 하이라이트하거나 노트를 남겨 보세요.</p></div> : null}
          </div>
        </section>
        <article className="annotation-detail">
          {selected ? (
            <div>
              <p className="renovation-kicker">{selected.kind === "note" ? "내 노트" : selected.kind === "highlight" ? "하이라이트" : "AI 대화"} · {new Date(selected.updatedAt).toLocaleString("ko-KR")}</p>
              <h3>{annotationTitle(selected)}</h3>
              <blockquote>“{selected.selectedText}”</blockquote>
              {editingNoteId === selected.id && selected.result.kind === "note" ? (
                <div className="annotation-note-editor">
                  <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.currentTarget.value)} aria-label="노트 편집" autoFocus />
                  <div><button type="button" className="renovation-secondary" onClick={() => setEditingNoteId(null)} disabled={noteBusy}>취소</button><button type="button" className="renovation-primary" disabled={noteBusy || !noteDraft.trim()} onClick={() => {
                    setNoteBusy(true);
                    void onUpdateNote(selected.id, noteDraft).then(() => setEditingNoteId(null)).catch(() => undefined).finally(() => setNoteBusy(false));
                  }}>저장</button></div>
                </div>
              ) : <div className="annotation-body"><MarkdownContent content={annotationBody(selected)} /></div>}
              <div className="annotation-detail-actions">
                {selectedSource ? <button type="button" className="renovation-primary" onClick={() => onOpenAnnotation(selected)}>본문에서 보기 <ArrowRight size={16} /></button> : null}
                {selected.result.kind === "note" ? <button type="button" className="renovation-secondary" onClick={() => { setEditingNoteId(selected.id); setNoteDraft(selected.result.kind === "note" ? selected.result.note : ""); }}>편집</button> : null}
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
  annotations: MaterialAnnotation[];
  currentProgress: number;
  progress: ProjectProgressSnapshot | null;
  onContinue: () => void;
};

export function ProgressPage({ project, documents, sources, annotations, currentProgress, progress, onContinue }: ProgressPageProps) {
  const overall = useMemo(() => {
    if (progress) return progress.percent;
    const documentValues = documents.map((document) => documentProgress(document, sources, progress));
    const calculated = documentValues.length ? Math.round(documentValues.reduce((sum, value) => sum + value, 0) / documentValues.length) : 0;
    return Math.max(calculated, currentProgress);
  }, [currentProgress, documents, progress, sources]);
  const completed = progress?.documents.reduce((sum, document) => sum + document.sources.filter((source) => source.status === "completed").length, 0)
    ?? sources.filter((source) => source.learningStatus === "completed").length;
  const [courseDocumentId, setCourseDocumentId] = useState<string | null>(progress?.currentDocumentId || progress?.documents[0]?.documentId || null);
  const courseDocument = progress?.documents.find((document) => document.documentId === courseDocumentId) || progress?.documents[0] || null;
  const courseSources = courseDocument?.sources || sources.map((source, index) => ({
    sourceId: source.id,
    documentId: source.documentId || "",
    title: source.title,
    ordinal: index,
    status: source.learningStatus,
    coveredChunks: 0,
    totalChunks: 0,
    percent: source.learningStatus === "completed" ? 100 : 0,
    currentChunkId: null,
    activeSessionId: null,
  }));

  return (
    <div className="renovation-page progress-page">
      <header className="renovation-header">
        <div><p className="renovation-kicker">Progress</p><h2>학습 진척도</h2><span>읽기 분량이 아니라 이해가 남은 지점을 보여줍니다.</span></div>
        <button type="button" className="renovation-primary" onClick={onContinue} disabled={!sources.length}>학습 계속하기 <ArrowRight size={16} /></button>
      </header>
      <div className="progress-layout renovation-scroll">
        <section className="progress-main">
          <p className="renovation-kicker">{project?.title || "Learning project"}</p>
          <h3>학습의 궤적</h3>
          <div className="progress-hero-number"><strong>{overall}</strong><span>% learned</span></div>
          <p>현재 {sources.length}개 학습 소스 중 {completed}개를 마쳤습니다. 준비 진도와 실제 학습 진도는 별도로 기록됩니다.</p>
          <div className="progress-recent">
            <h3>최근 학습 기록</h3>
            <span>질문, 노트, 완료한 소스가 한 타임라인에 모입니다.</span>
            {progress?.recentActivity.slice(0, 5).map((activity) => (
              <div key={activity.id}><small>{formatRelativeTime(activity.occurredAt)}</small><strong>{activity.title}</strong><em>{activity.kind === "session" ? "학습" : activity.kind === "note" ? "노트" : activity.kind === "highlight" ? "하이라이트" : "AI 대화"}</em></div>
            )) || annotations.slice(0, 5).map((annotation) => (
              <div key={annotation.id}><small>{formatRelativeTime(annotation.updatedAt)}</small><strong>{annotationTitle(annotation)}</strong><em>{annotation.kind === "note" ? "노트" : annotation.kind === "highlight" ? "하이라이트" : "AI 대화"}</em></div>
            ))}
            {!progress?.recentActivity.length && !annotations.length ? sources.slice(0, 4).map((source) => (
              <div key={source.id}><small>{formatRelativeTime(source.updatedAt)}</small><strong>{source.title}</strong><em>{sourceLearningLabel(source)}</em></div>
            )) : null}
          </div>
        </section>
        <aside className="course-map">
          <p className="renovation-kicker">Course map</p>
          <h3>이 프로젝트에서 어디까지 왔나요?</h3>
          {progress && progress.documents.length > 1 ? (
            <select className="course-map-document" value={courseDocument?.documentId || ""} onChange={(event) => setCourseDocumentId(event.currentTarget.value)} aria-label="Course map 자료 선택">
              {progress.documents.map((document) => <option key={document.documentId} value={document.documentId}>{document.title}</option>)}
            </select>
          ) : null}
          <ol>
            {courseSources.map((source, index) => (
              <li key={source.sourceId} className={`${source.status} ${source.currentChunkId ? "current" : ""}`}>
                <i aria-hidden="true" />
                <strong>{index + 1}. {withoutLeadingIndex(source.title)}</strong>
                <span>{source.status === "completed" ? "완료" : source.status === "in_progress" ? `진행 중 · ${source.coveredChunks}/${source.totalChunks} 대목` : source.totalChunks ? `학습 준비 · ${source.totalChunks} 대목` : "학습 준비"}</span>
              </li>
            ))}
          </ol>
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
