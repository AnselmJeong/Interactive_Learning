import { describe, expect, test } from "bun:test";
import { classifyProgressionCommand } from "./progression-command";

describe("typed progression commands", () => {
  test("accepts explicit progress and return commands", () => {
    expect(classifyProgressionCommand("계속해줘.")).toBe("advance_paragraph");
    expect(classifyProgressionCommand("다음 문단으로 넘어가주세요")).toBe("advance_paragraph");
    expect(classifyProgressionCommand("진도로 돌아갈게요.")).toBe("return_to_progress");
  });

  test("keeps ambiguous learner text on the tutor answer path", () => {
    expect(classifyProgressionCommand("그 얘기로 넘어가기 전에 하나만 더 물어볼게요")).toBeNull();
    expect(classifyProgressionCommand("왜 다음으로 넘어가는 건가요?")).toBeNull();
  });
});
