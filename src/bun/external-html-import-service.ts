import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  AnnotationAttachment,
  ExternalHtmlAttachment,
  ExternalHtmlImportPreview,
  MaterialAnnotation,
} from "../shared/artifact-types";
import { externalHtmlAttachmentDir, annotationAssetDir, assertRegularFileBelow } from "./annotation-assets";
import { getMaterialAnnotation, updateMaterialAnnotationAttachments } from "./annotation-store";
import { MAX_EXTERNAL_HTML_ORIGINAL_BYTES, prepareExternalHtmlBytes, type PreparedExternalHtml } from "./external-html-policy";
import { writeMaterialAnnotationsSnapshot } from "./project-bundle-sync";
import { SettingsService } from "./settings-service";

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export type ExternalHtmlManifest = {
  schemaVersion: 1;
  policyVersion: 1;
  attachment: ExternalHtmlAttachment;
  transforms: string[];
  files: {
    original: { name: "original.html"; sha256: string; byteSize: number };
    runnable: { name: "runnable.html"; sha256: string; byteSize: number };
  };
};

type StagedPreview = {
  preview: ExternalHtmlImportPreview;
  prepared: PreparedExternalHtml;
  originalBytes: Uint8Array;
};

function sha256(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function externalAttachments(annotation: MaterialAnnotation) {
  return (annotation.attachments || []).filter((item): item is ExternalHtmlAttachment => item.kind === "external_html");
}

function safeExportName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "external-applet.html";
}

function collisionSafeFile(folder: string, fileName: string) {
  const extension = extname(fileName) || ".html";
  const stem = basename(fileName, extension);
  let path = join(folder, `${stem}${extension}`);
  for (let index = 2; existsSync(path); index += 1) path = join(folder, `${stem}-${index}${extension}`);
  return path;
}

