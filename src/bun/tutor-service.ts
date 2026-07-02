import { getDb } from "./project-db";
import { CourseArtifactService } from "./course-artifact-service";
import { SettingsService } from "./settings-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { OpenAICompatibleClient } from "./openai-compatible-client";
import { dataPath } from "./paths";
import { syncProjectRootToDb, writeSessionSnapshot } from "./project-bundle-sync";
import type { CourseModule, LectureModulePlan, MaterialArtifacts, PresentationModulePlan, SourceChunk, VisualSpec } from "../shared/artifact-types";
import type { SessionSnapshot, SessionSummary, SourceRef, TutorContentBlock, TutorContext, TutorIntent, TutorMessage, TutorStateUpdate, TutorTurnOutput } from "../shared/tutor-types";

// "start_module": open the first source chunk of a (new) module with a content summary.
// "next_chunk": continue to the next source chunk within the same module. "return_to_progress":
// bridge back to the current source chunk after a detour. "user_message": the learner replied.
type TurnPayload = { event: "start_module" | "next_chunk" | "return_to_progress" | "user_message"; userText?: string };

const VALID_INTENTS: TutorIntent[] = ["start", "answer", "question", "off_topic", "deeper", "meta_complaint", "satisfied"];
const DIGRESSION_INTENTS = new Set<TutorIntent>(["question", "off_topic", "deeper", "meta_complaint"]);
const PROGRESSION_CHOICES = new Set(["다음 진도로 넘어가주세요.", "다음 대목으로 넘어가주세요.", "다음 문단으로 넘어가주세요.", "다음 모듈로 넘어가주세요.", "진도로 돌아갈게요."]);

