import { useCallback, useEffect, useRef, useState } from "react";
import type { BuddyMessageInput, BuddyMessageMood } from "../../../shared/rpc-types";

type PrefetchState = "idle" | "generating" | "ready" | "failed";
type BuddyMessageKind = "auto" | "chat";
type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

const FALLBACK_CLICK_MESSAGES = [
  "저는 책갈피 출신이라, 진도 욕심이 조금 있어요.",
  "어려운 문장은 반으로 접어서 보면 덜 무섭습니다.",
  "각주도 언젠가는 주인공이 되고 싶대요.",
  "잠깐 웃고 다시 갑시다. 이해는 도망가지 않아요.",
  "오늘의 작전: 한 대목만 더 선명하게 만들기.",
];

const FALLBACK_AUTO_MESSAGES: Partial<Record<BuddyMessageMood, string>> = {
  thinking: "잠깐만요. 이어질 설명을 정리하고 있어요.",
  ready: "다음 설명이 준비됐어요.",
  progress: "좋아요. 한 대목 더 지나갔어요.",
  complete: "오늘 학습 흐름을 끝까지 밟았어요.",
};

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
  const fallbackClickMessageIndexRef = useRef(0);
  const requestIdRef = useRef(0);

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

  const fallbackClickMessage = useCallback(() => {
    const text = FALLBACK_CLICK_MESSAGES[fallbackClickMessageIndexRef.current % FALLBACK_CLICK_MESSAGES.length] ?? FALLBACK_CLICK_MESSAGES[0]!;
    fallbackClickMessageIndexRef.current += 1;
    return text;
  }, []);

  const generateMessage = useCallback(async (trigger: BuddyMessageInput["trigger"], kind: BuddyMessageKind) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const previousMessage = message?.text || null;
    if (kind === "chat") {
      setMessage({ text: "한마디 생각하는 중...", kind: "chat" });
    }
    try {
      const result = (await request("buddy.generateMessage", {
        trigger,
        mood,
        progressPercent,
        currentModuleTitle: currentModuleTitle || null,
        tutorThinking: thinking,
        prefetchStatus: prefetchState,
        previousMessage,
      } satisfies BuddyMessageInput)) as { text?: string };
      const text = result.text?.trim();
      if (!text || requestIdRef.current !== requestId) return;
      setMessage((current) => (kind === "auto" && current?.kind === "chat" ? current : { text, kind }));
    } catch {
      if (requestIdRef.current !== requestId) return;
      const text = kind === "chat" ? fallbackClickMessage() : FALLBACK_AUTO_MESSAGES[mood];
      if (!text) return;
      setMessage((current) => (kind === "auto" && current?.kind === "chat" ? current : { text, kind }));
    }
  }, [currentModuleTitle, fallbackClickMessage, message?.text, mood, prefetchState, progressPercent, request, thinking]);

  function showClickMessage() {
    if (!enabled || !active) return;
    void generateMessage("click", "chat");
  }

  useEffect(() => {
    if (!enabled || !active) {
      previousMoodRef.current = null;
      return;
    }
    if (previousMoodRef.current === mood) return;
    previousMoodRef.current = mood;
    if (!FALLBACK_AUTO_MESSAGES[mood]) return;

    let ignore = false;
    let timeout = 0;
    void (async () => {
      await generateMessage("state", "auto");
      if (ignore) return;
      timeout = window.setTimeout(() => {
        setMessage((current) => (current?.kind === "auto" ? null : current));
      }, mood === "complete" ? 6200 : 4200);
    })();
    return () => {
      ignore = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [active, enabled, generateMessage, mood]);

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
