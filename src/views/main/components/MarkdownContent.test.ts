import { describe, expect, test } from "bun:test";
import { micromark } from "micromark";
import { normalizeMarkdownContent } from "./MarkdownContent";

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
});
