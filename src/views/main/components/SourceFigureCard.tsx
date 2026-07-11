import { useEffect, useRef, useState } from "react";
import { Check, Image as ImageIcon, Loader2, Save, Sparkles, Trash2 } from "lucide-react";
import type { MaterialAnnotation, SourceFigure } from "../../../shared/artifact-types";
import { figureExplanationLookupResult } from "../figure-annotations";
import { figureAssetFallbackAction } from "../figure-asset-fallback";
import { MarkdownContent } from "./MarkdownContent";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type SourceFigureCardProps = {
  figure: SourceFigure;
  materialId: string;
  request: RpcRequest;
  compact?: boolean;
  contextChunkIds?: string[];
  savedAnnotations?: MaterialAnnotation[];
  onAnnotationSaved?: (annotation: MaterialAnnotation) => void;
  onAnnotationDeleted?: (annotationId: string) => void;
};

function userFacingFigureError(message: string) {
  return message.replace(/^FIGURE_ASSET_MISSING:\s*/, "").replace(/^FIGURE_ASSET_TOO_LARGE:\s*/, "");
}

function cleanLocator(locator: string) {
  return locator.replace(/^before\s+/i, "").replace(/^document$/i, "").trim();
}

function captionFor(figure: SourceFigure) {
  return figure.caption?.trim() || "Figure from source";
}

const figureAssetUrlCache = new Map<string, string>();

