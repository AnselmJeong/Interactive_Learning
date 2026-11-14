import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplanationEvidence } from "./ExplanationEvidence";

test("renders nothing for interpretation, uncertain or source blocks, even with evidence", () => {
  for (const status of ["interpretation", "uncertain", "source"] as const) {
    const html = renderToStaticMarkup(createElement(ExplanationEvidence, {
      grounding: { status, evidence: [{ chunkId: "c", quote: "quoted", startOffset: 0, endOffset: 6 }] },
      sourceRefById: new Map([["c", { chunkId: "c", title: "Source", locator: "p. 20", text: "" }]]),
    }));
    expect(html).toBe("");
  }
});

test("keeps the analogy and background badges without a source disclosure", () => {
  const background = renderToStaticMarkup(createElement(ExplanationEvidence, { grounding: { status: "background", evidence: [] } }));
  expect(background).toContain("배경지식");
  const analogy = renderToStaticMarkup(createElement(ExplanationEvidence, { grounding: { status: "analogy", evidence: [{ chunkId: "c", quote: "q", startOffset: 0, endOffset: 1 }] } }));
  expect(analogy).toContain("설명용 비유");
  expect(analogy).not.toContain("<details>");
  expect(analogy).not.toContain("연결된 원문");
});
