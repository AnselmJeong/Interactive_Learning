import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatParams } from "./openai-compatible-client";
import type { MaterialArtifacts } from "../shared/artifact-types";
import { closeDbForTests, getDb } from "./project-db";
import { getMaterialAnnotation, saveMaterialAnnotation } from "./annotation-store";
import { AnnotationService } from "./annotation-service";
import { questionThreadFromResult } from "../shared/question-thread";

describe("annotation image search routing", () => {
  test("prefers configured broad image search results over Wikipedia lookup", async () => {
    const service = new AnnotationService(
      {} as never,
      async () => { throw new Error("AI provider should not be used"); },
      undefined,
      async () => [{
        title: "Natural selection diagram",
        thumbnailUrl: "data:image/png;base64,AQID",
        imageUrl: "https://example.edu/evolution.png",
        pageUrl: "https://example.edu/evolution",
        sourceTitle: "example.edu",
        provider: "brave",
        width: 1200,
        height: 800,
      }]
    );

    const result = await service.findImages({ materialId: "material-1", chunkId: "chunk-1", selectedText: "natural selection" });

    expect(result.provider).toBe("brave");
    expect(result.images[0]?.sourceTitle).toBe("example.edu");
    expect(result.sourceMeta[0]).toMatchObject({ provider: "Brave · example.edu", url: "https://example.edu/evolution" });
  });
});

function artifacts(): MaterialArtifacts {
  return {
    manifest: {
      id: "material-1",
      projectId: "project-1",
      title: "Material",
      sourceIds: ["source-1"],
      sourceChunkIds: ["chunk-1"],
      generatedAt: "2026-07-10T00:00:00.000Z",
      generatorModel: "test-model",
      status: "ready",
    },
    overview: {
      paragraph: "Material overview",
      sourceChunkIds: ["chunk-1"],
      generatedAt: "2026-07-10T00:00:00.000Z",
      generatorVersion: "test",
    },
    conceptMap: [],
    coursePlan: {
      id: "course-1",
      title: "Course",
      subtitle: "",
      audience: "learner",
      estimatedTimeMinutes: 10,
      modules: [{
        id: "module-1",
        title: "Module",
        learningGoal: "Explain the selected claim",
        conceptIds: [],
        sourceChunkIds: ["chunk-1"],
        visualIds: [],
        hookIntent: "",
        checkpointRubric: "",
        masterySignals: [],
        misconceptionSignals: [],
        remediationStrategy: "",
      }],
    },
    visuals: [],
    sourceChunks: [{
      id: "chunk-1",
      headingPath: ["Heading"],
      locator: "p. 1",
      kind: "body",
      text: "The selected claim connects the premise to the conclusion.",
      confidence: 1,
    }],
    sourceIndex: { "chunk-1": { sourceId: "source-1", title: "Source", locator: "p. 1" } },
    figures: [],
    figureIndex: {},
    annotations: [],
  } as MaterialArtifacts;
}

