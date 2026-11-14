import { describe, expect, test } from "bun:test";
import { renderMathInHtml } from "./math-html";
import { delimitBareLatex, splitMathText } from "./math-text";
// Bun escapes non-ASCII inside String.raw, so Korean fixtures use plain strings.
import { normalizeMarkdownContent } from "./components/MarkdownContent";

const maths = (text: string) => splitMathText(text).filter((s) => s.kind === "math").map((s) => (s.kind === "math" ? s.tex : ""));

describe("math detection", () => {
  test("finds dollar, paren and bracket delimited math", () => {
    expect(maths("그래서 $f = 1/T$입니다.")).toEqual(["f = 1/T"]);
    expect(maths("$2\\text{ Hz}$는 1초에 두 번")).toEqual([String.raw`2\text{ Hz}`]);
    expect(maths("식 \\(e^{-\\lambda d}\\)와 \\[P = 1\\]")).toEqual([String.raw`e^{-\lambda d}`, "P = 1"]);
    expect(maths("$$a^2 + b^2 = c^2$$")).toEqual(["a^2 + b^2 = c^2"]);
  });

  test("leaves prices and escaped dollars alone", () => {
    expect(maths("책값은 $5 and $10 사이입니다.")).toEqual([]);
    expect(maths("\\$x\\$는 그대로")).toEqual([]);
    expect(maths("비용은 $ 20입니다.")).toEqual([]);
  });

  test("finds undelimited LaTeX and stops at prose", () => {
    expect(maths("원문의 예시: 2\\text{ Hz}는 1초에 두 번입니다.")).toEqual([String.raw`2\text{ Hz}`]);
    expect(maths("주파수는 f = \\frac{1}{T}이므로")).toEqual([String.raw`f = \frac{1}{T}`]);
    expect(maths(String.raw`The decay rate \lambda controls it.`)).toEqual([String.raw`\lambda`]);
    expect(maths(String.raw`with power P \propto A^2, the result`)).toEqual([String.raw`P \propto A^2`]);
  });

  test("ignores backslashes that are not math", () => {
    expect(maths("경로 C:\\Users\\name 은 그대로")).toEqual([]);
    expect(delimitBareLatex("줄바꿈 \\n 기호")).toBe("줄바꿈 \\n 기호");
  });
});

describe("renderMathInHtml", () => {
  test("renders $…$ inside headings, paragraphs and asides", () => {
    const html = renderMathInHtml("<h3>그래서 $f = 1/T$입니다.</h3><p>$2\\text{ Hz}$는 두 번</p><aside class=\"learn-aside\">단위 환산 $f = 1/T$</aside>");
    expect(html).not.toContain("$");
    expect(html.match(/class="katex"/gu)?.length).toBe(3);
    expect(html).toContain("입니다.</h3>");
  });

  test("renders bare LaTeX in learning HTML but not in source HTML", () => {
    const raw = "<p>주기 T와 f = \\frac{1}{T}의 관계</p>";
    expect(renderMathInHtml(raw)).toContain('class="katex"');
    expect(renderMathInHtml(raw, { bareLatex: false })).toBe(raw);
  });

  test("leaves code, MathML and prices untouched", () => {
    const raw = "<p>가격 $5 and $10</p><pre><code>$x$</code></pre>";
    expect(renderMathInHtml(raw)).toBe(raw);
  });
});

describe("Markdown bare LaTeX", () => {
  test("wraps undelimited LaTeX for remark-math", () => {
    expect(normalizeMarkdownContent("예를 들어 2\\text{ Hz}는 1초에 두 번입니다.")).toBe("예를 들어 $2\\text{ Hz}$는 1초에 두 번입니다.");
    expect(normalizeMarkdownContent("이미 $\\frac{1}{T}$인 식은 그대로")).toBe("이미 $\\frac{1}{T}$인 식은 그대로");
  });
});
