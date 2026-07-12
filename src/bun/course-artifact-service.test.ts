import { describe, expect, test } from "bun:test";
import { canReuseMaterialForGeneration, generateMaterialOverview, materialGenerationKey, normalizeFigureCaptionChunks } from "./course-artifact-service";
import type { SourceChunk } from "../shared/artifact-types";
import type { AiChatClient, ChatParams } from "./openai-compatible-client";

describe("material generation dedupe", () => {
  test("does not reuse interrupted generating material rows", () => {
    expect(canReuseMaterialForGeneration("ready")).toBe(true);
    expect(canReuseMaterialForGeneration("generating")).toBe(false);
    expect(canReuseMaterialForGeneration("failed")).toBe(false);
  });

  test("uses a stable key for the same project and source set", () => {
    expect(materialGenerationKey("project-a", ["source-b", "source-a", "source-a"])).toBe(
      materialGenerationKey("project-a", ["source-a", "source-b"])
    );
    expect(materialGenerationKey("project-b", ["source-a", "source-b"])).not.toBe(materialGenerationKey("project-a", ["source-a", "source-b"]));
  });
});

describe("figure caption curriculum normalization", () => {
  const chunk = (id: string, kind: SourceChunk["kind"], text: string): SourceChunk => ({
    id,
    headingPath: ["Section"],
    locator: "p. 1",
    kind,
    text,
    confidence: 1,
  });

  test("keeps the image caption and removes an immediately repeated plain caption", () => {
    const image = chunk("figure", "caption", "![Fig. 1. A caption](../assets/figure.png)");
    const repeated = chunk("caption", "body", "Fig. 1. A caption");
    const prose = chunk("prose", "body", "The argument continues here.");

    const result = normalizeFigureCaptionChunks([image, repeated, prose]);

    expect(result.chunks.map((item) => item.id)).toEqual(["figure", "prose"]);
    expect([...result.removedChunkIds]).toEqual(["caption"]);
  });

  test("does not remove a distinct caption or a non-adjacent matching paragraph", () => {
    const image = chunk("figure", "caption", "![Fig. 1. A caption](../assets/figure.png)");
    const prose = chunk("prose", "body", "The argument continues here.");
    const laterCaption = chunk("later", "body", "Fig. 1. A caption");

    const result = normalizeFigureCaptionChunks([image, prose, laterCaption]);

    expect(result.chunks.map((item) => item.id)).toEqual(["figure", "prose", "later"]);
    expect(result.removedChunkIds.size).toBe(0);
  });
});

