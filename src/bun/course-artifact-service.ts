import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDb } from "./project-db";
import { dataPath, materialDirAt } from "./paths";
import { SourceService } from "./source-service";
import { listMaterialAnnotations } from "./annotation-store";
import type {
  Concept,
  CourseModule,
  CoursePlan,
  CriticReport,
  LecturePlan,
  MaterialArtifacts,
  MaterialManifest,
  MaterialOverview,
  PresentationPlan,
  SourceChunk,
  SourceFigure,
  VisualSpec,
} from "../shared/artifact-types";
import type { MaterialSummary } from "../shared/rpc-types";
import { displayableCourseTitle, displayableHeadingPath, displayableModuleTitle, displayableOutlineTitle, plainDisplayText } from "../shared/display-title";
import type { AiChatClient } from "./openai-compatible-client";

type MaterialRow = {
  id: string;
  project_id: string;
  title: string;
  material_type: string;
  status: "draft" | "generating" | "ready" | "failed";
  manifest_path: string | null;
  concept_map_path: string | null;
  course_plan_path: string | null;
  overview_path: string | null;
  overview_json: string | null;
  lecture_plan_path: string | null;
  presentation_plan_path: string | null;
  critic_report_path: string | null;
  visual_specs_path: string | null;
  source_index_path: string | null;
  generation_error: string | null;
  created_at: number;
  updated_at: number;
};

type LearningSection = {
  title: string;
  chunks: SourceChunk[];
  text: string;
};

type SourceTitleForChunk = (chunk: SourceChunk) => string | undefined;

type HeavyMaterialArtifacts = Omit<MaterialArtifacts, "annotations">;

type ArtifactCacheEntry = {
  updatedAt: number;
  artifacts: HeavyMaterialArtifacts;
};

function toMaterial(row: MaterialRow, sourceIds: string[]): MaterialSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    materialType: row.material_type,
    status: row.status,
    sourceIds,
    generationError: row.generation_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function canReuseMaterialForGeneration(status: MaterialRow["status"]) {
  return status === "ready";
}

export function materialGenerationKey(projectId: string, sourceIds: string[]) {
  return `${projectId}:${[...new Set(sourceIds)].sort().join("\u0000")}`;
}

function uniqueSourceIds(sourceIds: string[]) {
  return [...new Set(sourceIds.filter(Boolean))];
}

