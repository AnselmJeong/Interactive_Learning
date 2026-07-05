import { useCallback, useEffect, useRef, useState } from "react";
import type { BuddyMessageInput, BuddyMessageMood } from "../../../shared/rpc-types";

type PrefetchState = "idle" | "generating" | "ready" | "failed";
type BuddyMessageKind = "auto" | "chat";
type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

const FALLBACK_AUTO_MESSAGES: Partial<Record<BuddyMessageMood, string>> = {
  thinking: "잠깐만요. 이어질 설명을 정리하고 있어요.",
  ready: "다음 설명이 준비됐어요.",
  progress: "좋아요. 한 대목 더 지나갔어요.",
  complete: "오늘 학습 흐름을 끝까지 밟았어요.",
};

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
  complete: boolean;
}) {
  const [progressPulse, setProgressPulse] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: BuddyMessageKind } | null>(null);
  const previousProgressRef = useRef(progressPercent);
  const previousMoodRef = useRef<BuddyMessageMood | null>(null);
  const autoRequestIdRef = useRef(0);
  const chatRequestIdRef = useRef(0);
  const autoDismissTimeoutRef = useRef<number | null>(null);
  const latestVisibilityRef = useRef({ enabled, active });

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
  const moodVersionRef = useRef(0);
  const renderedMoodRef = useRef(mood);
  if (renderedMoodRef.current !== mood) {
    renderedMoodRef.current = mood;
    moodVersionRef.current += 1;
  }
  const latestRequestContextRef = useRef({
    mood,
    moodVersion: moodVersionRef.current,
    progressPercent,
    currentModuleTitle: currentModuleTitle || null,
    tutorThinking: thinking,
    prefetchStatus: prefetchState,
    previousMessage: null as string | null,
  });
  latestRequestContextRef.current = {
    mood,
    moodVersion: moodVersionRef.current,
    progressPercent,
    currentModuleTitle: currentModuleTitle || null,
    tutorThinking: thinking,
    prefetchStatus: prefetchState,
    previousMessage: message?.text || null,
  };
  latestVisibilityRef.current = { enabled, active };

  const clearAutoDismiss = useCallback(() => {
    if (!autoDismissTimeoutRef.current) return;
    window.clearTimeout(autoDismissTimeoutRef.current);
    autoDismissTimeoutRef.current = null;
  }, []);

  const generateMessage = useCallback(async (trigger: BuddyMessageInput["trigger"], kind: BuddyMessageKind) => {
    const requestId = kind === "chat" ? chatRequestIdRef.current + 1 : autoRequestIdRef.current + 1;
    if (kind === "chat") chatRequestIdRef.current = requestId;
    else autoRequestIdRef.current = requestId;

    const context = { ...latestRequestContextRef.current };
    if (kind === "chat") {
      clearAutoDismiss();
      setMessage({ text: "한마디 생각하는 중...", kind: "chat" });
    }
    try {
      const result = (await request("buddy.generateMessage", {
        trigger,
        mood: context.mood,
        progressPercent: context.progressPercent,
        currentModuleTitle: context.currentModuleTitle,
        tutorThinking: context.tutorThinking,
        prefetchStatus: context.prefetchStatus,
        previousMessage: context.previousMessage,
      } satisfies BuddyMessageInput)) as { text?: string };
      const text = result.text?.trim();
      if (!text) return;
      if (kind === "chat" ? chatRequestIdRef.current !== requestId : autoRequestIdRef.current !== requestId) return;
      if (kind === "auto") {
        const latest = latestRequestContextRef.current;
        const visible = latestVisibilityRef.current;
        if (!visible.enabled || !visible.active || latest.moodVersion !== context.moodVersion) return;
      }
      setMessage((current) => (kind === "auto" && current?.kind === "chat" ? current : { text, kind }));
      if (kind === "auto") {
        clearAutoDismiss();
        autoDismissTimeoutRef.current = window.setTimeout(() => {
          autoDismissTimeoutRef.current = null;
          setMessage((current) => (current?.kind === "auto" ? null : current));
        }, context.mood === "complete" ? 6200 : 4200);
      }
    } catch (error) {
      if (kind === "chat" ? chatRequestIdRef.current !== requestId : autoRequestIdRef.current !== requestId) return;
      const text = kind === "chat" ? clickFailureMessage(error) : FALLBACK_AUTO_MESSAGES[context.mood];
      if (!text) return;
      if (kind === "auto") {
        const latest = latestRequestContextRef.current;
        const visible = latestVisibilityRef.current;
        if (!visible.enabled || !visible.active || latest.moodVersion !== context.moodVersion) return;
      }
      setMessage((current) => (kind === "auto" && current?.kind === "chat" ? current : { text, kind }));
      if (kind === "auto") {
        clearAutoDismiss();
        autoDismissTimeoutRef.current = window.setTimeout(() => {
          autoDismissTimeoutRef.current = null;
          setMessage((current) => (current?.kind === "auto" ? null : current));
        }, context.mood === "complete" ? 6200 : 4200);
      }
    }
  }, [clearAutoDismiss, request]);

  function showClickMessage() {
    if (!enabled || !active) return;
    void generateMessage("click", "chat");
  }

  useEffect(() => {
    if (!enabled || !active) {
      previousMoodRef.current = null;
      autoRequestIdRef.current += 1;
      chatRequestIdRef.current += 1;
      clearAutoDismiss();
      setMessage(null);
      return;
    }
    if (previousMoodRef.current === mood) return;
    previousMoodRef.current = mood;
    if (!FALLBACK_AUTO_MESSAGES[mood]) {
      autoRequestIdRef.current += 1;
      return;
    }

    void generateMessage("state", "auto");
  }, [active, clearAutoDismiss, enabled, generateMessage, mood]);

  useEffect(() => clearAutoDismiss, [clearAutoDismiss]);

  if (!enabled || !active) return null;

  return (
    <div className="learning-buddy" data-mood={mood} data-side={viewMode === "source" ? "right" : "left"}>
      {message ? (
        <div
          className={`learning-buddy-message ${message.kind}`}
          role={message.kind === "auto" ? "status" : "group"}
          aria-label={message.kind === "chat" ? "Learning buddy 메시지" : undefined}
          aria-live="polite"
        >
          <p>{message.text}</p>
          {message.kind === "chat" ? (
            <div className="learning-buddy-message-actions">
              <button type="button" onClick={showClickMessage}>또 한마디</button>
              <button type="button" onClick={() => setMessage(null)}>닫기</button>
            </div>
          ) : null}
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
