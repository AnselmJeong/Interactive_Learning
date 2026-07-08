import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Highlighter, Image as ImageIcon, Loader2, MessageSquare, Save, Search, Trash2, X } from "lucide-react";
import type { ImageLookupResult, LookupResult, MaterialAnnotation, TextSelectionAnchor } from "../../../shared/artifact-types";
import type { ChatSubmitShortcut } from "../../../shared/settings-types";
import { MarkdownContent } from "./MarkdownContent";
import { highlightAnnotationIdsForRange } from "../annotation-inline-links";
import { buildTextSelectionAnchor, isIgnoredSelectionElement } from "../selection-anchor";
import { shouldSubmitTextArea } from "../submit-shortcut";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
type LookupAction = "question" | "lookup" | "image";

type SelectionState = {
  chunkId: string;
  anchorMessageId?: string | null;
  anchorBlockId?: string | null;
  textAnchor?: TextSelectionAnchor | null;
  highlightAnnotationIds: string[];
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
  queryText: string;
  result?: LookupResult | ImageLookupResult;
  error?: string;
};

type LearningSelectionLookupProps = {
  rootRef: RefObject<HTMLElement | null>;
  materialId: string | null;
  defaultChunkId: string | null;
  request: RpcRequest;
  submitShortcut: ChatSubmitShortcut;
  onAnnotationSaved?: (annotation: MaterialAnnotation) => void;
  onDeleteAnnotation?: (annotationId: string) => void | Promise<void>;
};

const LOOKUP_PANEL_WIDTH = 420;
const LOOKUP_PANEL_HEIGHT = 560;
const SELECTED_TEXT_MAX_CHARS = 4000;

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
  const toolbarHeight = 216;
  const margin = 14;
  const containerRect = container?.getBoundingClientRect();
  const preferredRight = containerRect ? containerRect.right - toolbarWidth - margin : window.innerWidth - toolbarWidth - margin;
  const x = Math.max(12, Math.min(window.innerWidth - toolbarWidth - 12, preferredRight));
  const centeredY = rect.top + rect.height / 2 - toolbarHeight / 2;
  const y = Math.max(92, Math.min(window.innerHeight - toolbarHeight - 14, centeredY));
  return { x, y };
}

function actionLabel(action: LookupAction) {
  if (action === "question") return "추가 질문";
  if (action === "lookup") return "위키 요약";
  return "이미지 후보";
}

