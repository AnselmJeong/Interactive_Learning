import { createHash } from "node:crypto";
import { getDb } from "./project-db";
import { CourseArtifactService } from "./course-artifact-service";
import { SettingsService } from "./settings-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { createAiProviderClient } from "./ai-provider-client";
import { isProviderError } from "./provider-error";
import { dataPath } from "./paths";
import { deleteSessionSnapshot, writeSessionSnapshot } from "./project-bundle-sync";
import { classifyProgressionCommand } from "../shared/progression-command";
import { plainDisplayText } from "../shared/display-title";
import type { CourseModule, LectureModulePlan, MaterialArtifacts, PresentationModulePlan, SourceChunk, VisualSpec } from "../shared/artifact-types";
import type { LearningMessageBatchStatus, SessionSnapshot, SessionSummary, SourceRef, TutorContentBlock, TutorContext, TutorIntent, TutorMessage, TutorPrefetchStatus, TutorStateUpdate, TutorTurnOutput } from "../shared/tutor-types";

// "start_module": open the first source chunk of a (new) module with a content summary.
// "continue_chunk": keep the cursor on the current source chunk and continue teaching it.
// "next_chunk": continue to the next source chunk within the same module. "return_to_progress":
// resume after a detour on the next active source chunk. "user_message": the learner replied.
type TurnPayload = { event: "start_module" | "continue_chunk" | "next_chunk" | "return_to_progress" | "user_message"; userText?: string };
type SessionCommitGuard = {
  status: SessionSnapshot["status"];
  currentModuleId: string | null;
  currentChunkId: string | null;
  completedModuleIds: string[];
  coveredChunkIds: string[];
  messageCount: number;
  lastMessageId: string | null;
};

const VALID_INTENTS: TutorIntent[] = ["start", "answer", "question", "off_topic", "deeper", "meta_complaint", "satisfied"];
const DIGRESSION_INTENTS = new Set<TutorIntent>(["question", "off_topic", "deeper", "meta_complaint"]);
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 1200;
const PREFETCH_PROMPT_VERSION = "tutor-default-continue-v2-language";
const MESSAGE_BATCH_PROMPT_VERSION = PREFETCH_PROMPT_VERSION;
const PREFETCH_TTL_MS = 20 * 60 * 1000;
const PREFETCH_PROVIDER_TIMEOUT_MS = 120 * 1000;
const PREFETCH_CONSUME_MAX_WAIT_MS = 100 * 1000;
const MAX_ACTIVE_PREFETCH_JOBS = 2;
const MAX_BATCH_STEPS = 160;
const TERM_RENDERING_RULE = [
  "TERM RENDERING RULE:",
  "When teaching in Korean, never replace foreign proper nouns or culturally specific technical terms with Korean-only transliterations.",
  "If the source gives an original spelling, romanized form, or foreign-language title/name, preserve that form.",
  "On first mention in Korean, write the Korean gloss/transliteration plus the original in parentheses whenever the original is known, e.g. 보에티우스(Boethius), 포르투나(Fortune), 알마문(al-Ma'mun), 무타질라(Mu'tazila), 이성('aql).",
  "For people, schools, movements, book titles, Arabic/Islamic terms, philosophical terms, and other identity-bearing names, keep the original form visible; if the Korean rendering would be awkward or obscure, use the original form directly.",
].join(" ");

export class SessionMutationQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, action: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(sessionId) || Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(sessionId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId);
    }
  }
}

export function tutorLanguageInstruction(tutorLanguage: string) {
  if (tutorLanguage === "ko") {
    return [
      "Reply in Korean.",
      "This applies to every learner-facing JSON field: message, block body/title/items/steps/table cells/reflection aiView, and choices.",
      "Keep JSON keys, enum values, ids, and sourceRef values in English exactly as the schema requires.",
      "Do not switch to English just because the source text, course title, previous messages, lecture plan, or presentation plan is English.",
      "source_quote.quote may preserve the exact source wording, but all explanation around it must be Korean.",
      "For foreign proper nouns and specialized terms, include the original spelling in parentheses on first mention when known.",
    ].join(" ");
  }
  return [
    "Reply in English.",
    "This applies to every learner-facing JSON field: message, block body/title/items/steps/table cells/reflection aiView, and choices.",
    "Keep JSON keys, enum values, ids, and sourceRef values exactly as the schema requires.",
  ].join(" ");
}

// A lightweight Korean-aware heuristic. It is only a hint and a fallback; when the model
// returns its own userIntent we trust that instead. The point is that a substantive
// question must never be mistaken for "ready to advance".
function classifyIntent(userText: string, event: TurnPayload["event"]): TutorIntent {
  if (event === "start_module" || event === "continue_chunk" || event === "next_chunk" || event === "return_to_progress") return "start";
  const t = (userText || "").trim();
  if (!t) return "answer";
  const has = (...needles: string[]) => needles.some((needle) => t.includes(needle));
  if (has("대답을 안", "대답 안", "답을 안", "답 안 ", "무시", "동문서답", "딴소리", "회피", "왜 안", "엉뚱", "다시 시도", "다시 답", "제대로 답")) return "meta_complaint";
  if (has("다음 대목", "다음 문단", "넘어가", "이어서 들", "이어 갈", "계속 진행", "다음으로")) return "satisfied";
  if (has("더 풀어", "더 자세", "예시", "예를", "구체적", "쉽게 바꿔", "쉽게 설명", "더 알고", "더 설명", "자세히")) return "deeper";
  if (t.endsWith("?") || t.endsWith("까요") || t.endsWith("나요") || t.endsWith("인가요") || t.endsWith("건가요") || has("있을까", "있나요", "어떻게", "무엇", "뭔가요", "왜 ", "궁금", "무슨", "어떤")) return "question";
  return "answer";
}

function normalizeChoiceText(choice: string) {
  if (choice.includes("원래 흐름") || choice.includes("돌아갈게요")) return "이 설명을 원문 흐름과 다시 연결해 주세요.";
  return choice;
}

function plainOptionalTitle(value: unknown, maxLength = 90) {
  if (!value) return undefined;
  return plainDisplayText(String(value)).slice(0, maxLength) || undefined;
}

function originalTermCandidates(chunks: SourceChunk[], limit = 18) {
  const candidates = new Set<string>();
  const romanized = /(?:\b(?:al|ibn|bint|abu|ahl|dar|bayt|mu|muta|mutaz|ash|ahl)[-'][A-Za-z][A-Za-z'’\-]+|\b[A-Z][A-Za-z]+(?:['’\-][A-Za-z]+)+|\b[A-Za-z]+[ʿ‘'’][A-Za-z]+|\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})/g;
  for (const chunk of chunks) {
    for (const field of [...chunk.headingPath, chunk.locator, chunk.text]) {
      for (const match of field.matchAll(romanized)) {
        const term = match[0].replace(/[),.;:]+$/g, "").trim();
        if (term.length >= 3 && term.length <= 60) candidates.add(term);
        if (candidates.size >= limit) return [...candidates];
      }
    }
  }
  return [...candidates];
}

// Detects an explicit learner confirmation to end the session after all modules are done.
function isFinishConfirmation(text: string) {
  const t = text.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (["네", "예", "yes", "마칠게요", "마칠게", "종료", "끝", "끝낼게요", "끝내요", "완료", "네 마칠게요", "네 종료"].includes(lower)) return true;
  return t.includes("마칠") || t.includes("종료") || t.includes("끝내") || t.includes("끝낼");
}

function coerceIntent(value: unknown): TutorIntent | null {
  return typeof value === "string" && (VALID_INTENTS as string[]).includes(value) ? (value as TutorIntent) : null;
}

type SessionRow = {
  id: string;
  project_id: string;
  material_id: string;
  title: string;
  status: "active" | "completed" | "archived";
  current_module_id: string | null;
  completed_module_ids_json: string;
  current_chunk_id: string | null;
  covered_chunk_ids_json: string;
  model: string | null;
  created_at: number;
  updated_at: number;
};

type SessionListRow = SessionRow & {
  message_count: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  module_id: string | null;
  source_refs_json: string;
  choices_json: string;
  blocks_json: string;
  visual_id: string | null;
  state_update_json: string | null;
  delivery_state: "visible" | "prepared" | "discarded";
  batch_run_id: string | null;
  cursor_before_json: string | null;
  cursor_after_json: string | null;
  created_at: number;
  ordinal: number;
};

type TutorPrefetchRow = {
  id: string;
  session_id: string;
  material_id: string;
  kind: "default_continue";
  status: "queued" | "generating" | "ready" | "consumed" | "stale" | "failed" | "cancelled";
  base_message_count: number;
  base_last_message_id: string | null;
  base_current_chunk_id: string | null;
  base_covered_chunk_ids_json: string;
  base_session_fingerprint: string;
  target_event: PlannedProgressTurn["targetEvent"];
  target_module_id: string | null;
  target_chunk_id: string | null;
  cursor_after_json: string;
  provider: string;
  model: string;
  settings_fingerprint: string;
  material_fingerprint: string;
  prompt_version: string;
  output_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type LearningMessageBatchRunRow = {
  id: string;
  session_id: string;
  material_id: string;
  status: "queued" | "generating" | "ready" | "partial" | "failed" | "cancelled" | "stale";
  route_kind: "default_continue";
  provider: string;
  model: string;
  settings_fingerprint: string;
  material_fingerprint: string;
  prompt_version: string;
  total_steps: number;
  completed_steps: number;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type PlannedProgressTurn = {
  kind: "default_continue";
  targetEvent: "continue_chunk" | "next_chunk" | "start_module" | "return_to_progress" | "finish_prompt";
  moduleId: string;
  baseCurrentChunkId: string | null;
  baseCoveredChunkIds: string[];
  targetChunkId: string | null;
  coveredChunkIdsAfter: string[];
  completedModuleIdsAfter: string[];
  cursorAfter: {
    currentModuleId: string | null;
    currentChunkId: string | null;
    coveredChunkIds: string[];
    completedModuleIds: string[];
  };
};

type PreparedMessageCursor = PlannedProgressTurn["cursorAfter"];

export function repairedCurrentChunkId(currentChunkId: string | null, coveredChunkIds: string[], curriculumChunkIds: string[]) {
  if (!curriculumChunkIds.length) return null;
  const curriculumIds = new Set(curriculumChunkIds);
  const covered = new Set(coveredChunkIds.filter((id) => curriculumIds.has(id)));
  const allCovered = covered.size >= curriculumChunkIds.length;
  if (allCovered) return curriculumChunkIds[curriculumChunkIds.length - 1]!;
  if (!currentChunkId || !curriculumIds.has(currentChunkId) || covered.has(currentChunkId)) {
    return curriculumChunkIds.find((id) => !covered.has(id)) || curriculumChunkIds[0]!;
  }
  return currentChunkId;
}

export function repairedModuleCurrentChunkId(
  currentChunkId: string | null,
  coveredChunkIds: string[],
  moduleChunkIds: string[],
  taughtModuleChunkIds: string[] = []
) {
  const orderedModuleChunkIds = uniqueStrings(moduleChunkIds.filter(Boolean));
  if (!orderedModuleChunkIds.length) return null;

  const moduleIdSet = new Set(orderedModuleChunkIds);
  const covered = new Set(coveredChunkIds.filter((id) => moduleIdSet.has(id)));
  if (covered.size >= orderedModuleChunkIds.length) {
    return orderedModuleChunkIds[orderedModuleChunkIds.length - 1]!;
  }

  const firstUncoveredAfter = (chunkId: string) => {
    const index = orderedModuleChunkIds.indexOf(chunkId);
    if (index < 0) return null;
    return orderedModuleChunkIds.slice(index + 1).find((id) => !covered.has(id)) || null;
  };

  const activeCandidate = (chunkId: string | null | undefined) => {
    if (!chunkId || !moduleIdSet.has(chunkId)) return null;
    if (!covered.has(chunkId)) return chunkId;
    return firstUncoveredAfter(chunkId);
  };

  const currentCandidate = activeCandidate(currentChunkId);
  if (currentCandidate) return currentCandidate;

  for (const chunkId of [...taughtModuleChunkIds].reverse()) {
    const taughtCandidate = activeCandidate(chunkId);
    if (taughtCandidate) return taughtCandidate;
  }

  return orderedModuleChunkIds.find((id) => !covered.has(id)) || orderedModuleChunkIds[0]!;
}

function jsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonBlocks(raw: string | null): TutorContentBlock[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TutorContentBlock[]) : [];
  } catch {
    return [];
  }
}

function toMessage(row: MessageRow): TutorMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    blocks: jsonBlocks(row.blocks_json),
    moduleId: row.module_id || undefined,
    sourceRefs: jsonArray(row.source_refs_json),
    choices: jsonArray(row.choices_json),
    visualId: row.visual_id,
    stateUpdate: row.state_update_json ? JSON.parse(row.state_update_json) : undefined,
    createdAt: row.created_at,
    ordinal: row.ordinal,
  };
}

function clampHistory(messages: TutorMessage[]) {
  const mapped = messages.slice(-MAX_HISTORY_TURNS).map((message) => ({
    role: message.role === "user" ? ("user" as const) : ("assistant" as const),
    content: (message.blocks?.length ? blocksToPlainText(message.blocks) : message.content).slice(0, MAX_HISTORY_CHARS),
  }));
  // Collapse repeated assistant turns. If the model already said something almost identical,
  // feeding it back verbatim teaches it to keep looping. Replace the duplicate with an
  // explicit instruction to vary instead.
  const seen = new Set<string>();
  return mapped.map((entry) => {
    if (entry.role !== "assistant") return entry;
    const fingerprint = entry.content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (fingerprint && seen.has(fingerprint)) {
      return { role: "assistant" as const, content: "(이전 턴과 거의 같은 답을 이미 했습니다. 같은 말을 반복하지 말고 새로운 각도로 진행하세요.)" };
    }
    if (fingerprint) seen.add(fingerprint);
    return entry;
  });
}

function blocksToPlainText(blocks: TutorContentBlock[]) {
  return blocks
    .map((block) => {
      if (block.type === "bullets") return `${block.title || ""}\n${block.items.map((item) => `- ${item}`).join("\n")}`;
      if (block.type === "flow") return `${block.title || ""}\n${block.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
      if (block.type === "compare_table") return `${block.title || ""}\n${block.columns.join(" | ")}\n${block.rows.map((row) => block.columns.map((column) => row[column] || "").join(" | ")).join("\n")}`;
      if (block.type === "source_quote") return `"${block.quote}"`;
      if (block.type === "misconception") return `${block.title || "헷갈릴 수 있는 지점"}\n${block.body}\n${block.repair}`;
      return block.body;
    })
    .filter(Boolean)
    .join("\n\n");
}

function safeQuote(text: string, maxWords = 25) {
  return text.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, maxWords).join(" ");
}

function trimSentence(text: string, max = 260) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, max)}${normalized.length > max ? "..." : ""}`;
}

function stripTldrLead(text: string) {
  return text
    .replace(/^\s*(?:핵심은|요지는|요약하면|한마디로|TL;?DR[:：]?)\s*/i, "")
    .replace(/^\s*(?:이\s+자료의\s+)?(?:핵심|요지)\s*(?:은|는|:|：)\s*/i, "")
    .trim();
}

type CompareTableBlock = Extract<TutorContentBlock, { type: "compare_table" }>;
type FlowBlock = Extract<TutorContentBlock, { type: "flow" }>;

function pipeCells(line: string) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isMarkdownTableDivider(line: string) {
  return pipeCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownPipeTable(text: string): CompareTableBlock | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"));
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const dividerLine = lines[1];
  if (!headerLine || !dividerLine) return null;
  const columns = pipeCells(headerLine).slice(0, 4);
  if (columns.length < 2) return null;
  const dataLines = isMarkdownTableDivider(dividerLine) ? lines.slice(2) : lines.slice(1);
  const rows = dataLines
    .map((line) => pipeCells(line))
    .filter((cells) => cells.length >= 2)
    .map((cells) => Object.fromEntries(columns.map((column, index) => [column, (cells[index] || "").slice(0, 220)])))
    .filter((row) => columns.some((column) => row[column]))
    .slice(0, 5);
  return rows.length ? { type: "compare_table", columns, rows } : null;
}

function splitFlowTitle(firstPart: string) {
  const normalized = firstPart.replace(/[：:]$/, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.{4,45}?(?:구조|맥락|과정|흐름|논리|구분|대조|관계|전개))\s+(.{2,})$/u);
  if (!match) return { title: normalized, firstStep: "" };
  const [, title = "", firstStep = ""] = match;
  return { title: title.trim(), firstStep: firstStep.trim() };
}

function parseLoosePipeFlow(text: string): FlowBlock | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized.includes("|")) return null;
  const parts = normalized.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const { title, firstStep } = splitFlowTitle(parts[0] || "");
  const stepParts = firstStep ? [firstStep, ...parts.slice(1)] : parts.slice(1);
  const steps = stepParts
    .map((part) => part.replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  return steps.length >= 2
    ? { type: "flow", title: title.slice(0, 90), steps }
    : null;
}

function parsePipeStructureBlock(text: string): CompareTableBlock | FlowBlock | null {
  if ((text.match(/\|/g) || []).length < 2) return null;
  return parseMarkdownPipeTable(text) || parseLoosePipeFlow(text);
}

