import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaterialAnnotation, NoteImageAttachment, NoteImageUpload } from "../shared/artifact-types";
import { getMaterialAnnotation } from "./annotation-store";
import { annotationAssetDir } from "./annotation-assets";

export const MAX_NOTE_IMAGE_COUNT = 8;
export const MAX_NOTE_IMAGE_BYTES = 8_000_000;
export const MAX_NOTE_IMAGE_TOTAL_BYTES = 24_000_000;

const EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

type SupportedMimeType = keyof typeof EXTENSION_BY_MIME;

function assetPath(annotation: Pick<MaterialAnnotation, "projectId" | "materialId" | "id">, imageId: string, mimeType: SupportedMimeType) {
  return join(annotationAssetDir(annotation), `${imageId}.${EXTENSION_BY_MIME[mimeType]}`);
}

function decodeBase64(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > Math.ceil(MAX_NOTE_IMAGE_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("붙여넣은 이미지 데이터가 올바르지 않습니다.");
  }
  return Buffer.from(normalized, "base64");
}

function detectedMimeType(bytes: Uint8Array): SupportedMimeType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}

function cleanFileName(value: string, mimeType: SupportedMimeType) {
  const fallback = `pasted-image.${EXTENSION_BY_MIME[mimeType]}`;
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

function safeDimension(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 50_000 ? Math.round(value) : undefined;
}

export async function saveNoteImageUploads(
  annotation: Pick<MaterialAnnotation, "projectId" | "materialId" | "id">,
  uploads: NoteImageUpload[],
  existing: NoteImageAttachment[] = []
) {
  if (existing.length + uploads.length > MAX_NOTE_IMAGE_COUNT) throw new Error(`노트에는 이미지를 최대 ${MAX_NOTE_IMAGE_COUNT}개까지 저장할 수 있습니다.`);
  if (!uploads.length) return [];
  const existingBytes = existing.reduce((sum, image) => sum + Math.max(0, image.byteSize || 0), 0);
  const prepared = uploads.map((upload) => {
    const bytes = decodeBase64(upload.dataBase64);
    if (!bytes.length || bytes.length > MAX_NOTE_IMAGE_BYTES) throw new Error("이미지 한 개는 8MB 이하여야 합니다.");
    const mimeType = detectedMimeType(bytes);
    if (!mimeType || mimeType !== upload.mimeType) throw new Error("PNG, JPEG, WebP 또는 GIF 이미지만 붙여넣을 수 있습니다.");
    const id = crypto.randomUUID();
    const attachment: NoteImageAttachment = {
      id,
      fileName: cleanFileName(upload.fileName, mimeType),
      mimeType,
      byteSize: bytes.length,
      ...(safeDimension(upload.width) ? { width: safeDimension(upload.width) } : {}),
      ...(safeDimension(upload.height) ? { height: safeDimension(upload.height) } : {}),
    };
    return { bytes, attachment };
  });
  if (existingBytes + prepared.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_NOTE_IMAGE_TOTAL_BYTES) {
    throw new Error("노트 이미지의 전체 용량은 24MB 이하여야 합니다.");
  }

  const dir = annotationAssetDir(annotation);
  await mkdir(dir, { recursive: true });
  const written: NoteImageAttachment[] = [];
  try {
    for (const image of prepared) {
      await writeFile(assetPath(annotation, image.attachment.id, image.attachment.mimeType), image.bytes, { flag: "wx" });
      written.push(image.attachment);
    }
    return written;
  } catch (error) {
    await Promise.all(written.map((image) => rm(assetPath(annotation, image.id, image.mimeType), { force: true })));
    throw error;
  }
}

export async function removeNoteImageFiles(annotation: Pick<MaterialAnnotation, "projectId" | "materialId" | "id">, images: NoteImageAttachment[]) {
  await Promise.all(images.map((image) => rm(assetPath(annotation, image.id, image.mimeType), { force: true })));
}

export function resolveNoteImageAsset(annotationId: string, imageId: string) {
  const annotation = getMaterialAnnotation(annotationId);
  if (!annotation || annotation.result.kind !== "note") return null;
  const image = (annotation.result.images || []).find((item) => item.id === imageId);
  if (!image) return null;
  return { path: assetPath(annotation, image.id, image.mimeType), mimeType: image.mimeType };
}