describe("annotation side-chat service", () => {
  let tempRoot = "";
  let calls: ChatParams[] = [];
  let answers: string[] = [];
  let service: AnnotationService;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-side-chat-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
    const now = Date.now();
    getDb().query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, ?)").run(tempRoot, now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)").run(now, now);

    calls = [];
    answers = ["첫 답변", "두 번째 답변"];
    const client = {
      listModels: async () => [],
      chatJson: async () => ({}),
      chatText: async (params: ChatParams) => {
        calls.push(params);
        return answers.shift() || "답변";
      },
    };
    service = new AnnotationService(
      { getArtifacts: async () => artifacts() } as never,
      async () => ({
        publicSettings: { aiProvider: "openai", providers: { openai: { selectedModel: "test-model" } } },
        apiKey: { value: "test-key", source: "test" },
        client,
      }) as never
    );
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  test("passes the first answer into the second turn history", async () => {
    const first = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "첫 질문",
    });
    const second = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "그렇다면 다음은?",
      draftThread: first.thread,
    });

    expect(second.thread.messages.map((message) => message.content)).toEqual(["첫 질문", "첫 답변", "그렇다면 다음은?", "두 번째 답변"]);
    expect(calls[1]?.messages.slice(-3).map((message) => [message.role, message.content])).toEqual([
      ["user", "첫 질문"],
      ["assistant", "첫 답변"],
      ["user", "그렇다면 다음은?"],
    ]);
  });

  test("saves a chat note with its text anchor and snapshot payload", async () => {
    const textAnchor = {
      version: 1 as const,
      surface: "chat" as const,
      scope: "chat-message" as const,
      chunkId: "chunk-1",
      messageId: "message-1",
      blockId: null,
      selectedText: "selected claim",
      normalizedText: "selected claim",
      occurrence: 0,
      startOffset: 4,
      endOffset: 18,
      prefix: "The ",
      suffix: " connects",
      scopeTextLength: 60,
    };

    const saved = await service.save({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "chat",
      anchorMessageId: "message-1",
      anchorBlockId: null,
      textAnchor,
      kind: "note",
      selectedText: "selected claim",
      result: { kind: "note", note: "이 전제가 결론으로 이어지는 이유를 다시 보기" },
      sourceMeta: [],
    });

    expect(saved).toMatchObject({
      kind: "note",
      surface: "chat",
      anchorMessageId: "message-1",
      textAnchor,
      result: { kind: "note", note: "이 전제가 결론으로 이어지는 이유를 다시 보기" },
    });
    const snapshotPath = join(tempRoot, "project-1", "materials", "material-1", "annotations.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(snapshot[0]).toMatchObject({ id: saved.id, kind: "note", textAnchor, result: saved.result });
  });

  test("grounds an opted-in side-chat turn with Ollama web sources and preserves them on the answer", async () => {
    const searchQueries: string[] = [];
    const webCalls: ChatParams[] = [];
    const client = {
      listModels: async () => [],
      chatJson: async () => ({}),
      chatText: async (params: ChatParams) => {
        webCalls.push(params);
        if (params.maxTokens === 64) return "premise conclusion current evidence";
        if (params.messages.some((message) => message.content.includes("citation repair"))) {
          return "검색 근거에서 확인한 새로운 설명입니다. [S1]";
        }
        return "본문만 반복하고 검색 근거를 쓰지 않은 초안입니다.";
      },
    };
    service = new AnnotationService(
      { getArtifacts: async () => artifacts() } as never,
      async () => ({
        publicSettings: { aiProvider: "openai", providers: { openai: { selectedModel: "test-model" } } },
        apiKey: { value: "test-key", source: "test" },
        client,
      }) as never,
      async (query) => {
        searchQueries.push(query);
        return [{
          id: "S1",
          title: "Research source",
          url: "https://example.com/research",
          provider: "Web search",
          retrievedAt: "2026-07-10T00:00:00.000Z",
          snippet: "Evidence about the selected claim connecting a premise to a conclusion.",
        }];
      }
    );

    const response = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "최신 연구 근거도 알려줘",
      useWebSearch: true,
    });

    expect(searchQueries).toEqual(['"selected claim" premise conclusion current evidence']);
    expect(webCalls[0]?.messages[1]?.content).toContain("Selected text: selected claim");
    expect(webCalls[1]?.messages.some((message) => message.content.includes("[S1] Research source"))).toBe(true);
    expect(webCalls[1]?.messages[0]?.content).toContain("primary factual basis");
    expect(webCalls[1]?.messages[0]?.content).not.toContain("The selected claim connects the premise to the conclusion.");
    expect(webCalls).toHaveLength(3);
    expect(response.thread.messages[1]?.content).toContain("[S1]");
    expect(response.thread.messages[1]?.content).not.toContain("본문만 반복");
    expect(response.thread.messages[1]?.sources?.[0]).toMatchObject({ id: "S1", url: "https://example.com/research" });
    expect(response.thread.sourceMeta.some((source) => source.url === "https://example.com/research")).toBe(true);
  });

  test("retries an irrelevant module-biased search with the exact selected concept", async () => {
    const searchQueries: string[] = [];
    const webCalls: ChatParams[] = [];
    let queryRewriteCount = 0;
    const client = {
      listModels: async () => [],
      chatJson: async () => ({}),
      chatText: async (params: ChatParams) => {
        webCalls.push(params);
        if (params.maxTokens === 64) {
          queryRewriteCount += 1;
          return queryRewriteCount === 1
            ? "Roman Stoicism comprehensive overview history principles"
            : "imago Dei Christian theology meaning history significance";
        }
        return "imago Dei는 기독교 신학의 인간 이해와 연결되는 개념입니다. [S1]";
      },
    };
    service = new AnnotationService(
      { getArtifacts: async () => ({
        ...artifacts(),
        coursePlan: {
          ...artifacts().coursePlan,
          modules: [{ ...artifacts().coursePlan.modules[0]!, title: "Roman Stoicism" }],
        },
        sourceIndex: { "chunk-1": { sourceId: "source-1", title: "Roman Stoicism", locator: "p. 1" } },
      }) } as never,
      async () => ({
        publicSettings: { aiProvider: "openai", providers: { openai: { selectedModel: "test-model" } } },
        apiKey: { value: "test-key", source: "test" },
        client,
      }) as never,
      async (query) => {
        searchQueries.push(query);
        if (searchQueries.length === 1) {
          return [{ id: "S1", title: "Roman Stoicism", url: "https://example.com/stoicism", snippet: "Stoic ethics and Roman philosophy." }];
        }
        return [{ id: "S1", title: "Imago Dei", url: "https://example.com/imago-dei", snippet: "Imago Dei in Christian theological anthropology." }];
      }
    );

    const response = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "imago Dei",
      userText: "포괄적으로 설명해줘",
      useWebSearch: true,
    });

    expect(webCalls[0]?.messages[1]?.content).toContain("Selected text: imago Dei");
    expect(webCalls[0]?.messages[1]?.content).toContain("Learner question: 포괄적으로 설명해줘");
    expect(searchQueries).toEqual([
      '"imago Dei" Roman Stoicism comprehensive overview history principles',
      "imago Dei Christian theology meaning history significance",
    ]);
    expect(response.thread.messages[1]?.content).toContain("[S1]");
    expect(response.thread.messages[1]?.sources?.[0]?.url).toBe("https://example.com/imago-dei");
  });

  test("fails closed when a searched answer still omits every valid source citation after repair", async () => {
    const client = {
      listModels: async () => [],
      chatJson: async () => ({}),
      chatText: async (params: ChatParams) => params.maxTokens === 64 ? "relevant evidence" : "인용 없는 답변",
    };
    service = new AnnotationService(
      { getArtifacts: async () => artifacts() } as never,
      async () => ({
        publicSettings: { aiProvider: "openai", providers: { openai: { selectedModel: "test-model" } } },
        apiKey: { value: "test-key", source: "test" },
        client,
      }) as never,
      async () => [{ id: "S1", title: "Source", url: "https://example.com", snippet: "Relevant evidence about the selected claim" }]
    );

    await expect(service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "외부 근거도 알려줘",
      useWebSearch: true,
    })).rejects.toThrow("답변에 인용하지 못했습니다");
  });

  test("keeps a continued legacy thread as a draft until explicitly saved", async () => {
    const legacy = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "chat",
      kind: "question",
      selectedText: "selected claim",
      result: {
        kind: "question",
        title: "첫 질문",
        question: "첫 질문",
        body: "기존 답변",
        query: "selected claim",
        provider: "ai",
        model: "old-model",
        retrievedAt: "2026-07-09T00:00:00.000Z",
        sourceMeta: [],
      },
      sourceMeta: [],
    });
    if (legacy.result.kind !== "question") throw new Error("Expected a legacy question annotation");

    const response = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "후속 질문",
      draftThread: questionThreadFromResult(legacy.result, legacy.createdAt),
    });

    expect(response.thread.messages.map((message) => message.content)).toEqual(["첫 질문", "기존 답변", "후속 질문", "첫 답변"]);
    expect(getMaterialAnnotation(legacy.id)?.result.kind).toBe("question");

    const saved = await service.updateQuestionThread({ annotationId: legacy.id, thread: response.thread });
    expect(saved.id).toBe(legacy.id);
    expect(saved.result.kind).toBe("question_thread");
    const snapshotPath = join(tempRoot, "project-1", "materials", "material-1", "annotations.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(snapshot[0]?.id).toBe(legacy.id);
    expect(snapshot[0]?.result?.kind).toBe("question_thread");
  });

  test("rejects explicit thread updates for non-question annotations", async () => {
    const saved = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      kind: "highlight",
      selectedText: "selected claim",
      result: { kind: "highlight", style: "yellow" },
      sourceMeta: [],
    });

    const draft = await service.askTurn({
      materialId: "material-1",
      chunkId: "chunk-1",
      selectedText: "selected claim",
      userText: "질문",
    });

    await expect(service.updateQuestionThread({ annotationId: saved.id, thread: draft.thread }))
      .rejects.toThrow("Only question annotations");
  });
});
