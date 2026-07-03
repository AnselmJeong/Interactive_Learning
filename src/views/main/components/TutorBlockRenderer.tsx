import { memo, useState } from "react";
import type { SourceRef, TutorContentBlock } from "../../../shared/tutor-types";
import { MarkdownContent } from "./MarkdownContent";
import { SourceFigureCard } from "./SourceFigureCard";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type CompareTableBlock = Extract<TutorContentBlock, { type: "compare_table" }>;
type FlowBlock = Extract<TutorContentBlock, { type: "flow" }>;

function pipeCells(line: string) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isMarkdownTableDivider(line: string) {
  return pipeCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownPipeTable(text: string): CompareTableBlock | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"));
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const dividerLine = lines[1];
  if (!headerLine || !dividerLine || !isMarkdownTableDivider(dividerLine)) return null;
  const columns = pipeCells(headerLine).slice(0, 4);
  if (columns.length < 2) return null;
  const rows = lines
    .slice(2)
    .map((line) => pipeCells(line))
    .filter((cells) => cells.length >= 2)
    .map((cells) => Object.fromEntries(columns.map((column, index) => [column, (cells[index] || "").slice(0, 220)])))
    .filter((row) => columns.some((column) => row[column]))
    .slice(0, 5);
  return rows.length ? { type: "compare_table", columns, rows } : null;
}

function splitFlowTitle(firstPart: string) {
  const normalized = firstPart.replace(/[：:]$/, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.{4,45}?(?:구조|맥락|과정|흐름|논리|구분|대조|관계|전개))\s+(.{2,})$/u);
  if (!match) return { title: normalized, firstStep: "" };
  const [, title = "", firstStep = ""] = match;
  return { title: title.trim(), firstStep: firstStep.trim() };
}

function parseLoosePipeFlow(text: string): FlowBlock | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized.includes("|")) return null;
  const parts = normalized.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const { title, firstStep } = splitFlowTitle(parts[0] || "");
  const stepParts = firstStep ? [firstStep, ...parts.slice(1)] : parts.slice(1);
  const steps = stepParts
    .map((part) => part.replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  return steps.length >= 2 ? { type: "flow", title: title.slice(0, 90), steps } : null;
}

function parsePipeStructure(text: string): CompareTableBlock | FlowBlock | null {
  if ((text.match(/\|/g) || []).length < 2) return null;
  return parseMarkdownPipeTable(text) || parseLoosePipeFlow(text);
}

function splitNumberedFlowIntro(prefix: string) {
  const normalized = prefix.replace(/\s+/g, " ").trim();
  if (!normalized) return { intro: "", title: "" };
  const titleLike = /(구조|맥락|과정|흐름|논리|도출|전개|단계|순서|경로)$/u;
  const sentenceBreak = normalized.lastIndexOf(". ");
  if (sentenceBreak >= 0) {
    const intro = normalized.slice(0, sentenceBreak + 1).trim();
    const tail = normalized.slice(sentenceBreak + 2).trim().replace(/[：:]$/u, "");
    if (tail.length >= 4 && tail.length <= 90 && titleLike.test(tail)) return { intro, title: tail };
  }
  const asTitle = normalized.replace(/[：:]$/u, "");
  if (asTitle.length >= 4 && asTitle.length <= 90 && titleLike.test(asTitle)) return { intro: "", title: asTitle };
  return { intro: normalized, title: "" };
}

function splitNumberedFlowTail(finalStep: string) {
  const match = finalStep.match(/^(.{35,}?[.!?。…])\s+((?:러셀은|즉|이처럼|결국|따라서|그러므로|다시)\s.+)$/u);
  if (!match) return { step: finalStep.trim(), tail: "" };
  return { step: (match[1] || "").trim(), tail: (match[2] || "").trim() };
}