describe("material overview", () => {
  test("uses a topic-only overview prompt for articles", async () => {
    let requestMessages: ChatParams["messages"] = [];
    const client = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async (params: ChatParams) => {
        requestMessages = params.messages;
        return {
          paragraph: "이 논문은 소셜 미디어에서 받는 반응이 게시 행동과 정신건강의 관계를 이해하는 데 어떤 역할을 하는지 다룬다. 연구진은 실제 이용 기록과 우울 관련 측정을 함께 살펴보며, 온라인 보상에 대한 행동적 반응을 현실 환경에서 분석하는 접근을 취한다. 이를 통해 소셜 미디어 사용과 정신건강을 연결하는 심리적 과정을 탐색한다.",
        };
      },
    } satisfies AiChatClient;
    const chunks: SourceChunk[] = [
      { id: "chunk-1", headingPath: ["Results"], locator: "p. 1", kind: "body", text: "The paper reports detailed numerical findings.", confidence: 1 },
    ];

    const overview = await generateMaterialOverview("Paper", chunks, { client, model: "test-model" }, "article");
    const systemPrompt = requestMessages.find((message) => message.role === "system")?.content || "";

    expect(systemPrompt).toContain("세부 결과");
    expect(systemPrompt).toContain("연구 주제");
    expect(overview.generatorVersion).toBe("article-overview-v1-topic-only");
  });

  test("sends every source chunk to the model and stores a Korean-only subject summary", async () => {
    const chunks: SourceChunk[] = [
      { id: "chunk-1", headingPath: ["Opening tension"], locator: "p. 1", kind: "body", text: "The source begins by challenging a familiar assumption. It then establishes the central problem.", confidence: 1 },
      { id: "chunk-2", headingPath: ["Consequences"], locator: "p. 2", kind: "body", text: "The later argument traces the consequences through a concrete case.", confidence: 1 },
    ];
    let requestMessages: ChatParams["messages"] = [];
    const client = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async (params: ChatParams) => {
        requestMessages = params.messages;
        return {
          paragraph: "이 글은 익숙한 가정에 의문을 제기하며 문제 해결이 어떤 전제와 선택을 통해 구체적인 결과로 이어지는지를 다룬다. 중심 논지는 문제를 정의하는 방식이 가능한 해법의 범위와 결과를 결정한다는 데 있으며, 추상적인 판단과 실제 사례 사이의 긴장을 함께 분석한다. 이를 통해 사고 과정과 선택의 결과가 서로 분리된 단계가 아니라 하나의 연속된 구조임을 보여준다.",
        };
      },
    } satisfies AiChatClient;
    const overview = await generateMaterialOverview("A difficult source", chunks, { client, model: "test-model" });
    const sourcePrompt = requestMessages.find((message) => message.role === "user")?.content || "";
    expect(sourcePrompt).toContain(chunks[0]!.text);
    expect(sourcePrompt).toContain(chunks[1]!.text);
    expect(overview.paragraph).not.toMatch(/[A-Za-z]/);
    expect(overview.sourceChunkIds).toEqual(["chunk-1", "chunk-2"]);
    expect(overview.generatorVersion).toBe("material-overview-v2-llm-full-source");
  });

  test("retries when the model includes English or generic learning copy", async () => {
    let calls = 0;
    const client = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async () => {
        calls += 1;
        return calls === 1
          ? { paragraph: "This source explains modules. 학습에서는 핵심 구조를 자기 말로 설명합니다." }
          : {
              paragraph: "이 글은 인간이 문제를 발견하고 해법을 선택하는 과정에서 어떤 논리적 전제가 작동하는지를 분석한다. 문제의 표현 방식과 선택 가능한 행동의 범위가 서로 영향을 주고받으며, 합리적 판단처럼 보이는 과정에도 역사적 조건과 실천적 제약이 개입한다는 점이 중심 주장이다. 결국 사고와 행동은 분리된 절차가 아니라 환경 속에서 함께 형성되는 구조로 제시된다.",
            };
      },
    } satisfies AiChatClient;
    const chunks: SourceChunk[] = [
      { id: "chunk-1", headingPath: [], locator: "p. 1", kind: "body", text: "Complete source text.", confidence: 1 },
    ];

    const overview = await generateMaterialOverview("Source", chunks, { client, model: "test-model" });

    expect(calls).toBe(2);
    expect(overview.paragraph).not.toMatch(/[A-Za-z]/);
    expect(overview.paragraph).not.toContain("학습에서는");
  });

  test("retries when the first structured overview response is invalid JSON", async () => {
    let calls = 0;
    const client = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async () => {
        calls += 1;
        if (calls === 1) throw new Error("AI returned prose instead of JSON: Model did not return valid JSON");
        return {
          paragraph: "이 글은 인간의 기억과 사고를 관계망과 활성화의 흐름으로 설명하는 이론이 어떻게 발전했는지를 다룬다. 개념 사이의 연결과 활성화 확산은 의미 기억과 추론을 설명하며, 상호작용하는 여러 처리 단계는 읽기와 인지가 점진적으로 형성되는 과정을 보여준다. 중심 주장은 사고가 고정된 규칙의 적용이 아니라 연결 강도에 따라 변화하는 역동적인 상태라는 데 있다.",
        };
      },
    } satisfies AiChatClient;
    const chunks: SourceChunk[] = [
      { id: "chunk-1", headingPath: [], locator: "p. 1", kind: "body", text: "Complete source text.", confidence: 1 },
    ];

    const overview = await generateMaterialOverview("Source", chunks, { client, model: "test-model" });

    expect(calls).toBe(2);
    expect(overview.paragraph).toContain("기억과 사고");
  });
});
