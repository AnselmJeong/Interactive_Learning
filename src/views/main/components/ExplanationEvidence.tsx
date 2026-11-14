import type { ExplanationGrounding, ExplanationStatus } from "../../../shared/deep-reading-types";
import type { SourceRef } from "../../../shared/tutor-types";

// "source" and "interpretation" carry no learning value as visible labels, so only the
// statuses that warn the learner (analogy, background, uncertain) get a badge.
const labels: Partial<Record<ExplanationStatus, string>> = { analogy: "설명용 비유", background: "배경지식", uncertain: "판단 보류" };

export function ExplanationEvidence({ grounding, sourceRefById }: { grounding?: ExplanationGrounding; sourceRefById?: Map<string, SourceRef> }) {
  if (!grounding) return null;
  return (
    <aside className="explanation-evidence">
      {labels[grounding.status] ? <span className="explanation-status">{labels[grounding.status]}</span> : null}
      {grounding.evidence.length ? (
        <details>
          <summary>연결된 원문 {grounding.evidence.length > 1 ? `· ${grounding.evidence.length}` : ""}</summary>
          <p className="evidence-caption">이 설명에 연결된 원문 구절입니다.</p>
          {grounding.evidence.map((entry, index) => {
            const source = sourceRefById?.get(entry.chunkId);
            return <blockquote key={`${entry.chunkId}-${entry.startOffset}-${index}`}>{entry.quote}{source ? <footer>{source.title} · {source.locator}</footer> : null}</blockquote>;
          })}
        </details>
      ) : null}
    </aside>
  );
}
