import { describe, expect, test } from "bun:test";
import { micromark } from "micromark";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdownContent, MarkdownContent, normalizeLegacySelectedMath, normalizeMarkdownContent } from "./MarkdownContent";

describe("MarkdownContent normalization", () => {
  test("keeps bold markup working before Korean particles after punctuation", () => {
    const html = micromark(normalizeMarkdownContent("**Theosis (신화)**는 기독교 전통에서 중요한 개념입니다."));
    expect(html).toContain("<strong>Theosis (신화)</strong>");
    expect(html).toContain("는 기독교 전통");
  });

  test("repairs model-escaped bold delimiters before Korean particles", () => {
    const html = micromark(normalizeMarkdownContent("\\*\\*Theosis (신화)\\*\\*는 기독교 전통에서 중요한 개념입니다."));
    expect(html).toContain("<strong>Theosis (신화)</strong>");
    expect(html).toContain("는 기독교 전통");
  });

  test("does not rewrite escaped bold markers inside inline code", () => {
    const normalized = normalizeMarkdownContent("코드 `\\*\\*Theosis (신화)\\*\\*는` 그대로 둡니다.");
    expect(normalized).toContain("`\\*\\*Theosis (신화)\\*\\*는`");
  });

  test("converts LaTeX parenthesis delimiters into Markdown inline math", () => {
    const normalized = normalizeMarkdownContent(String.raw`지수 함수 \(e^{-\lambda d}\)를 사용합니다.`);
    expect(normalized).toBe(String.raw`지수 함수 $e^{-\lambda d}$를 사용합니다.`);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: String.raw`지수 함수 \(e^{-\lambda d}\)를 사용합니다.` }));
    expect(html).toContain('class="katex"');
    expect(html).toContain("λ");
  });

  test("converts LaTeX bracket delimiters into Markdown display math outside code", () => {
    const normalized = normalizeMarkdownContent(`결과는 다음과 같습니다.\n\\[\nP(d)=e^{-\\lambda d}\n\\]\n\n코드 \`\\(x\\)\`는 유지합니다.`);
    expect(normalized).toContain(`$$\nP(d)=e^{-\\lambda d}\n$$`);
    expect(normalized).toContain("`\\(x\\)`");
  });

  test("renders bare scientific subscript identifiers from stored tutor messages", () => {
    const content = "시냅스 전류는 sj와 V_syn에 의존하고, 외부 입력 I_ext_i와 가중치 wij는 Gsyn으로 조절됩니다.";
    const normalized = normalizeMarkdownContent(content);
    expect(normalized).toContain(String.raw`$s_{j}$`);
    expect(normalized).toContain(String.raw`$V_{\mathrm{syn}}$`);
    expect(normalized).toContain(String.raw`$I_{\mathrm{ext},i}$`);
    expect(normalized).toContain(String.raw`$w_{ij}$`);
    expect(normalized).toContain(String.raw`$G_{\mathrm{syn}}$`);

    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(html.match(/class="katex"/g)).toHaveLength(5);
    expect(html).toContain("syn");
    expect(html).toContain("ext");
  });

  test("repairs escaped underscores but preserves code and existing math", () => {
    const normalized = normalizeMarkdownContent(String.raw`V\_syn과 $I_{\mathrm{ext},i}$, 코드 \`V_syn\``);
    expect(normalized).toBe(String.raw`$V_{\mathrm{syn}}$과 $I_{\mathrm{ext},i}$, 코드 \`V_syn\``);
  });

  test("collapses legacy triple KaTeX selection text into one inline formula", () => {
    const legacy = "이 미분방정식을 τmdVdt=−(V−Vss)\\tau_m \\frac{dV}{dt} = - (V - V_{ss})τm​dtdV​=−(V−Vss​)로 변형";
    expect(normalizeLegacySelectedMath(legacy)).toBe("이 미분방정식을 $\\tau_m \\frac{dV}{dt} = - (V - V_{ss})$로 변형");
    const html = renderToStaticMarkup(createElement(InlineMarkdownContent, { content: legacy }));
    expect(html.match(/class="katex"/g)).toHaveLength(1);
  });

  test("renders inline math without adding paragraph wrappers", () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdownContent, { content: String.raw`시정수 $\tau_m$` }));
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<p>");
  });
});
