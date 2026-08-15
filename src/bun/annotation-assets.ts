import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MaterialAnnotation } from "../shared/artifact-types";
import { getDb } from "./project-db";
import { dataPath } from "./paths";

type AnnotationIdentity = Pick<MaterialAnnotation, "projectId" | "materialId" | "id">;

export function annotationProjectRoot(projectId: string) {
  const row = getDb().query<{ root_path: string | null }, [string]>("SELECT root_path FROM projects WHERE id = ?").get(projectId);
  if (!row) throw new Error("Project not found");
  return row.root_path || dataPath("projects");
}

export function annotationAssetDir(annotation: AnnotationIdentity) {
  return join(annotationProjectRoot(annotation.projectId), annotation.projectId, "materials", annotation.materialId, "annotation-assets", annotation.id);
}

export function externalHtmlAttachmentDir(annotation: AnnotationIdentity, attachmentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error("Invalid attachment id");
  return join(annotationAssetDir(annotation), "external-html", attachmentId);
}

export async function ensureAnnotationAssetDir(annotation: AnnotationIdentity) {
  const path = annotationAssetDir(annotation);
  await mkdir(path, { recursive: true });
  return path;
}

export async function assertRegularFileBelow(root: string, candidate: string) {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Asset path escaped its annotation root");
  const info = await lstat(candidateResolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Asset is not a regular file");
  const canonicalRoot = await realpath(rootResolved);
  const canonicalFile = await realpath(candidateResolved);
  const canonicalRel = relative(canonicalRoot, canonicalFile);
  if (!canonicalRel || canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) throw new Error("Asset path escaped its annotation root");
  return candidateResolved;
}

export async function removeAllAnnotationAssets(annotation: AnnotationIdentity) {
  await rm(annotationAssetDir(annotation), { recursive: true, force: true });
}