function splitNumberedFlowIntro(prefix: string) {
  const normalized = prefix.replace(/\s+/g, " ").trim();
  if (!normalized) return { intro: "", title: "" };
  const titleLike = /(구조|맥락|과정|흐름|논리|도출|전개|단계|순서|경로)$/u;
  const sentenceBreak = normalized.lastIndexOf(". ");
  if (sentenceBreak >= 0) {
    const intro = normalized.slice(0, sentenceBreak + 1).trim();
    const tail = normalized.slice(sentenceBreak + 2).trim().replace(/[：:]$/u, "");
    if (tail.length >= 4 && tail.length <= 90 && titleLike.test(tail)) return { intro, title: tail };
  }
  const asTitle = normalized.replace(/[：:]$/u, "");
  if (asTitle.length >= 4 && asTitle.length <= 90 && titleLike.test(asTitle)) return { intro: "", title: asTitle };
  return { intro: normalized, title: "" };
}

function splitNumberedFlowTail(finalStep: string) {
  const match = finalStep.match(/^(.{35,}?[.!?。…])\s+((?:러셀은|즉|이처럼|결국|따라서|그러므로|다시)\s.+)$/u);
  if (!match) return { step: finalStep.trim(), tail: "" };
  return { step: (match[1] || "").trim(), tail: (match[2] || "").trim() };
}

function parseNumberedFlowBlocks(text: string): TutorContentBlock[] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches = [...normalized.matchAll(/(?:^|\s)([1-8])[.)]\s+/gu)];
  if (matches.length < 3) return null;
  if (matches[0]?.[1] !== "1") return null;
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index]?.[1] !== String(index + 1)) return null;
  }

  const firstIndex = matches[0]?.index ?? -1;
  if (firstIndex < 0) return null;
  const { intro, title } = splitNumberedFlowIntro(normalized.slice(0, firstIndex));
  let tail = "";
  const steps = matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1]?.index ?? normalized.length : normalized.length;
      const rawStep = normalized.slice(start, end).trim();
      if (index !== matches.length - 1) return rawStep;
      const split = splitNumberedFlowTail(rawStep);
      tail = split.tail;
      return split.step;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (steps.length < 3) return null;

  const blocks: TutorContentBlock[] = [];
  if (intro) blocks.push({ type: "paragraph", body: intro.slice(0, 700) });
  blocks.push({ type: "flow", title: title || undefined, steps });
  if (tail) blocks.push({ type: "paragraph", body: tail.slice(0, 500) });
  return blocks;
}

function splitDashBulletTail(segment: string) {
  const transitions = [" 이런 ", " 이제 ", " 따라서 ", " 그러므로 ", " 결국 ", " 다시 ", " 여기서 "];
  const colonIndex = segment.search(/[：:]/u);
  const minIndex = colonIndex >= 0 ? colonIndex + 16 : 24;
  const candidates = transitions
    .map((token) => {
      const index = segment.indexOf(token, minIndex);
      return index >= 0 ? { token, index } : null;
    })
    .filter((item): item is { token: string; index: number } => Boolean(item))
    .sort((a, b) => a.index - b.index);
  const first = candidates[0];
  if (!first) return { item: segment.trim(), tail: "" };
  return {
    item: segment.slice(0, first.index).trim().replace(/[,\s]+$/u, ""),
    tail: segment.slice(first.index + 1).trim(),
  };
}

function parseInlineBulletBlocks(text: string): TutorContentBlock[] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches = [...normalized.matchAll(/(?:^|\s)([-*•])\s+(?=\S)/gu)];
  if (matches.length < 2) return null;

  const prefixEnd = matches[0]?.index ?? 0;
  const prefix = normalized.slice(0, prefixEnd).trim();
  const rawItems = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]?.index ?? normalized.length : normalized.length;
    return normalized.slice(start, end).trim();
  });
  const labeledCount = rawItems.filter((item) => /^[^:：]{1,48}[：:]\s*\S/u.test(item)).length;
  const startsAsLiteralList = !prefix && Boolean(matches[0]?.[1]);
  if (labeledCount < 2 && !startsAsLiteralList) return null;

  let tail = "";
  const items = rawItems
    .map((item, index) => {
      if (index !== rawItems.length - 1) return item.trim();
      const split = splitDashBulletTail(item);
      tail = split.tail;
      return split.item;
    })
    .filter(Boolean)
    .slice(0, 6);
  if (items.length < 2) return null;

  const blocks: TutorContentBlock[] = [];
  if (prefix) blocks.push({ type: "paragraph", body: prefix.slice(0, 500) });
  blocks.push({ type: "bullets", items });
  if (tail) blocks.push({ type: "paragraph", body: tail.slice(0, 500) });
  return blocks;
}

function parseDashBulletBlocks(text: string): TutorContentBlock[] | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const inlineBlocks = parseInlineBulletBlocks(normalized);
  if (inlineBlocks) return inlineBlocks;
  if (!normalized.includes(" - ")) return null;
  const parts = normalized.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const title = parts[0] || "";
  const rawItems = parts.slice(1);
  const labeledCount = rawItems.filter((item) => /^[^:：]{1,48}[：:]\s*\S/u.test(item)).length;
  if (labeledCount < 2) return null;

  let tail = "";
  const items = rawItems
    .map((item, index) => {
      if (index !== rawItems.length - 1) return item.trim();
      const split = splitDashBulletTail(item);
      tail = split.tail;
      return split.item;
    })
    .filter(Boolean)
    .slice(0, 5);
  if (items.length < 2) return null;

  const blocks: TutorContentBlock[] = [{ type: "bullets", title: title.slice(0, 90), items }];
  if (tail) blocks.push({ type: "paragraph", body: tail.slice(0, 500) });
  return blocks;
}

