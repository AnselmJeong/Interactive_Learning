import katex from "katex";

/**
 * Math detection shared by the Markdown and HTML renderers.
 *
 * Model output does not always delimit math cleanly: rich HTML blocks carry
 * `$f = 1/T$` as plain text, and some answers leave `\frac{1}{T}` or
 * `2\text{ Hz}` with no delimiters at all. These helpers find both forms and
 * only accept a candidate when KaTeX can actually render it, so ordinary text
 * (prices, paths, prose) stays untouched.
 */

export type MathSegment =
  | { kind: "text"; value: string }
  | { kind: "math"; value: string; tex: string; display: boolean };

const MATH_TOKEN_CHARS = /[A-Za-z0-9\\{}()[\]^_=+\-*/.,|<>'!:~Ͱ-Ͽ·×÷′−←-⇿∀-⋿ ]/u;
const LATEX_COMMAND = /\\[A-Za-z]+/gu;
const PLAIN_WORD = /^[A-Za-z]{2,}[.,;:!?]*$/u;
const MATHY_TOKEN = /[0-9=+\-*/^_{}()<>|\\Ͱ-Ͽ·×÷−∀-⋿]|^[A-Za-z]$/u;

export function canRenderTex(tex: string, display = false): boolean {
  if (!tex.trim()) return false;
  try {
    katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function renderTex(tex: string, display = false): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", output: "htmlAndMathml" });
}

function isEscaped(text: string, index: number) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Find `$$…$$`, `\[…\]`, `\(…\)` and `$…$` spans that KaTeX accepts. */
export function splitDelimitedMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) segments.push({ kind: "text", value: buffer });
    buffer = "";
  };
  const accept = (raw: string, tex: string, display: boolean) => {
    flush();
    segments.push({ kind: "math", value: raw, tex: tex.trim(), display });
  };
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("$$") && !isEscaped(text, i)) {
      const end = text.indexOf("$$", i + 2);
      if (end > i + 2 && canRenderTex(text.slice(i + 2, end), true)) {
        accept(text.slice(i, end + 2), text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }
    if ((rest.startsWith("\\[") || rest.startsWith("\\(")) && !isEscaped(text, i)) {
      const display = rest[1] === "[";
      const end = text.indexOf(display ? "\\]" : "\\)", i + 2);
      if (end > i + 2 && canRenderTex(text.slice(i + 2, end), display)) {
        accept(text.slice(i, end + 2), text.slice(i + 2, end), display);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "$" && !isEscaped(text, i) && text[i + 1] !== "$" && text[i + 1] && !/\s/u.test(text[i + 1]!)) {
      let end = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        const char = text[j];
        if (char === "\n") break;
        if (char === "$" && !isEscaped(text, j)) {
          // `$5 and $10` is prose about money, not math.
          if (!/\s/u.test(text[j - 1]!) && !/[0-9]/u.test(text[j + 1] || "")) end = j;
          break;
        }
      }
      if (end > i + 1 && canRenderTex(text.slice(i + 1, end))) {
        accept(text.slice(i, end + 1), text.slice(i + 1, end), false);
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return segments;
}

function balancedBraces(value: string) {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\") { i += 1; continue; }
    if (value[i] === "{") depth += 1;
    if (value[i] === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function trimTrailingProse(value: string) {
  const tokens = value.split(/(\s+)/u);
  while (tokens.length) {
    const last = tokens[tokens.length - 1]!;
    if (!last.trim() || (PLAIN_WORD.test(last) && !last.includes("\\"))) tokens.pop();
    else break;
  }
  let result = tokens.join("");
  // Sentence punctuation after a formula is prose.
  while (/[.,;:!?]$/u.test(result) && balancedBraces(result.slice(0, -1))) result = result.slice(0, -1);
  while (result.endsWith(")") && (result.match(/\(/gu) || []).length < (result.match(/\)/gu) || []).length) result = result.slice(0, -1);
  return result.trimEnd();
}

function leadingMathTokens(prefix: string) {
  // Characters glued to the command (`2\text`, `x=\frac`) always belong to it.
  const tokens = prefix.split(/(\s+)/u);
  let kept = "";
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (!token.trim()) {
      kept = token + kept;
      continue;
    }
    const glued = index === tokens.length - 1;
    if (!glued && (PLAIN_WORD.test(token) || !MATHY_TOKEN.test(token))) break;
    kept = token + kept;
  }
  let result = kept.trimStart();
  while (result.startsWith("(") && (result.match(/\(/gu) || []).length > (result.match(/\)/gu) || []).length) result = result.slice(1).trimStart();
  return result;
}

/** Find undelimited LaTeX such as `2\text{ Hz}` or `f = \frac{1}{T}` in plain text. */
export function splitBareLatex(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let cursor = 0;
  LATEX_COMMAND.lastIndex = 0;
  for (let match = LATEX_COMMAND.exec(text); match; match = LATEX_COMMAND.exec(text)) {
    const commandStart = match.index;
    if (commandStart < cursor) continue;
    let left = commandStart;
    while (left > cursor && MATH_TOKEN_CHARS.test(text[left - 1]!) && text[left - 1] !== "\n") left -= 1;
    let right = commandStart;
    let depth = 0;
    while (right < text.length) {
      const char = text[right]!;
      if (char === "\n") break;
      if (char === "\\" && right + 1 < text.length) { right += 2; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      if (depth <= 0 && !MATH_TOKEN_CHARS.test(char)) break;
      right += 1;
    }
    // Markdown emphasis markers around a formula are not part of it.
    const head = leadingMathTokens(text.slice(left, commandStart)).replace(/^[*_]+/u, "");
    const tail = trimTrailingProse(text.slice(commandStart, right)).replace(/[*_]+$/u, "");
    const tex = `${head}${tail}`;
    const start = commandStart - head.length;
    if (!tail || !balancedBraces(tex) || !canRenderTex(tex)) continue;
    if (start > cursor) segments.push({ kind: "text", value: text.slice(cursor, start) });
    segments.push({ kind: "math", value: tex, tex, display: false });
    cursor = start + tex.length;
    LATEX_COMMAND.lastIndex = cursor;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

/** Delimited math first, then undelimited LaTeX in what is left. */
export function splitMathText(text: string, options: { bareLatex?: boolean } = {}): MathSegment[] {
  const delimited = splitDelimitedMath(text);
  if (options.bareLatex === false) return delimited;
  return delimited.flatMap((segment) => (segment.kind === "text" && segment.value.includes("\\") ? splitBareLatex(segment.value) : [segment]));
}

/** Wrap undelimited LaTeX in `$…$` so remark-math can pick it up. */
export function delimitBareLatex(text: string): string {
  if (!text.includes("\\")) return text;
  return splitBareLatex(text).map((segment) => (segment.kind === "math" ? `$${segment.tex}$` : segment.value)).join("");
}
