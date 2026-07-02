import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Highlighter, Search, StickyNote, Trash2 } from "lucide-react";
import type { MaterialArtifacts } from "../../../shared/artifact-types";
import { MarkdownContent } from "./MarkdownContent";

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

type ImmersiveSourceViewProps = {
  artifacts: MaterialArtifacts;
  sourceProgress: SourceProgress | null;
  sessionReadOnly: boolean;
  displayHeadingPath: (parts: string[]) => string;
  cleanSourceText: (content: string, heading: string) => string;
};

function storageKey(materialId: string) {
  return `learnie.source-marks.${materialId}`;
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
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
}: ImmersiveSourceViewProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ chunkId: string; text: string; x: number; y: number } | null>(null);
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null);
  const { marks, commit } = useSourceMarks(artifacts.manifest.id);
  const chunkRefs = useRef(new Map<string, HTMLElement>());
  const sourceDocRef = useRef<HTMLDivElement | null>(null);
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
  const noteCount = marks.filter((mark) => mark.kind === "note").length;
  const highlightCount = marks.filter((mark) => mark.kind === "highlight").length;

  useEffect(() => {
    if (sourceProgress?.firstCurrentIndex == null || sourceProgress.firstCurrentIndex < 0) return;
    const chunk = artifacts.sourceChunks[sourceProgress.firstCurrentIndex];
    const el = chunk ? chunkRefs.current.get(chunk.id) : null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [artifacts.sourceChunks, sourceProgress?.firstCurrentIndex]);

  function scrollToChunk(chunkId: string) {
    chunkRefs.current.get(chunkId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function captureSelection() {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) {
      setSelection(null);
      return;
    }
    const text = selected.toString().replace(/\s+/g, " ").trim();
    if (text.length < 3) {
      setSelection(null);
      return;
    }
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
      setSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setSelection({
      chunkId: startChunk.dataset.chunkId || "",
      text: text.slice(0, 420),
      x: rect.left + rect.width / 2,
      y: Math.max(76, rect.top - 48),
    });
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

        <div className="source-doc immersive-source-doc" ref={sourceDocRef} onMouseUp={() => setTimeout(captureSelection, 0)}>
          {selection ? (
            <div className="selection-toolbar" style={{ left: selection.x, top: selection.y }}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addMark("highlight")}>
                <Highlighter size={14} /> 표시
              </button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addMark("note")}>
                <StickyNote size={14} /> 노트
              </button>
            </div>
          ) : null}

          {enrichedChunks.map(({ chunk, index, heading, showHeading, text, matchesQuery }) => {
            const status = sourceProgress?.statusFor(chunk.id) || "upcoming";
            const chunkMarks = marksByChunk.get(chunk.id) || [];
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
                {text ? <MarkdownContent content={text} /> : null}
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
