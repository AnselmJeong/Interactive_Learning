import { useCallback, useEffect, useRef, useState } from "react";
import type { BuddyMessageInput, BuddyMessageMood } from "../../../shared/rpc-types";
import {
  crossedLearningMilestone,
  LEARNING_MILESTONE_COPY,
  type LearningMilestone,
} from "../learning-milestones";

type PrefetchState = "idle" | "generating" | "ready" | "failed";
type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
type BuddyScreenSide = "left" | "right";
const botanBuddySrc = "views://main/assets/botan-kamiina-sharpened.webp";
export const LEARNING_MILESTONE_ASSET: Record<LearningMilestone, string> = {
  30: "views://main/assets/buddy-milestone-30.gif",
  50: "views://main/assets/buddy-milestone-50.gif",
  85: "views://main/assets/buddy-milestone-85.gif",
  100: "views://main/assets/buddy-milestone-100.gif",
};

const MILESTONE_DURATION_MS: Record<LearningMilestone, number> = {
  30: 1150,
  50: 1250,
  85: 1150,
  100: 1150,
};

function clickFailureMessage(error: unknown) {
  const detail = (error as Error)?.message?.replace(/\s+/g, " ").trim();
  if (!detail) return "지금은 새 한마디를 만들지 못했어요. 잠시 후 다시 눌러 주세요.";
  return `지금은 새 한마디를 만들지 못했어요. ${detail.slice(0, 120)}`;
}

export function resolveLearningBuddyLayout({
  viewMode,
  leftPaneOpen,
  rightPaneOpen,
}: {
  viewMode: "chat" | "source";
  leftPaneOpen: boolean;
  rightPaneOpen: boolean;
}): { screenSide: BuddyScreenSide; bubbleSide: BuddyScreenSide } {
  const screenSide = viewMode === "source" ? "right" : "left";
  const bubbleSide = screenSide === "right"
    ? (rightPaneOpen ? "right" : "left")
    : (leftPaneOpen ? "left" : "right");
  return { screenSide, bubbleSide };
}

export function LearningBuddy({
  enabled,
  active,
  request,
  viewMode,
  leftPaneOpen,
  rightPaneOpen,
  thinking,
  prefetchState,
  progressPercent,
  sessionId,
  currentModuleTitle,
  currentModuleContext,
  complete,
}: {
  enabled: boolean;
  active: boolean;
  request: RpcRequest;
  viewMode: "chat" | "source";
  leftPaneOpen: boolean;
  rightPaneOpen: boolean;
  thinking: boolean;
  prefetchState: PrefetchState;
  progressPercent: number;
  sessionId: string | null;
  currentModuleTitle?: string;
  currentModuleContext?: string | null;
  complete: boolean;
}) {
  const [progressPulse, setProgressPulse] = useState(false);
  const [milestone, setMilestone] = useState<LearningMilestone | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const previousProgressRef = useRef(progressPercent);
  const previousSessionIdRef = useRef(sessionId);
  const chatRequestIdRef = useRef(0);

  useEffect(() => {
    if (sessionId !== previousSessionIdRef.current) {
      previousSessionIdRef.current = sessionId;
      previousProgressRef.current = progressPercent;
      setProgressPulse(false);
      setMilestone(null);
      return;
    }
    if (!active) {
      previousProgressRef.current = progressPercent;
      return;
    }
    if (progressPercent > previousProgressRef.current) {
      setProgressPulse(true);
      setMilestone(crossedLearningMilestone(previousProgressRef.current, progressPercent));
      const timeout = window.setTimeout(() => setProgressPulse(false), 1100);
      previousProgressRef.current = progressPercent;
      return () => window.clearTimeout(timeout);
    }
    previousProgressRef.current = progressPercent;
  }, [active, progressPercent, sessionId]);

  useEffect(() => {
    if (!milestone) return;
    const timeout = window.setTimeout(() => setMilestone(null), MILESTONE_DURATION_MS[milestone]);
    return () => window.clearTimeout(timeout);
  }, [milestone]);

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

  const { screenSide, bubbleSide } = resolveLearningBuddyLayout({ viewMode, leftPaneOpen, rightPaneOpen });
  const milestoneCopy = milestone ? LEARNING_MILESTONE_COPY[milestone] : null;
  const portraitSrc = milestone ? LEARNING_MILESTONE_ASSET[milestone] : botanBuddySrc;

  return (
    <div
      className="learning-buddy"
      data-mood={mood}
      data-milestone={milestone || undefined}
      data-side={screenSide}
      data-bubble-side={bubbleSide}
    >
      {milestoneCopy ? (
        <div className="learning-buddy-milestone" role="status" aria-live="polite">
          <span>{milestone}%</span>
          <div>
            <strong>{milestoneCopy.title}</strong>
            <small>{milestoneCopy.detail}</small>
          </div>
        </div>
      ) : null}
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
      <button type="button" className="learning-buddy-button" onClick={showClickMessage} aria-label="Kamiina Botan learning buddy 메시지 열기" aria-expanded={Boolean(message)}>
        <div className="learning-buddy-stage" aria-hidden="true">
          <div className="buddy-celebration-sprites">
            {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
          </div>
          <span className="buddy-note buddy-note-a" />
          <span className="buddy-note buddy-note-b" />
          <span className="buddy-note buddy-note-c" />
          <div className="buddy-portrait">
            <img key={milestone ? `milestone-${milestone}` : "still"} src={portraitSrc} alt="" draggable={false} />
            <span className="buddy-glint" />
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
