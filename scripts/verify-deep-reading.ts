/** Explicit live-model smoke check on synthetic sources; does not open or modify user projects. */
import { writeFile } from "node:fs/promises";
import type { SourceChunk, CoursePlan, CourseModule, MaterialArtifacts } from "../src/shared/artifact-types";
import type { SessionSnapshot, TutorTurnOutput } from "../src/shared/tutor-types";
import { TutorService } from "../src/bun/tutor-service";
import { SettingsService } from "../src/bun/settings-service";
import { AiProviderSettingsService } from "../src/bun/ai-provider-settings";
import { createAiProviderClient } from "../src/bun/ai-provider-client";
import { compileLearningIr } from "../src/bun/learning-ir-compiler";
import { compileDeepReading } from "../src/bun/deep-reading-service";

if (!process.argv.includes("--live")) throw new Error("Pass --live to run this check against the configured model.");
const settings = await new SettingsService().get();
const model = settings.providers[settings.aiProvider].selectedModel;
if (!model) throw new Error("No model configured in the selected LEARNIE_APP_DATA_ROOT.");
const key = await new AiProviderSettingsService().getApiKey(settings.aiProvider);
const client = createAiProviderClient(settings, key.value);
const texts = [
  ["Argument", "Coerced action is not autonomous. Institutional control can constrain autonomous action. This does not establish that all institutional control eliminates autonomy."],
  ["Definition and limitation", "Autonomy means acting on reasons one endorses. Institutional control does not always amount to coercion. A rule accepted voluntarily may constrain behavior without coercing the actor."],
  ["Mechanism", "A positive input current charges a membrane capacitor, increasing its voltage. A spike occurs only if the voltage reaches the threshold. Below threshold the same current may increase voltage without producing a spike. This simplified model omits active channel dynamics."],
  ["Mathematical method", "Assume a constant capacitance C greater than zero and no leak. Current I satisfies I = C dV/dt. For constant I, integrating from time zero gives V(t) = V(0) + It/C. The linear trajectory requires the constant-current and no-leak assumptions; it is not a general model of a biological membrane."],
];
const chunks: SourceChunk[] = texts.map(([title, text], index) => ({ id: `synthetic-${index}`, headingPath: [title!], locator: `Synthetic section ${index + 1}`, kind: "body", text: text!, confidence: 1 }));
const coursePlan: CoursePlan = { id: "smoke", title: "Synthetic deep reading", subtitle: "", audience: "general", estimatedTimeMinutes: 5, modules: chunks.map((chunk) => ({ id: chunk.id, title: chunk.headingPath[0]!, sourceChunkIds: [chunk.id], learningGoal: "Explain the inference and its limits", conceptIds: [], visualIds: [], hookIntent: "", checkpointRubric: "", masterySignals: [], misconceptionSignals: [], remediationStrategy: "" })) };
const ir = await compileLearningIr({ materialId: "synthetic-smoke", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: [] });
const started = Date.now();
const plan = await compileDeepReading({ chunks, ir, runtime: { client, model }, onProgress: (completed, total) => console.log(`Planning ${completed}/${total}`) });
const lessons: TutorTurnOutput[] = [];
if (process.argv.includes("--lessons")) {
  // Exercise the real prompt and sanitizer while replacing only the settings lookup.
  // No session/project database is created or modified by this isolated path.
  const service = new TutorService() as unknown as {
    tutorProviderRuntime: () => Promise<{ settings: typeof settings; client: typeof client; learningLevel: "medium" }>;
    aiTutorOutput: (artifacts: MaterialArtifacts, module: CourseModule, chunk: SourceChunk, session: SessionSnapshot, payload: { event: "next_chunk" }) => Promise<Partial<TutorTurnOutput>>;
    sanitizeOutput: (artifacts: MaterialArtifacts, module: CourseModule, chunk: SourceChunk, session: SessionSnapshot, payload: { event: "next_chunk" }, output: Partial<TutorTurnOutput>) => TutorTurnOutput;
  };
  service.tutorProviderRuntime = async () => ({ settings, client, learningLevel: "medium" });
  const artifacts: MaterialArtifacts = {
    manifest: { id: "synthetic", projectId: "synthetic", title: coursePlan.title, sourceIds: ["synthetic"], sourceChunkIds: chunks.map((chunk) => chunk.id), generatedAt: plan.generatedAt, generatorModel: model, status: "ready" },
    overview: { paragraph: "Synthetic examples", sourceChunkIds: [], generatedAt: plan.generatedAt, generatorVersion: "smoke" },
    sourceChunks: chunks, sourceSemanticIr: ir, coursePlan, lecturePlan: { materialId: "synthetic", generatedAt: plan.generatedAt, modules: [], deepReading: plan }, conceptMap: [], visuals: [], sourceIndex: {}, figures: [], figureIndex: {}, annotations: [],
  };
  for (const index of [0, 2, 3]) {
    const chunk = chunks[index]!;
    const module = coursePlan.modules[index]!;
    const session: SessionSnapshot = { id: "synthetic", projectId: "synthetic", materialId: "synthetic", title: "Synthetic", status: "active", currentModuleId: module.id, completedModuleIds: [], currentChunkId: chunk.id, coveredChunkIds: [], model, messageSetId: null, lastRevealedRouteIndex: -1, lastRevealedMessageId: null, messages: [], createdAt: 0, updatedAt: 0 };
    const payload = { event: "next_chunk" as const };
    const raw = await service.aiTutorOutput(artifacts, module, chunk, session, payload);
    const lesson = service.sanitizeOutput(artifacts, module, chunk, session, payload, raw);
    lessons.push(lesson);
    console.log(`Lesson ${index}: ${lesson.blocks?.length} blocks, ${lesson.blocks?.filter((block) => block.grounding?.evidence.length).length} with located evidence`);
  }
}
const outputPath = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
if (outputPath) await writeFile(outputPath, JSON.stringify({ chunks, plan, lessons }, null, 2));
console.log(JSON.stringify({ provider: settings.aiProvider, model, elapsedSeconds: Math.round((Date.now() - started) / 1000), passages: plan.passages.map(({ chunkId, status, steps, connections, limitation }) => ({ chunkId, status, steps: steps.length, connections: connections.length, limitation })) }, null, 2));
if (plan.passages.some((passage) => passage.status !== "analyzed")) process.exitCode = 1;
if (lessons.some((lesson) => !lesson.blocks?.some((block) => block.grounding?.evidence.length))) process.exitCode = 1;
