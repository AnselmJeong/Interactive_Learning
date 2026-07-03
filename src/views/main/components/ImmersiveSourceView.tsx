import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { BookOpen, Bookmark, Highlighter, Image as ImageIcon, Loader2, Save, Search, Sparkles, StickyNote, Trash2, X } from "lucide-react";
import type { ImageLookupResult, LookupResult, MaterialAnnotation, MaterialArtifacts } from "../../../shared/artifact-types";
import { stripFigureMarkdown } from "../figure-text";
import { MarkdownContent } from "./MarkdownContent";
import { SourceFigureCard } from "./SourceFigureCard";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type SourceChunkStatus = "covered" | "current" | "upcoming";

type SourceProgress = {
  total: number;
  reached: number;
  coveredCount: number;
  percent: number;
  statusFor: (id: string) => SourceChunkStatus;
  firstCurrentIndex: number;
};

type SourceMark = {
  id: string;
  chunkId: string;
  kind: "highlight" | "note";
  text: string;
  note: string;
  createdAt: number;
};

type LookupAction = "define" | "lookup" | "image";

type SelectionState = {
  chunkId: string;
  text: string;
  x: number;
  y: number;
};

type LookupPanelState = {
  action: LookupAction;
  selection: SelectionState;
  status: "loading" | "ready" | "saving" | "saved" | "error";
  x: number;
  y: number;
  result?: LookupResult | ImageLookupResult;
  error?: string;
};

type ImmersiveSourceViewProps = {
  artifacts: MaterialArtifacts;
  sourceProgress: SourceProgress | null;
  sessionReadOnly: boolean;
  displayHeadingPath: (parts: string[]) => string;
  cleanSourceText: (content: string, heading: string) => string;
  request: RpcRequest;
};

const LOOKUP_PANEL_WIDTH = 420;
const LOOKUP_PANEL_HEIGHT = 560;

function storageKey(materialId: string) {
  return `learnie.source-marks.${materialId}`;
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function clampPoint(x: number, y: number) {
  const width = Math.min(LOOKUP_PANEL_WIDTH, window.innerWidth - 24);
  const height = Math.min(LOOKUP_PANEL_HEIGHT, window.innerHeight - 88);
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, x)),
    y: Math.max(76, Math.min(window.innerHeight - height - 24, y)),
  };
}

function toolbarPointForRange(rect: DOMRect, container: HTMLElement | null) {
  const toolbarWidth = 58;
  const toolbarHeight = 248;
  const margin = 14;
  const containerRect = container?.getBoundingClientRect();
  const preferredRight = containerRect ? containerRect.right - toolbarWidth - margin : window.innerWidth - toolbarWidth - margin;
  const x = Math.max(12, Math.min(window.innerWidth - toolbarWidth - 12, preferredRight));
  const centeredY = rect.top + rect.height / 2 - toolbarHeight / 2;
  const y = Math.max(92, Math.min(window.innerHeight - toolbarHeight - 14, centeredY));
  return { x, y };
}

function actionLabel(action: LookupAction) {
  if (action === "define") return "원문 정의";
  if (action === "lookup") return "위키 요약";
  return "이미지 후보";
}

function resultSourceMeta(result: LookupResult | ImageLookupResult | undefined) {
  return result?.sourceMeta || [];
}

function useSourceMarks(materialId: string) {
  const [marks, setMarks] = useState<SourceMark[]>([]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(materialId)) || "[]") as SourceMark[];
      setMarks(Array.isArray(parsed) ? parsed : []);
    } catch {
      setMarks([]);
    }
  }, [materialId]);

  function commit(next: SourceMark[]) {
    setMarks(next);
    localStorage.setItem(storageKey(materialId), JSON.stringify(next));
  }

  return { marks, commit };
}

