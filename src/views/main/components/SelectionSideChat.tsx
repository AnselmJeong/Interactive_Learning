import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCcw, Save, Send, X } from "lucide-react";
import type { QuestionThreadResult } from "../../../shared/artifact-types";
import type { ChatSubmitShortcut } from "../../../shared/settings-types";
import { MarkdownContent } from "./MarkdownContent";
import { shouldSubmitTextArea } from "../submit-shortcut";

export type SelectionSideChatState = {
  key: string;
  selectedText: string;
  thread?: QuestionThreadResult;
  annotationId?: string;
  status: "ready" | "asking" | "saving" | "error";
  pendingUserText?: string;
  error?: string;
  x: number;
  y: number;
};

type SelectionSideChatProps = {
  panel: SelectionSideChatState;
  submitShortcut: ChatSubmitShortcut;
  onSend: (text: string) => void;
  onRetry: () => void;
  onSave: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
};

const PANEL_WIDTH = 460;
const PANEL_HEIGHT = 680;

export function clampSideChatPoint(x: number, y: number) {
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 24);
  const height = Math.min(PANEL_HEIGHT, window.innerHeight * 0.72, window.innerHeight - 100);
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, x)),
    y: Math.max(76, Math.min(window.innerHeight - height - 24, y)),
  };
}

export function SelectionSideChat({
  panel,
  submitShortcut,
  onSend,
  onRetry,
  onSave,
  onClose,
  onMove,
}: SelectionSideChatProps) {
  const [draft, setDraft] = useState("");
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const busy = panel.status === "asking" || panel.status === "saving";

  useEffect(() => {
    composerRef.current?.focus();
  }, [panel.key]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [panel.thread?.messages.length, panel.pendingUserText, panel.status]);

  useEffect(() => {
    if (!dragging) return;
    function onPointerMove(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampSideChatPoint(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
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
    dragRef.current = { offsetX: event.clientX - panel.x, offsetY: event.clientY - panel.y };
    setDragging(true);
  }

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  }

  const messages = panel.thread?.messages || [];

  return (
    <aside
      className={`selection-side-chat ${dragging ? "dragging" : ""}`}
      role="dialog"
      aria-label="선택 텍스트 사이드 대화"
      style={{ left: panel.x, top: panel.y }}
    >
      <header className="side-chat-drag-handle" onPointerDown={startDrag} title="드래그해서 이동">
        <div className="side-chat-heading">
          <span>사이드 대화</span>
          <button
            type="button"
            className={`side-chat-selection ${selectionExpanded ? "expanded" : ""}`}
            onClick={() => setSelectionExpanded((current) => !current)}
            aria-expanded={selectionExpanded}
            title={selectionExpanded ? "선택문 접기" : "선택문 전체 보기"}
          >
            <strong>{panel.selectedText}</strong>
            {selectionExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
        <div className="side-chat-header-actions">
          <button
            type="button"
            className={panel.annotationId ? "saved" : "save"}
            onClick={onSave}
            disabled={Boolean(panel.annotationId) || !panel.thread?.messages.length || busy}
            aria-label={panel.annotationId ? "주석으로 저장됨" : "주석으로 저장"}
            title={panel.annotationId ? "저장됨 · 이후 대화는 자동 저장됩니다" : "주석으로 저장"}
          >
            <Save size={15} />
            <span>{panel.annotationId ? "저장됨" : "저장"}</span>
          </button>
          <button type="button" onClick={onClose} aria-label="사이드 대화 닫기" title="닫기">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="side-chat-transcript" ref={transcriptRef} aria-label="사이드 대화 기록">
        {messages.length ? messages.map((message) => (
          <article key={message.id} className={`side-chat-message ${message.role}`}>
            <span>{message.role === "user" ? "나" : "Learnie"}</span>
            {message.role === "assistant" ? <MarkdownContent content={message.content} compact /> : <p>{message.content}</p>}
          </article>
        )) : (
          <p className="side-chat-empty">선택한 문장에 관해 궁금한 점을 물어보세요. 이 대화는 메인 학습 진도와 분리됩니다.</p>
        )}
        {panel.pendingUserText ? (
          <article className="side-chat-message user pending">
            <span>나</span>
            <p>{panel.pendingUserText}</p>
          </article>
        ) : null}
        {panel.status === "asking" ? (
          <div className="side-chat-pending" aria-live="polite">
            <Loader2 size={16} className="spin" aria-hidden="true" /> 답변 작성 중
          </div>
        ) : null}
        {panel.status === "error" ? (
          <div className="side-chat-error" role="alert">
            <p>{panel.error || "대화를 이어가지 못했습니다."}</p>
            {panel.pendingUserText ? (
              <button type="button" onClick={onRetry}>
                <RotateCcw size={14} /> 다시 시도
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        className="side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitTextArea(event, submitShortcut)) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="후속 질문을 입력하세요"
          rows={2}
          disabled={busy}
          aria-label="사이드 대화 질문"
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="질문 보내기" title="보내기">
          <Send size={17} />
        </button>
      </form>
    </aside>
  );
}
