import { Loader2, RefreshCw } from "lucide-react";
import type { PreparedLearningIrResult } from "../../../shared/learning-ir-types";
import { ConceptGraphView } from "./ConceptGraphView";

export function LearningGuideView({
  result,
  busy = false,
  onOpenSource,
  onOpenLearningMessage,
  learnedRouteIndex,
  canOpenLearningMessage,
  onRetry,
}: {
  result: PreparedLearningIrResult;
  busy?: boolean;
  onOpenSource?: (chunkId: string) => void;
  onOpenLearningMessage?: (preparedMessageId: string) => void;
  learnedRouteIndex?: number;
  canOpenLearningMessage?: (preparedMessageId: string) => boolean;
  onRetry?: () => void;
}) {
  if (result.status === "ready" && result.ir) {
    return (
      <article className="learning-guide">
        <ConceptGraphView
          ir={result.ir}
          onOpenSource={onOpenSource}
          onOpenLearningMessage={onOpenLearningMessage}
          learnedRouteIndex={learnedRouteIndex}
          canOpenLearningMessage={canOpenLearningMessage}
        />
      </article>
    );
  }

  const generating = busy || result.status === "generating";
  return (
    <article className="learning-guide learning-guide-status" aria-live="polite">
      <div className="learning-guide-status-card">
        {generating ? <Loader2 size={24} className="spin" aria-hidden="true" /> : null}
        <p className="eyebrow">학습지도</p>
        <h3>{generating ? "학습지도를 만들고 있습니다" : result.status === "unavailable" ? "학습지도를 표시하지 못했습니다" : "학습지도를 준비하고 있습니다"}</h3>
        <p>
          {generating
            ? "사전 생성 메시지는 모두 준비되었습니다. 전체 수업에서 실제로 설명한 개념과 그 관계를 정리하는 중입니다."
            : result.status === "unavailable"
              ? result.error || "완성된 메시지에서 확인할 수 있는 개념 관계가 부족합니다."
              : "사전 생성 메시지가 모두 준비되면 이곳에서 개념과 관계를 볼 수 있습니다."}
        </p>
        {result.status === "unavailable" && onRetry ? (
          <button type="button" className="wide-button" onClick={onRetry} disabled={busy}>
            <RefreshCw size={15} aria-hidden="true" /> 다시 만들기
          </button>
        ) : null}
      </div>
    </article>
  );
}
