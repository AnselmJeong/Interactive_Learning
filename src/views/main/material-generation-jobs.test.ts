import { describe, expect, test } from "bun:test";
import {
  applyMaterialGenerationProgress,
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
});
