import { describe, expect, test } from "bun:test";
import type { BuddyMessageInput } from "../shared/rpc-types";
import { buildBuddyPromptMessages, cleanBuddyMessage } from "./buddy-message";

const input: BuddyMessageInput = {
  trigger: "click",
  mood: "progress",
  progressPercent: 42,
  currentModuleTitle: "충분조건과 지능",
  currentModuleContext: "충분조건은 필요조건과 구분된다.",
  tutorThinking: false,
  prefetchStatus: "ready",
  previousMessage: "방금 한 발을 더 나아갔어요.",
};

describe("Buddy message prompt", () => {
  test("prioritizes a warm, lightly humorous reset over textbook summary copy", () => {
    const [system, user] = buildBuddyPromptMessages(input);

    expect(system.content).toContain("어깨에서 힘을 빼고");
    expect(system.content).toContain("자연스러운 해요체");
    expect(system.content).toContain("가벼운 유머");
    expect(system.content).toContain("살짝 능청스러운 애교");
    expect(system.content).toContain("매번 억지로 웃기려 하지 말고");
    expect(system.content).toContain("과한 유아어");
    expect(user.content).toContain("마음을 풀어 주는 것을 우선");
  });

  test("passes context as reference-only data and asks for variation", () => {
    const [system, user] = buildBuddyPromptMessages(input);

    expect(system.content).toContain("동일한 시작, 문장 구조, 농담을 반복하지 않는다");
    expect(user.content).toContain("Reference-only module/source context");
    expect(user.content).toContain("<context>\n충분조건은 필요조건과 구분된다.\n</context>");
    expect(user.content).toContain(`Previous bubble to avoid repeating: ${input.previousMessage}`);
  });
});

describe("Buddy message cleanup", () => {
  test("keeps only the first sentence and removes labels", () => {
    expect(cleanBuddyMessage("버디: 오호, 충분조건이라니 이름부터 자신감이 넘치네요! 두 번째 문장입니다.")).toBe(
      "오호, 충분조건이라니 이름부터 자신감이 넘치네요!",
    );
  });

  test("keeps a playful opening attached to the useful sentence", () => {
    expect(cleanBuddyMessage("오호! 충분조건은 이름부터 자신감이 넘치네요!")).toBe(
      "오호, 충분조건은 이름부터 자신감이 넘치네요!",
    );
  });
});
