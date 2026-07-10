import { describe, expect, test } from "bun:test";
import type { LookupResult, QuestionThreadResult } from "./artifact-types";
import { firstQuestion, questionCount, questionMessages, questionThreadFromResult } from "./question-thread";

describe("question thread adapters", () => {
  const legacy: LookupResult = {
    kind: "question",
    title: "첫 질문",
    question: "왜 중요한가요?",
    body: "앞뒤 논리를 연결하기 때문입니다.",
    query: "선택한 문장",
    provider: "ai",
    model: "test-model",
    retrievedAt: "2026-07-10T00:00:00.000Z",
    sourceMeta: [],
  };

  test("reads a legacy question as a one-turn thread without mutating it", () => {
    const messages = questionMessages(legacy, 123);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("왜 중요한가요?");
    expect(messages[1]?.model).toBe("test-model");
    expect(legacy.kind).toBe("question");
  });

  test("converts legacy data only when a real thread is requested", () => {
    const thread = questionThreadFromResult(legacy, 123);
    expect(thread.kind).toBe("question_thread");
    expect(thread.version).toBe(1);
    expect(questionCount(thread)).toBe(1);
    expect(firstQuestion(thread)).toBe("왜 중요한가요?");
  });

  test("preserves native thread messages", () => {
    const thread: QuestionThreadResult = {
      kind: "question_thread",
      version: 1,
      title: "첫 질문",
      messages: [{ id: "u1", role: "user", content: "첫 질문", createdAt: 1 }],
      provider: "ai",
      retrievedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: 1,
      sourceMeta: [],
    };
    expect(questionMessages(thread)).toBe(thread.messages);
  });
});
