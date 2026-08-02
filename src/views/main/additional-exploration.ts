import type { MaterialAnnotation } from "../../shared/artifact-types";
import type { SourceRef, TutorMessage } from "../../shared/tutor-types";

const PROGRESSION_CHOICES = new Set([
  "계속해줘",
  "계속해줘.",
  "다음 진도로 넘어가주세요.",
  "다음 대목으로 넘어가주세요.",
  "다음 문단으로 넘어가주세요.",
  "다음 모듈로 넘어가주세요.",
  "진도로 돌아갈게요.",
  "네, 마칠게요.",
  "아니요, 더 질문이 있어요.",
]);

export function isProgressionChoice(choice: string) {
  return PROGRESSION_CHOICES.has(choice.trim());
}

function normalizeChoiceText(choice: string) {
  if (!choice) return "";
  if (choice.includes("원래 흐름") || choice.includes("돌아갈게요")) {
    return "이 설명을 원문 흐름과 다시 연결해 주세요.";
  }
  return choice;
}

function normalizedChoiceKey(choice: string) {
  return choice.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function additionalExplorationChoices(choices: string[]) {
  const seen = new Set<string>();
  return choices
    .map((choice) => normalizeChoiceText(choice.replace(/\s+/g, " ").trim()))
    .filter((choice) => {
      const key = normalizedChoiceKey(choice);
      if (!choice || PROGRESSION_CHOICES.has(choice) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

export function isAdditionalExplorationAnnotation(annotation: MaterialAnnotation) {
  return annotation.kind === "question"
    && annotation.result.kind === "question_thread"
    && annotation.result.origin === "suggested_exploration";
}

export function savedAdditionalExplorationTitles(annotations: MaterialAnnotation[], messageId: string) {
  return new Set(
    annotations
      .filter((annotation) => annotation.anchorMessageId === messageId && isAdditionalExplorationAnnotation(annotation))
      .map((annotation) => normalizedChoiceKey(annotation.result.kind === "question_thread" ? annotation.result.title : ""))
      .filter(Boolean),
  );
}

export function isAdditionalExplorationSaved(savedTitles: Set<string>, choice: string) {
  return savedTitles.has(normalizedChoiceKey(choice));
}

export function additionalExplorationContext(message: TutorMessage, sourceRef?: SourceRef | null) {
  const sourceText = sourceRef?.text?.replace(/\s+/g, " ").trim();
  const messageText = message.content.replace(/\s+/g, " ").trim();
  return (sourceText || messageText || message.choices[0] || "추가 탐색").slice(0, 4000);
}