export function SourceFigureCard({
  figure,
  materialId,
  request,
  compact = false,
  contextChunkIds = [],
  savedAnnotations = [],
  onAnnotationSaved,
  onAnnotationDeleted,
}: SourceFigureCardProps) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imageSrc, setImageSrc] = useState(() => figureAssetUrlCache.get(`${materialId}:${figure.id}`) || "");
  const [imageError, setImageError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [explanationModel, setExplanationModel] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [error, setError] = useState("");
  const fallbackAttemptedKeyRef = useRef<string | null>(null);
  const fallbackLoadingKeyRef = useRef<string | null>(null);
  const activeAssetKeyRef = useRef("");
  const mountedRef = useRef(false);
  const fallbackCacheKey = `${materialId}:${figure.id}`;
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    activeAssetKeyRef.current = fallbackCacheKey;
    const cached = figureAssetUrlCache.get(fallbackCacheKey);
    setImageSrc(cached || "");
    setImageError("");
    if (!cached) void loadFallbackAsset();
    return () => {
      mountedRef.current = false;
    };
  }, [fallbackCacheKey]);

  useEffect(() => {
    if (imageError) return;
    const timer = window.setTimeout(() => {
      const image = imageRef.current;
      if (!image || !image.complete || image.naturalWidth > 0) return;
      void loadFallbackAsset();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fallbackCacheKey, imageError, imageSrc]);

  async function loadFallbackAsset() {
    const action = figureAssetFallbackAction(
      fallbackCacheKey,
      fallbackAttemptedKeyRef.current,
      fallbackLoadingKeyRef.current
    );
    if (action === "wait") return;
    if (action === "failed") {
      setImageError("그림 파일을 불러오지 못했습니다.");
      return;
    }
    fallbackAttemptedKeyRef.current = fallbackCacheKey;
    fallbackLoadingKeyRef.current = fallbackCacheKey;
    setImageError("");
    const cached = figureAssetUrlCache.get(fallbackCacheKey);
    if (cached) {
      setImageSrc(cached);
      fallbackLoadingKeyRef.current = null;
      return;
    }

    try {
      const result = (await request("figures.getAssetUrl", { materialId, figureId: figure.id })) as { url?: string };
      if (!mountedRef.current || activeAssetKeyRef.current !== fallbackCacheKey) return;
      if (!result.url) {
        setImageError("그림 파일을 불러오지 못했습니다.");
        return;
      }
      figureAssetUrlCache.set(fallbackCacheKey, result.url);
      setImageError("");
      setImageSrc(result.url);
    } catch (err) {
      if (!mountedRef.current || activeAssetKeyRef.current !== fallbackCacheKey) return;
      const message = (err as Error).message || String(err);
      setImageError(userFacingFigureError(message) || "그림 파일을 불러오지 못했습니다.");
    } finally {
      if (fallbackLoadingKeyRef.current === fallbackCacheKey) fallbackLoadingKeyRef.current = null;
    }
  }

  async function explain() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request("figures.explain", { materialId, figureId: figure.id, contextChunkIds })) as { explanation: string; model: string };
      setExplanation(result.explanation);
      setExplanationModel(result.model);
      setSaveState("idle");
    } catch (err) {
      const message = (err as Error).message || String(err);
      setError(
        message.includes("VISION_MODEL_REQUIRED")
          ? "이 그림 설명에는 vision-capable model이 필요합니다. Settings에서 Figure vision model을 선택하세요."
          : userFacingFigureError(message)
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveExplanation() {
    const body = explanation.trim();
    const chunkId = contextChunkIds[0] || figure.sourceChunkIds[0];
    if (!body || !chunkId || saving || saveState === "saved" || savedAnnotations.length) return;
    setSaving(true);
    setError("");
    try {
      const result = figureExplanationLookupResult(figure, body, explanationModel);
      const saved = (await request("annotations.save", {
        materialId,
        chunkId,
        surface: "source",
        kind: result.kind,
        selectedText: result.query,
        result,
        sourceMeta: result.sourceMeta,
      })) as MaterialAnnotation;
      setSaveState("saved");
      onAnnotationSaved?.(saved);
    } catch (err) {
      const message = (err as Error).message || String(err);
      setError(`설명 저장 실패: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  const canSaveExplanation = Boolean(explanation.trim() && (contextChunkIds[0] || figure.sourceChunkIds[0]) && !savedAnnotations.length && saveState !== "saved");

  return (
    <figure className={`source-figure-card ${compact ? "compact" : ""}`}>
      <div className="source-figure-media">
        {imageError ? (
          <div className="source-figure-image-error">
            <ImageIcon size={18} />
            <span>{imageError}</span>
          </div>
        ) : !imageSrc ? (
          <div className="source-figure-image-error" aria-label="그림 파일 불러오는 중">
            <Loader2 size={18} className="spin" />
            <span>그림 파일을 불러오는 중입니다.</span>
          </div>
        ) : (
          <img
            ref={imageRef}
            src={imageSrc}
            alt={captionFor(figure)}
            loading={compact ? "eager" : "lazy"}
            onLoad={() => setImageError("")}
            onError={() => void loadFallbackAsset()}
          />
        )}
      </div>
      <figcaption>
        <div>
          <span><ImageIcon size={14} /> {cleanLocator(figure.locator) || "Source figure"}</span>
          <p>{captionFor(figure)}</p>
        </div>
        <button type="button" onClick={explain} disabled={busy} title="그림 설명">
          {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
          설명
        </button>
      </figcaption>
      {error ? <p className="source-figure-error">{error}</p> : null}
      {explanation ? (
        <div className="source-figure-explanation">
          <div className="source-figure-explanation-actions">
            <span>그림 설명</span>
            <button type="button" onClick={saveExplanation} disabled={!canSaveExplanation || saving} title="annotation으로 저장">
              {saving ? <Loader2 size={14} className="spin" /> : saveState === "saved" || savedAnnotations.length ? <Check size={14} /> : <Save size={14} />}
              {saveState === "saved" || savedAnnotations.length ? "저장됨" : "저장"}
            </button>
          </div>
          <MarkdownContent content={explanation} compact />
        </div>
      ) : null}
      {savedAnnotations.length && !explanation ? (
        <div className="source-figure-saved-explanations">
          {savedAnnotations.map((annotation) => (
            annotation.result.kind === "lookup" ? (
              <div key={annotation.id} className="source-figure-explanation saved">
                <div className="source-figure-explanation-actions">
                  <span>저장된 그림 설명</span>
                  {onAnnotationDeleted ? (
                    <button type="button" onClick={() => onAnnotationDeleted(annotation.id)} title="삭제" aria-label="저장된 그림 설명 삭제">
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <Check size={14} />
                  )}
                </div>
                <MarkdownContent content={annotation.result.body} compact />
              </div>
            ) : null
          ))}
        </div>
      ) : null}
    </figure>
  );
}
