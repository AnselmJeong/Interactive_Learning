import { useCallback, useEffect, useRef, useState } from "react";
import type { BuddyMessageInput, BuddyMessageMood } from "../../../shared/rpc-types";

type PrefetchState = "idle" | "generating" | "ready" | "failed";
type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

function clickFailureMessage(error: unknown) {
  const detail = (error as Error)?.message?.replace(/\s+/g, " ").trim();
  if (!detail) return "지금은 새 한마디를 만들지 못했어요. 잠시 후 다시 눌러 주세요.";
  return `지금은 새 한마디를 만들지 못했어요. ${detail.slice(0, 120)}`;
}

export function LearningBuddy({
  enabled,
  active,
  request,
  viewMode,
  thinking,
  prefetchState,
  progressPercent,
  currentModuleTitle,
  currentModuleContext,
  complete,
}: {
  enabled: boolean;
  active: boolean;
  request: RpcRequest;
  viewMode: "chat" | "source";
  thinking: boolean;
  prefetchState: PrefetchState;
  progressPercent: number;
  currentModuleTitle?: string;
  currentModuleContext?: string | null;
  complete: boolean;
}) {
  const [progressPulse, setProgressPulse] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const previousProgressRef = useRef(progressPercent);
  const chatRequestIdRef = useRef(0);

  useEffect(() => {
    if (!active) {
      previousProgressRef.current = progressPercent;
      return;
    }
    if (progressPercent > previousProgressRef.current) {
      setProgressPulse(true);
      const timeout = window.setTimeout(() => setProgressPulse(false), 1100);
      previousProgressRef.current = progressPercent;
      return () => window.clearTimeout(timeout);
    }
    previousProgressRef.current = progressPercent;
  }, [active, progressPercent]);

  const mood: BuddyMessageMood = complete
    ? "complete"
    : progressPulse
    ? "progress"
    : thinking || prefetchState === "generating"
    ? "thinking"
    : prefetchState === "ready"
    ? "ready"
    : prefetchState === "failed"
    ? "quiet"
    : "idle";
  const latestRequestContextRef = useRef({
    mood,
    progressPercent,
    currentModuleTitle: currentModuleTitle || null,
    currentModuleContext: currentModuleContext || null,
    tutorThinking: thinking,
    prefetchStatus: prefetchState,
    previousMessage: null as string | null,
  });
  latestRequestContextRef.current = {
    mood,
    progressPercent,
    currentModuleTitle: currentModuleTitle || null,
    currentModuleContext: currentModuleContext || null,
    tutorThinking: thinking,
    prefetchStatus: prefetchState,
    previousMessage: message,
  };

  const generateMessage = useCallback(async (trigger: BuddyMessageInput["trigger"]) => {
    const requestId = chatRequestIdRef.current + 1;
    chatRequestIdRef.current = requestId;

    const context = { ...latestRequestContextRef.current };
    setMessage("한마디 생각하는 중...");
    try {
      const result = (await request("buddy.generateMessage", {
        trigger,
        mood: context.mood,
        progressPercent: context.progressPercent,
        currentModuleTitle: context.currentModuleTitle,
        currentModuleContext: context.currentModuleContext,
        tutorThinking: context.tutorThinking,
        prefetchStatus: context.prefetchStatus,
        previousMessage: context.previousMessage,
      } satisfies BuddyMessageInput)) as { text?: string };
      const text = result.text?.trim();
      if (!text) return;
      if (chatRequestIdRef.current !== requestId) return;
      setMessage(text);
    } catch (error) {
      if (chatRequestIdRef.current !== requestId) return;
      setMessage(clickFailureMessage(error));
    }
  }, [request]);

  function showClickMessage() {
    if (!enabled || !active) return;
    void generateMessage("click");
  }

  useEffect(() => {
    if (!enabled || !active) {
      chatRequestIdRef.current += 1;
      setMessage(null);
    }
  }, [active, enabled]);

  if (!enabled || !active) return null;

  return (
    <div className="learning-buddy" data-mood={mood} data-side={viewMode === "source" ? "right" : "left"}>
      {message ? (
        <div
          className="learning-buddy-message chat"
          role="group"
          aria-label="Learning buddy 메시지"
          aria-live="polite"
        >
          <p>{message}</p>
          <div className="learning-buddy-message-actions">
            <button type="button" onClick={showClickMessage}>또 한마디</button>
            <button type="button" onClick={() => setMessage(null)}>닫기</button>
          </div>
        </div>
      ) : null}
      <button type="button" className="learning-buddy-button" onClick={showClickMessage} aria-label="Learning buddy 메시지 열기" aria-expanded={Boolean(message)}>
        <div className="learning-buddy-stage" aria-hidden="true">
          <span className="buddy-note buddy-note-a" />
          <span className="buddy-note buddy-note-b" />
          <span className="buddy-note buddy-note-c" />
          <div className="buddy-book">
            <span className="buddy-cover" />
            <span className="buddy-page-line buddy-page-line-a" />
            <span className="buddy-page-line buddy-page-line-b" />
            <span className="buddy-face">
              <i />
              <i />
              <b />
            </span>
            <span className="buddy-bookmark" />
          </div>
          <div className="buddy-signal">
            <i />
            <i />
            <i />
          </div>
        </div>
      </button>
    </div>
  );
}
