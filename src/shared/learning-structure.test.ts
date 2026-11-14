import { describe, expect, test } from "bun:test";
import { learningBlockPresentation, parseLearningTable } from "./learning-structure";
import type { TutorContentBlock } from "./tutor-types";

describe("visual form of saved learning content", () => {
  test("uses the existing comparison labels and preserves repeated labels and evidence", () => {
    const grounding = { status: "source" as const, evidence: [] };
    const block = { type: "bullets" as const, title: "실제 vs. 왜곡", items: ["실제: 주장 A", "실제: 주장 B", "왜곡: 주장 C"], grounding };
    expect(learningBlockPresentation(block)).toEqual({
      type: "compare_table", title: block.title, columns: ["비교 대상", "설명"],
      rows: block.items.map((s) => ({ "비교 대상": s.split(": ")[0]!, "설명": s.split(": ")[1]! })), grounding,
    });
    expect(learningBlockPresentation(block)).toEqual(learningBlockPresentation(learningBlockPresentation(block)));
  });

  test("recovers complete legacy table rows without treating them as a sequence", () => {
    expect(learningBlockPresentation({ type: "flow", title: "Area", steps: ["Before", "After", "--", "--", "--", "A", "B", "C"] }))
      .toMatchObject({ type: "compare_table", columns: ["Area", "Before", "After"], rows: [{ Area: "A", Before: "B", After: "C" }] });
  });

  test("keeps parallel points and partial comparisons, diagrams explicit stages", () => {
    const plain: TutorContentBlock = { type: "bullets", title: "경로를 이해하는 배경", items: ["A", "B"] };
    const partial: TutorContentBlock = { type: "bullets", title: "관점의 차이", items: ["철학자: 설명", "다른 한계도 있다."] };
    expect(learningBlockPresentation(plain)).toBe(plain);
    expect(learningBlockPresentation(partial)).toBe(partial);
    expect(learningBlockPresentation({ ...plain, title: "시냅스 전달 단계" })).toMatchObject({ type: "flow", steps: plain.items });
  });

  test("diagrams a standalone arrow chain and leaves math and inline prose intact", () => {
    expect(learningBlockPresentation({ type: "paragraph", body: "빛 흡수 → 전하 이동 → 신호 검출" })).toMatchObject({ type: "flow", steps: ["빛 흡수", "전하 이동", "신호 검출"] });
    const math: TutorContentBlock = { type: "paragraph", body: "$A → B → C$" };
    expect(learningBlockPresentation(math)).toBe(math);
  });

  test("requires a standalone complete table and preserves empty cells, math and long text", () => {
    const long = "가".repeat(230);
    const grid = "| 항목 | 식 | 설명 |\n| -- | -- | -- |\n| A | | " + long + " |\n| B | $p(x|y)$ | C |";
    expect(parseLearningTable(grid)?.rows).toEqual([{ 항목: "A", 식: "", 설명: long }, { 항목: "B", 식: "$p(x|y)$", 설명: "C" }]);
    expect(parseLearningTable("Intro\n" + grid)).toBeNull();
    expect(parseLearningTable(grid + "\n| half |")).toBeNull();
  });
});