export function ImmersiveSourceView({
  artifacts,
  sourceProgress,
  sessionReadOnly,
  displayHeadingPath,
  cleanSourceText,
  request,
}: ImmersiveSourceViewProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [lookupPanel, setLookupPanel] = useState<LookupPanelState | null>(null);
  const [annotations, setAnnotations] = useState<MaterialAnnotation[]>(artifacts.annotations || []);
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null);
  const { marks, commit } = useSourceMarks(artifacts.manifest.id);
  const chunkRefs = useRef(new Map<string, HTMLElement>());
  const sourceDocRef = useRef<HTMLDivElement | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const q = normalizeQuery(query);

  const enrichedChunks = useMemo(() => {
    return artifacts.sourceChunks.map((chunk, index) => {
      const heading = displayHeadingPath(chunk.headingPath);
      const prevHeading = index > 0 ? displayHeadingPath(artifacts.sourceChunks[index - 1]?.headingPath || []) : "";
      const showHeading = Boolean(heading) && heading !== prevHeading;
      const text = cleanSourceText(chunk.text, heading || chunk.headingPath.at(-1) || "");
      const haystack = `${heading} ${text}`.toLowerCase();
      return { chunk, index, heading, showHeading, text, matchesQuery: Boolean(q && haystack.includes(q)) };
    });
  }, [artifacts.sourceChunks, cleanSourceText, displayHeadingPath, q]);

  const searchMatches = useMemo(() => enrichedChunks.filter((item) => item.matchesQuery).slice(0, 20), [enrichedChunks]);
  const marksByChunk = useMemo(() => {
    const groups = new Map<string, SourceMark[]>();
    for (const mark of marks) {
      const group = groups.get(mark.chunkId) || [];
      group.push(mark);
      groups.set(mark.chunkId, group);
    }
    return groups;
  }, [marks]);
  const figuresByChunk = useMemo(() => {
    const groups = new Map<string, typeof artifacts.figures>();
    for (const figure of artifacts.figures || []) {
      const targetIds = figure.sourceChunkIds.length ? figure.sourceChunkIds : [artifacts.sourceChunks[0]?.id].filter((id): id is string => Boolean(id));
      for (const chunkId of targetIds) {
        const group = groups.get(chunkId) || [];
        group.push(figure);
        groups.set(chunkId, group);
      }
    }
    return groups;
  }, [artifacts.figures, artifacts.sourceChunks]);
  const annotationsByChunk = useMemo(() => {
    const groups = new Map<string, MaterialAnnotation[]>();
    for (const annotation of annotations) {
      const group = groups.get(annotation.chunkId) || [];
      group.push(annotation);
      groups.set(annotation.chunkId, group);
    }
    return groups;
  }, [annotations]);
  const displayFiguresByChunk = useMemo(() => {
    const chunkOrder = new Map(artifacts.sourceChunks.map((chunk, index) => [chunk.id, index]));
    const groups = new Map<string, typeof artifacts.figures>();
    for (const figure of artifacts.figures || []) {
      const firstChunkId = [...figure.sourceChunkIds].sort((a, b) => (chunkOrder.get(a) ?? 0) - (chunkOrder.get(b) ?? 0))[0] || artifacts.sourceChunks[0]?.id;
      if (!firstChunkId) continue;
      const group = groups.get(firstChunkId) || [];
      group.push(figure);
      groups.set(firstChunkId, group);
    }
    return groups;
  }, [artifacts.figures, artifacts.sourceChunks]);
  const noteCount = marks.filter((mark) => mark.kind === "note").length;
  const highlightCount = marks.filter((mark) => mark.kind === "highlight").length;

  useEffect(() => {
    setAnnotations(artifacts.annotations || []);
  }, [artifacts.annotations, artifacts.manifest.id]);

  useEffect(() => {
    if (sourceProgress?.firstCurrentIndex == null || sourceProgress.firstCurrentIndex < 0) return;
    const chunk = artifacts.sourceChunks[sourceProgress.firstCurrentIndex];
    const el = chunk ? chunkRefs.current.get(chunk.id) : null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [artifacts.sourceChunks, sourceProgress?.firstCurrentIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSelection(null);
      setLookupPanel(null);
      window.getSelection()?.removeAllRanges();
    }
    function onSelectionIntent() {
      scheduleCaptureSelection();
    }
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionIntent);
    window.addEventListener("pointerup", onSelectionIntent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionIntent);
      window.removeEventListener("pointerup", onSelectionIntent);
      if (selectionTimerRef.current != null) {
        window.clearTimeout(selectionTimerRef.current);
      }
    };
  }, []);

  function scrollToChunk(chunkId: string) {
    chunkRefs.current.get(chunkId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function readSelection(): SelectionState | null {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
    const text = selected.toString().replace(/\s+/g, " ").trim();
    if (text.length < 3) return null;
    const range = selected.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
    const startChunk = startElement?.closest<HTMLElement>(".source-chunk");
    const endChunk = endElement?.closest<HTMLElement>(".source-chunk");
    if (!startChunk || startChunk !== endChunk || !sourceDocRef.current?.contains(startChunk)) {
      return null;
    }
    const rect = range.getBoundingClientRect();
    const point = toolbarPointForRange(rect, sourceDocRef.current);
    return {
      chunkId: startChunk.dataset.chunkId || "",
      text: text.slice(0, 420),
      x: point.x,
      y: point.y,
    };
  }

  function scheduleCaptureSelection() {
    if (selectionTimerRef.current != null) {
      window.clearTimeout(selectionTimerRef.current);
    }
    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null;
      captureSelection();
    }, 40);
  }

  function captureSelection() {
    const next = readSelection();
    setSelection(next);
  }

  function addMark(kind: SourceMark["kind"]) {
    if (!selection?.chunkId || !selection.text) return;
    const mark: SourceMark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chunkId: selection.chunkId,
      kind,
      text: selection.text,
      note: "",
      createdAt: Date.now(),
    };
    commit([mark, ...marks]);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    if (kind === "note") setEditingMarkId(mark.id);
  }

  function updateNote(markId: string, note: string) {
    commit(marks.map((mark) => (mark.id === markId ? { ...mark, note } : mark)));
  }

  function removeMark(markId: string) {
    commit(marks.filter((mark) => mark.id !== markId));
    if (editingMarkId === markId) setEditingMarkId(null);
  }

  async function runLookup(action: LookupAction, sourceSelection = selection) {
    if (!sourceSelection?.chunkId || !sourceSelection.text) return;
    const panelPoint = clampPoint(sourceSelection.x - 448, sourceSelection.y);
    const nextSelection = { ...sourceSelection };
    setSelection(nextSelection);
    setLookupPanel({ action, selection: nextSelection, status: "loading", x: panelPoint.x, y: panelPoint.y });
    const method = action === "define" ? "annotations.define" : action === "lookup" ? "annotations.lookup" : "annotations.findImages";
    try {
      const result = (await request(method, {
        materialId: artifacts.manifest.id,
        chunkId: sourceSelection.chunkId,
        selectedText: sourceSelection.text,
      })) as LookupResult | ImageLookupResult;
      setLookupPanel({ action, selection: nextSelection, status: "ready", x: panelPoint.x, y: panelPoint.y, result });
    } catch (error) {
      setLookupPanel({
        action,
        selection: nextSelection,
        status: "error",
        x: panelPoint.x,
        y: panelPoint.y,
        error: (error as Error).message || String(error),
      });
    }
  }

  async function saveLookupResult(panel: LookupPanelState) {
    if (!panel.result || panel.status === "saving" || panel.status === "saved") return;
    if (panel.result.kind === "image" && panel.result.images.length === 0) return;
    setLookupPanel({ ...panel, status: "saving" });
    try {
      const saved = (await request("annotations.save", {
        materialId: artifacts.manifest.id,
        chunkId: panel.selection.chunkId,
        kind: panel.result.kind,
        selectedText: panel.selection.text,
        result: panel.result,
        sourceMeta: resultSourceMeta(panel.result),
      })) as MaterialAnnotation;
      setAnnotations((current) => [saved, ...current.filter((annotation) => annotation.id !== saved.id)]);
      setLookupPanel({ ...panel, status: "saved" });
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    } catch (error) {
      setLookupPanel({
        ...panel,
        status: "error",
        error: `Save failed: ${(error as Error).message || String(error)}`,
      });
    }
  }

  async function removeAnnotation(annotationId: string) {
    const previous = annotations;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
    try {
      await request("annotations.delete", { annotationId });
    } catch {
      setAnnotations(previous);
    }
  }

  return (
    <div className="source-view immersive-source-view">
      <aside className="source-spine" aria-label="Source progress">
        <div className="source-spine-rail">
          <i style={{ height: `${sourceProgress?.percent || 0}%` }} />
          {enrichedChunks.map(({ chunk, index, heading }) => {
            const status = sourceProgress?.statusFor(chunk.id) || "upcoming";
            return (
              <button
                key={chunk.id}
                type="button"
                className={`source-spine-node ${status}`}
                style={{ top: `${enrichedChunks.length > 1 ? (index / (enrichedChunks.length - 1)) * 100 : 0}%` }}
                onClick={() => scrollToChunk(chunk.id)}
                title={heading || chunk.locator || `대목 ${index + 1}`}
              >
                <span />
              </button>
            );
          })}
        </div>
      </aside>

      <header className="source-reader-head">
        <div>
          <p className="eyebrow">원문 읽기</p>
          <h3>{sourceProgress?.percent || 0}% 다룸</h3>
          {sessionReadOnly && sourceProgress && sourceProgress.percent < 90 ? (
            <p>아직 다루지 않은 원문이 남아 있습니다. 새 세션을 시작해 이어서 학습할 수 있습니다.</p>
          ) : null}
        </div>
        <div className="source-reader-tools">
          <label className="source-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="원문 검색" />
          </label>
          <span><Highlighter size={14} /> {highlightCount}</span>
          <span><StickyNote size={14} /> {noteCount}</span>
          <span><Sparkles size={14} /> {annotations.length}</span>
        </div>
      </header>

      <div className="source-reader-layout">
        <nav className="source-search-results" aria-label="Search results">
          <div className="source-progress-meta">
            <span>{sourceProgress ? `${sourceProgress.reached}/${sourceProgress.total}` : "0/0"} 단락</span>
            <div className="lesson-bar">
              <i style={{ width: `${sourceProgress?.percent || 0}%` }} />
            </div>
            <div className="source-legend">
              <span className="covered">다룸</span>
              <span className="current">진행 중</span>
              <span className="upcoming">예정</span>
            </div>
          </div>
          {q ? (
            <div className="search-result-list">
              <strong>{searchMatches.length ? `${searchMatches.length}개 결과` : "결과 없음"}</strong>
              {searchMatches.map(({ chunk, heading, text }) => (
                <button key={chunk.id} type="button" onClick={() => scrollToChunk(chunk.id)}>
                  <b>{heading || chunk.locator || "원문"}</b>
                  <span>{text.slice(0, 110)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="source-reader-hint">
              <Bookmark size={16} />
              <p>표시와 노트</p>
            </div>
          )}
        </nav>

        <div
          className="source-doc immersive-source-doc"
          ref={sourceDocRef}
          onMouseUp={scheduleCaptureSelection}
          onPointerUp={scheduleCaptureSelection}
          onKeyUp={scheduleCaptureSelection}
        >
          {selection ? (
            <div className="selection-toolbar" style={{ left: selection.x, top: selection.y }} aria-label="선택 텍스트 작업">
              <button
                type="button"
                className="mark-action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addMark("highlight")}
                aria-label="표시"
                title="표시"
              >
                <Highlighter size={20} />
              </button>
              <button
                type="button"
                className="note-action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addMark("note")}
                aria-label="노트"
                title="노트"
              >
                <StickyNote size={20} />
              </button>
              <button
                type="button"
                className="define-action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void runLookup("define")}
                aria-label="원문 정의"
                title="원문 정의"
              >
                <BookOpen size={20} />
              </button>
              <button
                type="button"
                className="lookup-action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void runLookup("lookup")}
                aria-label="위키 요약"
                title="위키 요약"
              >
                <Search size={20} />
              </button>
              <button
                type="button"
                className="image-action"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void runLookup("image")}
                aria-label="이미지 후보"
                title="이미지 후보"
              >
                <ImageIcon size={20} />
              </button>
            </div>
          ) : null}
          {lookupPanel ? (
            <LookupPopover
              panel={lookupPanel}
              onSave={() => void saveLookupResult(lookupPanel)}
              onClose={() => setLookupPanel(null)}
              onMove={(x, y) => setLookupPanel((current) => (current ? { ...current, x, y } : current))}
            />
          ) : null}

          {enrichedChunks.map(({ chunk, index, heading, showHeading, text, matchesQuery }) => {
            const status = sourceProgress?.statusFor(chunk.id) || "upcoming";
            const chunkMarks = marksByChunk.get(chunk.id) || [];
            const chunkFigures = figuresByChunk.get(chunk.id) || [];
            const displayFigures = displayFiguresByChunk.get(chunk.id) || [];
            const chunkAnnotations = annotationsByChunk.get(chunk.id) || [];
            return (
              <article
                key={chunk.id}
                data-chunk-id={chunk.id}
                className={`source-chunk immersive-source-chunk ${status} ${matchesQuery ? "search-hit" : ""}`}
                ref={(el) => {
                  if (el) chunkRefs.current.set(chunk.id, el);
                  else chunkRefs.current.delete(chunk.id);
                }}
              >
                <div className="source-chunk-kicker">
                  <span>{chunk.locator || `대목 ${index + 1}`}</span>
                  <span>{status === "current" ? "진행 중" : status === "covered" ? "다룸" : "예정"}</span>
                </div>
                {showHeading ? <h4 className="source-heading">{heading}</h4> : null}
                {text ? <MarkdownContent content={stripFigureMarkdown(text, chunkFigures)} /> : null}
                {chunkAnnotations.length ? (
                  <div className="source-annotation-list">
                    {chunkAnnotations.map((annotation) => (
                      <SavedAnnotationCard
                        key={annotation.id}
                        annotation={annotation}
                        onDelete={() => void removeAnnotation(annotation.id)}
                      />
                    ))}
                  </div>
                ) : null}
                {displayFigures.length ? (
                  <div className="source-figure-list">
                    {displayFigures.map((figure) => (
                      <SourceFigureCard key={figure.id} figure={figure} materialId={artifacts.manifest.id} request={request} />
                    ))}
                  </div>
                ) : null}
                {chunkMarks.length ? (
                  <div className="source-mark-list">
                    {chunkMarks.map((mark) => (
                      <article key={mark.id} className={`source-mark ${mark.kind}`}>
                        <div>
                          {mark.kind === "note" ? <StickyNote size={14} /> : <Highlighter size={14} />}
                          <p>{mark.text}</p>
                          <button type="button" onClick={() => removeMark(mark.id)} title="삭제">
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {mark.kind === "note" ? (
                          <textarea
                            value={mark.note}
                            onFocus={() => setEditingMarkId(mark.id)}
                            onChange={(event) => updateNote(mark.id, event.target.value)}
                            placeholder="이 대목에 대한 생각을 남기세요"
                            rows={editingMarkId === mark.id ? 3 : 1}
                          />
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LookupPopover({
  panel,
  onSave,
  onClose,
  onMove,
}: {
  panel: LookupPanelState;
  onSave: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const canSave = Boolean(panel.result && panel.status === "ready" && (panel.result.kind !== "image" || panel.result.images.length > 0));
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    function onPointerMove(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampPoint(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
      onMove(next.x, next.y);
    }
    function onPointerUp() {
      dragRef.current = null;
      setDragging(false);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [dragging, onMove]);

  function startDrag(event: PointerEvent<HTMLElement>) {
    if ((event.target as Element).closest("button")) return;
    event.preventDefault();
    dragRef.current = {
      offsetX: event.clientX - panel.x,
      offsetY: event.clientY - panel.y,
    };
    setDragging(true);
  }

  return (
    <aside className={`lookup-popover ${dragging ? "dragging" : ""}`} role="dialog" aria-label={`${actionLabel(panel.action)} result`} style={{ left: panel.x, top: panel.y }}>
      <header className="lookup-popover-drag-handle" onPointerDown={startDrag} title="드래그해서 이동">
        <div>
          <span>{actionLabel(panel.action)}</span>
          <strong>{panel.selection.text}</strong>
        </div>
        <button type="button" onClick={onClose} title="닫기">
          <X size={15} />
        </button>
      </header>

      {panel.status === "loading" || panel.status === "saving" ? (
        <div className="lookup-state">
          <Loader2 size={18} className="spin" />
          <span>{panel.status === "saving" ? "저장 중" : "찾는 중"}</span>
        </div>
      ) : null}

      {panel.status === "error" ? (
        <div className="lookup-error">
          <p>{panel.error || "Lookup failed."}</p>
        </div>
      ) : null}

      {panel.result && panel.status !== "loading" && panel.status !== "saving" && panel.status !== "error" ? (
        <LookupResultBody result={panel.result} />
      ) : null}

      {panel.status === "saved" ? <p className="lookup-saved">저장되었습니다.</p> : null}

      <footer>
        <button type="button" className="wide-button" onClick={onClose}>
          닫기
        </button>
        <button type="button" className="wide-button primary" onClick={onSave} disabled={!canSave}>
          <Save size={15} /> Save
        </button>
      </footer>
    </aside>
  );
}

function LookupResultBody({ result }: { result: LookupResult | ImageLookupResult }) {
  if (result.kind === "image") {
    return (
      <div className="lookup-result-body">
        {result.images.length ? (
          <div className="lookup-image-grid">
            {result.images.map((image, index) => (
              <a
                key={`${image.title}-${image.pageUrl || image.imageUrl || index}`}
                href={image.pageUrl || image.imageUrl || image.thumbnailUrl}
                target="_blank"
                rel="noreferrer"
                title={image.title}
              >
                <img src={image.thumbnailUrl} alt={image.title} loading="lazy" />
              </a>
            ))}
          </div>
        ) : (
          <p className="lookup-empty">관련 이미지를 찾지 못했습니다.</p>
        )}
      </div>
    );
  }

  return (
    <div className="lookup-result-body">
      <h4>{result.title}</h4>
      <MarkdownContent content={result.body} compact />
      <SourceMetaLinks sourceMeta={result.sourceMeta} />
    </div>
  );
}

function SavedAnnotationCard({ annotation, onDelete }: { annotation: MaterialAnnotation; onDelete: () => void }) {
  const result = annotation.result;
  return (
    <article className={`source-annotation-card ${annotation.kind}`}>
      <header>
        <div>
          <span>{annotation.kind === "image" ? "Image" : annotation.kind === "define" ? "Define" : "Lookup"}</span>
          <strong>{annotation.selectedText}</strong>
        </div>
        <button type="button" onClick={onDelete} title="삭제">
          <Trash2 size={14} />
        </button>
      </header>
      {result.kind === "define" || result.kind === "lookup" || result.kind === "image" ? (
        <LookupResultBody result={result} />
      ) : result.kind === "note" ? (
        <p className="lookup-result-summary">{result.note}</p>
      ) : (
        <p className="lookup-result-summary">표시된 텍스트입니다.</p>
      )}
    </article>
  );
}

function SourceMetaLinks({ sourceMeta }: { sourceMeta: Array<{ title: string; url?: string; provider?: string; retrievedAt?: string }> }) {
  if (!sourceMeta.length) return null;
  return (
    <div className="lookup-source-meta">
      {sourceMeta.map((source, index) => (
        source.url ? (
          <a key={`${source.title}-${index}`} href={source.url} target="_blank" rel="noreferrer">
            {source.provider || "Source"}: {source.title}
          </a>
        ) : (
          <span key={`${source.title}-${index}`}>
            {source.provider || "Source"}: {source.title}
          </span>
        )
      ))}
    </div>
  );
}
