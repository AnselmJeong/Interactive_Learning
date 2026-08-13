import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdditionalExploration } from "./AdditionalExploration";

describe("AdditionalExploration", () => {
  test("renders formulas in suggested questions as math", () => {
    const html = renderToStaticMarkup(createElement(AdditionalExploration, {
      choices: [String.raw`시정수 $\tau_m$은 어떤 의미인가요?`],
      savedTitles: new Set<string>(),
      latest: true,
      disabled: false,
      onExplore: async () => undefined,
    }));
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$\\tau_m$");
  });
});
