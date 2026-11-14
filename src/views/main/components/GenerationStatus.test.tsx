import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationStatus } from "./GenerationStatus";

describe("GenerationStatus", () => {
  test("shows the current generation stage and accessible progress", () => {
    const html = renderToStaticMarkup(
      <GenerationStatus
        status="학습 구조 분석 중 · 7/37"
        busy
        progress={{
          projectId: "project-1",
          materialId: "material-1",
          stage: "graph",
          message: "학습 구조 분석 중 · 7/37",
          progress: 33,
        }}
      />,
    );

    expect(html).toContain("학습 구조 분석 중 · 7/37");
    expect(html).toContain("33%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="33"');
  });

  test("returns to the compact completed state without a progress bar", () => {
    const html = renderToStaticMarkup(
      <GenerationStatus status="Ready" busy={false} progress={null} />,
    );

    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("status-percent");
  });
});
