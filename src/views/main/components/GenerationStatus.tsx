import { Check, Loader2 } from "lucide-react";
import type { GenerationProgress } from "../../../shared/rpc-types";

type GenerationStatusProps = {
  status: string;
  busy: boolean;
  progress: GenerationProgress | null;
};

function boundedProgress(progress: number) {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function GenerationStatus({ status, busy, progress }: GenerationStatusProps) {
  const activeProgress = progress && progress.stage !== "complete" && progress.stage !== "failed"
    ? progress
    : null;
  const progressValue = boundedProgress(activeProgress?.progress ?? 0);

  return (
    <div className={`status-pill${activeProgress ? " generation-active" : ""}`} title={status} aria-live="polite">
      <div className="status-pill-main">
        {busy || activeProgress ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
        <span className="status-text">{status}</span>
        {activeProgress ? <span className="status-percent">{progressValue}%</span> : null}
      </div>
      {activeProgress ? (
        <div
          className="generation-progress-bar"
          role="progressbar"
          aria-label="학습 자료 생성 진도"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressValue}
          aria-valuetext={`${activeProgress.message}, ${progressValue}%`}
        >
          <i style={{ transform: `scaleX(${progressValue / 100})` }} />
        </div>
      ) : null}
    </div>
  );
}
