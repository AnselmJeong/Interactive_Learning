import { expect, test } from "bun:test";
import { attachHtmlToExistingChunks, normalizeHtmlChunks } from "./source-html";

test("retains source table spans, inline formatting, formulas and figure positions", () => {
  const chunks = normalizeHtmlChunks('source', '<h1>Chapter</h1><p>Text with <em>emphasis</em> and H<sub>2</sub>O.</p><figure><img src="data:image/png;base64,AAAA"><figcaption>Figure 1</figcaption></figure><table><tr><td rowspan="2">Cell</td></tr><tr><td>Next</td></tr></table><h2>Next section</h2><p>Second.</p>');
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.html).toContain('<em>emphasis</em>');
  expect(chunks[0]?.html).toContain('rowspan="2"');
  expect(chunks[0]!.html!.indexOf('<figure')).toBeLessThan(chunks[0]!.html!.indexOf('<table'));
  expect(chunks[1]?.headingPath).toEqual(['Chapter', 'Next section']);
  expect(chunks.map((x) => x.id)).toEqual(['source-chunk-001', 'source-chunk-002']);
  expect(chunks[0]?.text).not.toContain('<');
});

test("restores existing chunks without changing citation IDs, text, or unmatched content", () => {
  const chunks = [
    { id: 'old-1', text: 'A precise original statement.', headingPath: ['Old heading'], locator: 'old locator', kind: 'body' as const, confidence: .9 },
    { id: 'old-2', text: 'This unmatched passage must stay readable.', headingPath: [], locator: 'x', kind: 'body' as const, confidence: .9 },
    { id: 'old-3', text: 'The next sentence is preserved.', headingPath: [], locator: 'x', kind: 'body' as const, confidence: .9 },
  ];
  const enriched = attachHtmlToExistingChunks(chunks, '<h1>New heading</h1><p>A <em>precise</em> original statement.</p><p>The next sentence is preserved.</p>');
  expect(enriched.map(({ html, ...chunk }) => chunk)).toEqual(chunks);
  expect(enriched[0]?.html).toContain('<em>precise</em>');
  expect(enriched[1]?.html).toBeUndefined();
  expect(enriched[2]?.html).toContain('The next sentence is preserved.');
});

test("never splits a table or drops content at paragraph size boundaries", () => {
  const paragraph = 'Long content. '.repeat(95);
  const chunks = normalizeHtmlChunks('source', `<p>${paragraph}</p><table><tr><td>Preserved cell</td></tr></table><p>After the table</p>`);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((x) => x.text).join('\n')).toContain('After the table');
  expect(chunks.filter((x) => x.html?.includes('<table'))).toHaveLength(1);
});

test("restores paragraph fragments and repeated sentences monotonically", () => {
  const texts = ['The first original sentence.', 'The next original sentence.', 'The first original sentence.'];
  const chunks = texts.map((text, i) => ({id: `old-${i}`, text, headingPath: [], locator:'x',kind:'body' as const,confidence:1}));
  const restored = attachHtmlToExistingChunks(chunks, '<p>The <em>first</em> original sentence. The next original sentence.</p><p>The <strong>first</strong> original sentence.</p>');
  expect(restored[0]?.html).toBe('<p>The <em>first</em> original sentence.</p>');
  expect(restored[1]?.html).toBe('<p>The next original sentence.</p>');
  expect(restored[2]?.html).toBe('<p>The <strong>first</strong> original sentence.</p>');
  expect(restored.map(({ html, ...chunk }) => chunk)).toEqual(chunks);
});

test("flags an HTML sidecar that stops long before its Markdown", async () => {
  const { htmlChunksCoverMarkdown } = await import("./source-html");
  const sections = Array.from({ length: 10 }, (_, index) => `## Section ${index + 1}\n\n${"Body sentence about wavelets. ".repeat(20)}`);
  const markdown = `# Chapter\n\n${sections.join("\n\n")}`;
  const fullHtml = sections.map((section) => `<h2>${section.split("\n\n")[0]!.slice(3)}</h2><p>${section.split("\n\n")[1]}</p>`).join("");
  const truncatedHtml = sections.slice(0, 3).map((section) => `<h2>${section.split("\n\n")[0]!.slice(3)}</h2><p>${section.split("\n\n")[1]}</p>`).join("");
  expect(htmlChunksCoverMarkdown(normalizeHtmlChunks("s", fullHtml), markdown)).toBe(true);
  expect(htmlChunksCoverMarkdown(normalizeHtmlChunks("s", truncatedHtml), markdown)).toBe(false);
});
