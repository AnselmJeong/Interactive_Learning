import type {
  LookupResult,
  QuestionThreadMessage,
  QuestionThreadResult,
} from "./artifact-types";

export type QuestionResult = LookupResult | QuestionThreadResult;

export function isQuestionThreadResult(result: unknown): result is QuestionThreadResult {
  if (!result || typeof result !== "object") return false;
  const candidate = result as Partial<QuestionThreadResult>;
  return candidate.kind === "question_thread" && candidate.version === 1 && Array.isArray(candidate.messages);
}

export function questionMessages(result: QuestionResult, fallbackCreatedAt = Date.now()): QuestionThreadMessage[] {
  if (isQuestionThreadResult(result)) return result.messages;
  if (result.kind !== "question") return [];
  const question = (result.question || result.title).trim();
  const answer = result.body.trim();
  return [
    ...(question ? [{ id: `legacy-user-${fallbackCreatedAt}`, role: "user" as const, content: question, createdAt: fallbackCreatedAt }] : []),
    ...(answer ? [{
      id: `legacy-assistant-${fallbackCreatedAt}`,
      role: "assistant" as const,
      content: answer,
      createdAt: fallbackCreatedAt,
      model: result.model,
      sources: result.sourceMeta.filter((source) => Boolean(source.url)),
    }] : []),
  ];
}

export function questionThreadFromResult(result: QuestionResult, fallbackCreatedAt = Date.now()): QuestionThreadResult {
  if (isQuestionThreadResult(result)) return result;
  const messages = questionMessages(result, fallbackCreatedAt);
  return {
    kind: "question_thread",
    version: 1,
    title: result.question || result.title,
    messages,
    provider: "ai",
    model: result.model,
    sourceTitle: result.sourceTitle,
    retrievedAt: result.retrievedAt,
    updatedAt: fallbackCreatedAt,
    sourceMeta: result.sourceMeta,
  };
}

export function questionCount(result: QuestionResult) {
  return questionMessages(result).filter((message) => message.role === "user").length;
}

export function firstQuestion(result: QuestionResult) {
  return questionMessages(result).find((message) => message.role === "user")?.content || result.title;
}
