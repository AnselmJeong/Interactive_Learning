import type { ExplanationGrounding, ExplanationStatus } from "../../../shared/deep-reading-types";
import type { SourceRef } from "../../../shared/tutor-types";

// Only statuses that change how the learner should read the explanation get a badge.
// Source passages are reached through the message-level "관련 원문 보기" button instead of
// a per-block disclosure, so grounding evidence is not rendered here.
const labels: Partial<Record<ExplanationStatus, string>> = { analogy: "설명용 비유", background: "배경지식" };

export function ExplanationEvidence({ grounding }: { grounding?: ExplanationGrounding; sourceRefById?: Map<string, SourceRef> }) {
  const label = grounding ? labels[grounding.status] : undefined;
  if (!label) return null;
  return (
    <aside className="explanation-evidence">
      <span className="explanation-status">{label}</span>
    </aside>
  );
}
