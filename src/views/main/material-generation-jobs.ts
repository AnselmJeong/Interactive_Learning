import type { GenerationProgress } from "../../shared/rpc-types";

// Learning-material generation (topic extraction, passage/explanation linking, study material
// assembly) can run for minutes. These jobs run in the background so the learner can keep
// studying; the UI tracks them here instead of through the global `busy` lock.

export type MaterialGenerationJob = {
  key: string;
  projectId: string;
  sourceIds: string[];
  forceNewVersion: boolean;
  progress: GenerationProgress | null;
  startedAt: number;
  updatedAt: number;
};

export type MaterialGenerationJobs = Record<string, MaterialGenerationJob>;

export function materialGenerationJobKey(projectId: string, sourceIds: string[], forceNewVersion = false) {
  return `${forceNewVersion ? "new" : "reuse"}:${projectId}:${[...new Set(sourceIds)].sort().join(",")}`;
}

export function startMaterialGenerationJob(
  jobs: MaterialGenerationJobs,
  projectId: string,
  sourceIds: string[],
  forceNewVersion: boolean,
  now = Date.now(),
): MaterialGenerationJobs {
  const key = materialGenerationJobKey(projectId, sourceIds, forceNewVersion);
  if (jobs[key]) return jobs;
  return { ...jobs, [key]: { key, projectId, sourceIds: [...sourceIds], forceNewVersion, progress: null, startedAt: now, updatedAt: now } };
}

export function finishMaterialGenerationJob(jobs: MaterialGenerationJobs, key: string): MaterialGenerationJobs {
  if (!jobs[key]) return jobs;
  const next = { ...jobs };
  delete next[key];
  return next;
}

// Progress events carry the source set they belong to, so concurrent jobs each keep their own
// bar. Terminal events are ignored here: the job is removed when its request settles.
export function applyMaterialGenerationProgress(
  jobs: MaterialGenerationJobs,
  progress: GenerationProgress,
  now = Date.now(),
): MaterialGenerationJobs {
  if (progress.stage === "complete" || progress.stage === "failed") return jobs;
  const key = progress.sourceIds?.length
    ? materialGenerationJobKey(progress.projectId, progress.sourceIds, Boolean(progress.forceNewVersion))
    : null;
  const target = key && jobs[key]
    ? jobs[key]
    : Object.values(jobs).find((job) => progress.materialId && job.progress?.materialId === progress.materialId)
      || (!key ? latestJob(Object.values(jobs).filter((job) => job.projectId === progress.projectId)) : null);
  if (target) return { ...jobs, [target.key]: { ...target, progress, updatedAt: now } };
  if (!key || !progress.sourceIds?.length) return jobs;
  // A job started elsewhere (e.g. the background message preparation) still gets a visible bar.
  return {
    ...jobs,
    [key]: {
      key,
      projectId: progress.projectId,
      sourceIds: [...progress.sourceIds],
      forceNewVersion: Boolean(progress.forceNewVersion),
      progress,
      startedAt: now,
      updatedAt: now,
    },
  };
}

function latestJob(jobs: MaterialGenerationJob[]) {
  return jobs.reduce<MaterialGenerationJob | null>((latest, job) => (!latest || job.updatedAt > latest.updatedAt ? job : latest), null);
}

// The status pill shows the most recently updated job and how many others are running.
export function primaryMaterialGenerationJob(jobs: MaterialGenerationJobs) {
  const all = Object.values(jobs);
  const withProgress = all.filter((job) => job.progress);
  return { job: latestJob(withProgress.length ? withProgress : all), total: all.length };
}