// A lightweight Korean-aware heuristic. It is only a hint and a fallback; when the model
// returns its own userIntent we trust that instead. The point is that a substantive
// question must never be mistaken for "ready to advance".
function classifyIntent(userText: string, event: TurnPayload["event"]): TutorIntent {
  if (event === "start_module" || event === "next_chunk" || event === "return_to_progress") return "start";
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
  created_at: number;
  ordinal: number;
};

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
  const mapped = messages.slice(-12).map((message) => ({
    role: message.role === "user" ? ("user" as const) : ("assistant" as const),
    content: (message.blocks?.length ? blocksToPlainText(message.blocks) : message.content).slice(0, 1800),
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

function compactError(error: unknown) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : String(error).replace(/\s+/g, " ").slice(0, 240);
}

// A provider connection/timeout failure (as opposed to a recoverable JSON-format problem). These
// should NOT be retried — we surface them so the learner can resubmit instead of waiting.
function isProviderConnectionError(error: unknown) {
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
  if (message.includes("AI provider HTTP")) return `provider request failed: ${message}`;
  if (message.includes("invalid JSON") || message.includes("valid JSON")) return `structured response parse failed: ${message}`;
  if (message.includes("empty message")) return `provider returned empty response: ${message}`;
  if (message.includes("not configured") || message.includes("Model is not selected")) return `provider is not configured: ${message}`;
  return message;
}

export class TutorService {
  private readonly artifacts = new CourseArtifactService();
  private readonly settings = new SettingsService();
  private readonly secrets = new AiProviderSettingsService();

  async listSessions(materialId: string): Promise<SessionSummary[]> {
    const material = this.artifacts.getRow(materialId);
    await syncProjectRootToDb(this.projectRoot(material.project_id));
    const rows = getDb()
      .query<SessionRow, [string]>("SELECT * FROM learning_sessions WHERE material_id = ? ORDER BY updated_at DESC")
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
      if (target) return { session: this.snapshot(target), context: await this.context(target) };
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
    return { session: this.snapshot(id), context: await this.context(id), firstTurn };
  }

  async load(sessionId: string) {
    return { session: this.snapshot(sessionId), context: await this.context(sessionId) };
  }

  async sendTurn(sessionId: string, userText: string) {
    const text = userText.trim();
    if (!text) throw new Error("Answer is empty");
    const session = this.snapshot(sessionId);
    const ordinal = session.messages.length;
    this.insertMessage({
      sessionId,
      role: "user",
      content: text,
      moduleId: session.currentModuleId || undefined,
      sourceRefs: [],
      choices: [],
      ordinal,
    });
    try {
      const output = await this.createTutorTurn(sessionId, { event: "user_message", userText: text });
      await this.persistSessionSnapshot(sessionId);
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
    } catch (error) {
      // Kill the failed turn: drop the dangling user message so the learner can resubmit cleanly
      // (instead of a spinner that never resolves), and surface the error to the caller.
      getDb().query("DELETE FROM learning_messages WHERE session_id = ? AND ordinal = ? AND role = 'user'").run(sessionId, ordinal);
      await this.persistSessionSnapshot(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async advance(sessionId: string, mode: "chunk" | "paragraph" | "module") {
    const session = this.snapshot(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const curriculum = this.orderedCurriculum(artifacts);
    const covered = new Set(session.coveredChunkIds);
    const focusChunk = this.currentChunkOf(artifacts, session);
    const currentModule = this.ownerModuleOf(artifacts, focusChunk?.id);
    if (!focusChunk) throw new Error("No current source chunk is available");

    let nextChunk: SourceChunk | undefined;
    if (mode === "module") {
      for (const id of currentModule.sourceChunkIds) covered.add(id);
      nextChunk = this.firstChunkOfNextModule(artifacts, currentModule.id);
      if (!nextChunk) nextChunk = this.firstUncoveredChunkAfter(artifacts, focusChunk.id, covered);
    } else {
      covered.add(focusChunk.id);
      const index = curriculum.findIndex((chunk) => chunk.id === focusChunk.id);
      nextChunk = curriculum[index + 1];
    }

    if (!nextChunk) {
      this.persistCursor(sessionId, artifacts, focusChunk.id, [...covered]);
      const output = this.finishPromptTurn(sessionId, currentModule);
      await this.persistSessionSnapshot(sessionId);
      return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
    }

    this.persistCursor(sessionId, artifacts, nextChunk.id, [...covered]);
    const nextModule = this.ownerModuleOf(artifacts, nextChunk.id);
    const output = await this.createTutorTurn(sessionId, { event: nextModule.id !== currentModule.id ? "start_module" : "next_chunk" });
    await this.persistSessionSnapshot(sessionId);
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
  }

  async returnToProgress(sessionId: string) {
    const session = this.snapshot(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const focusChunk = this.currentChunkOf(artifacts, session);
    if (!focusChunk) throw new Error("No current source chunk is available");
    const output = await this.createTutorTurn(sessionId, { event: "return_to_progress" });
    await this.persistSessionSnapshot(sessionId);
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
  }

  async selectModule(sessionId: string, moduleId: string) {
    const session = this.snapshot(sessionId);
    if (session.status !== "active") throw new Error("This session is not active");
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const module = this.moduleById(artifacts, moduleId);
    const firstChunk = this.firstChunkOfModule(artifacts, module);
    if (!firstChunk) throw new Error("This module has no source chunk");
    this.persistCursor(sessionId, artifacts, firstChunk.id, session.coveredChunkIds);
    await this.persistSessionSnapshot(sessionId);
    return { session: this.snapshot(sessionId), context: await this.context(sessionId) };
  }

  async openModule(sessionId: string, moduleId: string) {
    await this.selectModule(sessionId, moduleId);
    const output = await this.createTutorTurn(sessionId, { event: "start_module" });
    await this.persistSessionSnapshot(sessionId);
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

  private latestSessionId(materialId: string) {
    return getDb()
      .query<{ id: string }, [string]>("SELECT id FROM learning_sessions WHERE material_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get(materialId)?.id;
  }

  private snapshot(sessionId: string): SessionSnapshot {
    const row = this.getSessionRow(sessionId);
    const messages = getDb()
      .query<MessageRow, [string]>("SELECT * FROM learning_messages WHERE session_id = ? ORDER BY ordinal ASC")
      .all(sessionId)
      .map(toMessage);
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

  private summary(row: SessionRow, moduleTitles: Map<string, string>, totalModuleCount: number): SessionSummary {
    const completedModuleIds = jsonArray(row.completed_module_ids_json);
    const messageCount = getDb()
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM learning_messages WHERE session_id = ?")
      .get(row.id)?.count || 0;
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
      messageCount,
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
    ordinal: number;
  }) {
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, blocks_json, module_id, source_refs_json, choices_json, visual_id, state_update_json, created_at, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.sessionId,
        input.role,
        input.content,
        JSON.stringify(input.blocks || []),
        input.moduleId || null,
        JSON.stringify(input.sourceRefs),
        JSON.stringify(input.choices || []),
        input.visualId || null,
        input.stateUpdate ? JSON.stringify(input.stateUpdate) : null,
        Date.now(),
        input.ordinal
      );
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
    };
  }

  private async createTutorTurn(sessionId: string, payload: TurnPayload): Promise<TutorTurnOutput> {
    const session = this.snapshot(sessionId);
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
        ordinal: session.messages.length,
      });
      return farewell;
    }

    // Progression is PER SOURCE CHUNK when typed as free text. The dedicated UI buttons use
    // advance("chunk" | "module") above so their behavior is explicit.
    // A typed "넘어가" request (heuristic intent "satisfied")
    // marks the current chunk covered and steps to the next one, then teaches it. A small
    // source is one module of many chunks, so advancing by module would finish the whole
    // source in a single click — which is exactly the bug this replaces.
    if (payload.event === "user_message" && !allComplete && focusChunk) {
      const heuristic = classifyIntent(payload.userText || "", "user_message");
      if (heuristic === "satisfied") {
        covered.add(focusChunk.id);
        const index = curriculum.findIndex((chunk) => chunk.id === focusChunk.id);
        const nextChunk = curriculum[index + 1];
        if (!nextChunk) {
          // The last chunk is now covered. Ask the learner to finish; do not auto-complete.
          this.persistCursor(sessionId, artifacts, focusChunk.id, [...covered]);
          return this.finishPromptTurn(sessionId, currentModule);
        }
        this.persistCursor(sessionId, artifacts, nextChunk.id, [...covered]);
        const nextModule = this.ownerModuleOf(artifacts, nextChunk.id);
        // A chunk that begins a new module opens with a hook; otherwise we simply continue
        // to the next chunk within the same module.
        return await this.createTutorTurn(sessionId, { event: nextModule.id === currentModule.id ? "next_chunk" : "start_module" });
      }
    }

    // The AI turn is the real product. Retry a couple of times for transient JSON-format issues
    // (the second attempt asks harder for clean JSON). But a provider connection/timeout failure
    // is NOT retried — retrying just makes the learner wait through several long timeouts. On any
    // total failure we THROW so sendTurn can kill the turn and let the learner resubmit, rather
    // than fabricating a canned answer.
    let output: Partial<TutorTurnOutput> | null = null;
    let lastAiError: unknown = null;
    let connectionFailed = false;
    for (let attempt = 0; attempt < 2 && !output && !connectionFailed; attempt += 1) {
      try {
        output = await this.aiTutorOutput(artifacts, currentModule, focusChunk, session, payload, attempt);
      } catch (error) {
        lastAiError = error;
        connectionFailed = isProviderConnectionError(error);
        console.error(`[tutor] AI turn failed (attempt ${attempt + 1}/2)${connectionFailed ? " [connection]" : ""} for module ${currentModule.id}:`, error);
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

    this.insertMessage({
      sessionId,
      role: "assistant",
      content: sanitized.message,
      blocks: sanitized.blocks,
      moduleId: sanitized.moduleId,
      sourceRefs: sanitized.sourceRefs,
      choices: sanitized.choices,
      visualId: sanitized.diagram,
      stateUpdate: sanitized.stateUpdate,
      ordinal: this.snapshot(sessionId).messages.length,
    });
    return sanitized;
  }

  // The closing turn shown once every source chunk is covered: synthesize lightly and ask whether to
  // finish. It keeps the session active — only an explicit "네, 마칠게요" confirmation ends it.
  private finishPromptTurn(sessionId: string, module: CourseModule): TutorTurnOutput {
    const body = "여기까지 원문의 모든 대목을 함께 살펴봤습니다. 학습을 마칠까요, 아니면 더 짚어 보고 싶은 부분이 있으신가요?";
    const turn: TutorTurnOutput = {
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
    this.insertMessage({
      sessionId,
      role: "assistant",
      content: turn.message,
      blocks: turn.blocks,
      moduleId: turn.moduleId,
      sourceRefs: turn.sourceRefs,
      choices: turn.choices,
      visualId: turn.diagram,
      stateUpdate: turn.stateUpdate,
      ordinal: this.snapshot(sessionId).messages.length,
    });
    return turn;
  }

  // The learner's progression walks semantic source chunks in document order.
  private orderedCurriculum(artifacts: MaterialArtifacts): SourceChunk[] {
    return artifacts.sourceChunks;
  }

  // Maps every source chunk to the module that should frame it. A chunk explicitly listed by a
  // module is owned by it; an unlisted chunk inherits the most recent owning module so the
  // teaching context stays continuous.
  private chunkModuleMap(artifacts: MaterialArtifacts): Map<string, CourseModule> {
    const modules = artifacts.coursePlan.modules;
    const map = new Map<string, CourseModule>();
    let last = modules[0];
    for (const chunk of artifacts.sourceChunks) {
      const owner = modules.find((module) => module.sourceChunkIds.includes(chunk.id));
      if (owner) last = owner;
      if (last) map.set(chunk.id, last);
    }
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

  private completedModuleIdsFromChunks(artifacts: MaterialArtifacts, covered: Set<string>): string[] {
    return artifacts.coursePlan.modules
      .filter((module) => module.sourceChunkIds.length > 0 && module.sourceChunkIds.every((id) => covered.has(id)))
      .map((module) => module.id);
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

  private async aiTutorOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    focusChunk: SourceChunk | undefined,
    session: SessionSnapshot,
    payload: TurnPayload,
    attempt = 0
  ) {
    const settings = await this.settings.get();
    const key = await this.secrets.getApiKey();
    if (!settings.selectedModel || !key.value) throw new Error("AI provider is not configured");
    const client = new OpenAICompatibleClient({ baseUrl: settings.ollamaBaseUrl, apiKey: key.value, model: settings.selectedModel });
    const chunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
    const intent = classifyIntent(payload.userText || "", payload.event);
    const allComplete = artifacts.sourceChunks.length > 0 && session.coveredChunkIds.length >= artifacts.sourceChunks.length;
    const instruction = allComplete
      ? "Every source chunk has been covered. Do NOT teach new content. Briefly synthesize what the learner has covered, then ask: 원문의 모든 대목을 다뤘습니다. 학습을 마칠까요? Wait for their confirmation before ending."
      : payload.event === "return_to_progress"
        ? "The learner is returning from a detour. Do NOT advance the cursor. Bridge back in one sentence, then resume teaching the current source chunk. Make clear that this is where the lesson left off."
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
Invariant: assume the learner has not read the source. Teach it well enough that they feel a good teacher read it with them.

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

BE CONCISE AND VISUAL. The whole point of this app is to understand WITHOUT reading long text. Do not be discursive, speculative, or long-winded. Prefer compact, scannable structure over prose: use bullets, compare_table, misconception, and a diagram (when an allowed visual id fits) FIRST, and keep any paragraph/guided_reading to 2-3 short sentences. Each block should be tight; never write a wall of text. If an idea can be a table or a short list, make it one instead of a paragraph.
Return 2-4 content blocks. Do not return paragraph-only output unless the learner asked a narrow factual question.
	You teach the source ONE SOURCE CHUNK AT A TIME, in order. Teach only the current chunk below this turn; do not summarize or race ahead to later chunks. The learner steps to the next chunk by choosing the progression option.
	If the learner asks a detour question, answer it fully while preserving the current source chunk as the lesson anchor. When returning from a detour, bridge back to the anchored chunk instead of advancing.
	When starting a new module (or the very first chunk), open with a hook block whose body starts with "핵심은" and summarizes the module's actual content. It must NOT give study advice or talk about how to read. Then provide guided_reading before any reflective question. When simply continuing to the next chunk of the same module, open with a one-line bridge and a guided_reading of the new chunk — do not repeat a hook every time. Do not open by showing a raw source sentence unless the learner explicitly asks for the exact wording.
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
- guided_reading: {"type":"guided_reading","body":"3-5 sentence source explanation","sourceRef":"chunk id"}
- paragraph: {"type":"paragraph","body":"short explanation; may use your own knowledge when the source is silent"}
- bullets: {"type":"bullets","title":"optional","items":["2-5 short items"]}
- compare_table: {"type":"compare_table","title":"optional","columns":["2-4 columns"],"rows":[{"Column":"cell"}]}
- reflection: {"type":"reflection","body":"one open reflective prompt"}
- misconception: {"type":"misconception","title":"optional","body":"natural confusion","repair":"teacherly repair"}
- bridge: {"type":"bridge","body":"short transition"}
Output schema: {"message":"plain text fallback summary","blocks":[/* 2-4 blocks */],"diagram":"visual id or null","visualPlacement":"inline|side_panel|null","choices":["3 concrete learner continuations"],"progress":0,"moduleId":"${module.id}","sourceRefs":["allowed chunk id"],"stateUpdate":{"nextPhase":"orient|discuss|explain|clarify|synthesize|complete","readyToContinue":false,"nextSuggestedStep":"continue|stay|review","userIntent":"${intent}","turnMode":"teach|digress|synthesize","detectedConfusion":null,"criticWarning":null}}${strictJson}`,
        },
        ...clampHistory(session.messages),
        {
          role: "user",
          content:
            payload.event === "start_module"
              ? isSourceOpening
                ? "This is the very first turn. Open with a hook that starts with '핵심은' and summarizes the actual content of the source/module in one short paragraph, then teach the first source chunk with a guided_reading and invite reflection."
                : "Open this module's first source chunk as a guided lecture: first a content-summary hook starting with '핵심은', then guided_reading of the current chunk, then invite reflection."
              : payload.event === "next_chunk"
                ? "Continue to the next source chunk. Open with a one-line bridge from the previous chunk, then teach the current chunk with a guided_reading, then invite reflection. Do not repeat a hook."
                : payload.event === "return_to_progress"
                  ? "Return to the lesson path without advancing. Bridge from the detour back to the current source chunk, teach the chunk, then invite reflection."
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
    const key = await this.secrets.getApiKey();
    if (!settings.selectedModel || !key.value) throw new Error("AI provider is not configured");

    const client = new OpenAICompatibleClient({ baseUrl: settings.ollamaBaseUrl, apiKey: key.value, model: settings.selectedModel });
    const chunks = this.contextualChunks(artifacts, module, payload.userText, focusChunk?.id);
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
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
The structured JSON call failed, so this is a repair call. Return plain tutor text only.
Answer the learner's actual latest turn. Do not grade, do not say to stick closer to the source, and do not repeat a canned fallback.
Use the source chunks as primary context, but use your own knowledge when it helps. Be concise and scannable, not discursive: prefer short bullet-style lines over long prose, and keep it to a few short sentences. The goal is to understand without reading a wall of text.
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
      choices: this.defaultChoices(module, ready, isDigression),
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
    const intent = coerceIntent(output.stateUpdate?.userIntent) || heuristicIntent;
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
    const modelRefs = Array.isArray(output.sourceRefs) ? output.sourceRefs.filter((id) => contextualIds.has(id)) : [];
    const mergedRefs = uniqueStrings([...blockRefs, ...modelRefs]);
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
      choices: this.sanitizeChoices(output.choices, module, ready, isDigression),
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

    const assembled = [...requiredStartBlocks, ...fallbackBlocks]
      .filter((block) => (isOpening ? block.type !== "source_quote" : true))
      .map((block) => this.scrubBlock(block))
      .filter((block) => (block.type === "source_quote" ? allowedRefs.has(block.sourceRef) : true));
    // Final guard against a wall of text: break any long prose block into sentence-aligned,
    // scannable pieces. This is deterministic, so it holds even when the model ignores the
    // "be concise / use bullets" instruction or the turn was salvaged from prose.
    return this.splitWallOfText(assembled).slice(0, 10);
  }

  private moduleContentSummary(module: CourseModule, focusChunk: SourceChunk | undefined, lecturePlan: LectureModulePlan | undefined) {
    const basis = lecturePlan?.guidedReading.plainParaphrase || focusChunk?.text || module.learningGoal || module.title;
    const summary = trimSentence(basis.replace(/\s+/g, " "), 230);
    return summary.startsWith("핵심은") ? summary : `핵심은 ${summary}`;
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
    if (type === "hook") return { type, body: String(raw.body || "").slice(0, 280) };
    if (type === "guided_reading") {
      const sourceRef = typeof raw.sourceRef === "string" && allowedRefs.has(raw.sourceRef) ? raw.sourceRef : undefined;
      return { type, body: String(raw.body || "").slice(0, 4000), sourceRef };
    }
    if (type === "paragraph") return { type, body: String(raw.body || "").slice(0, 4000) };
    if (type === "bullets") {
      const items = Array.isArray(raw.items) ? raw.items.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [];
      return items.length ? { type, title: raw.title ? String(raw.title).slice(0, 90) : undefined, items } : null;
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
      return columns.length >= 2 && rows.length ? { type, title: raw.title ? String(raw.title).slice(0, 90) : undefined, columns, rows } : null;
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
    if (type === "reflection") return { type, body: String(raw.body || "").slice(0, 360) };
    if (type === "misconception") {
      return {
        type,
        title: raw.title ? String(raw.title).slice(0, 90) : undefined,
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
    const nextPhase = ready ? "complete" : isDigression ? "explain" : state?.nextPhase || (event === "start_module" || event === "next_chunk" ? "discuss" : "clarify");
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

  private sanitizeChoices(choices: unknown, module: CourseModule, passed: boolean, isDigression = false) {
    const cleaned = Array.isArray(choices)
      ? uniqueStrings(
          choices
            .map((choice) => normalizeChoiceText(String(choice).trim()))
            .filter((choice) => choice.length > 0 && choice.length <= 140 && !PROGRESSION_CHOICES.has(choice))
        ).slice(0, 3)
      : [];
    const defaults = this.defaultChoices(module, passed, isDigression).filter((choice) => !PROGRESSION_CHOICES.has(choice));
    return uniqueStrings([...cleaned, ...defaults]).slice(0, 3);
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
    };
  }

  private courseManagerHint(module: CourseModule, payload: TurnPayload, intent: TutorIntent) {
    if (payload.event === "start_module") {
      return "This is the first source chunk of a module. Open with intrigue (hook), teach this chunk with a guided_reading, and end with a reflective invitation.";
    }
    if (payload.event === "next_chunk") {
      return "Continue to the next source chunk. Bridge in one line from the previous chunk, teach THIS chunk with a guided_reading, and end with a reflective invitation. Do not repeat a hook and do not jump ahead.";
    }
    if (payload.event === "return_to_progress") {
      return "Return from the learner's detour to the current source chunk. Do not advance. Bridge briefly, then teach THIS chunk as the active lesson anchor.";
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
