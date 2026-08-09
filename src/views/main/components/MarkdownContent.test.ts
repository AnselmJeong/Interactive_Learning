import { describe, expect, test } from "bun:test";
import { micromark } from "micromark";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent, normalizeMarkdownContent } from "./MarkdownContent";

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
});
