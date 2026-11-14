import { Check, Loader2 } from "lucide-react";
import type { GenerationProgress } from "../../../shared/rpc-types";

type GenerationStatusProps = {
  status: string;
  busy: boolean;
  progress: GenerationProgress | null;
  // Background material generation: which source it is for and how many jobs are running.
  jobLabel?: string;
  jobCount?: number;
};

function boundedProgress(progress: number) {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function GenerationStatus({ status, busy, progress, jobLabel, jobCount = 0 }: GenerationStatusProps) {
  const activeProgress = progress && progress.stage !== "complete" && progress.stage !== "failed"
    ? progress
    : null;
  const progressValue = boundedProgress(activeProgress?.progress ?? 0);
  const backgroundJobs = Math.max(jobCount, activeProgress ? 1 : 0);
  const otherJobs = backgroundJobs > 1 ? ` 외 ${backgroundJobs - 1}건` : "";
  const jobText = activeProgress
    ? `${jobLabel ? `${jobLabel} · ` : ""}${activeProgress.message}${otherJobs}`
    : backgroundJobs
      ? `${jobLabel ? `${jobLabel} · ` : ""}학습 자료 준비 시작${otherJobs}`
      : null;
  const text = jobText || status;
  const title = jobText ? `${jobText}\n백그라운드에서 준비 중입니다. 그동안 계속 학습할 수 있습니다.` : status;

  return (
    <div className={`status-pill${activeProgress ? " generation-active" : ""}`} title={title} aria-live="polite">
      <div className="status-pill-main">
        {busy || backgroundJobs ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
        <span className="status-text">{text}</span>
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