// Break a long stretch of prose into scannable, sentence-aligned pieces so a single giant
// paragraph never renders as a wall of text. Splits on sentence terminators (Korean and Latin)
// and packs sentences up to ~maxLen without ever cutting mid-sentence.
function splitProse(text: string, maxLen = 240): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?。…]*[.!?。…]+["'”’)\]]?|[^.!?。…]+$/g) || [normalized];
  const pieces: string[] = [];
  let buffer = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (buffer && (buffer.length + 1 + sentence.length) > maxLen) {
      pieces.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function retrievalTokens(text: string) {
  const stop = new Set(["그리고", "그러나", "합니다", "있는", "없는", "것이다", "것은", "에서", "으로", "에게", "the", "and", "that", "with"]);
  return Array.from(new Set((text.match(/[가-힣A-Za-z0-9]{2,}/g) || []).map((item) => item.toLowerCase()).filter((item) => !stop.has(item)))).slice(0, 60);
}

function hasHangulFinalConsonant(text: string) {
  const char = Array.from(text.trim()).reverse().find((item) => /[가-힣]/u.test(item));
  if (!char) return false;
  const code = char.charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
}

function objectParticle(text: string) {
  return hasHangulFinalConsonant(text) ? "을" : "를";
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : String(error).replace(/\s+/g, " ").slice(0, 240);
}

// A provider connection/timeout failure (as opposed to a recoverable JSON-format problem). These
// should NOT be retried — we surface them so the learner can resubmit instead of waiting.
function isProviderConnectionError(error: unknown) {
  if (isProviderError(error)) {
    return ["auth", "model", "rate_limit", "server", "timeout", "network", "configuration"].includes(error.kind);
  }
  const name = (error as { name?: string })?.name || "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = compactError(error).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("ai provider http") ||
    message.includes("request failed") ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("network")
  );
}

function aiFailureSummary(error: unknown) {
  const message = compactError(error);
  if (!message) return "unknown AI failure";
  if (isProviderError(error)) return `provider ${error.kind} failure: ${message}`;
  if (message.includes("AI provider HTTP")) return `provider request failed: ${message}`;
  if (message.includes("invalid JSON") || message.includes("valid JSON")) return `structured response parse failed: ${message}`;
  if (message.includes("empty message")) return `provider returned empty response: ${message}`;
  if (message.includes("not configured") || message.includes("Model is not selected")) return `provider is not configured: ${message}`;
  return message;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function prefetchConsumeWaitMs(
  prefetchCreatedAt: number,
  now = Date.now(),
  maxWaitMs = PREFETCH_CONSUME_MAX_WAIT_MS,
  providerTimeoutMs = PREFETCH_PROVIDER_TIMEOUT_MS
) {
  const elapsedMs = Math.max(0, now - prefetchCreatedAt);
  const providerRemainingMs = Math.max(0, providerTimeoutMs - elapsedMs + 1000);
  return Math.min(maxWaitMs, providerRemainingMs);
}

function sameStringSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function isProgressTurnEvent(event: TurnPayload["event"]) {
  return event === "start_module" || event === "continue_chunk" || event === "next_chunk" || event === "return_to_progress";
}

type TutorPrefetchEmitter = (status: TutorPrefetchStatus) => void;
type LearningMessageBatchEmitter = (status: LearningMessageBatchStatus) => void;

export class TutorService {
  private readonly artifacts = new CourseArtifactService();
  private readonly settings = new SettingsService();
  private readonly secrets = new AiProviderSettingsService();
  private readonly activePrefetches = new Map<string, string>();
  private readonly activeBatchRuns = new Map<string, string>();
  private readonly cancelledBatchRuns = new Set<string>();
  private readonly chunkModuleMaps = new WeakMap<MaterialArtifacts["coursePlan"], Map<string, CourseModule>>();
  private readonly sessionMutations = new SessionMutationQueue();

  constructor(
    private readonly emitPrefetchStatus?: TutorPrefetchEmitter,
    private readonly emitBatchStatus?: LearningMessageBatchEmitter
  ) {}

  async listSessions(materialId: string): Promise<SessionSummary[]> {
    const rows = getDb()
      .query<SessionListRow, [string]>(
        `SELECT s.*, COUNT(m.id) AS message_count
         FROM learning_sessions s
         LEFT JOIN learning_messages m ON m.session_id = s.id AND m.delivery_state = 'visible'
         WHERE s.material_id = ?
         GROUP BY s.id
         ORDER BY s.updated_at DESC`
      )
      .all(materialId);
    let moduleTitles = new Map<string, string>();
    let totalModuleCount = 0;
    try {
      const artifacts = await this.artifacts.getArtifacts(materialId);
      moduleTitles = new Map(artifacts.coursePlan.modules.map((module) => [module.id, module.title]));
      totalModuleCount = artifacts.coursePlan.modules.length;
    } catch {
      moduleTitles = new Map();
    }
    return rows.map((row) => this.summary(row, moduleTitles, totalModuleCount));
  }

  async start(materialId: string, input: { mode: "new" | "continue"; sessionId?: string }) {
    if (input.mode === "continue") {
      const target = input.sessionId || this.latestSessionId(materialId);
      if (target) {
        return this.sessionMutations.run(target, async () => {
          await this.repairSessionCursorForSession(target, { persistSnapshot: true, stalePrefetches: true });
          return { session: this.snapshot(target), context: await this.context(target) };
        });
      }
      throw new Error("No active session is available for this material. Start fresh to create a new session.");
    }

    const material = this.artifacts.getRow(materialId);
    const artifacts = await this.artifacts.getArtifacts(materialId);
    const firstModule = artifacts.coursePlan.modules[0];
    if (!firstModule) throw new Error("Course plan has no modules");
    const firstChunk = this.orderedCurriculum(artifacts)[0];

    const settings = await this.settings.get();
    const id = crypto.randomUUID();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json, current_chunk_id, covered_chunk_ids_json, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, '[]', ?, '[]', ?, ?, ?)`
      )
      .run(id, material.project_id, materialId, material.title, firstModule.id, firstChunk?.id || null, settings.selectedModel, now, now);

    const firstTurn = await this.createTutorTurn(id, { event: "start_module" });
    await this.persistSessionSnapshot(id);
    this.scheduleDefaultContinue(id, "assistant_turn");
    return { session: this.snapshot(id), context: await this.context(id), firstTurn };
  }

  async load(sessionId: string) {
    return this.sessionMutations.run(sessionId, () => this.loadUnlocked(sessionId));
  }

  private async loadUnlocked(sessionId: string) {
    await this.repairSessionCursorForSession(sessionId, { persistSnapshot: true, stalePrefetches: true });
    this.scheduleDefaultContinue(sessionId, "session_loaded");
    return { session: this.snapshot(sessionId), context: await this.context(sessionId) };
  }

  async prefetchStatus(sessionId: string): Promise<TutorPrefetchStatus> {
    return this.currentPrefetchStatus(sessionId);
  }

  async batchMessagesStatus(materialId: string, sessionId?: string): Promise<LearningMessageBatchStatus> {
    if (!sessionId) return this.idleBatchStatus(materialId, null);
    return this.currentBatchStatus(sessionId, materialId);
  }

  async batchMessagesStart(materialId: string, input: { sessionId?: string; force?: boolean } = {}) {
    let targetSessionId = input.sessionId || null;
    if (!targetSessionId) {
      const started = await this.start(materialId, { mode: "new" });
      targetSessionId = started.session.id;
    }
    const sessionId = targetSessionId;
    const batch = await this.sessionMutations.run(sessionId, async () => {
      await this.repairSessionCursorForSession(sessionId, { persistSnapshot: true, stalePrefetches: true });
      return this.startBatchMessagesUnlocked(materialId, sessionId, Boolean(input.force));
    });
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), batch };
  }

  async batchMessagesCancel(sessionId: string): Promise<LearningMessageBatchStatus> {
    return this.sessionMutations.run(sessionId, () => this.cancelBatchMessagesUnlocked(sessionId));
  }

  async deleteSession(sessionId: string) {
    return this.sessionMutations.run(sessionId, () => this.deleteSessionUnlocked(sessionId));
  }

  private async deleteSessionUnlocked(sessionId: string) {
    const row = this.getSessionRow(sessionId);
    this.markPrefetchesStale(sessionId);
    const deleted = getDb().query("DELETE FROM learning_sessions WHERE id = ?").run(sessionId).changes > 0;
    if (deleted) {
      await deleteSessionSnapshot(this.projectRoot(row.project_id), row.project_id, sessionId);
    }
    return deleted;
  }

  async sendTurn(sessionId: string, userText: string) {
    return this.sessionMutations.run(sessionId, () => this.sendTurnUnlocked(sessionId, userText));
  }

  private async sendTurnUnlocked(sessionId: string, userText: string) {
    const text = userText.trim();
    if (!text) throw new Error("Answer is empty");
    await this.repairSessionCursorForSession(sessionId, { persistSnapshot: true, stalePrefetches: true });
    const typedProgressionCommand = classifyProgressionCommand(text);
    if (typedProgressionCommand) {
      if (typedProgressionCommand === "return_to_progress") return this.returnToProgressUnlocked(sessionId);
      return this.advanceUnlocked(sessionId, "paragraph");
    }
    const session = this.snapshotHeader(sessionId);
    const inserted = this.insertMessage({
      sessionId,
      role: "user",
      content: text,
      moduleId: session.currentModuleId || undefined,
      sourceRefs: [],
      choices: [],
    });
    try {
      const output = await this.createTutorTurn(sessionId, { event: "user_message", userText: text });
      await this.persistSessionSnapshot(sessionId);
      if (output.stateUpdate.turnMode !== "digress") this.scheduleDefaultContinue(sessionId, "assistant_turn");
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
    } catch (error) {
      // Kill the failed turn: drop the dangling user message so the learner can resubmit cleanly
      // (instead of a spinner that never resolves), and surface the error to the caller.
      getDb().query("DELETE FROM learning_messages WHERE id = ? AND role = 'user'").run(inserted.id);
      await this.persistSessionSnapshot(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async advance(sessionId: string, mode: "chunk" | "paragraph" | "module") {
    return this.sessionMutations.run(sessionId, () => this.advanceUnlocked(sessionId, mode));
  }

  private async advanceUnlocked(sessionId: string, mode: "chunk" | "paragraph" | "module") {
    let session = this.snapshotForPlanning(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    if (await this.repairSessionCursor(sessionId, artifacts, { persistSnapshot: true, stalePrefetches: true })) {
      session = this.snapshotForPlanning(sessionId);
    }

    if (mode === "paragraph") {
      const consumed = await this.tryConsumeDefaultContinue(sessionId, { waitForGenerating: !this.hasPreparedMessages(sessionId) });
      if (consumed) {
        await this.persistSessionSnapshot(sessionId);
        this.scheduleDefaultContinue(sessionId, "assistant_turn");
        return { session: this.snapshot(sessionId), context: await this.context(sessionId), output: consumed };
      }
      const revealed = await this.tryRevealNextPreparedMessage(sessionId);
      if (revealed) {
        await this.persistSessionSnapshot(sessionId);
        this.scheduleDefaultContinue(sessionId, "assistant_turn");
        return { session: this.snapshot(sessionId), context: await this.context(sessionId), output: revealed };
      }
      this.markPrefetchesStale(sessionId);
      const plan = this.planDefaultContinue(session, artifacts);
      const output = await this.generatePlannedProgressTurn(session, artifacts, plan);
      this.commitPlannedTutorTurn(sessionId, artifacts, plan, output);
      await this.persistSessionSnapshot(sessionId);
      this.scheduleDefaultContinue(sessionId, "assistant_turn");
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
    }

    this.markPrefetchesStale(sessionId);
    this.discardPreparedFuture(sessionId);
    const plan = this.planExplicitProgress(session, artifacts, mode);
    const output = await this.generatePlannedProgressTurn(session, artifacts, plan);
    this.commitPlannedTutorTurn(sessionId, artifacts, plan, output);
    await this.persistSessionSnapshot(sessionId);
    if (plan.targetEvent !== "finish_prompt") this.scheduleDefaultContinue(sessionId, "assistant_turn");
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
  }

  async returnToProgress(sessionId: string) {
    return this.sessionMutations.run(sessionId, () => this.returnToProgressUnlocked(sessionId));
  }

  private async returnToProgressUnlocked(sessionId: string) {
    let session = this.snapshotForPlanning(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    if (await this.repairSessionCursor(sessionId, artifacts, { persistSnapshot: true, stalePrefetches: true })) {
      session = this.snapshotForPlanning(sessionId);
    }
    const consumed = await this.tryConsumeDefaultContinue(sessionId, { returning: true, waitForGenerating: !this.hasPreparedMessages(sessionId) });
    if (consumed) {
      await this.persistSessionSnapshot(sessionId);
      this.scheduleDefaultContinue(sessionId, "assistant_turn");
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output: consumed };
    }
    const revealed = await this.tryRevealNextPreparedMessage(sessionId, { returning: true });
    if (revealed) {
      await this.persistSessionSnapshot(sessionId);
      this.scheduleDefaultContinue(sessionId, "assistant_turn");
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output: revealed };
    }
    this.markPrefetchesStale(sessionId);
    const plan = this.planExplicitProgress(session, artifacts, "return_to_progress");
    const output = await this.generatePlannedProgressTurn(session, artifacts, plan);
    this.commitPlannedTutorTurn(sessionId, artifacts, plan, output);
    await this.persistSessionSnapshot(sessionId);
    if (plan.targetEvent !== "finish_prompt") this.scheduleDefaultContinue(sessionId, "assistant_turn");
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
  }

  async selectModule(sessionId: string, moduleId: string) {
    return this.sessionMutations.run(sessionId, () => this.selectModuleUnlocked(sessionId, moduleId));
  }

  private async selectModuleUnlocked(sessionId: string, moduleId: string) {
    const session = this.snapshotHeader(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const module = this.moduleById(artifacts, moduleId);
    await this.repairSessionCursor(sessionId, artifacts, { persistSnapshot: true, stalePrefetches: true });
    const repairedSession = this.snapshotHeader(sessionId);
    if (!repairedSession.completedModuleIds.includes(module.id)) {
      this.discardPreparedFuture(sessionId);
      this.activateModuleCursor(sessionId, artifacts, module, repairedSession);
      await this.persistSessionSnapshot(sessionId);
    }
    return { session: this.snapshot(sessionId), context: await this.context(sessionId) };
  }

  async openModule(sessionId: string, moduleId: string) {
    return this.sessionMutations.run(sessionId, () => this.openModuleUnlocked(sessionId, moduleId));
  }

  private async openModuleUnlocked(sessionId: string, moduleId: string) {
    const session = this.snapshotHeader(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const module = this.moduleById(artifacts, moduleId);
    const firstChunk = this.firstChunkOfModule(artifacts, module);
    if (!firstChunk) throw new Error("This module has no source chunk");
    this.markPrefetchesStale(sessionId);
    this.discardPreparedFuture(sessionId);
    this.persistCursor(sessionId, artifacts, firstChunk.id, session.coveredChunkIds);
    const output = await this.createTutorTurn(sessionId, { event: "start_module" });
    await this.persistSessionSnapshot(sessionId);
    this.scheduleDefaultContinue(sessionId, "assistant_turn");
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
  }

  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  private async persistSessionSnapshot(sessionId: string) {
    const snapshot = this.snapshot(sessionId);
    await writeSessionSnapshot(this.projectRoot(snapshot.projectId), snapshot);
  }

  private async repairSessionCursorForSession(sessionId: string, options: { persistSnapshot?: boolean; stalePrefetches?: boolean } = {}) {
    const session = this.snapshotHeader(sessionId);
    if (session.status !== "active") return false;
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    return this.repairSessionCursor(sessionId, artifacts, options);
  }

  private async repairSessionCursor(sessionId: string, artifacts: MaterialArtifacts, options: { persistSnapshot?: boolean; stalePrefetches?: boolean } = {}) {
    const session = this.snapshotHeader(sessionId);
    if (session.status !== "active") return false;
    const curriculum = this.orderedCurriculum(artifacts);
    const curriculumIds = curriculum.map((chunk) => chunk.id);
    const curriculumIdSet = new Set(curriculumIds);
    const coveredIds = uniqueStrings(session.coveredChunkIds.filter((id) => curriculumIdSet.has(id)));
    const nextCurrentChunkId = repairedCurrentChunkId(session.currentChunkId, coveredIds, curriculumIds);
    const nextCurrentModuleId = nextCurrentChunkId ? this.ownerModuleOf(artifacts, nextCurrentChunkId).id : artifacts.coursePlan.modules[0]?.id || null;
    const completedModuleIds = this.completedModuleIdsFromChunks(artifacts, new Set(coveredIds));
    const needsRepair =
      session.currentChunkId !== nextCurrentChunkId ||
      session.currentModuleId !== nextCurrentModuleId ||
      !sameStringSet(session.coveredChunkIds, coveredIds) ||
      !sameStringSet(session.completedModuleIds, completedModuleIds);
    if (!needsRepair) return false;

    getDb()
      .query(
        `UPDATE learning_sessions
         SET current_module_id = ?, current_chunk_id = ?, covered_chunk_ids_json = ?, completed_module_ids_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextCurrentModuleId, nextCurrentChunkId, JSON.stringify(coveredIds), JSON.stringify(completedModuleIds), Date.now(), sessionId);
    if (options.stalePrefetches) this.markPrefetchesStale(sessionId);
    if (options.persistSnapshot) await this.persistSessionSnapshot(sessionId);
    return true;
  }

  private latestSessionId(materialId: string) {
    return getDb()
      .query<{ id: string }, [string]>("SELECT id FROM learning_sessions WHERE material_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get(materialId)?.id;
  }

  private snapshot(sessionId: string): SessionSnapshot {
    const row = this.getSessionRow(sessionId);
    const messages = this.messagesForSession(sessionId);
    return {
      id: row.id,
      projectId: row.project_id,
      materialId: row.material_id,
      title: row.title,
      status: row.status,
      currentModuleId: row.current_module_id,
      completedModuleIds: jsonArray(row.completed_module_ids_json),
      currentChunkId: row.current_chunk_id,
      coveredChunkIds: jsonArray(row.covered_chunk_ids_json),
      model: row.model || "",
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private snapshotHeader(sessionId: string): SessionSnapshot {
    const row = this.getSessionRow(sessionId);
    return {
      id: row.id,
      projectId: row.project_id,
      materialId: row.material_id,
      title: row.title,
      status: row.status,
      currentModuleId: row.current_module_id,
      completedModuleIds: jsonArray(row.completed_module_ids_json),
      currentChunkId: row.current_chunk_id,
      coveredChunkIds: jsonArray(row.covered_chunk_ids_json),
      model: row.model || "",
      messages: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private snapshotForPlanning(sessionId: string): SessionSnapshot {
    return {
      ...this.snapshotHeader(sessionId),
      messages: this.recentMessages(sessionId, Math.max(MAX_HISTORY_TURNS, 12)),
    };
  }

  private messagesForSession(sessionId: string) {
    return getDb()
      .query<MessageRow, [string]>("SELECT * FROM learning_messages WHERE session_id = ? AND delivery_state = 'visible' ORDER BY ordinal ASC")
      .all(sessionId)
      .map(toMessage);
  }

  private recentMessages(sessionId: string, limit = MAX_HISTORY_TURNS) {
    return getDb()
      .query<MessageRow, [string, number]>(
        `SELECT * FROM learning_messages
         WHERE session_id = ? AND delivery_state = 'visible'
         ORDER BY ordinal DESC
         LIMIT ?`
      )
      .all(sessionId, limit)
      .reverse()
      .map(toMessage);
  }

  private messageStats(sessionId: string) {
    const row = getDb()
      .query<{ count: number; last_message_id: string | null }, [string, string]>(
        `SELECT COUNT(*) AS count,
                (SELECT id FROM learning_messages WHERE session_id = ? AND delivery_state = 'visible' ORDER BY ordinal DESC LIMIT 1) AS last_message_id
         FROM learning_messages
         WHERE session_id = ? AND delivery_state = 'visible'`
      )
      .get(sessionId, sessionId);
    return { count: row?.count || 0, lastMessageId: row?.last_message_id || null };
  }

  private sessionCommitGuard(session: SessionSnapshot): SessionCommitGuard {
    const stats = this.messageStats(session.id);
    return {
      status: session.status,
      currentModuleId: session.currentModuleId,
      currentChunkId: session.currentChunkId,
      completedModuleIds: session.completedModuleIds,
      coveredChunkIds: session.coveredChunkIds,
      messageCount: stats.count,
      lastMessageId: stats.lastMessageId,
    };
  }

  private assertSessionCommitGuard(sessionId: string, guard: SessionCommitGuard) {
    const current = this.snapshotHeader(sessionId);
    const stats = this.messageStats(sessionId);
    const changed =
      current.status !== guard.status ||
      current.currentModuleId !== guard.currentModuleId ||
      current.currentChunkId !== guard.currentChunkId ||
      !sameStringSet(current.completedModuleIds, guard.completedModuleIds) ||
      !sameStringSet(current.coveredChunkIds, guard.coveredChunkIds) ||
      stats.count !== guard.messageCount ||
      stats.lastMessageId !== guard.lastMessageId;
    if (changed) {
      throw new Error("Session changed while the tutor response was generating. Please retry the action.");
    }
  }

  private summary(row: SessionListRow, moduleTitles: Map<string, string>, totalModuleCount: number): SessionSummary {
    const completedModuleIds = jsonArray(row.completed_module_ids_json);
    return {
      id: row.id,
      projectId: row.project_id,
      materialId: row.material_id,
      title: row.title,
      status: row.status,
      currentModuleId: row.current_module_id,
      currentModuleTitle: row.current_module_id ? moduleTitles.get(row.current_module_id) || null : null,
      completedModuleCount: completedModuleIds.length,
      totalModuleCount,
      messageCount: row.message_count || 0,
      model: row.model || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getSessionRow(sessionId: string) {
    const row = getDb().query<SessionRow, [string]>("SELECT * FROM learning_sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error("Session not found");
    return row;
  }

  private insertMessage(input: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: string;
    blocks?: TutorContentBlock[];
    moduleId?: string;
    sourceRefs: string[];
    choices?: string[];
    visualId?: string | null;
    stateUpdate?: TutorTurnOutput["stateUpdate"];
    deliveryState?: "visible" | "prepared";
    batchRunId?: string | null;
    cursorBefore?: PreparedMessageCursor;
    cursorAfter?: PreparedMessageCursor;
  }) {
    return getDb().transaction(() => this.insertMessageRow(input))();
  }

  private insertMessageRow(input: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: string;
    blocks?: TutorContentBlock[];
    moduleId?: string;
    sourceRefs: string[];
    choices?: string[];
    visualId?: string | null;
    stateUpdate?: TutorTurnOutput["stateUpdate"];
    deliveryState?: "visible" | "prepared";
    batchRunId?: string | null;
    cursorBefore?: PreparedMessageCursor;
    cursorAfter?: PreparedMessageCursor;
  }) {
    const now = Date.now();
    const id = crypto.randomUUID();
    const deliveryState = input.deliveryState || "visible";
    const visibleOrdinal = getDb()
      .query<{ ordinal: number }, [string]>("SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal FROM learning_messages WHERE session_id = ? AND delivery_state = 'visible'")
      .get(input.sessionId)?.ordinal || 0;
    const allOrdinal = getDb()
      .query<{ ordinal: number }, [string]>("SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal FROM learning_messages WHERE session_id = ?")
      .get(input.sessionId)?.ordinal || 0;
    const ordinal = deliveryState === "prepared" ? allOrdinal : visibleOrdinal;
    if (deliveryState === "visible") this.shiftPreparedMessages(input.sessionId, ordinal, 1);
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, blocks_json, module_id, source_refs_json, choices_json, visual_id, state_update_json,
          delivery_state, batch_run_id, cursor_before_json, cursor_after_json, created_at, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.role,
        input.content,
        JSON.stringify(input.blocks || []),
        input.moduleId || null,
        JSON.stringify(input.sourceRefs),
        JSON.stringify(input.choices || []),
        input.visualId || null,
        input.stateUpdate ? JSON.stringify(input.stateUpdate) : null,
        deliveryState,
        input.batchRunId || null,
        input.cursorBefore ? JSON.stringify(input.cursorBefore) : null,
        input.cursorAfter ? JSON.stringify(input.cursorAfter) : null,
        now,
        ordinal
      );
    getDb().query("UPDATE learning_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
    return { id, ordinal };
  }

  private shiftPreparedMessages(sessionId: string, fromOrdinal: number, by: number) {
    if (by <= 0) return;
    const rows = getDb()
      .query<{ id: string; ordinal: number }, [string, number]>(
        `SELECT id, ordinal FROM learning_messages
         WHERE session_id = ? AND delivery_state = 'prepared' AND ordinal >= ?
         ORDER BY ordinal DESC`
      )
      .all(sessionId, fromOrdinal);
    const update = getDb().query("UPDATE learning_messages SET ordinal = ? WHERE id = ?");
    for (const row of rows) update.run(row.ordinal + by, row.id);
  }

  private insertAssistantTurn(sessionId: string, output: TutorTurnOutput) {
    this.insertMessage({
      sessionId,
      role: "assistant",
      content: output.message,
      blocks: output.blocks,
      moduleId: output.moduleId,
      sourceRefs: output.sourceRefs,
      choices: output.choices,
      visualId: output.diagram,
      stateUpdate: output.stateUpdate,
    });
  }

  private async context(sessionId: string): Promise<TutorContext> {
    const session = this.snapshot(sessionId);
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const currentModule = this.currentModule(artifacts, session.currentModuleId);
    const chunks = this.contextualChunks(artifacts, currentModule);
    return {
      session,
      currentObjective: currentModule.learningGoal,
      sourceRefs: chunks.map((chunk) => this.sourceRef(artifacts, chunk)),
      visual: this.moduleVisual(artifacts, currentModule),
      moduleOutline: artifacts.coursePlan.modules.map((module) => ({
        id: module.id,
        title: module.title,
        status: session.completedModuleIds.includes(module.id)
          ? "completed"
          : module.id === currentModule.id
            ? "in_progress"
            : "not_started",
      })),
      chunks,
      figures: artifacts.figures,
    };
  }

  private async createTutorTurn(sessionId: string, payload: TurnPayload): Promise<TutorTurnOutput> {
    const session = this.snapshotForPlanning(sessionId);
    const guard = this.sessionCommitGuard(session);
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const curriculum = this.orderedCurriculum(artifacts);
    const totalChunks = curriculum.length;
    const covered = new Set(session.coveredChunkIds);
    const focusChunk = this.currentChunkOf(artifacts, session);
    const currentModule = this.ownerModuleOf(artifacts, focusChunk?.id);
    const allComplete = totalChunks > 0 && covered.size >= totalChunks;

    // Completion gate: the session never auto-completes. Only an EXPLICIT "yes, let's finish"
    // confirmation ends it.
    if (allComplete && payload.event === "user_message" && isFinishConfirmation(payload.userText || "")) {
      this.assertSessionCommitGuard(sessionId, guard);
      getDb().query("UPDATE learning_sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
      const farewell: TutorTurnOutput = {
        message: "원문의 모든 대목을 다뤘습니다. 학습을 마칩니다. 수고하셨습니다!",
        blocks: [{ type: "bridge", body: "원문의 모든 대목을 다뤘습니다. 학습을 마칩니다. 수고하셨습니다!" }],
        diagram: null,
        visualPlacement: null,
        choices: [],
        progress: 100,
        moduleId: currentModule.id,
        sourceRefs: [],
        stateUpdate: {
          nextPhase: "complete",
          readyToContinue: true,
          nextSuggestedStep: "continue",
          detectedConfusion: null,
          criticWarning: null,
          checkpointPassed: true,
          advanceModule: false,
          userIntent: "satisfied",
          turnMode: "synthesize",
        },
      };
      this.insertMessage({
        sessionId,
        role: "assistant",
        content: farewell.message,
        blocks: farewell.blocks,
        moduleId: farewell.moduleId,
        sourceRefs: farewell.sourceRefs,
        choices: farewell.choices,
        visualId: farewell.diagram,
        stateUpdate: farewell.stateUpdate,
      });
      return farewell;
    }

    const sanitized = await this.generateTutorTurnDraft(session, artifacts, payload);
    this.assertSessionCommitGuard(sessionId, guard);
    this.insertAssistantTurn(sessionId, sanitized);
    return sanitized;
  }

  private async generateTutorTurnDraft(session: SessionSnapshot, artifacts: MaterialArtifacts, payload: TurnPayload): Promise<TutorTurnOutput> {
    const curriculum = this.orderedCurriculum(artifacts);
    const totalChunks = curriculum.length;
    const covered = new Set(session.coveredChunkIds);
    const focusChunk = this.currentChunkOf(artifacts, session);
    const currentModule = this.ownerModuleOf(artifacts, focusChunk?.id);
    const allComplete = totalChunks > 0 && covered.size >= totalChunks;

    // The AI turn is the real product. Retry a couple of times for transient JSON-format issues
    // (the second attempt asks harder for clean JSON). But a provider connection/timeout failure
    // is NOT retried — retrying just makes the learner wait through several long timeouts.
    let output: Partial<TutorTurnOutput> | null = null;
    let lastAiError: unknown = null;
    let connectionFailed = false;
    for (let attempt = 0; attempt < 2 && !output && !connectionFailed; attempt += 1) {
      try {
        output = await this.aiTutorOutput(artifacts, currentModule, focusChunk, session, payload, attempt);
      } catch (error) {
        lastAiError = error;
        connectionFailed = isProviderConnectionError(error);
        if (connectionFailed) {
          console.error(`[tutor] AI turn failed (attempt ${attempt + 1}/2) [connection] for module ${currentModule.id}:`, error);
        } else {
          console.warn(`[tutor] AI structured turn failed (attempt ${attempt + 1}/2) for module ${currentModule.id}: ${compactError(error)}`);
        }
      }
    }
    if (!output && !connectionFailed) {
      try {
        output = await this.aiTutorTextRepairOutput(artifacts, currentModule, focusChunk, session, payload);
      } catch (error) {
        lastAiError = error;
        connectionFailed = isProviderConnectionError(error);
        console.error(`[tutor] AI text repair failed for module ${currentModule.id}:`, error);
      }
    }
    if (!output) {
      throw new Error(
        connectionFailed
          ? "튜터 응답을 받지 못했습니다 (시간 초과 또는 연결 오류). 잠시 후 다시 시도해 주세요."
          : `튜터 응답 생성에 실패했습니다: ${aiFailureSummary(lastAiError)}`
      );
    }
    const sanitized = this.sanitizeOutput(artifacts, currentModule, focusChunk, session, payload, output);
    sanitized.progress = totalChunks ? Math.round((covered.size / totalChunks) * 100) : 0;

    // Once the whole source is covered, offer an explicit finish-or-continue pair instead of
    // showing the normal chunk/module progression commands. Keep the session active until
    // the learner confirms.
    if (allComplete) {
      sanitized.choices = ["네, 마칠게요.", "아니요, 더 질문이 있어요."];
    }

    return sanitized;
  }

  // The closing turn shown once every source chunk is covered: synthesize lightly and ask whether to
  // finish. It keeps the session active — only an explicit "네, 마칠게요" confirmation ends it.
  private finishPromptTurn(sessionId: string, module: CourseModule): TutorTurnOutput {
    const turn = this.buildFinishPromptTurn(module);
    this.insertAssistantTurn(sessionId, turn);
    return turn;
  }

  private buildFinishPromptTurn(module: CourseModule): TutorTurnOutput {
    const body = "여기까지 원문의 모든 대목을 함께 살펴봤습니다. 학습을 마칠까요, 아니면 더 짚어 보고 싶은 부분이 있으신가요?";
    return {
      message: body,
      blocks: [{ type: "bridge", body }],
      diagram: null,
      visualPlacement: null,
      choices: ["네, 마칠게요.", "아니요, 더 질문이 있어요."],
      progress: 100,
      moduleId: module.id,
      sourceRefs: [],
      stateUpdate: {
        nextPhase: "complete",
        readyToContinue: false,
        nextSuggestedStep: "stay",
        detectedConfusion: null,
        criticWarning: null,
        checkpointPassed: false,
        advanceModule: false,
        userIntent: "satisfied",
        turnMode: "synthesize",
      },
    };
  }

  // The learner's progression walks semantic source chunks in document order.
  private orderedCurriculum(artifacts: MaterialArtifacts): SourceChunk[] {
    return artifacts.sourceChunks;
  }

  private planDefaultContinue(session: SessionSnapshot, artifacts: MaterialArtifacts): PlannedProgressTurn {
    const curriculum = this.orderedCurriculum(artifacts);
    const covered = new Set(session.coveredChunkIds);
    const focusChunk = this.currentChunkOf(artifacts, session);
    if (!focusChunk) throw new Error("No current source chunk is available");
    const currentModule = this.ownerModuleOf(artifacts, focusChunk.id);

    if (curriculum.length > 0 && covered.size >= curriculum.length) {
      return this.progressPlan(session, artifacts, "continue_chunk", focusChunk.id, [...covered]);
    }

    if (this.shouldContinueAdvanceToNextChunk(session, focusChunk, curriculum)) {
      covered.add(focusChunk.id);
      const index = curriculum.findIndex((chunk) => chunk.id === focusChunk.id);
      const nextChunk = curriculum[index + 1];
      if (!nextChunk) {
        return this.progressPlan(session, artifacts, "finish_prompt", focusChunk.id, [...covered], currentModule.id);
      }
      const nextModule = this.ownerModuleOf(artifacts, nextChunk.id);
      return this.progressPlan(session, artifacts, nextModule.id !== currentModule.id ? "start_module" : "next_chunk", nextChunk.id, [...covered]);
    }

    return this.progressPlan(session, artifacts, "continue_chunk", focusChunk.id, [...covered]);
  }

  private planExplicitProgress(
    session: SessionSnapshot,
    artifacts: MaterialArtifacts,
    mode: "chunk" | "module" | "return_to_progress"
  ): PlannedProgressTurn {
    const curriculum = this.orderedCurriculum(artifacts);
    const covered = new Set(session.coveredChunkIds);
    const focusChunk = this.currentChunkOf(artifacts, session);
    if (!focusChunk) throw new Error("No current source chunk is available");
    const currentModule = this.ownerModuleOf(artifacts, focusChunk.id);
    let nextChunk: SourceChunk | undefined;

    if (mode === "module") {
      for (const id of currentModule.sourceChunkIds) covered.add(id);
      nextChunk = this.firstChunkOfNextModule(artifacts, currentModule.id) || this.firstUncoveredChunkAfter(artifacts, focusChunk.id, covered);
    } else {
      covered.add(focusChunk.id);
      const index = curriculum.findIndex((chunk) => chunk.id === focusChunk.id);
      nextChunk = index >= 0 ? curriculum[index + 1] : undefined;
    }

    if (!nextChunk) {
      return this.progressPlan(session, artifacts, "finish_prompt", focusChunk.id, [...covered], currentModule.id);
    }

    if (mode === "return_to_progress") {
      return this.progressPlan(session, artifacts, "return_to_progress", nextChunk.id, [...covered]);
    }

    const nextModule = this.ownerModuleOf(artifacts, nextChunk.id);
    return this.progressPlan(session, artifacts, nextModule.id !== currentModule.id ? "start_module" : "next_chunk", nextChunk.id, [...covered]);
  }

  private progressPlan(
    session: SessionSnapshot,
    artifacts: MaterialArtifacts,
    targetEvent: PlannedProgressTurn["targetEvent"],
    targetChunkId: string,
    coveredChunkIdsAfter: string[],
    moduleIdOverride?: string
  ): PlannedProgressTurn {
    const covered = new Set(coveredChunkIdsAfter);
    const moduleId = moduleIdOverride || this.ownerModuleOf(artifacts, targetChunkId).id;
    const completedModuleIds = this.completedModuleIdsFromChunks(artifacts, covered);
    return {
      kind: "default_continue",
      targetEvent,
      moduleId,
      baseCurrentChunkId: session.currentChunkId,
      baseCoveredChunkIds: session.coveredChunkIds,
      targetChunkId,
      coveredChunkIdsAfter: [...covered],
      completedModuleIdsAfter: completedModuleIds,
      cursorAfter: {
        currentModuleId: moduleId,
        currentChunkId: targetChunkId,
        coveredChunkIds: [...covered],
        completedModuleIds,
      },
    };
  }

  private plannedSession(session: SessionSnapshot, plan: PlannedProgressTurn): SessionSnapshot {
    return {
      ...session,
      currentModuleId: plan.cursorAfter.currentModuleId,
      currentChunkId: plan.cursorAfter.currentChunkId,
      coveredChunkIds: plan.cursorAfter.coveredChunkIds,
      completedModuleIds: plan.cursorAfter.completedModuleIds,
    };
  }

  private async generatePlannedProgressTurn(session: SessionSnapshot, artifacts: MaterialArtifacts, plan: PlannedProgressTurn): Promise<TutorTurnOutput> {
    const plannedSession = this.plannedSession(session, plan);
    if (plan.targetEvent === "finish_prompt") return this.buildFinishPromptTurn(this.ownerModuleOf(artifacts, plan.targetChunkId));
    return this.generateTutorTurnDraft(plannedSession, artifacts, { event: plan.targetEvent });
  }

  // Maps every source chunk to the module that should frame it. A chunk explicitly listed by a
  // module is owned by it; an unlisted chunk inherits the most recent owning module so the
  // teaching context stays continuous.
  private chunkModuleMap(artifacts: MaterialArtifacts): Map<string, CourseModule> {
    const cached = this.chunkModuleMaps.get(artifacts.coursePlan);
    if (cached) return cached;
    const modules = artifacts.coursePlan.modules;
    const map = new Map<string, CourseModule>();
    let last = modules[0];
    for (const chunk of artifacts.sourceChunks) {
      const owner = modules.find((module) => module.sourceChunkIds.includes(chunk.id));
      if (owner) last = owner;
      if (last) map.set(chunk.id, last);
    }
    this.chunkModuleMaps.set(artifacts.coursePlan, map);
    return map;
  }

  private ownerModuleOf(artifacts: MaterialArtifacts, chunkId: string | null | undefined): CourseModule {
    return (chunkId ? this.chunkModuleMap(artifacts).get(chunkId) : undefined) || artifacts.coursePlan.modules[0]!;
  }

  private moduleById(artifacts: MaterialArtifacts, moduleId: string): CourseModule {
    const module = artifacts.coursePlan.modules.find((item) => item.id === moduleId);
    if (!module) throw new Error("Module not found");
    return module;
  }

  private firstChunkOfModule(artifacts: MaterialArtifacts, module: CourseModule): SourceChunk | undefined {
    const byId = new Map(artifacts.sourceChunks.map((chunk) => [chunk.id, chunk]));
    return module.sourceChunkIds.map((id) => byId.get(id)).find((chunk): chunk is SourceChunk => Boolean(chunk));
  }

  private firstChunkOfNextModule(artifacts: MaterialArtifacts, moduleId: string): SourceChunk | undefined {
    const modules = artifacts.coursePlan.modules;
    const index = modules.findIndex((module) => module.id === moduleId);
    for (const module of modules.slice(index + 1)) {
      const chunk = this.firstChunkOfModule(artifacts, module);
      if (chunk) return chunk;
    }
    return undefined;
  }

  private firstUncoveredChunkAfter(artifacts: MaterialArtifacts, chunkId: string, covered: Set<string>): SourceChunk | undefined {
    const curriculum = this.orderedCurriculum(artifacts);
    const index = curriculum.findIndex((chunk) => chunk.id === chunkId);
    return curriculum.slice(Math.max(0, index + 1)).find((chunk) => !covered.has(chunk.id));
  }

  private currentChunkOf(artifacts: MaterialArtifacts, session: SessionSnapshot): SourceChunk | undefined {
    const curriculum = this.orderedCurriculum(artifacts);
    return curriculum.find((chunk) => chunk.id === session.currentChunkId) || curriculum[0];
  }

  private shouldContinueAdvanceToNextChunk(session: SessionSnapshot, focusChunk: SourceChunk, curriculum: SourceChunk[]): boolean {
    const requiredTurns = this.requiredTeachingTurnsForChunk(focusChunk);
    return this.currentChunkTeachingTurnCount(session, focusChunk.id, curriculum) >= requiredTurns;
  }

  private requiredTeachingTurnsForChunk(chunk: SourceChunk): number {
    const length = chunk.text.replace(/\s+/g, " ").trim().length;
    if (length <= 700) return 1;
    if (length <= 1600) return 2;
    return 3;
  }

  private currentChunkTeachingTurnCount(session: SessionSnapshot, chunkId: string, curriculum: SourceChunk[]): number {
    const curriculumIds = new Set(curriculum.map((chunk) => chunk.id));
    const persistedTeachingMessages = this.persistedAssistantTeachingMessages(session.id);
    const messages = session.messages.length > persistedTeachingMessages.length ? session.messages : persistedTeachingMessages.length ? persistedTeachingMessages : session.messages;
    let count = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role !== "assistant") continue;
      if (message.stateUpdate?.turnMode === "digress") continue;
      const refs = this.messageTeachingChunkRefs(message).filter((id) => curriculumIds.has(id));
      if (!refs.length) continue;
      if (refs.includes(chunkId)) {
        count += 1;
        continue;
      }
      if (count > 0) break;
    }
    return count;
  }

  private persistedAssistantTeachingMessages(sessionId: string): TutorMessage[] {
    return getDb()
      .query<MessageRow, [string]>(
        `SELECT * FROM learning_messages
         WHERE session_id = ? AND role = 'assistant' AND delivery_state = 'visible'
         ORDER BY ordinal ASC`
      )
      .all(sessionId)
      .map(toMessage);
  }

  private messageTeachingChunkRefs(message: TutorMessage): string[] {
    const blockRefs = this.collectBlockSourceRefs(message.blocks || []);
    return blockRefs.length ? blockRefs : message.sourceRefs;
  }

  private completedModuleIdsFromChunks(artifacts: MaterialArtifacts, covered: Set<string>): string[] {
    return artifacts.coursePlan.modules
      .filter((module) => module.sourceChunkIds.length > 0 && module.sourceChunkIds.every((id) => covered.has(id)))
      .map((module) => module.id);
  }

  private activateModuleCursor(sessionId: string, artifacts: MaterialArtifacts, module: CourseModule, session = this.snapshotHeader(sessionId)) {
    const targetChunkId = repairedModuleCurrentChunkId(
      session.currentChunkId,
      session.coveredChunkIds,
      module.sourceChunkIds,
      this.taughtModuleChunkIds(sessionId, module)
    );
    if (!targetChunkId) throw new Error("This module has no source chunk");

    const covered = new Set(uniqueStrings(session.coveredChunkIds));
    const completedModuleIds = this.completedModuleIdsFromChunks(artifacts, covered);
    const cursorChanged =
      session.currentModuleId !== module.id ||
      session.currentChunkId !== targetChunkId ||
      !sameStringSet(session.completedModuleIds, completedModuleIds);
    if (!cursorChanged) return false;

    getDb()
      .query(
        `UPDATE learning_sessions
         SET current_module_id = ?, current_chunk_id = ?, covered_chunk_ids_json = ?, completed_module_ids_json = ?, status = 'active', updated_at = ?
         WHERE id = ?`
      )
      .run(module.id, targetChunkId, JSON.stringify([...covered]), JSON.stringify(completedModuleIds), Date.now(), sessionId);
    this.markPrefetchesStale(sessionId);
    return true;
  }

  private taughtModuleChunkIds(sessionId: string, module: CourseModule) {
    const moduleChunkIds = new Set(module.sourceChunkIds);
    const taught: string[] = [];
    for (const message of this.persistedAssistantTeachingMessages(sessionId)) {
      if (message.moduleId && message.moduleId !== module.id) continue;
      if (message.stateUpdate?.turnMode === "digress") continue;
      taught.push(...this.messageTeachingChunkRefs(message).filter((id) => moduleChunkIds.has(id)));
    }
    return taught;
  }

  // Persist the source-chunk cursor: the current chunk, the covered set, and the derived
  // current/completed module ids (kept in sync so the module outline and snapshot stay valid).
  private persistCursor(sessionId: string, artifacts: MaterialArtifacts, currentChunkId: string, coveredIds: string[]) {
    const covered = new Set(coveredIds);
    const moduleId = this.ownerModuleOf(artifacts, currentChunkId).id;
    const completedModuleIds = this.completedModuleIdsFromChunks(artifacts, covered);
    getDb()
      .query(
        `UPDATE learning_sessions
         SET current_module_id = ?, current_chunk_id = ?, covered_chunk_ids_json = ?, completed_module_ids_json = ?, status = 'active', updated_at = ?
         WHERE id = ?`
      )
      .run(moduleId, currentChunkId, JSON.stringify([...covered]), JSON.stringify(completedModuleIds), Date.now(), sessionId);
  }

  private async learningRuntimeFingerprint(artifacts: MaterialArtifacts, options: { requirePrefetchEnabled: boolean; requireApiKey: boolean }) {
    const settings = await this.settings.get();
    if (options.requirePrefetchEnabled && !settings.tutorPrefetchEnabled) return null;
    const provider = settings.aiProvider;
    const model = settings.providers[provider].selectedModel;
    const key = options.requireApiKey ? await this.secrets.getApiKey(provider) : null;
    if (!model || (options.requireApiKey && !key?.value)) return null;
    const settingsFingerprint = stableHash({
      provider,
      model,
      baseUrl: settings.providers[provider].baseUrl,
      tutorLanguage: settings.tutorLanguage,
    });
    return {
      provider,
      model,
      settingsFingerprint,
      materialFingerprint: this.materialFingerprint(artifacts),
    };
  }

  private async prefetchRuntimeFingerprint(artifacts: MaterialArtifacts) {
    return this.learningRuntimeFingerprint(artifacts, { requirePrefetchEnabled: true, requireApiKey: true });
  }

  private async batchRuntimeFingerprint(artifacts: MaterialArtifacts) {
    return this.learningRuntimeFingerprint(artifacts, { requirePrefetchEnabled: false, requireApiKey: true });
  }

  private async batchRevealFingerprint(artifacts: MaterialArtifacts) {
    return this.learningRuntimeFingerprint(artifacts, { requirePrefetchEnabled: false, requireApiKey: false });
  }

  private materialFingerprint(artifacts: MaterialArtifacts) {
    return stableHash({
      courseId: artifacts.coursePlan.id,
      title: artifacts.coursePlan.title,
      modules: artifacts.coursePlan.modules.map((module) => ({
        id: module.id,
        title: module.title,
        sourceChunkIds: module.sourceChunkIds,
      })),
      chunks: artifacts.sourceChunks.map((chunk) => ({
        id: chunk.id,
        locator: chunk.locator,
        headingPath: chunk.headingPath,
        length: chunk.text.length,
        sample: chunk.text.slice(0, 160),
      })),
    });
  }

  private emitPrefetch(status: TutorPrefetchStatus) {
    this.emitPrefetchStatus?.(status);
  }

  private currentPrefetchStatus(sessionId: string): TutorPrefetchStatus {
    const row = getDb()
      .query<TutorPrefetchRow, [string]>(
        `SELECT * FROM tutor_prefetches
         WHERE session_id = ? AND kind = 'default_continue'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionId);
    if (!row) {
      return { sessionId, kind: "default_continue", status: "idle", updatedAt: null };
    }
    const now = Date.now();
    const status: TutorPrefetchStatus["status"] = row.expires_at <= now && (row.status === "queued" || row.status === "generating" || row.status === "ready")
      ? "stale"
      : row.status === "queued"
        ? "generating"
        : row.status === "cancelled"
          ? "stale"
          : row.status;
    return {
      sessionId,
      kind: "default_continue",
      status,
      targetEvent: row.target_event,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }

  private idleBatchStatus(materialId: string, sessionId: string | null): LearningMessageBatchStatus {
    return {
      sessionId,
      materialId,
      runId: null,
      status: "idle",
      preparedCount: 0,
      visiblePreparedRemaining: 0,
      completedSteps: 0,
      totalSteps: 0,
      updatedAt: null,
      error: null,
    };
  }

  private preparedMessageCount(sessionId: string) {
    return getDb()
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM learning_messages WHERE session_id = ? AND delivery_state = 'prepared'")
      .get(sessionId)?.count || 0;
  }

  private currentBatchStatus(sessionId: string, materialIdHint?: string): LearningMessageBatchStatus {
    const run = getDb()
      .query<LearningMessageBatchRunRow, [string]>(
        `SELECT * FROM learning_message_batch_runs
         WHERE session_id = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`
      )
      .get(sessionId);
    const materialId = run?.material_id || materialIdHint || this.getSessionRow(sessionId).material_id;
    if (!run) return this.idleBatchStatus(materialId, sessionId);

    const preparedCount = this.preparedMessageCount(sessionId);
    const isSpentRun = preparedCount === 0 && (run.status === "ready" || run.status === "partial" || run.status === "stale");
    return {
      sessionId,
      materialId,
      runId: isSpentRun ? null : run.id,
      status: isSpentRun ? "idle" : run.status,
      preparedCount,
      visiblePreparedRemaining: preparedCount,
      completedSteps: isSpentRun ? 0 : run.completed_steps,
      totalSteps: isSpentRun ? 0 : run.total_steps,
      updatedAt: isSpentRun ? null : run.updated_at,
      error: isSpentRun ? null : run.error,
    };
  }

  private emitBatch(sessionId: string, materialId?: string) {
    try {
      this.emitBatchStatus?.(this.currentBatchStatus(sessionId, materialId));
    } catch {
      /* status pushes are best-effort */
    }
  }

  private hasPreparedMessages(sessionId: string) {
    return this.preparedMessageCount(sessionId) > 0;
  }

  private async startBatchMessagesUnlocked(materialId: string, sessionId: string, force: boolean): Promise<LearningMessageBatchStatus> {
    const session = this.snapshot(sessionId);
    if (session.materialId !== materialId) throw new Error("Session does not belong to this material");
    if (session.status !== "active") throw new Error("This session is not active");

    const current = this.currentBatchStatus(sessionId, materialId);
    if (!force && current.status === "generating") return current;
    if (!force && (current.status === "ready" || current.status === "partial") && current.preparedCount > 0) return current;

    const artifacts = await this.artifacts.getArtifacts(materialId);
    const runtime = await this.batchRuntimeFingerprint(artifacts);
    if (!runtime) throw new Error("AI provider is not configured");

    const previousActiveRunId = this.activeBatchRuns.get(sessionId);
    if (previousActiveRunId) this.cancelledBatchRuns.add(previousActiveRunId);
    this.markPrefetchesStale(sessionId);
    this.discardPreparedFuture(sessionId, { emit: false });

    const totalSteps = this.estimateDefaultContinueSteps(session, artifacts);
    const runId = crypto.randomUUID();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_message_batch_runs
         (id, session_id, material_id, status, route_kind, provider, model, settings_fingerprint, material_fingerprint,
          prompt_version, total_steps, completed_steps, created_at, updated_at)
         VALUES (?, ?, ?, 'generating', 'default_continue', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        runId,
        sessionId,
        materialId,
        runtime.provider,
        runtime.model,
        runtime.settingsFingerprint,
        runtime.materialFingerprint,
        MESSAGE_BATCH_PROMPT_VERSION,
        totalSteps,
        now,
        now
      );

    this.activeBatchRuns.set(sessionId, runId);
    this.cancelledBatchRuns.delete(runId);
    this.emitBatch(sessionId, materialId);
    void this.generateBatchMessages(sessionId, runId).catch((error) => {
      console.warn(`[tutor-batch] background generation failed for ${sessionId}: ${compactError(error)}`);
    });
    return this.currentBatchStatus(sessionId, materialId);
  }

  private cancelBatchMessagesUnlocked(sessionId: string): LearningMessageBatchStatus {
    const row = getDb()
      .query<LearningMessageBatchRunRow, [string]>(
        `SELECT * FROM learning_message_batch_runs
         WHERE session_id = ? AND status = 'generating'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionId);
    if (!row) return this.currentBatchStatus(sessionId);
    this.cancelledBatchRuns.add(row.id);
    const preparedCount = this.preparedMessageCount(sessionId);
    const nextStatus = preparedCount > 0 || row.completed_steps > 0 ? "partial" : "cancelled";
    getDb()
      .query("UPDATE learning_message_batch_runs SET status = ?, updated_at = ? WHERE id = ? AND status = 'generating'")
      .run(nextStatus, Date.now(), row.id);
    this.emitBatch(sessionId, row.material_id);
    return this.currentBatchStatus(sessionId, row.material_id);
  }

  private estimateDefaultContinueSteps(session: SessionSnapshot, artifacts: MaterialArtifacts) {
    let virtualSession = { ...session, messages: [...session.messages] };
    let count = 0;
    while (count < MAX_BATCH_STEPS) {
      const plan = this.planDefaultContinue(virtualSession, artifacts);
      count += 1;
      virtualSession = this.virtualSessionAfterOutput(virtualSession, plan, this.virtualOutputForPlan(plan));
      if (plan.targetEvent === "finish_prompt") break;
    }
    return count;
  }

  private async generateBatchMessages(sessionId: string, runId: string) {
    let run = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
    if (!run || run.status !== "generating") return;
    let completedSteps = run.completed_steps;
    let sawFinishPrompt = false;
    try {
      const artifacts = await this.artifacts.getArtifacts(run.material_id);
      let virtualSession = this.snapshot(sessionId);
      while (completedSteps < MAX_BATCH_STEPS) {
        if (this.cancelledBatchRuns.has(runId)) break;
        run = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
        if (!run || run.status !== "generating") break;

        const cursorBefore = this.cursorFromSession(virtualSession);
        const plan = this.planDefaultContinue(virtualSession, artifacts);
        const output = await this.generatePlannedProgressTurn(virtualSession, artifacts, plan);
        if (this.cancelledBatchRuns.has(runId)) break;

        const inserted = getDb().transaction(() => {
          const currentRun = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
          if (!currentRun || currentRun.status !== "generating") return false;
          this.insertMessageRow({
            sessionId,
            role: "assistant",
            content: output.message,
            blocks: output.blocks,
            moduleId: output.moduleId,
            sourceRefs: output.sourceRefs,
            choices: output.choices,
            visualId: output.diagram,
            stateUpdate: output.stateUpdate,
            deliveryState: "prepared",
            batchRunId: runId,
            cursorBefore,
            cursorAfter: plan.cursorAfter,
          });
          completedSteps += 1;
          getDb()
            .query("UPDATE learning_message_batch_runs SET completed_steps = ?, updated_at = ? WHERE id = ?")
            .run(completedSteps, Date.now(), runId);
          return true;
        })();
        if (!inserted) break;

        virtualSession = this.virtualSessionAfterOutput(virtualSession, plan, output);
        this.emitBatch(sessionId, run.material_id);
        if (plan.targetEvent === "finish_prompt") {
          sawFinishPrompt = true;
          break;
        }
      }

      const latest = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
      if (latest?.status === "generating") {
        const status = sawFinishPrompt ? "ready" : "partial";
        const error = sawFinishPrompt ? null : this.cancelledBatchRuns.has(runId) ? "Generation stopped." : "Batch generation stopped before the finish prompt.";
        getDb()
          .query("UPDATE learning_message_batch_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
          .run(status, error, Date.now(), runId);
      }
    } catch (error) {
      const latest = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
      if (latest?.status === "generating") {
        const preparedCount = this.preparedMessageCount(sessionId);
        getDb()
          .query("UPDATE learning_message_batch_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
          .run(preparedCount > 0 ? "partial" : "failed", compactError(error), Date.now(), runId);
      }
    } finally {
      if (this.activeBatchRuns.get(sessionId) === runId) this.activeBatchRuns.delete(sessionId);
      this.cancelledBatchRuns.delete(runId);
      const finalRun = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(runId);
      this.emitBatch(sessionId, finalRun?.material_id);
    }
  }

  private cursorFromSession(session: SessionSnapshot): PreparedMessageCursor {
    return {
      currentModuleId: session.currentModuleId,
      currentChunkId: session.currentChunkId,
      coveredChunkIds: [...session.coveredChunkIds],
      completedModuleIds: [...session.completedModuleIds],
    };
  }

  private virtualOutputForPlan(plan: PlannedProgressTurn): TutorTurnOutput {
    return {
      message: "",
      blocks: [],
      diagram: null,
      visualPlacement: null,
      choices: [],
      progress: 0,
      moduleId: plan.moduleId,
      sourceRefs: plan.targetChunkId ? [plan.targetChunkId] : [],
      stateUpdate: {
        nextPhase: plan.targetEvent === "finish_prompt" ? "complete" : "explain",
        readyToContinue: plan.targetEvent !== "finish_prompt",
        nextSuggestedStep: plan.targetEvent === "finish_prompt" ? "stay" : "continue",
        detectedConfusion: null,
        criticWarning: null,
        checkpointPassed: false,
        advanceModule: false,
        userIntent: "start",
        turnMode: plan.targetEvent === "finish_prompt" ? "synthesize" : "teach",
      },
    };
  }

  private virtualSessionAfterOutput(session: SessionSnapshot, plan: PlannedProgressTurn, output: TutorTurnOutput): SessionSnapshot {
    const next = this.plannedSession(session, plan);
    const sourceRefs = plan.targetChunkId && !output.sourceRefs.includes(plan.targetChunkId)
      ? [plan.targetChunkId, ...output.sourceRefs]
      : output.sourceRefs;
    const message: TutorMessage = {
      id: `virtual-${session.id}-${session.messages.length + 1}`,
      role: "assistant",
      content: output.message,
      blocks: output.blocks,
      moduleId: output.moduleId,
      sourceRefs,
      choices: output.choices,
      visualId: output.diagram,
      stateUpdate: output.stateUpdate,
      createdAt: Date.now(),
      ordinal: session.messages.length,
    };
    return { ...next, messages: [...session.messages, message] };
  }

  private discardPreparedFuture(sessionId: string, options: { emit?: boolean } = {}) {
    const activeRunId = this.activeBatchRuns.get(sessionId);
    if (activeRunId) this.cancelledBatchRuns.add(activeRunId);
    const materialId = getDb().query<{ material_id: string }, [string]>("SELECT material_id FROM learning_sessions WHERE id = ?").get(sessionId)?.material_id;
    const now = Date.now();
    getDb()
      .query("UPDATE learning_messages SET delivery_state = 'discarded' WHERE session_id = ? AND delivery_state = 'prepared'")
      .run(sessionId);
    getDb()
      .query(
        `UPDATE learning_message_batch_runs
         SET status = 'stale', updated_at = ?
         WHERE session_id = ? AND status IN ('queued', 'generating', 'ready', 'partial')`
      )
      .run(now, sessionId);
    if (options.emit !== false && materialId) this.emitBatch(sessionId, materialId);
  }

  private messageOutputFromRow(row: MessageRow): TutorTurnOutput {
    return {
      message: row.content,
      blocks: jsonBlocks(row.blocks_json),
      diagram: row.visual_id,
      visualPlacement: null,
      choices: jsonArray(row.choices_json),
      progress: 0,
      moduleId: row.module_id || "",
      sourceRefs: jsonArray(row.source_refs_json),
      stateUpdate: row.state_update_json ? JSON.parse(row.state_update_json) : {
        nextPhase: "explain",
        readyToContinue: true,
        nextSuggestedStep: "continue",
        detectedConfusion: null,
      },
    };
  }

  private preparedCursorMatches(session: SessionSnapshot, cursor: PreparedMessageCursor) {
    return (
      session.currentModuleId === cursor.currentModuleId &&
      session.currentChunkId === cursor.currentChunkId &&
      sameStringSet(session.coveredChunkIds, cursor.coveredChunkIds) &&
      sameStringSet(session.completedModuleIds, cursor.completedModuleIds)
    );
  }

  private async tryRevealNextPreparedMessage(sessionId: string, options: { returning?: boolean } = {}): Promise<TutorTurnOutput | null> {
    const row = getDb()
      .query<MessageRow, [string]>(
        `SELECT * FROM learning_messages
         WHERE session_id = ? AND delivery_state = 'prepared'
         ORDER BY ordinal ASC
         LIMIT 1`
      )
      .get(sessionId);
    if (!row?.batch_run_id || !row.cursor_before_json || !row.cursor_after_json) return null;

    const run = getDb().query<LearningMessageBatchRunRow, [string]>("SELECT * FROM learning_message_batch_runs WHERE id = ?").get(row.batch_run_id);
    if (!run || run.status === "stale" || run.status === "cancelled" || run.status === "failed") {
      this.discardPreparedFuture(sessionId);
      return null;
    }

    const artifacts = await this.artifacts.getArtifacts(run.material_id);
    const runtime = await this.batchRevealFingerprint(artifacts);
    if (!runtime || run.prompt_version !== MESSAGE_BATCH_PROMPT_VERSION || run.settings_fingerprint !== runtime.settingsFingerprint || run.material_fingerprint !== runtime.materialFingerprint) {
      this.discardPreparedFuture(sessionId);
      return null;
    }

    const cursorBefore = JSON.parse(row.cursor_before_json) as PreparedMessageCursor;
    const cursorAfter = JSON.parse(row.cursor_after_json) as PreparedMessageCursor;
    const session = this.snapshotHeader(sessionId);
    if (!this.preparedCursorMatches(session, cursorBefore)) {
      this.discardPreparedFuture(sessionId);
      return null;
    }

    let output = this.messageOutputFromRow(row);
    if (options.returning) output = this.withReturningBridge(output);

    getDb().transaction(() => {
      const current = this.snapshotHeader(sessionId);
      if (!this.preparedCursorMatches(current, cursorBefore)) throw new Error("Prepared tutor turn no longer matches the session cursor");
      getDb()
        .query(
          `UPDATE learning_messages
           SET delivery_state = 'visible', content = ?, blocks_json = ?, state_update_json = ?
           WHERE id = ? AND delivery_state = 'prepared'`
        )
        .run(output.message, JSON.stringify(output.blocks || []), output.stateUpdate ? JSON.stringify(output.stateUpdate) : null, row.id);
      getDb()
        .query(
          `UPDATE learning_sessions
           SET current_module_id = ?, current_chunk_id = ?, covered_chunk_ids_json = ?, completed_module_ids_json = ?, status = 'active', updated_at = ?
           WHERE id = ?`
        )
        .run(
          cursorAfter.currentModuleId,
          cursorAfter.currentChunkId,
          JSON.stringify(cursorAfter.coveredChunkIds),
          JSON.stringify(cursorAfter.completedModuleIds),
          Date.now(),
          sessionId
        );
    })();
    this.emitBatch(sessionId, run.material_id);
    return output;
  }

  private sessionFingerprint(session: SessionSnapshot, plan: PlannedProgressTurn, runtime: { settingsFingerprint: string; materialFingerprint: string }) {
    return stableHash({
      sessionId: session.id,
      kind: plan.kind,
      currentChunkId: plan.baseCurrentChunkId,
      coveredChunkIds: [...plan.baseCoveredChunkIds].sort(),
      settingsFingerprint: runtime.settingsFingerprint,
      materialFingerprint: runtime.materialFingerprint,
      promptVersion: PREFETCH_PROMPT_VERSION,
    });
  }

  private scheduleDefaultContinue(sessionId: string, reason: "assistant_turn" | "session_loaded") {
    void this.scheduleDefaultContinueAsync(sessionId, reason).catch((error) => {
      console.warn(`[tutor-prefetch] schedule failed for ${sessionId}: ${compactError(error)}`);
    });
  }

  private async scheduleDefaultContinueAsync(sessionId: string, _reason: "assistant_turn" | "session_loaded") {
    if (this.activePrefetches.has(sessionId) || this.activePrefetches.size >= MAX_ACTIVE_PREFETCH_JOBS) return;
    this.cleanupExpiredPrefetches();
    const session = this.snapshotForPlanning(sessionId);
    if (session.status !== "active") return;
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    if (artifacts.sourceChunks.length > 0 && session.coveredChunkIds.length >= artifacts.sourceChunks.length) return;
    const runtime = await this.prefetchRuntimeFingerprint(artifacts);
    if (!runtime) return;
    const plan = this.planDefaultContinue(session, artifacts);
    const baseSessionFingerprint = this.sessionFingerprint(session, plan, runtime);
    const existing = getDb()
      .query<TutorPrefetchRow, [string]>(
        `SELECT * FROM tutor_prefetches
         WHERE session_id = ? AND kind = 'default_continue' AND status IN ('queued', 'generating', 'ready')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionId);
    if (existing?.base_session_fingerprint === baseSessionFingerprint) return;
    if (existing) this.markPrefetchesStale(sessionId);

    const id = crypto.randomUUID();
    const now = Date.now();
    const stats = this.messageStats(sessionId);
    try {
      getDb()
        .query(
          `INSERT INTO tutor_prefetches
           (id, session_id, material_id, kind, status, base_message_count, base_last_message_id, base_current_chunk_id,
            base_covered_chunk_ids_json, base_session_fingerprint, target_event, target_module_id, target_chunk_id,
            cursor_after_json, provider, model, settings_fingerprint, material_fingerprint, prompt_version,
            created_at, updated_at, expires_at)
           VALUES (?, ?, ?, 'default_continue', 'generating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          sessionId,
          session.materialId,
          stats.count,
          stats.lastMessageId,
          plan.baseCurrentChunkId,
          JSON.stringify(plan.baseCoveredChunkIds),
          baseSessionFingerprint,
          plan.targetEvent,
          plan.moduleId,
          plan.targetChunkId,
          JSON.stringify(plan.cursorAfter),
          runtime.provider,
          runtime.model,
          runtime.settingsFingerprint,
          runtime.materialFingerprint,
          PREFETCH_PROMPT_VERSION,
          now,
          now,
          now + PREFETCH_TTL_MS
        );
      this.emitPrefetch({
        sessionId,
        kind: "default_continue",
        status: "generating",
        targetEvent: plan.targetEvent,
        updatedAt: now,
      });
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      return;
    }

    this.activePrefetches.set(sessionId, id);
    try {
      const output = await this.generatePlannedProgressTurn(session, artifacts, plan);
      getDb()
        .query("UPDATE tutor_prefetches SET status = 'ready', output_json = ?, updated_at = ? WHERE id = ? AND status = 'generating'")
        .run(JSON.stringify(output), Date.now(), id);
      this.emitPrefetch(this.currentPrefetchStatus(sessionId));
    } catch (error) {
      getDb()
        .query("UPDATE tutor_prefetches SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'generating'")
        .run(compactError(error), Date.now(), id);
      this.emitPrefetch(this.currentPrefetchStatus(sessionId));
    } finally {
      if (this.activePrefetches.get(sessionId) === id) this.activePrefetches.delete(sessionId);
    }
  }

  private cleanupExpiredPrefetches() {
    getDb()
      .query("UPDATE tutor_prefetches SET status = 'stale', updated_at = ? WHERE status IN ('queued', 'generating', 'ready') AND expires_at <= ?")
      .run(Date.now(), Date.now());
  }

  private markPrefetchesStale(sessionId: string) {
    getDb()
      .query("UPDATE tutor_prefetches SET status = 'stale', updated_at = ? WHERE session_id = ? AND status IN ('queued', 'generating', 'ready')")
      .run(Date.now(), sessionId);
    this.emitPrefetch(this.currentPrefetchStatus(sessionId));
  }

  private async tryConsumeDefaultContinue(sessionId: string, options: { returning?: boolean; waitForGenerating?: boolean } = {}): Promise<TutorTurnOutput | null> {
    this.cleanupExpiredPrefetches();
    const session = this.snapshotForPlanning(sessionId);
    if (session.status !== "active") return null;
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const runtime = await this.prefetchRuntimeFingerprint(artifacts);
    if (!runtime) return null;
    let row = getDb()
      .query<TutorPrefetchRow, [string]>(
        `SELECT * FROM tutor_prefetches
         WHERE session_id = ? AND kind = 'default_continue' AND status IN ('ready', 'generating', 'queued')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sessionId);
    if (row && (row.status === "generating" || row.status === "queued") && options.waitForGenerating !== false) {
      row = await this.waitForPrefetchCompletion(row.id, prefetchConsumeWaitMs(row.created_at));
    }
    if (!row || !row.output_json) return null;
    const plan = this.planFromPrefetchRow(row);
    const valid =
      row.prompt_version === PREFETCH_PROMPT_VERSION &&
      row.settings_fingerprint === runtime.settingsFingerprint &&
      row.material_fingerprint === runtime.materialFingerprint &&
      row.base_session_fingerprint === this.sessionFingerprint(session, plan, runtime) &&
      this.cursorMatchesPlan(session, plan);
    if (!valid) {
      this.markPrefetchRowStale(row.id);
      return null;
    }

    try {
      const output = JSON.parse(row.output_json) as TutorTurnOutput;
      const finalOutput = options.returning ? this.withReturningBridge(output) : output;
      this.commitPlannedTutorTurn(sessionId, artifacts, plan, finalOutput, row.id);
      this.emitPrefetch(this.currentPrefetchStatus(sessionId));
      return finalOutput;
    } catch (error) {
      this.markPrefetchRowStale(row.id);
      console.warn(`[tutor-prefetch] consume failed for ${sessionId}: ${compactError(error)}`);
      return null;
    }
  }

  private planFromPrefetchRow(row: TutorPrefetchRow): PlannedProgressTurn {
    const cursorAfter = JSON.parse(row.cursor_after_json) as PlannedProgressTurn["cursorAfter"];
    return {
      kind: "default_continue",
      targetEvent: row.target_event,
      moduleId: row.target_module_id || cursorAfter.currentModuleId || "",
      baseCurrentChunkId: row.base_current_chunk_id,
      baseCoveredChunkIds: jsonArray(row.base_covered_chunk_ids_json),
      targetChunkId: row.target_chunk_id,
      coveredChunkIdsAfter: cursorAfter.coveredChunkIds,
      completedModuleIdsAfter: cursorAfter.completedModuleIds,
      cursorAfter,
    };
  }

  private markPrefetchRowStale(prefetchId: string) {
    const row = getDb().query<TutorPrefetchRow, [string]>("SELECT * FROM tutor_prefetches WHERE id = ?").get(prefetchId);
    getDb().query("UPDATE tutor_prefetches SET status = 'stale', updated_at = ? WHERE id = ? AND status IN ('queued', 'generating', 'ready')").run(Date.now(), prefetchId);
    if (row) this.emitPrefetch(this.currentPrefetchStatus(row.session_id));
  }

  private async waitForPrefetchCompletion(prefetchId: string, timeoutMs: number): Promise<TutorPrefetchRow | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const row = getDb().query<TutorPrefetchRow, [string]>("SELECT * FROM tutor_prefetches WHERE id = ?").get(prefetchId);
      if (!row) return null;
      if (row.status === "ready" || row.status === "failed" || row.status === "stale" || row.status === "cancelled") return row;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return getDb().query<TutorPrefetchRow, [string]>("SELECT * FROM tutor_prefetches WHERE id = ?").get(prefetchId) || null;
  }

  private cursorMatchesPlan(session: SessionSnapshot, plan: PlannedProgressTurn) {
    return session.currentChunkId === plan.baseCurrentChunkId && sameStringSet(session.coveredChunkIds, plan.baseCoveredChunkIds);
  }

  private withReturningBridge(output: TutorTurnOutput): TutorTurnOutput {
    const bridge: TutorContentBlock = {
      type: "bridge",
      body: "좋아요. 방금 곁가지는 여기서 잠시 접고, 원래 흐름의 다음 대목으로 돌아가겠습니다.",
    };
    const blocks = [bridge, ...(output.blocks || [])];
    return {
      ...output,
      blocks,
      message: blocksToPlainText(blocks),
      stateUpdate: {
        ...output.stateUpdate,
        conversationMode: "returning",
      },
    };
  }

  private commitPlannedTutorTurn(sessionId: string, _artifacts: MaterialArtifacts, plan: PlannedProgressTurn, output: TutorTurnOutput, prefetchId?: string) {
    const db = getDb();
    let batchMaterialId: string | null = null;
    const commit = db.transaction(() => {
      const current = this.snapshotHeader(sessionId);
      if (current.status !== "active") throw new Error("This session is not active");
      if (!this.cursorMatchesPlan(current, plan)) throw new Error("Planned tutor turn no longer matches the session cursor");
      if (prefetchId) {
        batchMaterialId = current.materialId;
        this.discardPreparedFuture(sessionId, { emit: false });
      }
      db.query(
        `UPDATE learning_sessions
         SET current_module_id = ?, current_chunk_id = ?, covered_chunk_ids_json = ?, completed_module_ids_json = ?, status = 'active', updated_at = ?
         WHERE id = ?`
      ).run(
        plan.cursorAfter.currentModuleId,
        plan.cursorAfter.currentChunkId,
        JSON.stringify(plan.cursorAfter.coveredChunkIds),
        JSON.stringify(plan.cursorAfter.completedModuleIds),
        Date.now(),
        sessionId
      );
      this.insertMessageRow({
        sessionId,
        role: "assistant",
        content: output.message,
        blocks: output.blocks,
        moduleId: output.moduleId,
        sourceRefs: output.sourceRefs,
        choices: output.choices,
        visualId: output.diagram,
        stateUpdate: output.stateUpdate,
      });
      if (prefetchId) {
        db.query("UPDATE tutor_prefetches SET status = 'consumed', updated_at = ? WHERE id = ?").run(Date.now(), prefetchId);
      }
    });
    commit();
    if (batchMaterialId) this.emitBatch(sessionId, batchMaterialId);
  }

  private async aiTutorOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    focusChunk: SourceChunk | undefined,
    session: SessionSnapshot,
    payload: TurnPayload,
    attempt = 0
  ) {
    const settings = await this.settings.get();
    const key = await this.secrets.getApiKey(settings.aiProvider);
    if (!settings.providers[settings.aiProvider].selectedModel || !key.value) throw new Error("AI provider is not configured");
    const client = createAiProviderClient(settings, key.value);
    const languageInstruction = tutorLanguageInstruction(settings.tutorLanguage);
    const chunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
    const originalTerms = originalTermCandidates(focusChunk ? [focusChunk, ...chunks] : chunks);
    const originalTermLine = originalTerms.length
      ? `Original terms visible in the current context. Preserve these spellings when mentioning them, or add them in parentheses after a Korean gloss/transliteration: ${originalTerms.join(", ")}`
      : "";
    const intent = classifyIntent(payload.userText || "", payload.event);
    const allComplete = artifacts.sourceChunks.length > 0 && session.coveredChunkIds.length >= artifacts.sourceChunks.length;
    const instruction = allComplete
      ? payload.event === "user_message"
        ? "Every source chunk has been covered. There is no next module to open. If the learner asks a review question or names something they want to revisit, answer that specific question using the covered source and your broader knowledge where useful. Do NOT start a new module. End by offering either to finish the session or keep discussing a specific point."
        : "Every source chunk has been covered. Do NOT teach new content. Briefly synthesize what the learner has covered, then ask: 원문의 모든 대목을 다뤘습니다. 학습을 마칠까요? Wait for their confirmation before ending."
      : payload.event === "continue_chunk"
        ? "The learner chose 계속해줘. Stay on the same current source chunk. Continue with parts, implications, examples, or connective tissue from this chunk that the earlier assistant turns have not fully covered. Do NOT mark the chunk complete, do NOT move to the next chunk, and avoid repeating the same guided reading."
      : payload.event === "return_to_progress"
        ? "The learner is returning from a detour. The cursor is already on the next active source chunk. Bridge back in one sentence, do NOT repeat the detour or pre-detour chunk, then teach the current source chunk as the continuation."
      : this.courseManagerHint(module, payload, intent);
    // The chunk the learner is on right now. Teaching stays anchored to THIS chunk so the
    // lesson walks the source one semantic chunk at a time instead of dumping the whole module.
    const focusLine = focusChunk
      ? `Current source chunk to teach now (focus on THIS chunk, do not jump ahead): [${focusChunk.id}] ${focusChunk.text}`
      : "";
    // The very first turn of a brand-new session: the big opening block should preview the WHOLE
    // source's content (so the learner knows what they will learn), not give study advice.
    const isSourceOpening = payload.event === "start_module" && session.messages.length === 0;
    const courseOverviewLine = isSourceOpening
      ? `THIS IS THE FIRST TURN OF THE WHOLE SOURCE. Your FIRST block MUST be a "hook" that is a single short paragraph (3-5 sentences) summarizing the ENTIRE source in concrete terms: what it is actually about and what the learner will come to understand by the end, so they know what to expect. Do NOT give study advice or talk about how to read it — summarize the real content. Use this outline:
Source: ${artifacts.coursePlan.title}${artifacts.coursePlan.subtitle ? ` — ${artifacts.coursePlan.subtitle}` : ""}
${artifacts.coursePlan.modules.map((item) => `- ${item.title}`).join("\n")}
After that overview hook, teach the first source chunk with a guided_reading and invite reflection.`
      : "";
    const lecturePlan = this.lectureModule(artifacts, module);
    const presentationPlan = this.presentationModule(artifacts, module);
    const visualIds = artifacts.visuals.map((visual) => visual.id);
    const strictJson = attempt > 0
      ? "\n\nCRITICAL: Your previous response was prose, not JSON. Return a SINGLE valid JSON object and NOTHING else — no markdown fences, no prose, no explanation. The response MUST start with { and end with }."
      : "\n\nRespond with ONLY the JSON object — no prose, no markdown fences, no explanation before or after. The response MUST start with { and end with }.";
    const result = await client.chatJson({
      temperature: attempt > 0 ? 0.4 : 0.7,
      messages: [
        {
          role: "system",
          content: `You are a guided lecturer who teaches a source the learner has not read. Reply only as JSON. Tutor language: ${settings.tutorLanguage}.
${languageInstruction}
Invariant: assume the learner has not read the source. Teach it well enough that they feel a good teacher read it with them.
${TERM_RENDERING_RULE}
${originalTermLine}

ANSWER THE LEARNER. This is the most important rule. When the learner asks a question, raises a tangent, or says you are dodging, you MUST answer their actual question this turn. Never deflect with "let's move on", "that is a good starting point", or a transition to the next topic instead of answering. Dodging a direct question is a failure.

Use your own knowledge. The source chunks are your primary evidence, but you are a knowledgeable teacher, not a search box. When the learner asks something the source does not fully cover (e.g. "is there a philosopher who thought X?"), answer it from your broader knowledge, and make clear which parts come from the source versus general background. Do not refuse and do not redirect to the source.

Detours are allowed and good. If the learner takes the conversation sideways, follow them, answer well, and only afterwards gently offer a way to continue the lesson. Do not force the lesson forward while a question is open. Only move to the next step when the learner signals they are satisfied or explicitly asks to continue.

Never grade. Do not test recall before teaching. Never use "stick closer to the source", "try again", or "that is not in the source" as a primary response. If the learner is wrong, treat it as a useful intuition and teach the missing structure. Questions are for reflection, not grading.
Do not expose internal words such as module, checkpoint, rubric, learning objective, lecture plan, teaching move, source spark, visual note, or teaching guide.

Detected learner intent for this turn: ${intent}. Handle it as follows:
- question / off_topic: answer it directly and substantively first (turnMode "digress", readyToContinue false). Then offer to return.
- deeper: give the requested detail, example, or simpler restatement (turnMode "digress", readyToContinue false). Do NOT advance.
- meta_complaint: the learner feels ignored. Apologize briefly, then directly answer the question they actually asked in their recent messages (turnMode "digress", readyToContinue false).
- satisfied: ONLY when the learner explicitly asks to move on. Synthesize briefly and bridge forward (turnMode "synthesize", readyToContinue true).
- answer / start: teach in place (turnMode "teach"). Do NOT mark the learner satisfied or advance just because they answered well — keep teaching this topic in more depth, cover the parts of the source not yet discussed, and if they seem ready simply offer them the option to continue. The learner advances by choosing the progression option, never by your decision.

BE CONCISE AND VISUAL. The whole point of this app is to understand WITHOUT reading long text. Do not be discursive, speculative, or long-winded. Keep any paragraph/guided_reading to 2-3 short sentences. Each block should be tight; never write a wall of text.
FORMAT CONTRACT: every explanatory block MUST use exactly one of these four formats:
1. Plain sentences: use paragraph or guided_reading for a compact explanation in normal prose.
2. Bullet points: use bullets for a flat set of peer points, examples, takeaways, or corrections where order does not matter.
3. Table: use compare_table only for a true grid with stable columns and parallel rows, such as X vs Y, category comparisons, or dimensions shared by every row.
4. Numbered flow: use flow for a sequence, cause/effect chain, historical development, argument path, adaptation strategy, or any "A leads to B leads to C" structure.
Structural formats MUST be their own JSON blocks. Never put bullets, numbered steps, pipe-separated structures, or table-like text inside paragraph.body or guided_reading.body. A paragraph/guided_reading body is prose only.
If you need bullets, return {"type":"bullets","items":[...]}. If you need ordered steps, return {"type":"flow","steps":[...]}. If you need a grid, return {"type":"compare_table","columns":[...],"rows":[...]}.
Before writing a structured explanation, decide explicitly which of the four formats fits. If it is not a true row/column comparison, do NOT use compare_table. If order or causality matters, use flow rather than bullets. If the points are parallel and unordered, bullets are appropriate.
Do not emit Mermaid syntax unless a Mermaid renderer is explicitly available; this app currently expects structured blocks, not mermaid code fences.
Return 2-4 content blocks. Do not return paragraph-only output unless the learner asked a narrow factual question.
Never simulate a flow, bullet list, or table inside paragraph or guided_reading text. If you are tempted to write "A | B | C", "1. A 2. B", or "- A - B", stop and emit either a flow, bullets, or compare_table block.
Reflection blocks should not trap the learner before progress can continue. Whenever you emit a reflection block, include aiView: your own concise answer or interpretive stance, grounded in the current source, so the learner can reveal it without typing a reply.
	You teach the source ONE SOURCE CHUNK AT A TIME, in order. Teach only the current chunk below this turn; do not summarize or race ahead to later chunks. The learner steps to the next chunk by choosing the progression option.
	If the learner asks a detour question, answer it fully while preserving the current source chunk as the lesson anchor. When returning from a detour, continue from the next active chunk; do not replay the pre-detour explanation.
	When starting a new module (or the very first chunk), open with a hook block that naturally summarizes the module's actual content without formulaic labels such as "핵심은", "요약하면", or "TLDR". It must NOT give study advice or talk about how to read. Then provide guided_reading before any reflective question. When simply continuing to the next chunk of the same module, open with a one-line bridge and a guided_reading of the new chunk — do not repeat a hook every time. When continuing the same chunk, do not replay the same explanation; teach the still-undiscussed details, examples, mechanism, contrast, or implication inside the current chunk. Do not open by showing a raw source sentence unless the learner explicitly asks for the exact wording.
	Always provide exactly 3 choices that work as complete learner replies or exploration paths, phrased as learner continuations, not exam answers or UI commands. Do NOT include progression commands such as "다음 대목으로", "다음 문단으로", "다음 모듈로", or "다음 진도로"; the app shows those separately.
Current course: ${artifacts.coursePlan.title}
Current topic title: ${module.title}
Internal objective: ${module.learningGoal}
Teaching hint: ${instruction}
Lecture plan: ${JSON.stringify(lecturePlan)}
Presentation plan: ${JSON.stringify(presentationPlan)}
Concepts: ${concepts.map((concept) => `${concept.name}: ${concept.definition}`).join("\n")}
${courseOverviewLine}
${focusLine}
	Surrounding source chunks (context only — teach the current chunk above): ${chunks.map((chunk) => `[${chunk.id}] ${chunk.text}`).join("\n\n")}
Available visual ids: ${visualIds.join(", ")}
Block schema:
- hook: {"type":"hook","body":"short intriguing opening"}
- source_quote: {"type":"source_quote","quote":"25 words or fewer from an allowed chunk; only when exact wording genuinely helps","sourceRef":"chunk id","attribution":"optional"}
- guided_reading: {"type":"guided_reading","body":"2-3 sentence plain explanation of the current source chunk","sourceRef":"chunk id"}
- paragraph: {"type":"paragraph","body":"short explanation; may use your own knowledge when the source is silent"}
- bullets: {"type":"bullets","title":"optional","items":["2-5 short peer points where order does not matter"]}
- flow: {"type":"flow","title":"optional","steps":["2-8 short ordered steps"]}
- compare_table: {"type":"compare_table","title":"optional","columns":["2-4 columns"],"rows":[{"Column":"cell"}]}
- reflection: {"type":"reflection","body":"one open reflective prompt","aiView":"1-2 sentence answer you would offer if the learner asks for your view; not another question"}
- bridge: {"type":"bridge","body":"short transition"}
Output schema: {"message":"plain text fallback summary","blocks":[/* 2-4 blocks */],"diagram":"visual id or null","visualPlacement":"inline|side_panel|null","choices":["3 concrete learner continuations"],"progress":0,"moduleId":"${module.id}","sourceRefs":["allowed chunk id"],"stateUpdate":{"nextPhase":"orient|discuss|explain|clarify|synthesize|complete","readyToContinue":false,"nextSuggestedStep":"continue|stay|review","userIntent":"${intent}","turnMode":"teach|digress|synthesize","detectedConfusion":null,"criticWarning":null}}${strictJson}`,
        },
        ...clampHistory(session.messages),
        {
          role: "user",
          content:
            payload.event === "start_module"
              ? isSourceOpening
                ? "This is the very first turn. Open with a natural hook that summarizes the actual content of the source/module in one short paragraph. Do not start it with formulaic labels such as '핵심은', '요약하면', or 'TLDR'. Then teach the first source chunk with a guided_reading and invite reflection."
                : "Open this module's first source chunk as a guided lecture: first a natural content-summary hook without formulaic labels such as '핵심은', then guided_reading of the current chunk, then invite reflection."
              : payload.event === "next_chunk"
                ? "Continue to the next source chunk. Open with a one-line bridge from the previous chunk, then teach the current chunk with a guided_reading, then invite reflection. Do not repeat a hook."
                : payload.event === "continue_chunk"
                  ? "Continue the SAME current source chunk. Do not move to the next chunk. Do not repeat the earlier explanation; extend it by covering what remains implicit, under-explained, or newly useful in this chunk. Keep it concise and end with learner exploration choices."
                  : payload.event === "return_to_progress"
                    ? "Return to the lesson path after a detour. Do not repeat the detour or the previously taught chunk. Briefly bridge, then continue with the current source chunk below."
                    : `Learner just said: ${payload.userText}\nIntent looks like: ${intent}. Respond to what they actually said. If it is a question or complaint, answer it this turn; do not move on. Use their words as material, not as an exam submission.`,
        },
      ],
    });
    if (!result || typeof result !== "object") throw new Error("Model returned a non-object turn");
    return result as Partial<TutorTurnOutput>;
  }

  private async aiTutorTextRepairOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    focusChunk: SourceChunk | undefined,
    session: SessionSnapshot,
    payload: TurnPayload
  ): Promise<Partial<TutorTurnOutput>> {
    const settings = await this.settings.get();
    const key = await this.secrets.getApiKey(settings.aiProvider);
    if (!settings.providers[settings.aiProvider].selectedModel || !key.value) throw new Error("AI provider is not configured");

    const client = createAiProviderClient(settings, key.value);
    const languageInstruction = tutorLanguageInstruction(settings.tutorLanguage);
    const chunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
    const originalTerms = originalTermCandidates(focusChunk ? [focusChunk, ...chunks] : chunks);
    const originalTermLine = originalTerms.length
      ? `Original terms visible in the current context. Preserve these spellings when mentioning them, or add them in parentheses after a Korean gloss/transliteration: ${originalTerms.join(", ")}`
      : "";
    const intent = classifyIntent(payload.userText || "", payload.event);
    const isDigression = DIGRESSION_INTENTS.has(intent);
    const ready = payload.event === "user_message" && intent === "satisfied";
    const focusLine = focusChunk ? `Current source chunk to teach now: [${focusChunk.id}] ${focusChunk.text}` : "";
    const text = await client.chatText({
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: `You are a guided lecturer. Tutor language: ${settings.tutorLanguage}.
${languageInstruction}
The structured JSON call failed, so this is a repair call. Return plain tutor text only.
${TERM_RENDERING_RULE}
${originalTermLine}
Answer the learner's actual latest turn. Do not grade, do not say to stick closer to the source, and do not repeat a canned fallback.
Use the source chunks as primary context, but use your own knowledge when it helps. Be concise and scannable, not discursive. The goal is to understand without reading a wall of text.
For repair text, use plain short sentences or simple bullet points. Do not simulate flows or tables with pipe characters, markdown tables, mermaid, or numbered pseudo-diagrams.
Teach one source chunk at a time; stay on the current chunk below and do not race ahead.
If the learner is asking a question, answer directly first. If they gave an interpretation, connect their wording to the source and refine it.
Current topic: ${module.title}
Internal objective: ${module.learningGoal}
Concepts: ${concepts.map((concept) => `${concept.name}: ${concept.definition}`).join("\n")}
${focusLine}
Surrounding source chunks: ${chunks.map((chunk) => `[${chunk.id}] ${chunk.text}`).join("\n\n")}`,
        },
        ...clampHistory(session.messages),
        {
          role: "user",
          content:
            payload.event === "start_module" || payload.event === "next_chunk" || payload.event === "return_to_progress"
              ? "Teach the current source chunk as a guided lecture. Teach first, then invite reflection."
              : payload.event === "continue_chunk"
                ? "Continue the SAME current source chunk. Do not move to the next chunk. Do not repeat the earlier explanation; cover still-undiscussed details, examples, mechanism, contrast, or implication from this chunk."
                : `Learner just said: ${payload.userText}\nIntent looks like: ${intent}. Answer this turn.`,
        },
      ],
    });
    const blocks = this.textToTutorBlocks(text);
    if (!blocks.length) throw new Error("AI text repair returned empty content");
    return {
      message: blocksToPlainText(blocks),
      blocks,
      diagram: null,
      visualPlacement: null,
      choices: this.sanitizeChoices([], module, ready, isDigression, blocks),
      progress: Math.round(((session.completedModuleIds.length + (ready ? 1 : 0)) / artifacts.coursePlan.modules.length) * 100),
      moduleId: module.id,
      sourceRefs: chunks.map((chunk) => chunk.id).slice(0, 2),
      stateUpdate: {
        nextPhase: ready ? "complete" : isDigression ? "explain" : payload.event === "start_module" ? "discuss" : "clarify",
        readyToContinue: ready,
        nextSuggestedStep: ready ? "continue" : "stay",
        detectedConfusion: null,
        checkpointPassed: ready,
        advanceModule: ready,
        detectedMisconception: null,
        userIntent: intent,
        turnMode: ready ? "synthesize" : isDigression ? "digress" : "teach",
        conversationMode: payload.event === "return_to_progress" ? "returning" : isDigression ? "detour" : "on_track",
        criticWarning: "Structured tutor JSON failed; recovered with AI text repair.",
      },
    };
  }

  private textToTutorBlocks(text: string): TutorContentBlock[] {
    return text
      .replace(/^```(?:text|markdown)?/i, "")
      .replace(/```$/i, "")
      .split(/\n{2,}/)
      .map((part) => this.scrubExamLanguage(part.replace(/\s+/g, " ").trim()))
      .filter(Boolean)
      .slice(0, 6)
      .map((body) => ({ type: "paragraph" as const, body: body.slice(0, 4000) }));
  }

  private sanitizeOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    focusChunk: SourceChunk | undefined,
    session: SessionSnapshot,
    payload: TurnPayload,
    output: Partial<TutorTurnOutput>
  ): TutorTurnOutput {
    const allowedRefs = new Set(artifacts.sourceChunks.map((chunk) => chunk.id));
    const allowedVisuals = new Set(artifacts.visuals.map((visual) => visual.id));

    // Advancement is handled by the source-chunk cursor BEFORE this turn is generated, so this turn
    // never advances on its own. We only record the learner's intent for digression handling and
    // choice shaping. `ready` stays false here.
    const heuristicIntent = classifyIntent(payload.userText || "", payload.event);
    // UI-driven progression events are commands, not learner detours. The model may label
    // "continue this chunk" as "deeper"; do not let that surface a return-to-progress action.
    const intent = payload.event === "user_message" ? coerceIntent(output.stateUpdate?.userIntent) || heuristicIntent : heuristicIntent;
    const isDigression = DIGRESSION_INTENTS.has(intent) || DIGRESSION_INTENTS.has(heuristicIntent);
    const ready = false;
    // Keep the recorded intent consistent with the digression veto above.
    const effectiveIntent: TutorIntent = !DIGRESSION_INTENTS.has(intent) && DIGRESSION_INTENTS.has(heuristicIntent) ? heuristicIntent : intent;
    const baseProgress = artifacts.sourceChunks.length
      ? Math.round((session.coveredChunkIds.length / artifacts.sourceChunks.length) * 100)
      : 0;
    const blocks = this.sanitizeBlocks(artifacts, module, focusChunk, payload, output.blocks, output.message);
    const message = blocks.length ? blocksToPlainText(blocks) : this.scrubExamLanguage(String(output.message || "이 대목을 먼저 설명해 보겠습니다."));

    // Evidence selection: the source chunks shown under "근거 보기" must line up with the
    // answer body. Block-level refs (guided_reading / source_quote) are grounded in what is
    // actually rendered, so they are accepted as long as they are valid artifact chunk ids. The
    // model's free-floating top-level sourceRefs are only accepted when they fall inside the
    // current contextual retrieval set (plus the module's primary chunks), so the tutor cannot
    // claim evidence from a chunk that had nothing to do with this turn. If neither source yields
    // anything, fall back to the first contextual chunk, then the first module chunk, so a
    // reasonable source chunk is always shown.
    const contextualChunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const contextualIds = new Set(contextualChunks.map((chunk) => chunk.id));
    for (const id of module.sourceChunkIds) contextualIds.add(id);
    if (focusChunk) contextualIds.add(focusChunk.id);
    const blockRefs = this.collectBlockSourceRefs(blocks).filter((id) => allowedRefs.has(id));
    const groundedBlockRefs = isProgressTurnEvent(payload.event) && focusChunk ? blockRefs.filter((id) => id === focusChunk.id) : blockRefs;
    const modelRefs = isProgressTurnEvent(payload.event) ? [] : Array.isArray(output.sourceRefs) ? output.sourceRefs.filter((id) => contextualIds.has(id)) : [];
    const mergedRefs = uniqueStrings([...groundedBlockRefs, ...modelRefs]);
    const fallbackRef = focusChunk?.id || contextualChunks[0]?.id || module.sourceChunkIds[0];
    const sourceRefs = mergedRefs.length ? mergedRefs : fallbackRef ? [fallbackRef] : [];

    const criticWarning = [output.stateUpdate?.criticWarning || null, this.examLanguageWarning(String(output.message || "") + "\n" + blocksToPlainText(blocks))]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
    const stateUpdate = this.sanitizeState(output.stateUpdate, ready, effectiveIntent, criticWarning, payload.event);

    return {
      message,
      blocks,
      diagram: output.diagram && allowedVisuals.has(output.diagram) ? output.diagram : null,
      visualPlacement: output.visualPlacement === "inline" || output.visualPlacement === "side_panel" ? output.visualPlacement : null,
      choices: this.sanitizeChoices(output.choices, module, ready, isDigression, blocks),
      progress: Math.max(baseProgress, Math.min(100, Math.round(Number(output.progress) || baseProgress))),
      moduleId: module.id,
      sourceRefs,
      stateUpdate,
    };
  }

  // Collect every source chunk id explicitly attached to a rendered content block. These are
  // grounded in the answer body, so they are the most trustworthy evidence: if the tutor says it
  // is reading from chunk X, "근거 보기" must include chunk X.
  private collectBlockSourceRefs(blocks: TutorContentBlock[]): string[] {
    return blocks.flatMap((block) => {
      if (block.type === "guided_reading" && block.sourceRef) return [block.sourceRef];
      if (block.type === "source_quote") return [block.sourceRef];
      return [];
    });
  }

  private sanitizeBlocks(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    focusChunk: SourceChunk | undefined,
    payload: TurnPayload,
    blocks: unknown,
    fallbackMessage?: unknown
  ): TutorContentBlock[] {
    const allowedRefs = new Set(artifacts.sourceChunks.map((chunk) => chunk.id));
    const chunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const firstChunk = focusChunk || chunks[0];
    const lecturePlan = this.lectureModule(artifacts, module);
    const isOpening = payload.event === "start_module" || payload.event === "next_chunk" || payload.event === "return_to_progress";
    const rawCleaned = Array.isArray(blocks)
      ? blocks
          .map((block) => this.sanitizeBlock(block, allowedRefs, payload.event === "user_message"))
          .filter((block): block is TutorContentBlock => Boolean(block))
          .slice(0, 5)
      : [];
    const cleaned = payload.event === "start_module" ? rawCleaned.filter((block) => block.type !== "hook") : rawCleaned;

    const hasHook = cleaned.some((block) => block.type === "hook");
    const hasGuidedReading = cleaned.some((block) => block.type === "guided_reading");
    const requiredStartBlocks: TutorContentBlock[] = [];
    // A module's first chunk opens with a hook; a continuing or returning chunk opens with a short
    // bridge instead. Either way the current chunk must get a guided_reading.
    if (payload.event === "start_module" && !hasHook) {
      requiredStartBlocks.push({
        type: "hook",
        body: this.moduleContentSummary(module, firstChunk, lecturePlan),
      });
    }
    if (isOpening && !hasGuidedReading) {
      requiredStartBlocks.push({
        type: "guided_reading",
        sourceRef: firstChunk?.id,
        body: trimSentence(firstChunk?.text || lecturePlan?.guidedReading.plainParaphrase || String(fallbackMessage || module.learningGoal)),
      });
    }

    const fallbackBlocks: TutorContentBlock[] = cleaned.length
      ? cleaned
      : [{ type: "paragraph", body: this.scrubExamLanguage(String(fallbackMessage || "이 대목을 먼저 짧게 풀어 보겠습니다.")) }];
    const expandedBlocks = this.expandPseudoStructures(fallbackBlocks);

    const assembled = [...requiredStartBlocks, ...expandedBlocks]
      .filter((block) => (isOpening ? block.type !== "source_quote" : true))
      .map((block) => (block.type === "guided_reading" && !block.sourceRef && firstChunk?.id ? { ...block, sourceRef: firstChunk.id } : block))
      .map((block) => this.reanchorProgressBlock(block, payload.event, firstChunk))
      .map((block) => this.ensureReflectionAiView(block, firstChunk, lecturePlan))
      .map((block) => this.scrubBlock(block))
      .filter((block) => (block.type === "source_quote" ? allowedRefs.has(block.sourceRef) && (!isProgressTurnEvent(payload.event) || !firstChunk || block.sourceRef === firstChunk.id) : true));
    // Final guard against a wall of text: break any long prose block into sentence-aligned,
    // scannable pieces. This is deterministic, so it holds even when the model ignores the
    // "be concise / choose an explicit format" instruction or the turn was salvaged from prose.
    return this.splitWallOfText(assembled).slice(0, 10);
  }

  private reanchorProgressBlock(block: TutorContentBlock, event: TurnPayload["event"], focusChunk: SourceChunk | undefined): TutorContentBlock {
    if (!isProgressTurnEvent(event) || !focusChunk) return block;
    if (block.type === "guided_reading") return { ...block, sourceRef: focusChunk.id };
    return block;
  }

  private expandPseudoStructures(blocks: TutorContentBlock[]): TutorContentBlock[] {
    const expanded: TutorContentBlock[] = [];
    for (const block of blocks) {
      if (block.type !== "paragraph") {
        expanded.push(block);
        continue;
      }
      const numberedFlowBlocks = parseNumberedFlowBlocks(block.body);
      if (numberedFlowBlocks) {
        expanded.push(...numberedFlowBlocks);
        continue;
      }
      const dashBlocks = parseDashBulletBlocks(block.body);
      if (dashBlocks) {
        expanded.push(...dashBlocks);
        continue;
      }
      const structure = parsePipeStructureBlock(block.body);
      expanded.push(structure || block);
    }
    return expanded;
  }

  private ensureReflectionAiView(block: TutorContentBlock, focusChunk: SourceChunk | undefined, lecturePlan: LectureModulePlan | undefined): TutorContentBlock {
    if (block.type !== "reflection" || block.aiView?.trim()) return block;
    const basis = lecturePlan?.guidedReading.plainParaphrase || focusChunk?.text || "";
    const view = trimSentence(
      basis
        ? `저라면 이 질문을 이렇게 보겠습니다. ${basis.replace(/\s+/g, " ")}`
        : "저라면 이 질문을 원문이 던지는 긴장을 따라가며 답하겠습니다. 단정된 결론보다, 어떤 전제가 달라질 때 해석이 달라지는지를 먼저 보겠습니다.",
      360
    );
    return { ...block, aiView: view };
  }

  private moduleContentSummary(module: CourseModule, focusChunk: SourceChunk | undefined, lecturePlan: LectureModulePlan | undefined) {
    const basis = lecturePlan?.guidedReading.plainParaphrase || focusChunk?.text || module.learningGoal || module.title;
    return stripTldrLead(trimSentence(basis.replace(/\s+/g, " "), 230));
  }

  private splitWallOfText(blocks: TutorContentBlock[]): TutorContentBlock[] {
    const out: TutorContentBlock[] = [];
    for (const block of blocks) {
      if ((block.type === "paragraph" || block.type === "guided_reading") && block.body.length > 300) {
        const pieces = splitProse(block.body);
        if (pieces.length <= 1) {
          out.push(block);
          continue;
        }
        pieces.forEach((piece, index) => {
          if (block.type === "guided_reading" && index === 0) out.push({ type: "guided_reading", body: piece, sourceRef: block.sourceRef });
          else out.push({ type: "paragraph", body: piece });
        });
      } else {
        out.push(block);
      }
    }
    return out;
  }

  private sanitizeBlock(block: unknown, allowedRefs: Set<string>, showSourceQuote: boolean): TutorContentBlock | null {
    if (!block || typeof block !== "object" || !("type" in block)) return null;
    const raw = block as Record<string, unknown>;
    const type = String(raw.type);
    if (type === "hook") return { type, body: stripTldrLead(String(raw.body || "").slice(0, 280)) };
    if (type === "guided_reading") {
      const sourceRef = typeof raw.sourceRef === "string" && allowedRefs.has(raw.sourceRef) ? raw.sourceRef : undefined;
      return { type, body: String(raw.body || "").slice(0, 4000), sourceRef };
    }
    if (type === "paragraph") return { type, body: String(raw.body || "").slice(0, 4000) };
    if (type === "bullets") {
      const items = Array.isArray(raw.items) ? raw.items.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [];
      return items.length ? { type, title: plainOptionalTitle(raw.title), items } : null;
    }
    if (type === "flow") {
      const steps = Array.isArray(raw.steps) ? raw.steps.map((step) => String(step).trim()).filter(Boolean).slice(0, 8) : [];
      return steps.length >= 2 ? { type, title: plainOptionalTitle(raw.title), steps } : null;
    }
    if (type === "compare_table") {
      const columns = Array.isArray(raw.columns) ? raw.columns.map((item) => String(item).trim()).filter(Boolean).slice(0, 4) : [];
      const hasTableContent = (row: Record<string, string> | null): row is Record<string, string> => {
        if (!row) return false;
        return columns.some((column) => Boolean(row[column]?.trim()));
      };
      const rows = Array.isArray(raw.rows) && columns.length
        ? raw.rows
            .map((row) => this.sanitizeTableRow(row, columns))
            .filter(hasTableContent)
            .slice(0, 5)
        : [];
      return columns.length >= 2 && rows.length ? { type, title: plainOptionalTitle(raw.title), columns, rows } : null;
    }
    if (type === "source_quote") {
      const sourceRef = String(raw.sourceRef || "");
      if (!allowedRefs.has(sourceRef)) return null;
      return {
        type,
        quote: safeQuote(String(raw.quote || ""), 25),
        sourceRef,
        attribution: raw.attribution ? String(raw.attribution).slice(0, 90) : undefined,
        showToLearner: showSourceQuote,
      };
    }
    if (type === "reflection") {
      const aiView = String(raw.aiView || "").trim().slice(0, 700);
      return { type, body: String(raw.body || "").slice(0, 360), aiView: aiView || undefined };
    }
    if (type === "misconception") {
      return {
        type,
        title: plainOptionalTitle(raw.title),
        body: String(raw.body || "").slice(0, 360),
        repair: String(raw.repair || "").slice(0, 500),
      };
    }
    if (type === "bridge") return { type, body: String(raw.body || "").slice(0, 320) };
    return null;
  }

  private sanitizeTableRow(row: unknown, columns: string[]): Record<string, string> | null {
    if (Array.isArray(row)) {
      return Object.fromEntries(columns.map((column, index) => [column, String(row[index] || "").trim().slice(0, 220)]));
    }
    if (!row || typeof row !== "object") return null;
    const record = row as Record<string, unknown>;
    const keys = Object.keys(record);
    const normalizedKey = new Map(keys.map((key) => [key.replace(/\s+/g, "").toLowerCase(), key]));
    const exactOrSimilar = Object.fromEntries(
      columns.map((column) => {
        const direct = record[column];
        const similarKey = normalizedKey.get(column.replace(/\s+/g, "").toLowerCase());
        const value = direct ?? (similarKey ? record[similarKey] : undefined);
        return [column, String(value ?? "").trim().slice(0, 220)];
      })
    );
    if (columns.some((column) => exactOrSimilar[column])) return exactOrSimilar;
    const values = Object.values(record);
    return Object.fromEntries(columns.map((column, index) => [column, String(values[index] || "").trim().slice(0, 220)]));
  }

  private scrubBlock(block: TutorContentBlock): TutorContentBlock {
    if (block.type === "bullets") return { ...block, items: block.items.map((item) => this.scrubExamLanguage(item)) };
    if (block.type === "flow") return { ...block, steps: block.steps.map((step) => this.scrubExamLanguage(step)) };
    if (block.type === "compare_table") {
      return {
        ...block,
        rows: block.rows.map((row) => Object.fromEntries(block.columns.map((column) => [column, this.scrubExamLanguage(row[column] || "")]))),
      };
    }
    if (block.type === "source_quote") return block;
    if (block.type === "misconception") {
      return { ...block, body: this.scrubExamLanguage(block.body), repair: this.scrubExamLanguage(block.repair) };
    }
    if (block.type === "reflection") {
      return { ...block, body: this.scrubExamLanguage(block.body), aiView: block.aiView ? this.scrubExamLanguage(block.aiView) : undefined };
    }
    return { ...block, body: this.scrubExamLanguage(block.body) };
  }

  private sanitizeState(
    state: Partial<TutorStateUpdate> | undefined,
    ready: boolean,
    intent: TutorIntent,
    criticWarning: string | null,
    event: TurnPayload["event"]
  ): TutorStateUpdate {
    const isDigression = DIGRESSION_INTENTS.has(intent);
    const nextPhase = ready ? "complete" : isDigression ? "explain" : state?.nextPhase || (event === "start_module" || event === "continue_chunk" || event === "next_chunk" ? "discuss" : "clarify");
    const conversationMode = event === "return_to_progress" ? "returning" : isDigression ? "detour" : "on_track";
    // `ready` is the ONLY authority for advancement. We deliberately ignore the model's raw
    // checkpointPassed/advanceModule flags so a stray flag during a digression cannot skip ahead.
    return {
      nextPhase,
      readyToContinue: ready,
      nextSuggestedStep: ready ? "continue" : state?.nextSuggestedStep === "review" ? "review" : "stay",
      detectedConfusion: state?.detectedConfusion || null,
      criticWarning,
      checkpointPassed: ready,
      advanceModule: ready,
      detectedMisconception: state?.detectedMisconception || null,
      userIntent: intent,
      turnMode: ready ? "synthesize" : isDigression ? "digress" : "teach",
      conversationMode,
    };
  }

  private scrubExamLanguage(text: string) {
    return text
      .replace(/아직은\s*원문\s*쪽으로\s*조금\s*더\s*붙여야\s*합니다\.?/g, "이 지점은 원문 구조를 한 번 더 풀어 보면 좋겠습니다.")
      .replace(/원문에\s*더\s*붙여야\s*합니다\.?/g, "원문 구조를 먼저 짧게 풀어 보겠습니다.")
      .replace(/다시\s*말해\s*보세요\.?/g, "이 설명을 바탕으로 어느 지점이 달라지는지 살펴봅시다.")
      .replace(/(?:module|checkpoint|rubric|learning objective|lecture plan|teaching move|source spark|visual note|teaching guide)/gi, "읽기 방향")
      .replace(/(?:모듈|체크포인트|루브릭|학습\s*목표|강의\s*계획|수업\s*자료|교안|교사용\s*메모)/g, "읽기 방향")
      .replace(/정답/g, "핵심")
      .trim();
  }

  private examLanguageWarning(text: string) {
    const patterns = [/원문에\s*더\s*붙/, /다시\s*말해\s*보/, /정답/, /틀렸/];
    return patterns.some((pattern) => pattern.test(text)) ? "Exam-like language was scrubbed from the tutor turn." : null;
  }

  private currentModule(artifacts: MaterialArtifacts, moduleId: string | null): CourseModule {
    return artifacts.coursePlan.modules.find((module) => module.id === moduleId) || artifacts.coursePlan.modules[0]!;
  }

  private moduleChunks(artifacts: MaterialArtifacts, module: CourseModule): SourceChunk[] {
    const byId = new Map(artifacts.sourceChunks.map((chunk) => [chunk.id, chunk]));
    return module.sourceChunkIds.map((id) => byId.get(id)).filter((chunk): chunk is SourceChunk => Boolean(chunk));
  }

  private contextualChunks(artifacts: MaterialArtifacts, module: CourseModule, userText = "", focusChunkId?: string, limit = 6): SourceChunk[] {
    const primary = this.moduleChunks(artifacts, module);
    const primaryIds = new Set(primary.map((chunk) => chunk.id));
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
    const query = [
      module.title,
      module.learningGoal,
      userText,
      ...concepts.flatMap((concept) => [concept.name, concept.definition, concept.whyItMatters]),
    ].join(" ");
    const tokens = retrievalTokens(query);
    const scored = artifacts.sourceChunks
      .filter((chunk) => !primaryIds.has(chunk.id))
      .map((chunk) => {
        const heading = chunk.headingPath.join(" ").toLowerCase();
        const text = chunk.text.toLowerCase();
        const score = tokens.reduce((sum, token) => sum + (heading.includes(token) ? 4 : 0) + (text.includes(token) ? 1 : 0), 0);
        return { chunk, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit - primary.length))
      .map((item) => item.chunk);
    const combined = [...primary, ...scored];
    // Keep the paragraph currently being taught at the head of the context, and make sure it is
    // present even if it is not one of the module's primary chunks.
    if (focusChunkId) {
      const focus = artifacts.sourceChunks.find((chunk) => chunk.id === focusChunkId);
      if (focus) {
        const rest = combined.filter((chunk) => chunk.id !== focusChunkId);
        return [focus, ...rest].slice(0, limit);
      }
    }
    return combined.slice(0, limit);
  }

  private moduleVisual(artifacts: MaterialArtifacts, module: CourseModule): VisualSpec | null {
    const lectureVisual = this.lectureModule(artifacts, module)?.visualOpportunities.find((visual) => visual.placement !== "after_hook")?.id;
    const id = lectureVisual || module.visualIds[0];
    if (!id || id === "visual-course-map" || this.isTeachingGuideVisualId(id)) return null;
    const visual = artifacts.visuals.find((item) => item.id === id) || null;
    return visual && !this.isTeachingGuideVisual(visual) ? visual : null;
  }

  private isTeachingGuideVisualId(id: string) {
    return id.endsWith("-reading-map");
  }

  private isTeachingGuideVisual(visual: VisualSpec) {
    return (
      this.isTeachingGuideVisualId(visual.id) ||
      visual.title.includes("읽기 지도") ||
      visual.title.includes("읽기 방향") ||
      (visual.type === "annotated_table" && visual.columns.some((column) => ["읽기 포인트", "함께 볼 내용", "수업 재료", "메모"].includes(column)))
    );
  }

  private sanitizeChoices(choices: unknown, module: CourseModule, passed: boolean, isDigression = false, blocks: TutorContentBlock[] = []) {
    const cleaned = Array.isArray(choices)
      ? uniqueStrings(
          choices
            .map((choice) => normalizeChoiceText(String(choice).trim()))
            .filter((choice) => choice.length > 0 && choice.length <= 140 && !classifyProgressionCommand(choice))
        ).slice(0, 3)
      : [];
    const invitationChoices = this.choicesFromFinalInvitation(blocks);
    const defaults = this.defaultChoices(module, passed, isDigression).filter((choice) => !classifyProgressionCommand(choice));
    return uniqueStrings([...invitationChoices, ...cleaned, ...defaults]).slice(0, 3);
  }

  private choicesFromFinalInvitation(blocks: TutorContentBlock[]) {
    const text = blocksToPlainText(blocks).replace(/\s+/g, " ").trim();
    const finalSentence = (text.match(/[^.!?。…?？]*[.!?。…?？]+["'”’)\]]?$/u)?.[0] || text.slice(-180)).trim();
    const match = finalSentence.match(/(?:이제\s+)?(.{4,120}?)([을를])\s*(?:살펴볼까요|살펴볼까요\?|볼까요|보겠습니다|살펴보겠습니다)[?？.]?$/u);
    if (!match) return [];
    const rawObject = (match[1] || "").split(/[,，]/u).pop()?.trim() || "";
    if (!rawObject || rawObject.length > 80) return [];
    const target = rawObject.replace(/^(?:이제|다음으로|원래\s+대목으로\s+돌아가서)\s*/u, "").trim();
    if (!target) return [];
    return [
      `네, ${target}${objectParticle(target)} 살펴봐 주세요.`,
      `${target}${objectParticle(target)} 보기 전에 왜 여기서 이어지는지 연결해 주세요.`,
      "그 전에 방금 내용을 한 문장으로 정리해 주세요.",
    ];
  }

  private defaultChoices(module: CourseModule, passed: boolean, isDigression = false) {
    if (passed) {
      return ["방금 내용을 한 문장으로 정리해 주세요.", "예시를 하나만 더 보고 싶어요.", "관련된 원문 근거를 다시 보여 주세요."];
    }
    if (isDigression) {
      return [
        "방금 그 부분을 조금 더 자세히 설명해 주세요.",
        "관련된 다른 예시도 하나 들어 주세요.",
        "방금 설명을 원문 표현과 연결해 주세요.",
      ];
    }
    const signal = (module.understandingSignals || module.masterySignals).find((item) => item.length > 1) || "핵심 단서";
    return [
      `${signal}이 왜 중요한지 조금 더 풀어 주세요.`,
      "이 대목을 표로 비교해서 보고 싶어요.",
      "아직 감이 흐릿해요. 핵심 문장을 더 쉽게 바꿔 주세요.",
    ];
  }

  private sourceRef(artifacts: MaterialArtifacts, chunk: SourceChunk): SourceRef {
    const meta = artifacts.sourceIndex[chunk.id];
    return {
      chunkId: chunk.id,
      title: meta?.title || chunk.headingPath.join(" > ") || "Source",
      locator: meta?.locator || chunk.locator,
      text: chunk.text,
      figures: artifacts.figures.filter((figure) => figure.sourceChunkIds.includes(chunk.id)),
    };
  }

  private courseManagerHint(module: CourseModule, payload: TurnPayload, intent: TutorIntent) {
    if (payload.event === "start_module") {
      return "This is the first source chunk of a module. Open with intrigue (hook), teach this chunk with a guided_reading, and end with a reflective invitation.";
    }
    if (payload.event === "next_chunk") {
      return "Continue to the next source chunk. Bridge in one line from the previous chunk, teach THIS chunk with a guided_reading, and end with a reflective invitation. Do not repeat a hook and do not jump ahead.";
    }
    if (payload.event === "continue_chunk") {
      return "Continue teaching THIS SAME source chunk. Focus on material from this chunk that has not yet been explained, add a concrete example or contrast if useful, and do not jump ahead.";
    }
    if (payload.event === "return_to_progress") {
      return "Return from the learner's detour to the next active source chunk. Bridge briefly, do not repeat the pre-detour chunk, then teach THIS chunk as the continuation.";
    }
    switch (intent) {
      case "satisfied":
        return "The learner wants to move on. Synthesize briefly and bridge forward.";
      case "question":
      case "off_topic":
        return "Answer the learner's question directly and substantively this turn, drawing on the source and your own knowledge. Do not advance. Afterwards offer to return to the main thread.";
      case "deeper":
        return "Give the requested detail, example, or simpler restatement. Stay on this point; do not advance.";
      case "meta_complaint":
        return "The learner feels ignored. Briefly acknowledge it, then directly answer the question they actually asked in their recent messages. Do not advance.";
      default:
        return "Teach the missing structure before asking for reflection. Use their words as material. Do not ask the same recall question again.";
    }
  }

  private lectureModule(artifacts: MaterialArtifacts, module: CourseModule): LectureModulePlan | undefined {
    return artifacts.lecturePlan?.modules.find((item) => item.moduleId === module.id);
  }

  private presentationModule(artifacts: MaterialArtifacts, module: CourseModule): PresentationModulePlan | undefined {
    return artifacts.presentationPlan?.modules.find((item) => item.moduleId === module.id);
  }
}
