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

describe("GenerationStatus background jobs", () => {
  test("labels the background job and counts the others", () => {
    const html = renderToStaticMarkup(
      <GenerationStatus
        status="Ready"
        busy={false}
        jobLabel="“2장”"
        jobCount={2}
        progress={{ projectId: "p", stage: "graph", message: "대목별 설명과 원문 연결을 설계하는 중 · 3/12", progress: 70 }}
      />,
    );
    expect(html).toContain("“2장” · 대목별 설명과 원문 연결을 설계하는 중 · 3/12 외 1건");
    expect(html).toContain('aria-valuenow="70"');
  });
});
