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
  PresentationPlan,
  SourceChunk,
  SourceFigure,
  VisualSpec,
} from "../shared/artifact-types";
import type { MaterialSummary } from "../shared/rpc-types";

type MaterialRow = {
  id: string;
  project_id: string;
  title: string;
  material_type: string;
  status: "draft" | "generating" | "ready" | "failed";
  manifest_path: string | null;
  concept_map_path: string | null;
  course_plan_path: string | null;
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

function sourceSpark(text: string) {
  const words = text.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 25);
  return words.join(" ");
}

function chunkTitle(chunk: SourceChunk, fallback: string) {
  return chunk.headingPath.at(-1) || fallback;
}

function normalizeHeadingTitle(title: string) {
  return title
    .replace(/\s+course$/i, "")
    .replace(/\.[A-Za-z0-9]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanHeadingParts(parts: string[], leadingTitle?: string) {
  const normalized = parts.map((part) => part.replace(/\s+course$/i, "").trim()).filter(Boolean);
  if (normalized.length > 1 && leadingTitle && normalizeHeadingTitle(normalized[0] || "") === normalizeHeadingTitle(leadingTitle)) return normalized.slice(1);
  if (normalized.length > 1 && /^chapter\s+\d+\b/i.test(normalized[0] || "")) return normalized.slice(1);
  return normalized;
}

function sectionTitle(chunk: SourceChunk, fallback: string, leadingTitle?: string) {
  return cleanHeadingParts(chunk.headingPath, leadingTitle).join(" > ") || chunkTitle(chunk, fallback);
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
    const name = chunk.headingPath.at(-1) || `핵심 개념 ${index + 1}`;
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
    title,
    subtitle: "Source-grounded adaptive learning material",
    audience: "일반 성인 학습자",
    estimatedTimeMinutes: Math.max(10, modules.length * 5),
    modules,
  };
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

  private projectRoot(projectId: string) {
    const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
    return row?.root_path || dataPath("projects");
  }

  private sourceIdForChunk(chunk: SourceChunk, sourceIds: string[]) {
    return sourceIds.find((sourceId) => chunk.id.startsWith(`${sourceId}-`));
  }

  async generate(projectId: string, sourceIds: string[]) {
    if (!sourceIds.length) throw new Error("At least one source is required");
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
    const title = rows.length === 1 ? rows[0]!.title : `${rows[0]!.title} 외 ${rows.length - 1}개`;
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
           SET status = 'ready', manifest_path = ?, concept_map_path = ?, course_plan_path = ?,
               lecture_plan_path = ?, presentation_plan_path = ?, critic_report_path = ?,
               visual_specs_path = ?, source_index_path = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          paths.manifest,
          paths.concepts,
          paths.course,
          paths.lecture,
          paths.presentation,
          paths.critic,
          paths.visuals,
          paths.index,
          Date.now(),
          id
        );
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
    const sourceChunks = (await Promise.all(this.sourceIds(materialId).map((sourceId) => this.sources.loadChunks(sourceId)))).flat();
    const figures = await this.loadMaterialFigures(row);
    const figureIndex = await this.loadMaterialFigureIndex(row, figures);
    const annotations = listMaterialAnnotations(materialId);
    return { manifest, conceptMap, coursePlan, lecturePlan, presentationPlan, criticReport, visuals, sourceChunks, sourceIndex, figures, figureIndex, annotations };
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
