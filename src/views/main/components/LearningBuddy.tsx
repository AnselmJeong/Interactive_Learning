import { useEffect, useRef, useState } from "react";

type PrefetchState = "idle" | "generating" | "ready" | "failed";
type BuddyMood = "idle" | "thinking" | "ready" | "progress" | "complete" | "quiet";

export function LearningBuddy({
  enabled,
  active,
  viewMode,
  thinking,
  prefetchState,
  progressPercent,
  complete,
}: {
  enabled: boolean;
  active: boolean;
  viewMode: "chat" | "source";
  thinking: boolean;
  prefetchState: PrefetchState;
  progressPercent: number;
  complete: boolean;
}) {
  const [progressPulse, setProgressPulse] = useState(false);
  const previousProgressRef = useRef(progressPercent);

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

  if (!enabled || !active) return null;

  const mood: BuddyMood = complete
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

  return (
    <div className="learning-buddy" data-mood={mood} data-side={viewMode === "source" ? "right" : "left"} aria-hidden="true">
      <div className="learning-buddy-stage">
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
    </div>
  );
}
