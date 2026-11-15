import { describe, expect, test } from "bun:test";
import {
  applyMaterialGenerationProgress,
  documentSourcesNeedingAnalysis,
  sourceAnalysisState,
  finishMaterialGenerationJob,
  materialGenerationJobKey,
  primaryMaterialGenerationJob,
  startMaterialGenerationJob,
} from "./material-generation-jobs";

describe("material generation jobs", () => {
  test("keys are stable across source order and separate new versions", () => {
    expect(materialGenerationJobKey("p", ["b", "a"])).toBe(materialGenerationJobKey("p", ["a", "b"]));
    expect(materialGenerationJobKey("p", ["a"], true)).not.toBe(materialGenerationJobKey("p", ["a"]));
  });

  test("tracks concurrent jobs with their own progress", () => {
    let jobs = startMaterialGenerationJob({}, "p", ["a"], false, 1);
    jobs = startMaterialGenerationJob(jobs, "p", ["b"], true, 2);
    jobs = applyMaterialGenerationProgress(jobs, { projectId: "p", materialId: "m-a", sourceIds: ["a"], stage: "brief", message: "A", progress: 40 }, 3);
    jobs = applyMaterialGenerationProgress(jobs, { projectId: "p", materialId: "m-b", sourceIds: ["b"], forceNewVersion: true, stage: "graph", message: "B", progress: 70 }, 4);

    expect(jobs[materialGenerationJobKey("p", ["a"])]?.progress?.progress).toBe(40);
    expect(jobs[materialGenerationJobKey("p", ["b"], true)]?.progress?.progress).toBe(70);
    const primary = primaryMaterialGenerationJob(jobs);
    expect(primary.total).toBe(2);
    expect(primary.job?.progress?.message).toBe("B");
  });

  test("terminal events do not resurrect jobs and finishing removes them", () => {
    let jobs = startMaterialGenerationJob({}, "p", ["a"], false, 1);
    const key = materialGenerationJobKey("p", ["a"]);
    jobs = finishMaterialGenerationJob(jobs, key);
    jobs = applyMaterialGenerationProgress(jobs, { projectId: "p", sourceIds: ["a"], stage: "complete", message: "done", progress: 100 });
    expect(jobs).toEqual({});
  });

  test("shows jobs started elsewhere once their progress arrives", () => {
    const jobs = applyMaterialGenerationProgress({}, { projectId: "p", sourceIds: ["c"], stage: "normalize", message: "C", progress: 5 });
    expect(primaryMaterialGenerationJob(jobs).job?.sourceIds).toEqual(["c"]);
  });

  test("batch analysis queues only document sources without a ready material, in order", () => {
    const sources = [
      { id: "s1", documentId: "d" },
      { id: "s2", documentId: "d" },
      { id: "x", documentId: "other" },
      { id: "s3", documentId: "d" },
    ];
    const materials = [
      { sourceIds: ["s1"], status: "ready" },
      { sourceIds: ["s2"], status: "failed" },
      { sourceIds: ["s3", "s1"], status: "ready" },
    ];
    expect(documentSourcesNeedingAnalysis(sources, materials, "d")).toEqual(["s2", "s3"]);
  });

  test("reports per-source analysis state", () => {
    const jobs = startMaterialGenerationJob({}, "p", ["s2"], false, 1);
    const batch = {
      projectId: "p", documentId: "d", sourceIds: ["s2", "s3", "s4"],
      completedSourceIds: [], failedSourceIds: ["s4"], currentSourceId: "s2", stopRequested: false,
    };
    const materials = [{ sourceIds: ["s1"], status: "ready" }];
    expect(sourceAnalysisState("s1", materials, jobs, batch)).toBe("ready");
    expect(sourceAnalysisState("s2", materials, jobs, batch)).toBe("running");
    expect(sourceAnalysisState("s3", materials, jobs, batch)).toBe("queued");
    expect(sourceAnalysisState("s4", materials, jobs, batch)).toBe("failed");
    expect(sourceAnalysisState("s3", materials, jobs, { ...batch, stopRequested: true })).toBe("none");
    expect(sourceAnalysisState("s5", materials, {}, null)).toBe("none");
  });
});
