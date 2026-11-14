import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplanationEvidence } from "./ExplanationEvidence";

test("renders interpretation, original location and escaped excerpts without claiming verification", () => {
  const html = renderToStaticMarkup(createElement(ExplanationEvidence, {
    grounding: { status: "interpretation", evidence: [{ chunkId: "c", quote: "<script>alert(1)</script>", startOffset: 0, endOffset: 25 }] },
    sourceRefById: new Map([["c", { chunkId: "c", title: "Source", locator: "p. 20", text: "" }]]),
  }));
  expect(html).toContain("해석적 재구성");
  expect(html).toContain("<details>");
  expect(html).toContain("p. 20");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("검증 완료");
});

test("background without source excerpts has no misleading source disclosure", () => {
  const html = renderToStaticMarkup(createElement(ExplanationEvidence, { grounding: { status: "background", evidence: [] } }));
  expect(html).toContain("배경지식");
  expect(html).not.toContain("<details>");
});
