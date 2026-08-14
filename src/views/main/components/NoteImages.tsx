import { Image as ImageIcon, X } from "lucide-react";
import type { NoteImageAttachment, NoteImageUpload } from "../../../shared/artifact-types";

export const MAX_NOTE_IMAGES = 8;
const MAX_NOTE_IMAGE_BYTES = 8_000_000;
const SUPPORTED_NOTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type PendingNoteImage = NoteImageUpload & {
  id: string;
  byteSize: number;
  url: string;
};

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("이미지를 읽지 못했습니다."));
    reader.onerror = () => reject(reader.error || new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

async function imageDimensions(file: File) {
  if (typeof createImageBitmap !== "function") return {};
  try {
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    return {};
  }
}

export async function readPastedNoteImages(clipboardData: DataTransfer): Promise<PendingNoteImage[]> {
  const files = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (!files.length) return [];
  return Promise.all(files.map(async (file, index) => {
    if (!SUPPORTED_NOTE_IMAGE_TYPES.has(file.type)) throw new Error("PNG, JPEG, WebP 또는 GIF 이미지만 붙여넣을 수 있습니다.");
    if (!file.size || file.size > MAX_NOTE_IMAGE_BYTES) throw new Error("이미지 한 개는 8MB 이하여야 합니다.");
    const url = await readAsDataUrl(file);
    const dataBase64 = url.slice(url.indexOf(",") + 1);
    return {
      id: `pending-${crypto.randomUUID()}`,
      fileName: file.name || `pasted-image-${index + 1}`,
      mimeType: file.type,
      dataBase64,
      byteSize: file.size,
      url,
      ...await imageDimensions(file),
    };
  }));
}

export function noteImageUpload(image: PendingNoteImage): NoteImageUpload {
  return {
    fileName: image.fileName,
    mimeType: image.mimeType,
    dataBase64: image.dataBase64,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
  };
}

export function NoteImageGallery({
  images,
  onRemove,
}: {
  images: Array<NoteImageAttachment | PendingNoteImage>;
  onRemove?: (imageId: string) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="note-image-gallery" aria-label={`노트 이미지 ${images.length}개`}>
      {images.map((image) => (
        <figure key={image.id}>
          {image.url ? <img src={image.url} alt={image.fileName} loading="lazy" /> : <span><ImageIcon size={20} /> 이미지를 불러올 수 없음</span>}
          {onRemove ? (
            <button type="button" onClick={() => onRemove(image.id)} aria-label={`${image.fileName} 제거`} title="이미지 제거">
              <X size={14} />
            </button>
          ) : null}
          <figcaption>{image.fileName}</figcaption>
        </figure>
      ))}
    </div>
  );
}
