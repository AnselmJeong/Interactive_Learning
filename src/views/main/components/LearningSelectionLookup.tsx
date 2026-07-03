import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { BookOpen, Image as ImageIcon, Loader2, Save, Search, X } from "lucide-react";
import type { ImageLookupResult, LookupResult, MaterialAnnotation } from "../../../shared/artifact-types";
import { MarkdownContent } from "./MarkdownContent";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
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

type LearningSelectionLookupProps = {
  rootRef: RefObject<HTMLElement | null>;
  materialId: string | null;
  defaultChunkId: string | null;
  request: RpcRequest;
  onAnnotationSaved?: (annotation: MaterialAnnotation) => void;
};

const LOOKUP_PANEL_WIDTH = 420;
const LOOKUP_PANEL_HEIGHT = 560;

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
  const toolbarHeight = 168;
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

function elementFromNode(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function isIgnoredSelectionElement(element: Element | null) {
  return Boolean(element?.closest("button, input, textarea, select, [contenteditable='true'], .selection-toolbar, .lookup-popover, .modal"));
}

function resultSourceMeta(result: LookupResult | ImageLookupResult | undefined) {
  return result?.sourceMeta || [];
}

export function LearningSelectionLookup({
  rootRef,
  materialId,
  defaultChunkId,
  request,
  onAnnotationSaved,
}: LearningSelectionLookupProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [lookupPanel, setLookupPanel] = useState<LookupPanelState | null>(null);
  const selectionTimerRef = useRef<number | null>(null);

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

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const point = toolbarPointForRange(rect, root);
    return {
      chunkId,
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
      setSelection(readSelection());
    }, 40);
  }

  async function runLookup(action: LookupAction, sourceSelection = selection) {
    if (!materialId || !sourceSelection?.chunkId || !sourceSelection.text) return;
    const panelPoint = clampPoint(sourceSelection.x - 448, sourceSelection.y);
    const nextSelection = { ...sourceSelection };
    setSelection(nextSelection);
    setLookupPanel({ action, selection: nextSelection, status: "loading", x: panelPoint.x, y: panelPoint.y });
    const method = action === "define" ? "annotations.define" : action === "lookup" ? "annotations.lookup" : "annotations.findImages";
    try {
      const result = (await request(method, {
        materialId,
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
    if (!materialId || !panel.result || panel.status === "saving" || panel.status === "saved") return;
    if (panel.result.kind === "image" && panel.result.images.length === 0) return;
    setLookupPanel({ ...panel, status: "saving" });
    try {
      const saved = (await request("annotations.save", {
        materialId,
        chunkId: panel.selection.chunkId,
        kind: panel.result.kind,
        selectedText: panel.selection.text,
        result: panel.result,
        sourceMeta: resultSourceMeta(panel.result),
      })) as MaterialAnnotation;
      onAnnotationSaved?.(saved);
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

  function closePanel() {
    setLookupPanel(null);
  }

  return (
    <>
      {selection ? (
        <div className="selection-toolbar" style={{ left: selection.x, top: selection.y }} aria-label="선택 텍스트 작업">
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
          onClose={closePanel}
          onMove={(x, y) => setLookupPanel((current) => (current ? { ...current, x, y } : current))}
        />
      ) : null}
    </>
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