function parseNumberedFlowBlocks(text: string): TutorContentBlock[] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches = [...normalized.matchAll(/(?:^|\s)([1-8])[.)]\s+/gu)];
  if (matches.length < 3) return null;
  if (matches[0]?.[1] !== "1") return null;
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index]?.[1] !== String(index + 1)) return null;
  }

  const firstIndex = matches[0]?.index ?? -1;
  if (firstIndex < 0) return null;
  const { intro, title } = splitNumberedFlowIntro(normalized.slice(0, firstIndex));
  let tail = "";
  const steps = matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1]?.index ?? normalized.length : normalized.length;
      const rawStep = normalized.slice(start, end).trim();
      if (index !== matches.length - 1) return rawStep;
      const split = splitNumberedFlowTail(rawStep);
      tail = split.tail;
      return split.step;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (steps.length < 3) return null;

  const blocks: TutorContentBlock[] = [];
  if (intro) blocks.push({ type: "paragraph", body: intro.slice(0, 700) });
  blocks.push({ type: "flow", title: title || undefined, steps });
  if (tail) blocks.push({ type: "paragraph", body: tail.slice(0, 500) });
  return blocks;
}

function splitDashBulletTail(segment: string) {
  const transitions = [" 이런 ", " 이제 ", " 따라서 ", " 그러므로 ", " 결국 ", " 다시 ", " 여기서 "];
  const colonIndex = segment.search(/[：:]/u);
  const minIndex = colonIndex >= 0 ? colonIndex + 16 : 24;
  const candidates = transitions
    .map((token) => {
      const index = segment.indexOf(token, minIndex);
      return index >= 0 ? { token, index } : null;
    })
    .filter((item): item is { token: string; index: number } => Boolean(item))
    .sort((a, b) => a.index - b.index);
  const first = candidates[0];
  if (!first) return { item: segment.trim(), tail: "" };
  return {
    item: segment.slice(0, first.index).trim().replace(/[,\s]+$/u, ""),
    tail: segment.slice(first.index + 1).trim(),
  };
}

function parseDashBulletBlocks(text: string): TutorContentBlock[] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized.includes(" - ")) return null;
  const parts = normalized.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const title = parts[0] || "";
  const rawItems = parts.slice(1);
  const labeledCount = rawItems.filter((item) => /^[^:：]{1,48}[：:]\s*\S/u.test(item)).length;
  if (labeledCount < 2) return null;

  let tail = "";
  const items = rawItems
    .map((item, index) => {
      if (index !== rawItems.length - 1) return item.trim();
      const split = splitDashBulletTail(item);
      tail = split.tail;
      return split.item;
    })
    .filter(Boolean)
    .slice(0, 5);
  if (items.length < 2) return null;

  const blocks: TutorContentBlock[] = [{ type: "bullets", title: title.slice(0, 90), items }];
  if (tail) blocks.push({ type: "paragraph", body: tail.slice(0, 500) });
  return blocks;
}

function blockSourceRef(block: TutorContentBlock) {
  if (block.type === "guided_reading" && block.sourceRef) return block.sourceRef;
  if (block.type === "source_quote") return block.sourceRef;
  return null;
}