export async function validateExternalHtmlAttachment(annotation: MaterialAnnotation, attachment: ExternalHtmlAttachment) {
  if (!externalAttachments(annotation).some((item) => item.id === attachment.id)) throw new Error("Attachment does not belong to annotation");
  const dir = externalHtmlAttachmentDir(annotation, attachment.id);
  const root = annotationAssetDir(annotation);
  const manifestPath = await assertRegularFileBelow(root, join(dir, "manifest.json"));
  const originalPath = await assertRegularFileBelow(root, join(dir, "original.html"));
  const runnablePath = await assertRegularFileBelow(root, join(dir, "runnable.html"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExternalHtmlManifest;
  if (manifest.schemaVersion !== 1 || manifest.policyVersion !== 1 || manifest.attachment.id !== attachment.id) throw new Error("Attachment manifest is incompatible");
  if (JSON.stringify(manifest.attachment) !== JSON.stringify(attachment)) throw new Error("Attachment metadata does not match its manifest");
  const [original, runnable] = await Promise.all([readFile(originalPath), readFile(runnablePath)]);
  if (original.length !== attachment.originalByteSize || sha256(original) !== attachment.originalSha256) throw new Error("Original HTML hash mismatch");
  if (runnable.length !== attachment.runnableByteSize || sha256(runnable) !== attachment.runnableSha256) throw new Error("Runnable HTML hash mismatch");
  return { dir, manifest, originalPath, runnablePath, original, runnable };
}

export class ExternalHtmlImportService {
  private readonly previews = new Map<string, StagedPreview>();
  private readonly settings = new SettingsService();

  constructor(private readonly chooseHtmlFile: () => Promise<string>) {}

  private discardExpired(now = Date.now()) {
    for (const [id, staged] of this.previews) {
      if (staged.preview.expiresAt <= now) this.previews.delete(id);
    }
  }

  async prepare(annotationId: string | null = null): Promise<ExternalHtmlImportPreview | null> {
    this.discardExpired();
    if (annotationId && !getMaterialAnnotation(annotationId)) throw new Error("Annotation not found");
    const selectedPath = await this.chooseHtmlFile();
    if (!selectedPath) return null;
    const extension = extname(selectedPath).toLowerCase();
    const reasons = [] as ExternalHtmlImportPreview["rejectionReasons"];
    if (extension !== ".html" && extension !== ".htm") reasons.push({ code: "invalid_extension", message: ".html 또는 .htm 파일만 가져올 수 있습니다." });
    const info = await lstat(selectedPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) reasons.push({ code: "not_regular_file", message: "일반 HTML 파일만 가져올 수 있습니다." });
    if (info?.isFile() && info.size > MAX_EXTERNAL_HTML_ORIGINAL_BYTES) reasons.push({ code: "original_too_large", message: "HTML 원본은 2 MiB 이하여야 합니다." });
    const originalBytes = reasons.length === 0 ? await readFile(selectedPath) : new Uint8Array();
    const prepared = reasons.length === 0
      ? await prepareExternalHtmlBytes(originalBytes, basename(selectedPath))
      : {
          title: basename(selectedPath, extension) || "대화형 설명",
          originalText: "",
          runnableText: "",
          dependencies: [],
          dependencyLicenses: [],
          rejectionReasons: [],
        } satisfies PreparedExternalHtml;
    reasons.push(...prepared.rejectionReasons);
    const previewId = crypto.randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    const preview: ExternalHtmlImportPreview = {
      previewId,
      annotationId,
      title: prepared.title,
      originalFileName: safeExportName(basename(selectedPath)),
      originalByteSize: info?.isFile() ? info.size : 0,
      status: reasons.length ? "rejected" : prepared.dependencies.length ? "ready_after_localization" : "ready",
      dependencies: prepared.dependencies,
      blockedCapabilities: ["네트워크", "새 창", "다운로드", "host 통신", "persistent storage"],
      rejectionReasons: reasons,
      expiresAt,
    };
    if (!reasons.length) this.previews.set(previewId, { preview, prepared, originalBytes });
    return preview;
  }

  cancel(previewId: string) {
    return { cancelled: this.previews.delete(previewId) };
  }

  async commit(annotationId: string, previewId: string, expectedAnnotationUpdatedAt: number) {
    this.discardExpired();
    const staged = this.previews.get(previewId);
    if (!staged || (staged.preview.annotationId && staged.preview.annotationId !== annotationId)) {
      throw new Error("IMPORT_PREVIEW_EXPIRED: 가져오기 분석이 만료되었습니다.");
    }
    const annotation = getMaterialAnnotation(annotationId);
    if (!annotation) throw new Error("Annotation not found");
    if (annotation.updatedAt !== expectedAnnotationUpdatedAt) throw new Error("ANNOTATION_STALE: annotation이 변경되었습니다. 다시 시도해 주세요.");
    const attachmentId = crypto.randomUUID();
    const originalSha256 = sha256(staged.originalBytes);
    const runnableBytes = utf8(staged.prepared.runnableText);
    const attachment: ExternalHtmlAttachment = {
      kind: "external_html",
      schemaVersion: 1,
      id: attachmentId,
      title: staged.prepared.title,
      originalFileName: staged.preview.originalFileName,
      originalByteSize: staged.originalBytes.length,
      runnableByteSize: runnableBytes.length,
      originalSha256,
      runnableSha256: sha256(runnableBytes),
      compatibility: staged.prepared.dependencies.length ? "localized" : "self_contained",
      importerVersion: 1,
      dependencies: staged.prepared.dependencies,
      importedAt: Date.now(),
    };
    const manifest: ExternalHtmlManifest = {
      schemaVersion: 1,
      policyVersion: 1,
      attachment,
      transforms: staged.prepared.dependencies.map((dependency) => `inline:${dependency.bundledAssetId}`),
      files: {
        original: { name: "original.html", sha256: attachment.originalSha256, byteSize: attachment.originalByteSize },
        runnable: { name: "runnable.html", sha256: attachment.runnableSha256, byteSize: attachment.runnableByteSize },
      },
    };
    const parent = join(annotationAssetDir(annotation), "external-html");
    const finalDir = externalHtmlAttachmentDir(annotation, attachmentId);
    const tempDir = join(parent, `.${attachmentId}.tmp-${crypto.randomUUID()}`);
    await mkdir(join(tempDir, "licenses"), { recursive: true });
    try {
      await Promise.all([
        writeFile(join(tempDir, "original.html"), staged.originalBytes, { flag: "wx" }),
        writeFile(join(tempDir, "runnable.html"), runnableBytes, { flag: "wx" }),
        writeFile(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }),
        ...staged.prepared.dependencyLicenses.map((license) => writeFile(join(tempDir, "licenses", license.fileName), license.bytes, { flag: "wx" })),
      ]);
      const [writtenOriginal, writtenRunnable] = await Promise.all([readFile(join(tempDir, "original.html")), readFile(join(tempDir, "runnable.html"))]);
      if (sha256(writtenOriginal) !== attachment.originalSha256 || sha256(writtenRunnable) !== attachment.runnableSha256) throw new Error("Attachment verification failed after writing");
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }

    const previousAttachments = annotation.attachments || [];
    const nextAttachments: AnnotationAttachment[] = [...previousAttachments.filter((item) => item.kind !== "external_html"), attachment];
    let updated: MaterialAnnotation | null = null;
    try {
      updated = updateMaterialAnnotationAttachments(annotation.id, nextAttachments, annotation.updatedAt);
      if (!updated) throw new Error("Updated annotation could not be loaded");
      await writeMaterialAnnotationsSnapshot(annotation.materialId);
    } catch (error) {
      if (updated) {
        try {
          updateMaterialAnnotationAttachments(annotation.id, previousAttachments, updated.updatedAt);
          await writeMaterialAnnotationsSnapshot(annotation.materialId);
        } catch { /* recovery will surface the orphan as a sync issue */ }
      }
      await rm(finalDir, { recursive: true, force: true });
      throw error;
    }
    this.previews.delete(previewId);
    await Promise.all(externalAttachments(annotation).map((old) => rm(externalHtmlAttachmentDir(annotation, old.id), { recursive: true, force: true })))
      .catch((error) => console.warn(`[external-html] Failed to remove replaced attachment assets: ${(error as Error).message}`));
    return updated;
  }

  async remove(annotationId: string, attachmentId: string, expectedAnnotationUpdatedAt: number) {
    const annotation = getMaterialAnnotation(annotationId);
    if (!annotation) throw new Error("Annotation not found");
    const target = externalAttachments(annotation).find((item) => item.id === attachmentId);
    if (!target) throw new Error("External HTML attachment not found");
    if (annotation.updatedAt !== expectedAnnotationUpdatedAt) throw new Error("ANNOTATION_STALE: annotation이 변경되었습니다. 다시 시도해 주세요.");
    const previous = annotation.attachments || [];
    const next = previous.filter((item) => item.id !== attachmentId);
    const updated = updateMaterialAnnotationAttachments(annotation.id, next, annotation.updatedAt);
    if (!updated) throw new Error("Updated annotation could not be loaded");
    try {
      await writeMaterialAnnotationsSnapshot(annotation.materialId);
    } catch (error) {
      updateMaterialAnnotationAttachments(annotation.id, previous, updated.updatedAt);
      throw error;
    }
    try {
      await rm(externalHtmlAttachmentDir(annotation, attachmentId), { recursive: true, force: true });
      return updated;
    } catch (error) {
      console.warn(`[external-html] Failed to remove detached attachment assets: ${(error as Error).message}`);
      return { ...updated, syncWarning: "대화형 설명 metadata는 삭제했지만 일부 파일은 다음 정리 때 제거됩니다." };
    }
  }

  async exportOriginal(annotationId: string, attachmentId: string) {
    const annotation = getMaterialAnnotation(annotationId);
    if (!annotation) throw new Error("Annotation not found");
    const attachment = externalAttachments(annotation).find((item) => item.id === attachmentId);
    if (!attachment) throw new Error("External HTML attachment not found");
    const validated = await validateExternalHtmlAttachment(annotation, attachment);
    const settings = await this.settings.get();
    await mkdir(settings.defaultDownloadFolder, { recursive: true });
    const path = collisionSafeFile(settings.defaultDownloadFolder, safeExportName(attachment.originalFileName));
    await copyFile(validated.originalPath, path);
    return { exported: true, fileName: basename(path) };
  }

  clear() {
    this.previews.clear();
  }
}
