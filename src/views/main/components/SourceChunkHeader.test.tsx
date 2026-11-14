import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceChunkHeader } from "./SourceChunkHeader";

const title = "Seeking a Generative Understanding of the Human Brain and Its Flexible Cognitive Repertoire";
const path = [`1. ${title}`, `1 ${title}`];

test("renders the reported Brain Flows heading once across breadcrumb and locator", () => {
  const html = renderToStaticMarkup(createElement(SourceChunkHeader, { headingPath: path, locator: `1 ${title}`.toUpperCase(), status: "upcoming" }));
  expect(html.match(/Seeking a Generative Understanding/g)).toHaveLength(1);
  expect(html).not.toContain("SEEKING");
  expect(html).not.toContain("›");
  expect(html).toContain("예정");
});

test("does not repeat a heading on the next chunk when only punctuation or case changes", () => {
  const html = renderToStaticMarkup(createElement(SourceChunkHeader, { headingPath: [`1 ${title}`.toUpperCase()], previousHeadingPath: path, locator: `1 ${title}`, status: "covered" }));
  expect(html).not.toContain("<h4");
  expect(html).not.toContain(title);
  expect(html).toContain("다룸");
});

test("shows the current subsection once and keeps a real page locator", () => {
  const html = renderToStaticMarkup(createElement(SourceChunkHeader, { headingPath: [...path, "1.1 A Cognitive Challenge"], previousHeadingPath: path, locator: "page 12", status: "current" }));
  expect(html).toContain("1.1 A Cognitive Challenge");
  expect(html).not.toContain(title);
  expect(html).toContain("page 12");
});

test("retains equal subsection names under different parent chapters", () => {
  const html = renderToStaticMarkup(createElement(SourceChunkHeader, { headingPath: ["2. Mechanisms", "Summary"], previousHeadingPath: ["1. Foundations", "Summary"], locator: "Summary", status: "upcoming" }));
  expect(html.match(/Summary/g)).toHaveLength(1);
});