function elementFromNode(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function resultSourceMeta(result: LookupResult | ImageLookupResult | undefined) {
  return result?.sourceMeta || [];
}

function imageLookupKey(image: ImageLookupResult["images"][number], index: number) {
  return `${image.title}-${image.pageUrl || image.imageUrl || image.thumbnailUrl || index}`;
}

function annotationMethod(action: LookupAction) {
  return action === "lookup" ? "annotations.lookup" : "annotations.findImages";
}

function initialQueryText(panel: LookupPanelState) {
  return panel.action === "question" ? panel.queryText : panel.queryText || panel.selection.text;
}

export function LearningSelectionLookup({
  rootRef,
  materialId,
  defaultChunkId,
  request,
  submitShortcut,
  onAnnotationSaved,
  onDeleteAnnotation,
}: LearningSelectionLookupProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [lookupPanel, setLookupPanel] = useState<LookupPanelState | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const lookupRequestSeqRef = useRef(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      lookupRequestSeqRef.current += 1;
      setSelection(null);
      setLookupPanel(null);
      window.getSelection()?.removeAllRanges();
    }

    function onSelectionIntent() {
      scheduleCaptureSelection();
    }

    document.addEventListener("selectionchange", onSelectionIntent);
    window.addEventListener("pointerup", onSelectionIntent);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionIntent);
      window.removeEventListener("pointerup", onSelectionIntent);
      window.removeEventListener("keydown", onKeyDown);
      if (selectionTimerRef.current != null) {
        window.clearTimeout(selectionTimerRef.current);
      }
    };
  }, [materialId, defaultChunkId, rootRef]);

  function readSelection(): SelectionState | null {
    const root = rootRef.current;
    if (!root || !materialId) return null;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
    const text = selected.toString().replace(/\s+/g, " ").trim();
    if (text.length < 3) return null;
    const range = selected.getRangeAt(0);
    const startElement = elementFromNode(range.startContainer);
    const endElement = elementFromNode(range.endContainer);
    if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;
    if (isIgnoredSelectionElement(startElement) || isIgnoredSelectionElement(endElement)) return null;

    const startLookup = startElement.closest<HTMLElement>("[data-lookup-chunk-id]");
    const endLookup = endElement.closest<HTMLElement>("[data-lookup-chunk-id]");
    const chunkId = startLookup?.dataset.lookupChunkId || endLookup?.dataset.lookupChunkId || defaultChunkId || "";
    if (!chunkId) return null;
    const startMessage = startElement.closest<HTMLElement>("[data-lookup-message-id]");
    const endMessage = endElement.closest<HTMLElement>("[data-lookup-message-id]");
    const startBlock = startElement.closest<HTMLElement>("[data-lookup-block-id]");
    const endBlock = endElement.closest<HTMLElement>("[data-lookup-block-id]");
    if (!startMessage || startMessage !== endMessage || startMessage.dataset.chatRole !== "assistant") return null;

    let scopeRoot: HTMLElement | null = null;
    let anchorBlockId: string | null = null;
    if (startBlock || endBlock) {
      if (!startBlock || startBlock !== endBlock) return null;
      scopeRoot = startBlock;
      anchorBlockId = startBlock.dataset.lookupBlockId || null;
    } else {
      scopeRoot = startMessage;
    }
    const anchorMessageId = startMessage.dataset.lookupMessageId || null;
    const textAnchor = buildTextSelectionAnchor({
      range,
      root: scopeRoot,
      surface: "chat",
      chunkId,
      messageId: anchorMessageId,
      blockId: anchorBlockId,
    });
    if (!textAnchor) return null;

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const point = toolbarPointForRange(rect, root);
    return {
      chunkId,
      anchorMessageId,
      anchorBlockId,
      text: textAnchor.selectedText.slice(0, SELECTED_TEXT_MAX_CHARS),
      textAnchor,
      highlightAnnotationIds: highlightAnnotationIdsForRange(root, range),
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
      setSelection(readSelection());
    }, 40);
  }

  async function runLookup(action: LookupAction, sourceSelection = selection) {
    if (!materialId || !sourceSelection?.chunkId || !sourceSelection.text) return;
    const panelPoint = clampPoint(sourceSelection.x - 448, sourceSelection.y);
    const nextSelection = { ...sourceSelection };
    const queryText = sourceSelection.text;
    if (action === "question") {
      setSelection(nextSelection);
      setLookupPanel({ action, selection: nextSelection, status: "ready", x: panelPoint.x, y: panelPoint.y, queryText: "", result: undefined });
      return;
    }
    const requestSeq = lookupRequestSeqRef.current + 1;
    lookupRequestSeqRef.current = requestSeq;
    setSelection(nextSelection);
    setLookupPanel({ action, selection: nextSelection, status: "loading", x: panelPoint.x, y: panelPoint.y, queryText });
    const method = annotationMethod(action);
    try {
      const result = (await request(method, {
        materialId,
        chunkId: sourceSelection.chunkId,
        selectedText: queryText,
      })) as LookupResult | ImageLookupResult;
      if (lookupRequestSeqRef.current !== requestSeq) return;
      setLookupPanel({ action, selection: nextSelection, status: "ready", x: panelPoint.x, y: panelPoint.y, queryText, result });
    } catch (error) {
      if (lookupRequestSeqRef.current !== requestSeq) return;
      setLookupPanel({
        action,
        selection: nextSelection,
        status: "error",
        x: panelPoint.x,
        y: panelPoint.y,
        queryText,
        error: (error as Error).message || String(error),
      });
    }
  }

  async function searchLookupResult(panel: LookupPanelState, queryText: string) {
    if (!materialId) return;
    const normalized = queryText.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const requestSeq = lookupRequestSeqRef.current + 1;
    lookupRequestSeqRef.current = requestSeq;
    setLookupPanel({ ...panel, status: "loading", queryText: normalized, result: undefined, error: undefined });
    try {
      const result = (await request(
        panel.action === "question" ? "annotations.ask" : annotationMethod(panel.action),
        panel.action === "question"
          ? {
              materialId,
              chunkId: panel.selection.chunkId,
              selectedText: panel.selection.text,
              question: normalized,
            }
          : {
              materialId,
              chunkId: panel.selection.chunkId,
              selectedText: normalized,
            }
      )) as LookupResult | ImageLookupResult;
      if (lookupRequestSeqRef.current !== requestSeq) return;
      setLookupPanel({ ...panel, status: "ready", queryText: normalized, result, error: undefined });
    } catch (error) {
      if (lookupRequestSeqRef.current !== requestSeq) return;
      setLookupPanel({
        ...panel,
        status: "error",
        queryText: normalized,
        result: undefined,
        error: (error as Error).message || String(error),
      });
    }
  }

  async function saveLookupResult(panel: LookupPanelState, result = panel.result) {
    if (!materialId || !result || panel.status === "saving" || panel.status === "saved") return;
    if (result.kind === "image" && result.images.length === 0) return;
    setLookupPanel({ ...panel, status: "saving" });
    try {
      const saved = (await request("annotations.save", {
        materialId,
        chunkId: panel.selection.chunkId,
        surface: "chat",
        anchorMessageId: panel.selection.anchorMessageId || null,
        anchorBlockId: panel.selection.anchorBlockId || null,
        textAnchor: panel.selection.textAnchor || null,
        kind: result.kind,
        selectedText: panel.selection.text,
        result,
        sourceMeta: resultSourceMeta(result),
      })) as MaterialAnnotation;
      onAnnotationSaved?.(saved);
      setLookupPanel(null);
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

  async function saveHighlight(sourceSelection = selection) {
    if (!materialId || !sourceSelection?.chunkId || !sourceSelection.text) return;
    try {
      const saved = (await request("annotations.save", {
        materialId,
        chunkId: sourceSelection.chunkId,
        surface: "chat",
        anchorMessageId: sourceSelection.anchorMessageId || null,
        anchorBlockId: sourceSelection.anchorBlockId || null,
        textAnchor: sourceSelection.textAnchor || null,
        kind: "highlight",
        selectedText: sourceSelection.text,
        result: { kind: "highlight", style: "yellow" },
        sourceMeta: [],
      })) as MaterialAnnotation;
      onAnnotationSaved?.(saved);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      setLookupPanel(null);
    } catch (error) {
      setLookupPanel({
        action: "lookup",
        selection: sourceSelection,
        status: "error",
        x: sourceSelection.x,
        y: sourceSelection.y,
        queryText: sourceSelection.text,
        error: `Save failed: ${(error as Error).message || String(error)}`,
      });
    }
  }

  async function deleteAnnotation(annotationId: string) {
    if (onDeleteAnnotation) {
      await onDeleteAnnotation(annotationId);
      return;
    }
    await request("annotations.delete", { annotationId });
  }

  async function removeSelectedHighlights(sourceSelection = selection) {
    const annotationIds = [...new Set(sourceSelection?.highlightAnnotationIds || [])];
    if (!annotationIds.length || !sourceSelection) return;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    try {
      for (const annotationId of annotationIds) {
        await deleteAnnotation(annotationId);
      }
    } catch (error) {
      setLookupPanel({
        action: "lookup",
        selection: sourceSelection,
        status: "error",
        x: sourceSelection.x,
        y: sourceSelection.y,
        queryText: sourceSelection.text,
        error: `Remove failed: ${(error as Error).message || String(error)}`,
      });
    }
  }

  function closePanel() {
    setLookupPanel(null);
  }

  return (
    <>
      {selection ? (
        <div className="selection-toolbar" style={{ left: selection.x, top: selection.y }} aria-label="선택 텍스트 작업">
          {selection.highlightAnnotationIds.length ? (
            <button
              type="button"
              className="remove-mark-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void removeSelectedHighlights()}
              aria-label="표시 삭제"
              title="표시 삭제"
            >
              <Trash2 size={20} />
            </button>
          ) : (
            <button
              type="button"
              className="mark-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void saveHighlight()}
              aria-label="표시"
              title="표시"
            >
              <Highlighter size={20} />
            </button>
          )}
          <button
            type="button"
            className="question-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runLookup("question")}
            aria-label="추가 질문"
            title="추가 질문"
          >
            <MessageSquare size={20} />
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
          onSave={(result) => void saveLookupResult(lookupPanel, result)}
          onSearch={(queryText) => void searchLookupResult(lookupPanel, queryText)}
          onClose={closePanel}
          onMove={(x, y) => setLookupPanel((current) => (current ? { ...current, x, y } : current))}
          submitShortcut={submitShortcut}
        />
      ) : null}
    </>
  );
}

function LookupPopover({
  panel,
  onSave,
  onSearch,
  onClose,
  onMove,
  submitShortcut,
}: {
  panel: LookupPanelState;
  onSave: (result: LookupResult | ImageLookupResult) => void;
  onSearch: (queryText: string) => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  submitShortcut: ChatSubmitShortcut;
}) {
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selectedImageKeys, setSelectedImageKeys] = useState<Set<string>>(new Set());
  const [queryText, setQueryText] = useState(() => initialQueryText(panel));
  const selectedResult = panel.result?.kind === "image"
    ? {
        ...panel.result,
        images: panel.result.images.filter((image, index) => selectedImageKeys.has(imageLookupKey(image, index))),
      }
    : panel.result;
  const canSave = Boolean(selectedResult && panel.status === "ready" && (selectedResult.kind !== "image" || selectedResult.images.length > 0));

  useEffect(() => {
    setSelectedImageKeys(new Set());
  }, [panel.result]);

  useEffect(() => {
    setQueryText(initialQueryText(panel));
  }, [panel.action, panel.queryText, panel.selection.text]);

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

      {panel.action === "question" ? (
        <form
          className="lookup-query-form question-query-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch(queryText);
          }}
        >
          <label>
            <span>Question</span>
            <textarea
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              onKeyDown={(event) => {
                if (shouldSubmitTextArea(event, submitShortcut) && queryText.trim()) {
                  event.preventDefault();
                  onSearch(queryText);
                }
              }}
              placeholder="이 부분에 대해 더 묻고 싶은 점"
              rows={3}
            />
          </label>
          <button type="submit" title="Ask" disabled={panel.status === "saving" || panel.status === "loading" || !queryText.trim()}>
            <MessageSquare size={15} />
          </button>
        </form>
      ) : (
        <form
          className="lookup-query-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch(queryText);
          }}
        >
          <label>
            <span>Search keyword</span>
            <input value={queryText} onChange={(event) => setQueryText(event.target.value)} />
          </label>
          <button type="submit" title="Search" disabled={panel.status === "saving" || !queryText.trim()}>
            <Search size={15} />
          </button>
        </form>
      )}

      {panel.status === "loading" || panel.status === "saving" ? (
        <div className="lookup-state">
          <Loader2 size={18} className="spin" />
          <span>{panel.status === "saving" ? "저장 중" : panel.action === "question" ? "답변 중" : "찾는 중"}</span>
        </div>
      ) : null}

      {panel.status === "error" ? (
        <div className="lookup-error">
          <p>{panel.error || "Lookup failed."}</p>
        </div>
      ) : null}

      {panel.result && panel.status !== "loading" && panel.status !== "saving" && panel.status !== "error" ? (
        <LookupResultBody result={panel.result} selectedImageKeys={selectedImageKeys} onSelectedImageKeysChange={setSelectedImageKeys} />
      ) : null}

      {panel.status === "saved" ? <p className="lookup-saved">저장되었습니다.</p> : null}

      <footer>
        <button type="button" className="wide-button" onClick={onClose}>
          닫기
        </button>
        <button type="button" className="wide-button primary" onClick={() => selectedResult && onSave(selectedResult)} disabled={!canSave}>
          <Save size={15} /> {selectedResult?.kind === "image" ? `Save ${selectedResult.images.length}` : "Save"}
        </button>
      </footer>
    </aside>
  );
}

