import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, Maximize2, Minimize2, X } from "lucide-react";
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

export async function readNoteImageFiles(files: File[]): Promise<PendingNoteImage[]> {
  return Promise.all(files.map(async (file, index) => {
    if (!SUPPORTED_NOTE_IMAGE_TYPES.has(file.type)) throw new Error("PNG, JPEG, WebP 또는 GIF 이미지만 추가할 수 있습니다.");
    if (!file.size || file.size > MAX_NOTE_IMAGE_BYTES) throw new Error("이미지 한 개는 8MB 이하여야 합니다.");
    const url = await readAsDataUrl(file);
    const dataBase64 = url.slice(url.indexOf(",") + 1);
    return {
      id: `pending-${crypto.randomUUID()}`,
      fileName: file.name || `note-image-${index + 1}`,
      mimeType: file.type,
      dataBase64,
      byteSize: file.size,
      url,
      ...await imageDimensions(file),
    };
  }));
}

export async function readPastedNoteImages(clipboardData: DataTransfer): Promise<PendingNoteImage[]> {
  const files = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (!files.length) return [];
  return readNoteImageFiles(files);
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
  const [previewImage, setPreviewImage] = useState<NoteImageAttachment | PendingNoteImage | null>(null);
  const [fitToViewport, setFitToViewport] = useState(true);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);

  function closePreview() {
    setPreviewImage(null);
    requestAnimationFrame(() => previewTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!previewImage) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewImage]);

  if (!images.length) return null;
  return (
    <>
      <div className="note-image-gallery" aria-label={`노트 이미지 ${images.length}개`}>
        {images.map((image) => (
          <figure key={image.id}>
            {image.url ? (
              <button
                type="button"
                className="note-image-preview-trigger"
                onClick={(event) => {
                  previewTriggerRef.current = event.currentTarget;
                  setFitToViewport(true);
                  setPreviewImage(image);
                }}
                aria-label={`${image.fileName} 크게 보기`}
                title="클릭하여 크게 보기"
              >
                <img src={image.url} alt={image.fileName} loading="lazy" />
                <span><Maximize2 size={15} /> 크게 보기</span>
              </button>
            ) : <span><ImageIcon size={20} /> 이미지를 불러올 수 없음</span>}
            {onRemove ? (
              <button className="note-image-remove" type="button" onClick={() => onRemove(image.id)} aria-label={`${image.fileName} 제거`} title="이미지 제거">
                <X size={14} />
              </button>
            ) : null}
            <figcaption>{image.fileName}</figcaption>
          </figure>
        ))}
      </div>
      {previewImage?.url ? createPortal(
        <div
          className="note-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${previewImage.fileName} 원본 이미지`}
        >
          <header>
            <div>
              <strong>{previewImage.fileName}</strong>
              {previewImage.width && previewImage.height ? <small>{previewImage.width} × {previewImage.height}px</small> : null}
            </div>
            <nav aria-label="이미지 보기 옵션">
              <button
                type="button"
                onClick={() => setFitToViewport((current) => !current)}
                aria-label={fitToViewport ? "원본 크기로 보기" : "화면에 맞추기"}
                aria-pressed={fitToViewport}
                title={fitToViewport ? "원본 크기로 보기" : "화면에 맞추기"}
              >
                {fitToViewport ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
                {fitToViewport ? "원본 크기" : "화면 맞춤"}
              </button>
              <button ref={closeButtonRef} type="button" onClick={closePreview} aria-label="이미지 미리보기 닫기" title="닫기">
                <X size={20} />
              </button>
            </nav>
          </header>
          <div
            className={`note-image-lightbox-canvas ${fitToViewport ? "fit" : "actual"}`}
            onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}
          >
            <img src={previewImage.url} alt={previewImage.fileName} />
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
