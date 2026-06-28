import { getDb } from "./project-db";
import { CourseArtifactService } from "./course-artifact-service";
import { SettingsService } from "./settings-service";
import { AiProviderSettingsService } from "./ai-provider-settings";
import { OpenAICompatibleClient } from "./openai-compatible-client";
import type { CourseModule, LectureModulePlan, MaterialArtifacts, PresentationModulePlan, SourceChunk, VisualSpec } from "../shared/artifact-types";
import type { SessionSnapshot, SourceRef, TutorContentBlock, TutorContext, TutorIntent, TutorMessage, TutorStateUpdate, TutorTurnOutput } from "../shared/tutor-types";

type TurnPayload = { event: "start_module" | "user_message"; userText?: string };

const VALID_INTENTS: TutorIntent[] = ["start", "answer", "question", "off_topic", "deeper", "meta_complaint", "satisfied"];
const DIGRESSION_INTENTS = new Set<TutorIntent>(["question", "off_topic", "deeper", "meta_complaint"]);

// A lightweight Korean-aware heuristic. It is only a hint and a fallback; when the model
// returns its own userIntent we trust that instead. The point is that a substantive
// question must never be mistaken for "ready to advance".
function classifyIntent(userText: string, event: "start_module" | "user_message"): TutorIntent {
  if (event === "start_module") return "start";
  const t = (userText || "").trim();
  if (!t) return "answer";
  const has = (...needles: string[]) => needles.some((needle) => t.includes(needle));
  if (has("대답을 안", "대답 안", "답을 안", "답 안 ", "무시", "동문서답", "딴소리", "회피", "왜 안", "엉뚱")) return "meta_complaint";
  if (has("다음 대목", "넘어가", "이어서 들", "이어 갈", "계속 진행", "이제 알겠", "이해됐", "이해했", "알겠어", "알겠습니다", "충분히 알", "됐어요", "다음으로")) return "satisfied";
  if (has("더 풀어", "더 자세", "예시", "예를", "구체적", "쉽게 바꿔", "쉽게 설명", "더 알고", "더 설명", "자세히")) return "deeper";
  if (t.endsWith("?") || t.endsWith("까요") || t.endsWith("나요") || t.endsWith("인가요") || t.endsWith("건가요") || has("있을까", "있나요", "어떻게", "무엇", "뭔가요", "왜 ", "궁금", "무슨", "어떤")) return "question";
  return "answer";
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

export class TutorService {
  private readonly artifacts = new CourseArtifactService();
  private readonly settings = new SettingsService();
  private readonly secrets = new AiProviderSettingsService();

  listSessions(materialId: string) {
    return getDb()
      .query<SessionRow, [string]>("SELECT * FROM learning_sessions WHERE material_id = ? ORDER BY updated_at DESC")
      .all(materialId)
      .map((row) => this.snapshot(row.id));
  }

  async start(materialId: string, input: { mode: "new" | "continue"; sessionId?: string }) {
    if (input.mode === "continue") {
      const target = input.sessionId || this.latestSessionId(materialId);
      if (target) return { session: this.snapshot(target), context: await this.context(target) };
    }

    const material = this.artifacts.getRow(materialId);
    const artifacts = await this.artifacts.getArtifacts(materialId);
    const firstModule = artifacts.coursePlan.modules[0];
    if (!firstModule) throw new Error("Course plan has no modules");

    const settings = await this.settings.get();
    const id = crypto.randomUUID();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, '[]', ?, ?, ?)`
      )
      .run(id, material.project_id, materialId, material.title, firstModule.id, settings.selectedModel, now, now);

    const firstTurn = await this.createTutorTurn(id, { event: "start_module" });
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
    const output = await this.createTutorTurn(sessionId, { event: "user_message", userText: text });
    return { session: this.snapshot(sessionId), context: await this.context(sessionId), output };
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
      model: row.model || "",
      messages,
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
    const chunks = this.moduleChunks(artifacts, currentModule);
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

  private async createTutorTurn(sessionId: string, payload: TurnPayload) {
    const session = this.snapshot(sessionId);
    const artifacts = await this.artifacts.getArtifacts(session.materialId);
    const currentModule = this.currentModule(artifacts, session.currentModuleId);

    // The AI turn is the real product. Retry a couple of times (the second attempt asks
    // harder for clean JSON) before falling back, and never swallow the error silently —
    // a silent fallback is exactly what produced the repeated canned-template loop.
    let output: Partial<TutorTurnOutput> | null = null;
    for (let attempt = 0; attempt < 2 && !output; attempt += 1) {
      try {
        output = await this.aiTutorOutput(artifacts, currentModule, session, payload, attempt);
      } catch (error) {
        console.error(`[tutor] AI turn failed (attempt ${attempt + 1}/2) for module ${currentModule.id}:`, error);
      }
    }
    if (!output) {
      console.warn(`[tutor] Falling back to deterministic turn for module ${currentModule.id}; AI was unavailable.`);
      output = this.fallbackTutorOutput(artifacts, currentModule, session, payload);
    }
    const sanitized = this.sanitizeOutput(artifacts, currentModule, session, payload, output);
    this.applyState(sessionId, artifacts, currentModule, sanitized);
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

  private async aiTutorOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    session: SessionSnapshot,
    payload: TurnPayload,
    attempt = 0
  ) {
    const settings = await this.settings.get();
    const key = await this.secrets.getApiKey();
    if (!settings.selectedModel || !key.value) throw new Error("AI provider is not configured");
    const client = new OpenAICompatibleClient({ baseUrl: settings.ollamaBaseUrl, apiKey: key.value, model: settings.selectedModel });
    const chunks = this.moduleChunks(artifacts, module);
    const concepts = artifacts.conceptMap.filter((concept) => module.conceptIds.includes(concept.id));
    const intent = classifyIntent(payload.userText || "", payload.event);
    const instruction = this.courseManagerHint(module, payload, intent);
    const lecturePlan = this.lectureModule(artifacts, module);
    const presentationPlan = this.presentationModule(artifacts, module);
    const visualIds = artifacts.visuals.map((visual) => visual.id);
    const strictJson = attempt > 0 ? "\nThe previous attempt returned malformed JSON. Return a SINGLE valid JSON object and nothing else — no markdown fences, no prose." : "";
    const result = await client.chatJson({
      temperature: attempt > 0 ? 0.4 : 0.7,
      messages: [
        {
          role: "system",
          content: `You are a guided lecturer who teaches a source the learner has not read. Reply only as JSON. Tutor language: ${settings.tutorLanguage}.
Invariant: assume the learner has not read the source. Teach it well enough that they feel a good teacher read it with them.

ANSWER THE LEARNER. This is the most important rule. When the learner asks a question, raises a tangent, or says you are dodging, you MUST answer their actual question this turn. Never deflect with "let's move on", "that is a good starting point", or a transition to the next topic instead of answering. Dodging a direct question is a failure.

Use your own knowledge. The source chunks are your primary evidence, but you are a knowledgeable teacher, not a search box. When the learner asks something the source does not fully cover (e.g. "is there a philosopher who thought X?"), answer it from your broader knowledge, and make clear which parts come from the source versus general background. Do not refuse and do not redirect to the source.

Detours are allowed and good. If the learner takes the conversation sideways, follow them, answer well, and only afterwards gently offer to return to the main thread (e.g. a choice like "원래 흐름으로 돌아갈게요"). Do not force the lesson forward while a question is open. Only move to the next step when the learner signals they are satisfied or explicitly asks to continue.

Never grade. Do not test recall before teaching. Never use "stick closer to the source", "try again", or "that is not in the source" as a primary response. If the learner is wrong, treat it as a useful intuition and teach the missing structure. Questions are for reflection, not grading.
Do not expose internal words such as module, checkpoint, rubric, learning objective, lecture plan, teaching move, source spark, visual note, or teaching guide.

Detected learner intent for this turn: ${intent}. Handle it as follows:
- question / off_topic: answer it directly and substantively first (turnMode "digress", readyToContinue false). Then offer to return.
- deeper: give the requested detail, example, or simpler restatement (turnMode "digress", readyToContinue false). Do NOT advance.
- meta_complaint: the learner feels ignored. Apologize briefly, then directly answer the question they actually asked in their recent messages (turnMode "digress", readyToContinue false).
- satisfied: they want to move on. Synthesize briefly and bridge forward (turnMode "synthesize", readyToContinue true).
- answer / start: teach in place (turnMode "teach"). Advance only if they clearly understand AND want to continue.

Return 2-4 content blocks. Do not return paragraph-only output unless the learner asked a narrow factual question.
For a new module, start with hook + guided_reading before any reflective question. Do not open by showing a raw source sentence unless the learner explicitly asks for the exact wording.
Always provide 2-3 choices that work as complete learner replies or exploration paths, phrased as learner continuations, not exam answers or UI commands. When you are in a digression, include one choice that returns to the main thread.
Current course: ${artifacts.coursePlan.title}
Current topic title: ${module.title}
Internal objective: ${module.learningGoal}
Teaching hint: ${instruction}
Lecture plan: ${JSON.stringify(lecturePlan)}
Presentation plan: ${JSON.stringify(presentationPlan)}
Concepts: ${concepts.map((concept) => `${concept.name}: ${concept.definition}`).join("\n")}
Source chunks: ${chunks.map((chunk) => `[${chunk.id}] ${chunk.text}`).join("\n\n")}
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
Output schema: {"message":"plain text fallback summary","blocks":[/* 2-4 blocks */],"diagram":"visual id or null","visualPlacement":"inline|side_panel|null","choices":["2-3 concrete learner continuations"],"progress":0,"moduleId":"${module.id}","sourceRefs":["allowed chunk id"],"stateUpdate":{"nextPhase":"orient|discuss|explain|clarify|synthesize|complete","readyToContinue":false,"nextSuggestedStep":"continue|stay|review","userIntent":"${intent}","turnMode":"teach|digress|synthesize","detectedConfusion":null,"criticWarning":null}}${strictJson}`,
        },
        ...clampHistory(session.messages),
        {
          role: "user",
          content:
            payload.event === "start_module"
              ? "Start this learning step as a guided lecture. Teach first, then invite reflection."
              : `Learner just said: ${payload.userText}\nIntent looks like: ${intent}. Respond to what they actually said. If it is a question or complaint, answer it this turn; do not move on. Use their words as material, not as an exam submission.`,
        },
      ],
    });
    if (!result || typeof result !== "object") throw new Error("Model returned a non-object turn");
    return result as Partial<TutorTurnOutput>;
  }

  private fallbackTutorOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    session: SessionSnapshot,
    payload: TurnPayload
  ): Partial<TutorTurnOutput> {
    const chunks = this.moduleChunks(artifacts, module);
    const firstChunk = chunks[0];
    const lecturePlan = this.lectureModule(artifacts, module);
    const intent = classifyIntent(payload.userText || "", payload.event);
    const isDigression = DIGRESSION_INTENTS.has(intent);
    // The deterministic fallback has no model, so it can never genuinely answer a question.
    // It must NOT pretend to, and must NOT advance the lesson out from under an open question.
    // Advancing is reserved for an explicit "I'm satisfied" signal.
    const ready = payload.event === "user_message" && intent === "satisfied";
    const completedCount = session.completedModuleIds.length + (ready ? 1 : 0);
    const progress = Math.round((completedCount / artifacts.coursePlan.modules.length) * 100);
    const paraphrase = lecturePlan?.guidedReading.plainParaphrase || trimSentence(firstChunk?.text || module.learningGoal);

    let blocks: TutorContentBlock[];
    if (payload.event === "start_module") {
      blocks = [
        { type: "hook", body: lecturePlan?.intrigue.surpriseLine || `${module.title}은 익숙한 말처럼 보이지만, 실제로는 한 가지 긴장을 열어 줍니다.` },
        {
          type: "guided_reading",
          sourceRef: firstChunk?.id,
          body:
            lecturePlan?.guidedReading.plainParaphrase ||
            `이 대목은 원문을 다 읽은 사람에게 확인 질문을 던지는 부분이 아닙니다. 먼저 ${trimSentence(firstChunk?.text || module.learningGoal)} 라는 흐름을 잡고, 왜 이 말이 다음 설명의 발판이 되는지 보겠습니다.`,
        },
        { type: "reflection", body: "이 설명에서 가장 낯설거나 더 알고 싶은 지점은 어디인가요?" },
      ];
    } else if (ready) {
      blocks = [
        { type: "paragraph", body: "좋아요, 방향이 잡혔다면 다음으로 이어 가 보겠습니다." },
        {
          type: "bullets",
          title: "지금 붙잡을 핵심",
          items: [paraphrase, lecturePlan?.intrigue.stakes || "이 구조를 잡으면 다음 대목이 왜 이어지는지 보입니다."],
        },
        { type: "bridge", body: "이제 이 관점을 가지고 다음 대목으로 이어 가겠습니다." },
      ];
    } else if (isDigression) {
      // Honest holding response: acknowledge the question, give what the source can offer,
      // and invite them to continue — without faking an answer or moving on.
      blocks = [
        {
          type: "paragraph",
          body:
            intent === "meta_complaint"
              ? "방금 질문을 제대로 받지 못했네요. 지금 자료로 짚을 수 있는 부분부터 다시 잡아 보겠습니다."
              : "좋은 질문이에요. 지금 이 대목의 원문이 짚어 주는 부분부터 연결해 보겠습니다.",
        },
        { type: "guided_reading", sourceRef: firstChunk?.id, body: paraphrase },
        { type: "reflection", body: "이 부분에서 특히 어떤 점이 더 궁금한지 한 가지만 짚어 주시겠어요?" },
      ];
    } else {
      blocks = [
        {
          type: "misconception",
          title: "헷갈릴 수 있는 출발점",
          body: "처음 읽지 않은 상태라면 일반 상식으로 먼저 해석하는 것이 자연스럽습니다.",
          repair: "먼저 이 대목이 여는 질문을 쉬운 말로 잡고, 그다음 문장들 사이의 관계를 나눠 보겠습니다.",
        },
        { type: "guided_reading", sourceRef: firstChunk?.id, body: paraphrase },
        { type: "reflection", body: "이 설명을 기준으로 보면, 처음 생각과 달라지는 지점은 무엇인가요?" },
      ];
    }

    const message = blocksToPlainText(blocks);
    return {
      message,
      blocks,
      diagram: null,
      visualPlacement: null,
      choices: this.defaultChoices(module, ready, isDigression),
      progress,
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
      },
    };
  }

  private sanitizeOutput(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    session: SessionSnapshot,
    payload: { event: "start_module" | "user_message"; userText?: string },
    output: Partial<TutorTurnOutput>
  ): TutorTurnOutput {
    const allowedRefs = new Set(module.sourceChunkIds);
    const allowedVisuals = new Set(artifacts.visuals.map((visual) => visual.id));
    const sourceRefs = Array.isArray(output.sourceRefs) ? output.sourceRefs.filter((id) => allowedRefs.has(id)) : [];

    // Advancement is decided by intent and the model's explicit decision — NOT by how long the
    // user typed or whether stray keywords matched. A question, a request for detail, or a
    // complaint must never push the lesson forward; only an explicit "satisfied"/continue does.
    const heuristicIntent = classifyIntent(payload.userText || "", payload.event);
    const intent = coerceIntent(output.stateUpdate?.userIntent) || heuristicIntent;
    // Either signal can flag a digression; that veto is intentional. We would rather stay on a
    // point one extra turn than skip ahead while the learner still has an open question.
    const isDigression = DIGRESSION_INTENTS.has(intent) || DIGRESSION_INTENTS.has(heuristicIntent);
    const userWantsAdvance = intent === "satisfied" && heuristicIntent !== "question";
    const modelWantsAdvance = output.stateUpdate?.readyToContinue === true && output.stateUpdate?.nextSuggestedStep === "continue";
    const ready = payload.event === "user_message" && !isDigression && (userWantsAdvance || modelWantsAdvance);
    // Keep the recorded intent consistent with the digression veto above.
    const effectiveIntent: TutorIntent = !DIGRESSION_INTENTS.has(intent) && DIGRESSION_INTENTS.has(heuristicIntent) ? heuristicIntent : intent;
    const completedCount = session.completedModuleIds.length + (ready ? 1 : 0);
    const baseProgress = Math.round((completedCount / artifacts.coursePlan.modules.length) * 100);
    const blocks = this.sanitizeBlocks(artifacts, module, payload, output.blocks, output.message);
    const message = blocks.length ? blocksToPlainText(blocks) : this.scrubExamLanguage(String(output.message || "이 대목을 먼저 설명해 보겠습니다."));
    const criticWarning = this.examLanguageWarning(String(output.message || "") + "\n" + blocksToPlainText(blocks));
    const stateUpdate = this.sanitizeState(output.stateUpdate, ready, effectiveIntent, criticWarning, payload.event);

    return {
      message,
      blocks,
      diagram: output.diagram && allowedVisuals.has(output.diagram) ? output.diagram : null,
      visualPlacement: output.visualPlacement === "inline" || output.visualPlacement === "side_panel" ? output.visualPlacement : null,
      choices: this.sanitizeChoices(output.choices, module, ready, isDigression),
      progress: Math.max(baseProgress, Math.min(100, Math.round(Number(output.progress) || baseProgress))),
      moduleId: module.id,
      sourceRefs: sourceRefs.length ? sourceRefs : module.sourceChunkIds.slice(0, 1),
      stateUpdate,
    };
  }

  private sanitizeBlocks(
    artifacts: MaterialArtifacts,
    module: CourseModule,
    payload: { event: "start_module" | "user_message"; userText?: string },
    blocks: unknown,
    fallbackMessage?: unknown
  ): TutorContentBlock[] {
    const allowedRefs = new Set(module.sourceChunkIds);
    const chunks = this.moduleChunks(artifacts, module);
    const firstChunk = chunks[0];
    const lecturePlan = this.lectureModule(artifacts, module);
    const cleaned = Array.isArray(blocks)
      ? blocks
          .map((block) => this.sanitizeBlock(block, allowedRefs, payload.event === "user_message"))
          .filter((block): block is TutorContentBlock => Boolean(block))
          .slice(0, 5)
      : [];

    const hasHook = cleaned.some((block) => block.type === "hook");
    const hasGuidedReading = cleaned.some((block) => block.type === "guided_reading");
    const requiredStartBlocks: TutorContentBlock[] = [];
    if (payload.event === "start_module" && !hasHook) {
      requiredStartBlocks.push({
        type: "hook",
        body: lecturePlan?.intrigue.surpriseLine || `${module.title}은 먼저 궁금증을 만들고 나서 읽어야 하는 대목입니다.`,
      });
    }
    if (payload.event === "start_module" && !hasGuidedReading) {
      requiredStartBlocks.push({
        type: "guided_reading",
        sourceRef: firstChunk?.id,
        body: lecturePlan?.guidedReading.plainParaphrase || trimSentence(firstChunk?.text || String(fallbackMessage || module.learningGoal)),
      });
    }

    const fallbackBlocks: TutorContentBlock[] = cleaned.length
      ? cleaned
      : [{ type: "paragraph", body: this.scrubExamLanguage(String(fallbackMessage || "이 대목을 먼저 짧게 풀어 보겠습니다.")) }];

    return [...requiredStartBlocks, ...fallbackBlocks]
      .filter((block) => (payload.event === "start_module" ? block.type !== "source_quote" : true))
      .map((block) => this.scrubBlock(block))
      .filter((block) => (block.type === "source_quote" ? allowedRefs.has(block.sourceRef) : true))
      .slice(0, 5);
  }

  private sanitizeBlock(block: unknown, allowedRefs: Set<string>, showSourceQuote: boolean): TutorContentBlock | null {
    if (!block || typeof block !== "object" || !("type" in block)) return null;
    const raw = block as Record<string, unknown>;
    const type = String(raw.type);
    if (type === "hook") return { type, body: String(raw.body || "").slice(0, 280) };
    if (type === "guided_reading") {
      const sourceRef = typeof raw.sourceRef === "string" && allowedRefs.has(raw.sourceRef) ? raw.sourceRef : undefined;
      return { type, body: String(raw.body || "").slice(0, 900), sourceRef };
    }
    if (type === "paragraph") return { type, body: String(raw.body || "").slice(0, 700) };
    if (type === "bullets") {
      const items = Array.isArray(raw.items) ? raw.items.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [];
      return items.length ? { type, title: raw.title ? String(raw.title).slice(0, 90) : undefined, items } : null;
    }
    if (type === "compare_table") {
      const columns = Array.isArray(raw.columns) ? raw.columns.map((item) => String(item).trim()).filter(Boolean).slice(0, 4) : [];
      const rows = Array.isArray(raw.rows)
        ? raw.rows
            .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
            .map((row) => Object.fromEntries(columns.map((column) => [column, String(row[column] || "").slice(0, 220)])))
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
    event: "start_module" | "user_message"
  ): TutorStateUpdate {
    const isDigression = DIGRESSION_INTENTS.has(intent);
    const nextPhase = ready ? "complete" : isDigression ? "explain" : state?.nextPhase || (event === "start_module" ? "discuss" : "clarify");
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

  private applyState(sessionId: string, artifacts: MaterialArtifacts, module: CourseModule, output: TutorTurnOutput) {
    const session = this.snapshot(sessionId);
    const completed = new Set(session.completedModuleIds);
    let nextModuleId = module.id;
    if (output.stateUpdate.nextSuggestedStep === "continue" || output.stateUpdate.readyToContinue || output.stateUpdate.advanceModule || output.stateUpdate.checkpointPassed) {
      completed.add(module.id);
      const index = artifacts.coursePlan.modules.findIndex((item) => item.id === module.id);
      nextModuleId = artifacts.coursePlan.modules[index + 1]?.id || module.id;
    }
    const status = completed.size >= artifacts.coursePlan.modules.length ? "completed" : "active";
    getDb()
      .query(
        `UPDATE learning_sessions
         SET current_module_id = ?, completed_module_ids_json = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextModuleId, JSON.stringify([...completed]), status, Date.now(), sessionId);
  }

  private currentModule(artifacts: MaterialArtifacts, moduleId: string | null): CourseModule {
    return artifacts.coursePlan.modules.find((module) => module.id === moduleId) || artifacts.coursePlan.modules[0]!;
  }

  private moduleChunks(artifacts: MaterialArtifacts, module: CourseModule): SourceChunk[] {
    const byId = new Map(artifacts.sourceChunks.map((chunk) => [chunk.id, chunk]));
    return module.sourceChunkIds.map((id) => byId.get(id)).filter((chunk): chunk is SourceChunk => Boolean(chunk));
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
      ? choices.map((choice) => String(choice).trim()).filter((choice) => choice.length > 0 && choice.length <= 140).slice(0, 3)
      : [];
    if (cleaned.length < 2) return this.defaultChoices(module, passed, isDigression);
    // In a digression, guarantee a way back to the main thread so the learner is never stranded.
    if (isDigression && !cleaned.some((choice) => choice.includes("원래") || choice.includes("돌아"))) {
      return [...cleaned.slice(0, 2), "이제 원래 흐름으로 돌아갈게요."];
    }
    return cleaned;
  }

  private defaultChoices(module: CourseModule, passed: boolean, isDigression = false) {
    if (passed) {
      return ["다음 대목으로 이어서 들어 볼게요.", "방금 내용을 한 문장으로 정리해 주세요.", "예시를 하나만 더 보고 넘어갈게요."];
    }
    if (isDigression) {
      return [
        "방금 그 부분을 조금 더 자세히 설명해 주세요.",
        "관련된 다른 예시도 하나 들어 주세요.",
        "이제 원래 흐름으로 돌아갈게요.",
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
      return "Open with intrigue, teach the source structure first, and end with a reflective invitation.";
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
