import { expect, test } from "bun:test";
import { richHtmlText, sanitizeRichHtml, stripRepeatedHtmlHeading } from "./rich-html";
import { normalizeLearningHtml } from "./learning-html";

test("removes repeated opening HTML headings through wrappers while retaining anchors and real subsections", () => {
  const html = '<article><header><h2 id="intro"><a id="start"></a>2.1 INTRODUCTION</h2></header><section><h3>2.1 Introduction</h3><p>A brain is an intricate system.</p><h3>2.2 Neurons</h3></section></article>';
  const result = stripRepeatedHtmlHeading(html, ["2.1 Introduction"]);
  expect(result).not.toMatch(/<h[1-6][^>]*>2\.1/i);
  expect(result).toContain('id="intro"');
  expect(result).toContain('id="start"');
  expect(result).toContain("A brain is an intricate system.");
  expect(result).toContain("<h3>2.2 Neurons</h3>");
});

test("does not remove matching prose, later headings, or a comparison panel's heading", () => {
  for (const html of [
    '<p>Introduction</p><h3>Introduction</h3>',
    '<h3>Context</h3><h3>Introduction</h3>',
    '<table><tr><th>Introduction</th></tr></table><h3>Introduction</h3>',
    '<div class="learn-compare"><section><h4>Introduction</h4><p>A</p></section><section><h4>After</h4><p>B</p></section></div>',
    '<div class="learn-compare"><section><h4>Before</h4><p>A</p></section><section><h4>Introduction</h4><p>B</p></section></div>',
  ]) expect(stripRepeatedHtmlHeading(html, ["Introduction"])).toBe(html);
});

test("keeps semantic tables, native disclosures, MathML and a passive vector diagram", () => {
  const html = sanitizeRichHtml('<details><summary>Why?</summary><p>Reason</p></details><table><tr><th colspan="2">A</th></tr></table><math><mfrac><mi>x</mi><mn>2</mn></mfrac></math><svg viewBox="0 0 300 100"><title>Flow</title><path d="M0 0L30 30" stroke="currentColor"/></svg>');
  expect(html).toContain('<summary>Why?</summary>');
  expect(html).toContain('colspan="2"');
  expect(html).toContain('<mfrac>');
  expect(html).toContain('viewBox="0 0 300 100"');
});

test("strips executable HTML, ambient app classes, network images and style escapes", () => {
  const html = sanitizeRichHtml('<script>alert(1)</script><img src="https://attacker.test/pixel" onerror="run()"><a href="java&#x73;cript:run()">link</a><svg onload="run()"><foreignObject><iframe src="file:///etc/passwd"></iframe></foreignObject><use href="https://bad.test/x.svg#x"/></svg><p class="app-shell learn-lead" style="position:fixed">safe</p>');
  expect(html).not.toMatch(/script|onerror|onload|foreignObject|iframe|attacker|bad\.test|app-shell|position:/);
  expect(html).toContain('class="learn-lead"');
  expect(richHtmlText(html)).toContain('safe');
});

test("scopes IDs and SVG markers without permitting external paint servers", () => {
  const html = sanitizeRichHtml('<svg><defs><marker id="arrow"></marker></defs><path marker-end="url(#arrow)" fill="url(https://bad.test/x)"/></svg>', { idPrefix: "lesson-2" });
  expect(html).toContain('id="lesson-2-arrow"');
  expect(html).toContain('marker-end="url(#lesson-2-arrow)"');
  expect(html).not.toContain('bad.test');
});

test("normalizes history text from visible HTML rather than trusting a model's fallback", () => {
  const block = normalizeLearningHtml({ html: '<p>Actual <strong>explanation</strong>.</p>', body: 'invented fallback' });
  expect(block?.body).toBe('Actual explanation.');
  expect(normalizeLearningHtml({ html: '<script>run()</script>' })).toBeNull();
  expect(normalizeLearningHtml({ html: 'a'.repeat(33_000) })).toBeNull();
});

test("source images cannot load arbitrary local files or remote assets", () => {
  const html = sanitizeRichHtml('<img src="file:///private/image.png" alt="Local image"><img src="https://example.com/a.png"><img src="../../elsewhere.png"><img src="data:image/png;base64,AAAA">', { source: true });
  expect(html).not.toMatch(/file:|https:|elsewhere/);
  expect(html).toContain('Local image');
  expect(html.match(/<img /g)).toHaveLength(1);
});
