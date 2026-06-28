import type { SourceRef } from "../../../shared/tutor-types";
import { MarkdownContent } from "./MarkdownContent";

function cleanLocator(locator: string) {
  return locator.replace(/^before\s+/i, "").replace(/^document$/i, "").trim();
}

export function SourceInspector({ refs }: { refs: SourceRef[] }) {
  return (
    <section className="inspector-section">
      <p className="eyebrow">Source References</p>
      <div className="source-ref-list">
        {refs.map((ref) => (
          <article key={ref.chunkId} className="source-ref">
            <strong>{ref.title}</strong>
            {cleanLocator(ref.locator) ? <small>{cleanLocator(ref.locator)}</small> : null}
            <MarkdownContent content={ref.text} compact />
          </article>
        ))}
      </div>
    </section>
  );
}