function LookupResultBody({
  result,
  selectedImageKeys,
  onSelectedImageKeysChange,
}: {
  result: LookupResult | ImageLookupResult;
  selectedImageKeys?: Set<string>;
  onSelectedImageKeysChange?: (keys: Set<string>) => void;
}) {
  if (result.kind === "image") {
    const selectable = Boolean(onSelectedImageKeysChange && selectedImageKeys);
    function toggleImage(key: string) {
      if (!onSelectedImageKeysChange || !selectedImageKeys) return;
      const next = new Set(selectedImageKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectedImageKeysChange(next);
    }

    return (
      <div className="lookup-result-body">
        {result.images.length ? (
          <div className="lookup-image-grid">
            {result.images.map((image, index) => {
              const key = imageLookupKey(image, index);
              if (!selectable) {
                return (
                  <a
                    key={key}
                    href={image.pageUrl || image.imageUrl || image.thumbnailUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={image.title}
                  >
                    <img src={image.thumbnailUrl} alt={image.title} loading="lazy" />
                  </a>
                );
              }
              const selected = selectedImageKeys?.has(key) || false;
              return (
                <button
                  key={key}
                  type="button"
                  className={`lookup-image-choice${selected ? " selected" : ""}`}
                  onClick={() => toggleImage(key)}
                  title={image.title}
                  aria-pressed={selected}
                >
                  <img src={image.thumbnailUrl} alt={image.title} loading="lazy" />
                  <span>{selected ? "Selected" : "Select"}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="lookup-empty">관련 이미지를 찾지 못했습니다.</p>
        )}
      </div>
    );
  }

  return (
    <div className="lookup-result-body">
      {result.kind === "question" ? (
        result.question ? <blockquote className="lookup-question-text">{result.question}</blockquote> : null
      ) : (
        <h4>{result.title}</h4>
      )}
      <MarkdownContent content={result.body} compact />
      <SourceMetaLinks sourceMeta={result.sourceMeta} />
    </div>
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
