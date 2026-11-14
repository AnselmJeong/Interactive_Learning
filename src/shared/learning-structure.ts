import { restoreLegacyDisplayMathFlow, splitMarkdownPipes } from "./markdown-pipes";
import type { TutorContentBlock } from "./tutor-types";

type TableBlock = Extract<TutorContentBlock, { type: "compare_table" }>;
const divider = /^:?-{2,}:?$/u;

function asTable(columns: string[], cells: string[][]): TableBlock | null {
  if (columns.length < 2 || columns.some((column) => !column) || new Set(columns).size !== columns.length) return null;
  if (!cells.length || cells.some((row) => row.length !== columns.length)) return null;
  const rows = cells.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]!])));
  return { type: "compare_table", columns, rows };
}

/** Accept a whole grid only. Prose around a Markdown table stays in the Markdown renderer. */
export function parseLearningTable(text: string, allowUndivided = false): TableBlock | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
  if (lines.length < 2 || !lines.every((line) => line.includes("|")) || text.includes("\\|")) return null;
  const [columns, second, ...rest] = lines.map((line) =>
    splitMarkdownPipes(line.replace(/^\|/, "").replace(/\|$/, "")).map((cell) => cell.trim()));
  if (!columns || !second) return null;
  if (second.length === columns.length && second.every((cell) => divider.test(cell))) return asTable(columns, rest);
  return allowUndivided ? asTable(columns, [second, ...rest]) : null;
}

// An older parser stored header cells, a row of dashes, then row-major cells as flow steps.
function recoverFlattenedTable(title: string | undefined, steps: string[]): TableBlock | null {
  if (!title) return null;
  const cells = [title, ...steps];
  const width = cells.findIndex((cell) => divider.test(cell));
  if (width < 2 || cells.length < width * 3 || cells.length % width !== 0) return null;
  if (!cells.slice(width, width * 2).every((cell) => divider.test(cell))) return null;
  const rows: string[][] = [];
  for (let i = width * 2; i < cells.length; i += width) rows.push(cells.slice(i, i + width));
  return asTable(cells.slice(0, width), rows);
}

const contrastTitle = /비교|대조|대비|차이|구분|구별|\b(?:vs\.?|versus|comparison|contrasts?|differences?)\b/iu;
const sequenceTitle = /(?:단계|과정|순서|전개|이어지는 경로|발생 경로|작용 경로)$|\b(?:steps in|stages of|sequence of|progression of|pathway from)\b/iu;

/** Change presentation only when the stored content supplies the labels or sequence itself. */
export function learningBlockPresentation(block: TutorContentBlock): TutorContentBlock {
  if (block.type === "paragraph" && !/[\x60$\\]/u.test(block.body)) {
    const chain = /^(?:[^→\n]{1,90}\s+→\s+){2,7}[^→\n]{1,90}$/u;
    if (chain.test(block.body.trim()) && !/[.!?。]\s/u.test(block.body)) {
      return { type: "flow", steps: block.body.trim().split(/\s+→\s+/u), grounding: block.grounding };
    }
  }
  if (block.type !== "flow" && block.type !== "bullets") return block;
  if (block.type === "flow") {
    const formula = restoreLegacyDisplayMathFlow(block.title, block.steps);
    if (formula) return { type: "paragraph", body: formula, grounding: block.grounding };
    const grid = recoverFlattenedTable(block.title, block.steps);
    if (grid) return { ...grid, grounding: block.grounding };
  }
  const items = block.type === "flow" ? block.steps : block.items;
  const title = block.title || "";
  if (items.length < 2) return block;
  if (contrastTitle.test(title)) {
    const cells: string[][] = [];
    for (const item of items) {
      const match = /^([^\n:：]{1,72})[:：]\s+([\s\S]+)$/u.exec(item.trim());
      if (!match || /[\x60$]/u.test(match[1]!)) return block;
      cells.push([match[1]!.trim(), match[2]!]);
    }
    const columns = /[가-힣]/u.test(title) ? ["비교 대상", "설명"] : ["Subject", "Description"];
    const rows = cells.map(([label, explanation]) => ({ [columns[0]!]: label!, [columns[1]!]: explanation! }));
    return { type: "compare_table", columns, rows, title, grounding: block.grounding };
  }
  if (block.type === "bullets" && sequenceTitle.test(title)) {
    return { type: "flow", title, steps: items, grounding: block.grounding };
  }
  return block;
}
