import type { LookupSourceMeta } from "../../../shared/artifact-types";

function hostname(source: LookupSourceMeta) {
  if (!source.url) return source.title;
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return source.title;
  }
}

export function QuestionWebSources({ sources }: { sources?: LookupSourceMeta[] }) {
  const linkedSources = (sources || []).filter((source) => Boolean(source.url));
  if (!linkedSources.length) return null;
  return (
    <div className="question-web-sources" aria-label="외부 출처">
      {linkedSources.map((source, index) => (
        <a
          key={`${source.id || index}-${source.url}`}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          title={`${source.title}\n${source.url}${source.snippet ? `\n\n${source.snippet}` : ""}`}
        >
          <strong>{source.id || `S${index + 1}`}</strong>
          <span>·</span>
          <span>{hostname(source)}</span>
        </a>
      ))}
    </div>
  );
}
