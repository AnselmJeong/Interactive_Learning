export type ProgressionCommand = "advance_paragraph" | "return_to_progress";

function normalizeCommandText(value: string) {
  return value
    .trim()
    .replace(/[.!?。？！…]+$/gu, "")
    .replace(/\s+/g, " ");
}

const ADVANCE_COMMANDS = new Set([
  "계속",
  "계속해",
  "계속해줘",
  "계속해주세요",
  "계속 진행",
  "계속 진행해줘",
  "이어서",
  "이어서 들려줘",
  "이어가",
  "이어가줘",
  "다음",
  "다음으로",
  "다음 대목",
  "다음 대목으로",
  "다음 대목으로 넘어가",
  "다음 대목으로 넘어가줘",
  "다음 문단",
  "다음 문단으로",
  "다음 문단으로 넘어가",
  "다음 문단으로 넘어가줘",
  "넘어가",
  "넘어가줘",
  "진행해줘",
  "다음 진도로 넘어가주세요",
  "다음 대목으로 넘어가주세요",
  "다음 문단으로 넘어가주세요",
  "다음 모듈로 넘어가주세요",
]);

const RETURN_COMMANDS = new Set([
  "진도로 돌아갈게요",
  "진도로 돌아갈게",
  "원래 진도로 돌아갈게요",
  "원래 흐름으로 돌아갈게요",
  "원래 흐름으로 돌아가줘",
  "원문 흐름으로 돌아가줘",
  "진도로 돌아가줘",
  "원래 진도로 돌아가줘",
]);

export function classifyProgressionCommand(value: string): ProgressionCommand | null {
  const text = normalizeCommandText(value);
  if (!text || text.length > 40 || /[?？]/u.test(text)) return null;
  if (RETURN_COMMANDS.has(text)) return "return_to_progress";
  if (ADVANCE_COMMANDS.has(text)) return "advance_paragraph";
  return null;
}