function sentences(text: string) {
  return text
    .split(/(?<=[.!?。！？다요죠음함됨])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function signalsFromText(text: string) {
  const tokens = Array.from(new Set((text.match(/[가-힣A-Za-z0-9]{2,}/g) || []).slice(0, 12)));
  return tokens.slice(0, 6);
}

function compactText(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, max)}${normalized.length > max ? "..." : ""}`;
}

export const MATERIAL_OVERVIEW_GENERATOR_VERSION = "material-overview-v2-llm-full-source";

export type MaterialOverviewRuntime = {
  client: AiChatClient;
  model: string;
};

type MaterialOverviewRuntimeProvider = () => Promise<MaterialOverviewRuntime>;

function fullSourceContext(chunks: SourceChunk[]) {
  return chunks
    .map((chunk, index) => {
      const heading = displayableHeadingPath(chunk.headingPath) || `대목 ${index + 1}`;
      return `[대목 ${index + 1} · ${heading} · ${chunk.locator}]\n${chunk.text.trim()}`;
    })
    .join("\n\n");
}

function validOverviewParagraph(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const paragraph = (value as { paragraph?: unknown }).paragraph;
  if (typeof paragraph !== "string") return null;
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (normalized.length < 80 || normalized.length > 1_200) return null;
  if (/[A-Za-z]/.test(normalized)) return null;
  if (/전체\s*\d+\s*개\s*대목|학습에서는|원문을 직접 읽지 않아도|모듈|module/i.test(normalized)) return null;
  return normalized;
}

export function isCurrentMaterialOverview(overview: MaterialOverview | null | undefined) {
  return overview?.generatorVersion === MATERIAL_OVERVIEW_GENERATOR_VERSION && Boolean(validOverviewParagraph(overview));
}

export async function generateMaterialOverview(
  title: string,
  chunks: SourceChunk[],
  runtime: MaterialOverviewRuntime
): Promise<MaterialOverview> {
  const sourceContext = fullSourceContext(chunks);
  const system = [
    "당신은 주어진 원문 전체의 핵심 주제를 정확하게 요약하는 편집자다.",
    "반드시 원문 전체를 종합하여 이 글이 무엇을 다루는지, 중심 문제와 핵심 주장, 주요 개념의 관계나 긴장을 한국어 한 문단 3~5문장으로 설명한다.",
    "학습 방법, 학습 가치, 모듈, 목차, 대목 수, 독자가 해야 할 일을 언급하지 않는다.",
    "원문의 문장을 그대로 인용하거나 영어를 섞지 말고, 고유명사와 전문 용어도 자연스러운 한국어 표기로 쓴다.",
    "근거 없는 일반론과 '핵심 구조를 자기 말로 설명한다' 같은 상투적인 문장을 쓰지 않는다.",
    "반환 형식은 반드시 {\"paragraph\":\"한국어 요약\"} 형태의 JSON 객체 하나다.",
  ].join(" ");
  const sourceMessage = `자료 제목: ${title}\n\n다음은 요약해야 할 원문 전체다. 일부만 골라 요약하지 말고 처음부터 끝까지 종합하라.\n\n${sourceContext}`;
  let lastResponse: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: sourceMessage },
      ...(attempt && lastResponse
        ? [
            { role: "assistant" as const, content: JSON.stringify(lastResponse) },
            {
              role: "user" as const,
              content: "이 응답은 조건을 어겼다. 영어와 학습 안내 및 목차 언급을 모두 제거하고, 원문 전체의 주제와 주장만 한국어 한 문단으로 다시 작성하라.",
            },
          ]
        : []),
    ];
    lastResponse = await runtime.client.chatJson({
      model: runtime.model,
      messages,
      temperature: 0.2,
      maxTokens: 900,
      timeoutMs: 180_000,
      thinking: "disabled",
    });
    const paragraph = validOverviewParagraph(lastResponse);
    if (paragraph) {
      return {
        paragraph,
        sourceChunkIds: chunks.map((chunk) => chunk.id),
        generatedAt: new Date().toISOString(),
        generatorVersion: MATERIAL_OVERVIEW_GENERATOR_VERSION,
      };
    }
  }
  throw new Error("AI가 원문 전체에 대한 한국어 주제 요약을 올바른 형식으로 생성하지 못했습니다");
}

function sourceSpark(text: string) {
  const words = text.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 25);
  return words.join(" ");
}

function chunkTitle(chunk: SourceChunk, fallback: string) {
  return plainDisplayText(chunk.headingPath.at(-1) || fallback) || fallback;
}

function sectionTitle(chunk: SourceChunk, fallback: string, leadingTitle?: string) {
  return displayableHeadingPath(chunk.headingPath, " > ", leadingTitle ? [leadingTitle] : []) || chunkTitle(chunk, fallback);
}

function learningSections(chunks: SourceChunk[], sourceTitleForChunk?: SourceTitleForChunk): LearningSection[] {
  const sections: LearningSection[] = [];
  for (const chunk of chunks) {
    const title = sectionTitle(chunk, `학습 단계 ${sections.length + 1}`, sourceTitleForChunk?.(chunk));
    const current = sections.at(-1);
    if (current?.title === title) {
      current.chunks.push(chunk);
      current.text = `${current.text}\n\n${chunk.text}`;
    } else {
      sections.push({ title, chunks: [chunk], text: chunk.text });
    }
  }
  return sections.length ? sections : chunks.map((chunk, index) => ({ title: chunkTitle(chunk, `학습 단계 ${index + 1}`), chunks: [chunk], text: chunk.text }));
}

function buildConcepts(chunks: SourceChunk[]): Concept[] {
  return chunks.slice(0, 12).map((chunk, index) => {
    const name = chunkTitle(chunk, `핵심 개념 ${index + 1}`);
    const firstSentence = sentences(chunk.text)[0] || chunk.text.slice(0, 120);
    return {
      id: `concept-${index + 1}`,
      name,
      definition: firstSentence,
      whyItMatters: "이 대목은 이후 질문과 설명의 근거가 되는 핵심 문맥입니다.",
      prerequisites: index > 0 ? [`concept-${index}`] : [],
      misconceptions: ["원문 근거 없이 일반 상식으로만 답하는 것"],
      sourceChunkIds: [chunk.id],
      visualCandidate: index === 0 ? { type: "flow", id: "visual-course-map" } : undefined,
    };
  });
}

function buildCoursePlan(title: string, chunks: SourceChunk[], concepts: Concept[], sourceTitleForChunk?: SourceTitleForChunk): CoursePlan {
  const sections = learningSections(chunks, sourceTitleForChunk);
  const selectedSections = sections;
  const modules: CourseModule[] = selectedSections.map((section, index) => {
    const sourceChunkIds = section.chunks.map((chunk) => chunk.id);
    const conceptIds = concepts.filter((concept) => concept.sourceChunkIds.some((id) => sourceChunkIds.includes(id))).map((concept) => concept.id);
    return {
      id: `module-${String(index + 1).padStart(2, "0")}`,
      title: section.title,
      learningGoal: `원문을 직접 읽지 않아도 ${section.title}의 핵심 주장과 긴장을 설명할 수 있다.`,
      conceptIds: conceptIds.length ? conceptIds : [concepts[index]?.id || concepts[0]?.id || "concept-1"],
      sourceChunkIds,
      visualIds: [],
      hookIntent: "원문을 읽지 않은 학습자가 궁금해할 긴장으로 열고, 바로 핵심 문맥을 대신 읽어 준다.",
      checkpointRubric: "사용자가 정답을 맞혔는지가 아니라, 설명된 구조를 자기 말로 만져 볼 준비가 되었는지를 본다.",
      masterySignals: signalsFromText(section.text),
      misconceptionSignals: ["모름", "상관없", "그냥", "전부", "아무것도"],
      remediationStrategy: "오답을 지적하지 말고, 원문 조각을 더 짧게 의역한 뒤 표나 비유로 설명을 다시 조직한다.",
      mode: "guided_lecture",
      understandingSignals: signalsFromText(section.text),
      confusionSignals: ["모름", "헷갈", "어려", "상관없", "그냥"],
      teacherRepairStrategy: "학습자의 직관을 출발점으로 삼고, 빠진 원문 구조를 먼저 가르친 뒤 짧은 반성 질문으로 연결한다.",
    };
  });

  return {
    id: `course-${crypto.randomUUID()}`,
    title: displayableCourseTitle(title) || plainDisplayText(title) || title,
    subtitle: "Source-grounded adaptive learning material",
    audience: "일반 성인 학습자",
    estimatedTimeMinutes: Math.max(10, modules.length * 5),
    modules,
  };
}

function sanitizeCoursePlan(coursePlan: CoursePlan): CoursePlan {
  return {
    ...coursePlan,
    title: displayableCourseTitle(coursePlan.title) || plainDisplayText(coursePlan.title) || coursePlan.title,
    modules: coursePlan.modules.map((module) => ({
      ...module,
      title: displayableModuleTitle(module.title) || plainDisplayText(module.title) || module.title,
      learningGoal: plainDisplayText(module.learningGoal) || module.learningGoal,
    })),
  };
}

function sanitizeSourceIndex(sourceIndex: MaterialArtifacts["sourceIndex"]): MaterialArtifacts["sourceIndex"] {
  return Object.fromEntries(
    Object.entries(sourceIndex).map(([chunkId, meta]) => [
      chunkId,
      {
        ...meta,
        title: displayableOutlineTitle(meta.title) || plainDisplayText(meta.title) || meta.title,
      },
    ])
  );
}

function buildVisuals(chunks: SourceChunk[], sourceTitleForChunk?: SourceTitleForChunk): VisualSpec[] {
  const labels = learningSections(chunks, sourceTitleForChunk).slice(0, 5).map((section, index) => section.title || `단계 ${index + 1}`);
  return [
    {
      id: "visual-course-map",
      type: "flow",
      title: "학습 흐름",
      items: labels.length ? labels : ["흥미로운 문제", "원문 대신 읽기", "구조화", "생각 얹기"],
    },
  ];
}

function buildLecturePlan(materialId: string, chunks: SourceChunk[], sourceTitleForChunk?: SourceTitleForChunk): LecturePlan {
  const sections = learningSections(chunks, sourceTitleForChunk);
  const selectedSections = sections;
  return {
    materialId,
    generatedAt: new Date().toISOString(),
    modules: selectedSections.map((section, index) => {
      const moduleId = `module-${String(index + 1).padStart(2, "0")}`;
      const title = section.title || `학습 단계 ${index + 1}`;
      const firstSentence = sentences(section.text)[0] || compactText(section.text, 140);
      return {
        moduleId,
        intrigue: {
          tension: `${title}에서 당연해 보이는 말과 실제 원문이 밀어붙이는 핵심 사이의 차이를 붙잡는다.`,
          stakes: "이 대목을 이해하면 뒤따르는 설명을 외우는 대신 왜 그런 순서로 전개되는지 볼 수 있다.",
          surpriseLine: `${title}은 결론을 외우게 하기보다, 이 대목이 어떤 질문을 열고 있는지 따라가게 합니다.`,
        },
        guidedReading: {
          sourceSpark: sourceSpark(firstSentence),
          plainParaphrase: compactText(firstSentence, 220),
          contextBefore: index === 0 ? "먼저 이 자료가 던지는 가장 큰 문제의식을 잡는다." : "앞 대목에서 만든 질문이 여기서 더 구체적인 주장으로 이어진다.",
          contextAfter: "이제 원문 근거를 짧게 붙잡은 뒤, 개념 사이의 관계를 표나 도해로 압축한다.",
        },
        bestAnalogy: null,
        interactionMove: index % 2 === 0 ? "rephrase" : "compare",
        likelyConfusion: "처음 듣는 학습자는 원문을 이미 읽은 사람처럼 세부 내용을 재현해야 한다고 느낄 수 있다.",
        teacherRepair: "세부를 다시 맞히게 하지 말고 핵심 발췌, 쉬운 의역, 비교 구조 순서로 설명을 재배열한다.",
        teachingMoves: [
          { type: "guided_reflection", prompt: "이 대목이 왜 이렇게 시작하는지 먼저 한 문장으로 감각을 잡는다." },
          { type: "rephrase", prompt: "원문 핵심을 일상적인 말로 바꿔 본다." },
        ],
        visualOpportunities: [],
      };
    }),
  };
}

function buildPresentationPlan(materialId: string, chunks: SourceChunk[], sourceTitleForChunk?: SourceTitleForChunk): PresentationPlan {
  const sections = learningSections(chunks, sourceTitleForChunk);
  const selectedSections = sections;
  return {
    materialId,
    modules: selectedSections.map((_, index) => ({
      moduleId: `module-${String(index + 1).padStart(2, "0")}`,
      defaultTurnShape: ["hook", "guided_reading", "bullets", "reflection"],
      recapShape: ["bullets", "bridge"],
      avoid: ["long_paragraph_only", "recall_test_before_teaching", "repeat_same_question"],
    })),
  };
}

function buildCriticReport(materialId: string, lecturePlan: LecturePlan, visuals: VisualSpec[]): CriticReport {
  const visualIds = new Set(visuals.map((visual) => visual.id));
  return {
    materialId,
    generatedAt: new Date().toISOString(),
    modules: lecturePlan.modules.map((module) => {
      const hasVisual = module.visualOpportunities.some((visual) => visualIds.has(visual.id));
      return {
        moduleId: module.moduleId,
        scores: {
          variety: 0.84,
          grounding: module.guidedReading.sourceSpark ? 0.86 : 0.45,
          visualFit: hasVisual ? 0.82 : 0.42,
          guidedReading: module.guidedReading.plainParaphrase ? 0.88 : 0.4,
          interaction: module.interactionMove ? 0.8 : 0.45,
          density: 0.76,
          progression: 0.82,
          nonExam: 0.86,
        },
        warnings: hasVisual || module.visualOpportunities.length === 0 ? [] : ["No matching visual opportunity was generated."],
      };
    }),
  };
}

export class CourseArtifactService {
  private readonly sources = new SourceService();
  private readonly artifactCache = new Map<string, ArtifactCacheEntry>();
  private readonly generationPromises = new Map<string, Promise<MaterialSummary>>();

  constructor(private readonly materialOverviewRuntime?: MaterialOverviewRuntimeProvider) {}

  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  private sourceIdForChunk(chunk: SourceChunk, sourceIds: string[]) {
    return sourceIds.find((sourceId) => chunk.id.startsWith(`${sourceId}-`));
  }

  async generate(projectId: string, sourceIds: string[]) {
    const normalizedSourceIds = uniqueSourceIds(sourceIds);
    if (!normalizedSourceIds.length) throw new Error("At least one source is required");
    const key = materialGenerationKey(projectId, normalizedSourceIds);
    const active = this.generationPromises.get(key);
    if (active) return active;
    const generation = this.generateUncached(projectId, normalizedSourceIds);
    this.generationPromises.set(key, generation);
    try {
      return await generation;
    } finally {
      if (this.generationPromises.get(key) === generation) this.generationPromises.delete(key);
    }
  }

  private async generateUncached(projectId: string, sourceIds: string[]) {
    const existing = this.findBySourceSet(projectId, sourceIds).find((material) => canReuseMaterialForGeneration(material.status));
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = Date.now();
    const rows = sourceIds.map((sourceId) => this.sources.getRow(sourceId));
    const sourceTitleById = new Map(rows.map((row) => [row.id, row.title]));
    const sourceTitleForChunk: SourceTitleForChunk = (chunk) => {
      const sourceId = this.sourceIdForChunk(chunk, sourceIds);
      return sourceId ? sourceTitleById.get(sourceId) : undefined;
    };
    const rawTitle = rows.length === 1 ? rows[0]!.title : `${rows[0]!.title} 외 ${rows.length - 1}개`;
    const title = plainDisplayText(rawTitle) || rawTitle || "Learning material";
    const dir = materialDirAt(this.projectRoot(projectId), projectId, id);
    await mkdir(dir, { recursive: true });

    getDb()
      .query(
        `INSERT INTO learning_materials
         (id, project_id, title, material_type, status, created_at, updated_at)
         VALUES (?, ?, ?, 'source_course', 'generating', ?, ?)`
      )
      .run(id, projectId, title, now, now);
    sourceIds.forEach((sourceId, index) => {
      getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES (?, ?, ?)").run(id, sourceId, index);
    });

    try {
      const sourceChunks = (await Promise.all(sourceIds.map((sourceId) => this.sources.loadChunks(sourceId)))).flat();
      const figures = (await Promise.all(sourceIds.map((sourceId) => this.sources.loadFigures(sourceId)))).flat();
      if (!sourceChunks.length) throw new Error("No chunks were extracted for selected sources");
      const conceptMap = buildConcepts(sourceChunks);
      const coursePlan = buildCoursePlan(title, sourceChunks, conceptMap, sourceTitleForChunk);
      const overview = await this.createMaterialOverview(title, sourceChunks);
      const visuals = buildVisuals(sourceChunks, sourceTitleForChunk);
      const lecturePlan = buildLecturePlan(id, sourceChunks, sourceTitleForChunk);
      const presentationPlan = buildPresentationPlan(id, sourceChunks, sourceTitleForChunk);
      const criticReport = buildCriticReport(id, lecturePlan, visuals);
      const manifest: MaterialManifest = {
        id,
        projectId,
        title,
        sourceIds,
        sourceChunkIds: sourceChunks.map((chunk) => chunk.id),
        generatedAt: new Date(now).toISOString(),
        generatorModel: "deterministic-mvp",
        status: "ready",
      };
      const sourceIndex = Object.fromEntries(
        sourceChunks.map((chunk) => [
          chunk.id,
          {
            sourceId: this.sourceIdForChunk(chunk, sourceIds) || sourceIds[0]!,
            title: sectionTitle(chunk, title, sourceTitleForChunk(chunk)),
            locator: chunk.locator,
          },
        ])
      );
      const figureIndex = buildFigureIndex(figures);

      const paths = {
        manifest: join(dir, "material_manifest.json"),
        concepts: join(dir, "concept_map.json"),
        course: join(dir, "course_plan.json"),
        overview: join(dir, "material_overview.json"),
        lecture: join(dir, "lecture_plan.json"),
        presentation: join(dir, "presentation_plan.json"),
        critic: join(dir, "critic_report.json"),
        visuals: join(dir, "visual_specs.json"),
        index: join(dir, "source_index.json"),
        chunks: join(dir, "source_chunks.json"),
        figures: join(dir, "figures.json"),
        figureIndex: join(dir, "figure_index.json"),
      };
      await Promise.all([
        writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
        writeFile(paths.concepts, `${JSON.stringify(conceptMap, null, 2)}\n`, "utf8"),
        writeFile(paths.course, `${JSON.stringify(coursePlan, null, 2)}\n`, "utf8"),
        writeFile(paths.overview, `${JSON.stringify(overview, null, 2)}\n`, "utf8"),
        writeFile(paths.lecture, `${JSON.stringify(lecturePlan, null, 2)}\n`, "utf8"),
        writeFile(paths.presentation, `${JSON.stringify(presentationPlan, null, 2)}\n`, "utf8"),
        writeFile(paths.critic, `${JSON.stringify(criticReport, null, 2)}\n`, "utf8"),
        writeFile(paths.visuals, `${JSON.stringify(visuals, null, 2)}\n`, "utf8"),
        writeFile(paths.index, `${JSON.stringify(sourceIndex, null, 2)}\n`, "utf8"),
        writeFile(paths.chunks, `${JSON.stringify(sourceChunks, null, 2)}\n`, "utf8"),
        writeFile(paths.figures, `${JSON.stringify(figures, null, 2)}\n`, "utf8"),
        writeFile(paths.figureIndex, `${JSON.stringify(figureIndex, null, 2)}\n`, "utf8"),
      ]);

      getDb()
        .query(
          `UPDATE learning_materials
           SET status = 'ready', manifest_path = ?, concept_map_path = ?, course_plan_path = ?, overview_path = ?, overview_json = ?,
               lecture_plan_path = ?, presentation_plan_path = ?, critic_report_path = ?,
               visual_specs_path = ?, source_index_path = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          paths.manifest,
          paths.concepts,
          paths.course,
          paths.overview,
          JSON.stringify(overview),
          paths.lecture,
          paths.presentation,
          paths.critic,
          paths.visuals,
          paths.index,
          Date.now(),
          id
        );
      this.artifactCache.delete(id);
      return this.getSummary(id);
    } catch (error) {
      getDb()
        .query("UPDATE learning_materials SET status = 'failed', generation_error = ?, updated_at = ? WHERE id = ?")
        .run((error as Error).message, Date.now(), id);
      throw error;
    }
  }

  list(projectId: string) {
    const rows = getDb()
      .query<MaterialRow, [string]>("SELECT * FROM learning_materials WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId);
    return rows.map((row) => toMaterial(row, this.sourceIds(row.id)));
  }

  findBySourceSet(projectId: string, sourceIds: string[]) {
    const expected = [...new Set(sourceIds)].sort();
    return this.list(projectId).filter((material) => {
      const actual = [...new Set(material.sourceIds)].sort();
      return actual.length === expected.length && actual.every((sourceId, index) => sourceId === expected[index]);
    });
  }

  recoverInterruptedGenerations() {
    const now = Date.now();
    const result = getDb()
      .query(
        `UPDATE learning_materials
         SET status = 'failed',
             generation_error = COALESCE(generation_error, 'Material generation was interrupted before completion. Regenerate to continue.'),
             updated_at = ?
         WHERE status = 'generating'`
      )
      .run(now);
    return result.changes;
  }

  getSummary(materialId: string) {
    const row = this.getRow(materialId);
    return toMaterial(row, this.sourceIds(materialId));
  }

  getRow(materialId: string) {
    const row = getDb().query<MaterialRow, [string]>("SELECT * FROM learning_materials WHERE id = ?").get(materialId);
    if (!row) throw new Error("Material not found");
    return row;
  }

  sourceIds(materialId: string) {
    return getDb()
      .query<{ source_id: string }, [string]>("SELECT source_id FROM material_sources WHERE material_id = ? ORDER BY ordinal ASC")
      .all(materialId)
      .map((row) => row.source_id);
  }

  async getArtifacts(materialId: string): Promise<MaterialArtifacts> {
    const row = this.getRow(materialId);
    const cached = this.artifactCache.get(materialId);
    if (cached?.updatedAt === row.updated_at && (!this.materialOverviewRuntime || isCurrentMaterialOverview(cached.artifacts.overview))) {
      return { ...cached.artifacts, annotations: listMaterialAnnotations(materialId) };
    }
    const artifacts = await this.loadHeavyArtifacts(row);
    this.artifactCache.set(materialId, { updatedAt: row.updated_at, artifacts });
    return { ...artifacts, annotations: listMaterialAnnotations(materialId) };
  }

  private async loadHeavyArtifacts(row: MaterialRow): Promise<HeavyMaterialArtifacts> {
    if (!row.manifest_path || !row.concept_map_path || !row.course_plan_path || !row.visual_specs_path || !row.source_index_path) {
      throw new Error("Material artifacts are incomplete");
    }
    const [manifest, conceptMap, coursePlan, lecturePlan, presentationPlan, criticReport, visuals, sourceIndex] = await Promise.all([
      readFile(row.manifest_path, "utf8").then((raw) => JSON.parse(raw) as MaterialManifest),
      readFile(row.concept_map_path, "utf8").then((raw) => JSON.parse(raw) as Concept[]),
      readFile(row.course_plan_path, "utf8").then((raw) => JSON.parse(raw) as CoursePlan),
      row.lecture_plan_path ? readFile(row.lecture_plan_path, "utf8").then((raw) => JSON.parse(raw) as LecturePlan) : Promise.resolve(undefined),
      row.presentation_plan_path
        ? readFile(row.presentation_plan_path, "utf8").then((raw) => JSON.parse(raw) as PresentationPlan)
        : Promise.resolve(undefined),
      row.critic_report_path ? readFile(row.critic_report_path, "utf8").then((raw) => JSON.parse(raw) as CriticReport) : Promise.resolve(undefined),
      readFile(row.visual_specs_path, "utf8").then((raw) => JSON.parse(raw) as VisualSpec[]),
      readFile(row.source_index_path, "utf8").then((raw) => JSON.parse(raw) as Record<string, { sourceId: string; title: string; locator: string }>),
    ]);
    const sourceChunks = await this.loadMaterialSourceChunks(row);
    const overview = await this.loadMaterialOverview(row, sourceChunks);
    const figures = await this.loadMaterialFigures(row);
    const figureIndex = await this.loadMaterialFigureIndex(row, figures);
    return {
      manifest,
      overview,
      conceptMap,
      coursePlan: sanitizeCoursePlan(coursePlan),
      lecturePlan,
      presentationPlan,
      criticReport,
      visuals,
      sourceChunks,
      sourceIndex: sanitizeSourceIndex(sourceIndex),
      figures,
      figureIndex,
    };
  }

  private async loadMaterialOverview(row: MaterialRow, sourceChunks: SourceChunk[]) {
    const overviewPath = row.overview_path || (row.manifest_path ? join(dirname(row.manifest_path), "material_overview.json") : null);
    if (row.overview_json) {
      try {
        const databaseOverview = JSON.parse(row.overview_json) as MaterialOverview;
        if (isCurrentMaterialOverview(databaseOverview)) return databaseOverview;
      } catch {
        // Invalid legacy JSON is replaced from the artifact file or regenerated below.
      }
    }
    let storedOverview: MaterialOverview | null = null;
    if (overviewPath) {
      try {
        storedOverview = JSON.parse(await readFile(overviewPath, "utf8")) as MaterialOverview;
        if (isCurrentMaterialOverview(storedOverview)) {
          this.persistMaterialOverview(row.id, storedOverview, overviewPath);
          return storedOverview;
        }
      } catch {
        storedOverview = null;
      }
    }
    if (!this.materialOverviewRuntime) {
      if (storedOverview?.paragraph?.trim()) return storedOverview;
      throw new Error("Material overview is missing");
    }
    const overview = await this.createMaterialOverview(row.title, sourceChunks);
    this.persistMaterialOverview(row.id, overview, overviewPath);
    if (overviewPath) {
      await writeFile(overviewPath, `${JSON.stringify(overview, null, 2)}\n`, "utf8").catch((error) => {
        console.warn("Failed to mirror material overview to artifact file", error);
      });
    }
    return overview;
  }

  private persistMaterialOverview(materialId: string, overview: MaterialOverview, overviewPath: string | null) {
    getDb()
      .query("UPDATE learning_materials SET overview_json = ?, overview_path = COALESCE(?, overview_path) WHERE id = ?")
      .run(JSON.stringify(overview), overviewPath, materialId);
  }

  private async createMaterialOverview(title: string, sourceChunks: SourceChunk[]) {
    if (!this.materialOverviewRuntime) throw new Error("AI provider is required to summarize the full source");
    return generateMaterialOverview(title, sourceChunks, await this.materialOverviewRuntime());
  }

  private async loadMaterialSourceChunks(row: MaterialRow) {
    if (row.manifest_path) {
      const chunksPath = join(dirname(row.manifest_path), "source_chunks.json");
      try {
        const chunks = JSON.parse(await readFile(chunksPath, "utf8")) as SourceChunk[];
        if (Array.isArray(chunks) && chunks.length) return chunks;
      } catch {
        // Older materials did not persist source chunks; fall back to current source artifacts.
      }
    }
    const sourceChunks = (await Promise.all(this.sourceIds(row.id).map((sourceId) => this.sources.loadChunks(sourceId)))).flat();
    if (sourceChunks.length && row.manifest_path) {
      await writeFile(join(dirname(row.manifest_path), "source_chunks.json"), `${JSON.stringify(sourceChunks, null, 2)}\n`, "utf8").catch(() => undefined);
    }
    return sourceChunks;
  }

  private async loadMaterialFigures(row: MaterialRow) {
    if (row.manifest_path) {
      try {
        const figures = JSON.parse(await readFile(join(dirname(row.manifest_path), "figures.json"), "utf8")) as SourceFigure[];
        if (figures.length) return figures;
      } catch {
        // Older materials did not persist figures; fall back to the current source artifacts.
      }
    }
    const figures = (await Promise.all(this.sourceIds(row.id).map((sourceId) => this.sources.loadFigures(sourceId)))).flat();
    if (figures.length && row.manifest_path) {
      await writeFile(join(dirname(row.manifest_path), "figures.json"), `${JSON.stringify(figures, null, 2)}\n`, "utf8").catch(() => undefined);
      await writeFile(join(dirname(row.manifest_path), "figure_index.json"), `${JSON.stringify(buildFigureIndex(figures), null, 2)}\n`, "utf8").catch(() => undefined);
    }
    return figures;
  }

  private async loadMaterialFigureIndex(row: MaterialRow, figures: SourceFigure[]) {
    if (row.manifest_path) {
      try {
        return JSON.parse(await readFile(join(dirname(row.manifest_path), "figure_index.json"), "utf8")) as MaterialArtifacts["figureIndex"];
      } catch {
        // Older materials did not persist a figure index.
      }
    }
    return buildFigureIndex(figures);
  }
}

function buildFigureIndex(figures: SourceFigure[]): MaterialArtifacts["figureIndex"] {
  return Object.fromEntries(
    figures.map((figure) => [
      figure.id,
      {
        sourceId: figure.sourceId,
        title: figure.title,
        locator: figure.locator,
        sourceChunkIds: figure.sourceChunkIds,
      },
    ])
  );
}