export const TutorBlockRenderer = memo(function TutorBlockRenderer({
  blocks,
  sourceRefById,
  fallbackSourceRefs = [],
  materialId,
  request,
}: {
  blocks: TutorContentBlock[];
  sourceRefById?: Map<string, SourceRef>;
  fallbackSourceRefs?: SourceRef[];
  materialId?: string;
  request?: RpcRequest;
}) {
  const visibleBlocks = blocks.filter((block) => block.type !== "source_quote" || block.showToLearner);
  if (!visibleBlocks.length) return null;
  const renderedFigureIds = new Set<string>();

  function figuresFor(refId: string | null) {
    if (!refId || !sourceRefById || !materialId || !request) return [];
    const figures = sourceRefById.get(refId)?.figures || [];
    return figures.filter((figure) => {
      if (renderedFigureIds.has(figure.id)) return false;
      renderedFigureIds.add(figure.id);
      return true;
    });
  }

  function fallbackFigures() {
    if (!materialId || !request) return [];
    return fallbackSourceRefs.flatMap((ref) => ref.figures || []).filter((figure) => {
      if (renderedFigureIds.has(figure.id)) return false;
      renderedFigureIds.add(figure.id);
      return true;
    });
  }

  return (
    <div className="tutor-block-stack">
      {visibleBlocks.map((block, index) => {
        const figures = figuresFor(blockSourceRef(block));
        return (
          <div key={`${block.type}-${index}`} className="tutor-block-with-figures">
            <TutorBlock block={block} />
            {figures.length && materialId && request ? (
              <div className="tutor-inline-figures">
                {figures.map((figure) => (
                  <SourceFigureCard key={figure.id} figure={figure} materialId={materialId} request={request} compact />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {(() => {
        const figures = fallbackFigures();
        return figures.length && materialId && request ? (
          <div className="tutor-inline-figures">
            {figures.map((figure) => (
              <SourceFigureCard key={figure.id} figure={figure} materialId={materialId} request={request} compact />
            ))}
          </div>
        ) : null;
      })()}
    </div>
  );
});

function TutorBlock({ block }: { block: TutorContentBlock }) {
  if (block.type === "hook") {
    return (
      <section className="tutor-block hook-block">
        <p>{block.body}</p>
      </section>
    );
  }

  if (block.type === "source_quote") {
    if (!block.showToLearner) return null;
    return (
      <section className="tutor-block source-quote-block">
        <p>{block.quote}</p>
        <small>{block.attribution || block.sourceRef}</small>
      </section>
    );
  }

  if (block.type === "guided_reading") {
    return (
      <section className="tutor-block guided-reading-block">
        <span>함께 읽기</span>
        <MarkdownContent content={block.body} compact />
      </section>
    );
  }

  if (block.type === "paragraph") {
    const numberedFlowBlocks = parseNumberedFlowBlocks(block.body);
    if (numberedFlowBlocks) {
      return (
        <>
          {numberedFlowBlocks.map((item, index) => (
            <TutorBlock key={`${item.type}-${index}`} block={item} />
          ))}
        </>
      );
    }
    const dashBlocks = parseDashBulletBlocks(block.body);
    if (dashBlocks) {
      return (
        <>
          {dashBlocks.map((item, index) => (
            <TutorBlock key={`${item.type}-${index}`} block={item} />
          ))}
        </>
      );
    }
    const structure = parsePipeStructure(block.body);
    if (structure) return <TutorBlock block={structure} />;
    return (
      <section className="tutor-block paragraph-block">
        <MarkdownContent content={block.body} compact />
      </section>
    );
  }

  if (block.type === "bullets") {
    return (
      <section className="tutor-block bullet-block">
        {block.title ? <h4>{block.title}</h4> : null}
        <ul>
          {block.items.map((item) => (
            <li key={item}>
              <MarkdownContent content={item} compact />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (block.type === "flow") {
    return (
      <section className="tutor-block flow-block">
        {block.title ? <h4>{block.title}</h4> : null}
        <ol>
          {block.steps.map((step, index) => (
            <li key={`${index}-${step}`}>
              <span>{index + 1}</span>
              <MarkdownContent content={step} compact />
            </li>
          ))}
        </ol>
      </section>
    );
  }

  if (block.type === "compare_table") {
    return (
      <section className="tutor-block compare-table-block">
        {block.title ? <h4>{block.title}</h4> : null}
        <div className="block-table-scroll">
          <table>
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.columns.map((column) => (
                    <td key={column}>
                      <MarkdownContent content={row[column] || ""} compact />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (block.type === "reflection") {
    return <ReflectionBlock block={block} />;
  }

  if (block.type === "misconception") {
    return (
      <section className="tutor-block misconception-block">
        <h4>{block.title || "헷갈릴 수 있는 지점"}</h4>
        <p>{block.body}</p>
        <div className="misconception-repair">
          <MarkdownContent content={block.repair} compact />
        </div>
      </section>
    );
  }

  return (
    <section className="tutor-block bridge-block">
      <p>{block.body}</p>
    </section>
  );
}

function ReflectionBlock({ block }: { block: Extract<TutorContentBlock, { type: "reflection" }> }) {
  const [open, setOpen] = useState(false);
  const hasAiView = Boolean(block.aiView?.trim());
  return (
    <section className="tutor-block reflection-block">
      <span>생각해 볼 점</span>
      <p>{block.body}</p>
      {hasAiView ? (
        <>
          <button type="button" className="ai-view-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            AI의 견해
          </button>
          {open ? (
            <div className="ai-view-panel">
              <MarkdownContent content={block.aiView || ""} compact />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
