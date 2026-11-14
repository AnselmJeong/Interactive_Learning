import { expect, test } from "bun:test";
import { reviewDeepReadingTurn } from "./deep-reading-review";
import type { TutorTurnOutput } from "../shared/tutor-types";

const draft: Partial<TutorTurnOutput> = { message: "초안", blocks: [{ type: "paragraph", body: "제약이 곧 제거를 뜻하는 것은 아니다." }], sourceRefs: ["focus"], progress: 0, moduleId: "m" };

test("review preserves routing and ignores reviewer state changes", async () => {
  let calls = 0;
  const result = await reviewDeepReadingTurn({ model: "fixture", client: {
    listModels: async () => [], chatText: async () => "", chatJson: async () => {
      calls += 1;
      return { blocks: [{ type: "paragraph", body: "재구성한 설명", grounding: { status: "interpretation", evidence: [] } }], message: "검토한 설명", progress: 100, moduleId: "wrong", stateUpdate: { advanceModule: true } };
    },
  } }, draft, []);
  expect(calls).toBe(1);
  expect(result.moduleId).toBe("m");
  expect(result.progress).toBe(0);
  expect(result.sourceRefs).toEqual(["focus"]);
  expect(result.stateUpdate).toBeUndefined();
});

test("failed review visibly marks uncertainty without an unbounded retry", async () => {
  let calls = 0;
  const result = await reviewDeepReadingTurn({ model: "fixture", client: {
    listModels: async () => [], chatText: async () => "", chatJson: async () => { calls += 1; throw new Error("offline"); },
  } }, draft, []);
  expect(calls).toBe(1);
  expect(result.blocks?.every((block) => block.grounding?.status === "uncertain")).toBe(true);
  expect(result.blocks?.[0]).toMatchObject({ type: "paragraph", body: "이번 해설은 원문 대조를 완료하지 못했습니다. 단정적인 해석은 원문과 함께 확인해 주세요." });
});
