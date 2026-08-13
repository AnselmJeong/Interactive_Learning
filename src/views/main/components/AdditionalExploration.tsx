import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Sparkles } from "lucide-react";
import {
  isAdditionalExplorationSaved,
} from "../additional-exploration";
import { InlineMarkdownContent } from "./MarkdownContent";

export function AdditionalExploration({
  choices,
  savedTitles,
  latest,
  disabled,
  onExplore,
}: {
  choices: string[];
  savedTitles: Set<string>;
  latest: boolean;
  disabled: boolean;
  onExplore: (choice: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(latest);
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(latest);
  }, [latest]);

  if (!choices.length) return null;

  async function addExploration(choice: string) {
    if (pendingChoice) return;
    setPendingChoice(choice);
    setError(null);
    try {
      await onExplore(choice);
    } catch (reason) {
      setError(`추가하지 못했습니다: ${(reason as Error).message || String(reason)}`);
    } finally {
      setPendingChoice(null);
    }
  }

  return (
    <section className={`additional-exploration ${open ? "open" : "collapsed"}`}>
      <button
        type="button"
        className="additional-exploration-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Sparkles size={15} aria-hidden="true" />
        <span>추가 탐색</span>
        <small>{choices.length}</small>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div className="additional-exploration-collapse" aria-hidden={!open}>
        <div className="additional-exploration-inner">
          <p>진도와 별도로 이 대목에 덧붙여 저장합니다.</p>
          <div className="additional-exploration-grid">
            {choices.map((choice) => {
              const saved = isAdditionalExplorationSaved(savedTitles, choice);
              const pending = pendingChoice === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  className={saved ? "saved" : ""}
                  disabled={disabled || saved || Boolean(pendingChoice)}
                  onClick={() => void addExploration(choice)}
                >
                  <InlineMarkdownContent content={choice} />
                  {pending ? (
                    <Loader2 size={14} className="spin" aria-label="추가 중" />
                  ) : saved ? (
                    <Check size={14} aria-label="추가됨" />
                  ) : null}
                </button>
              );
            })}
          </div>
          {error ? <p className="additional-exploration-error" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
