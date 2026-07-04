import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Sparkles } from "lucide-react";
import type { SourceFigure } from "../../../shared/artifact-types";
import { MarkdownContent } from "./MarkdownContent";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type SourceFigureCardProps = {
  figure: SourceFigure;
  materialId: string;
  request: RpcRequest;
  compact?: boolean;
  contextChunkIds?: string[];
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

const figureDataUrlCache = new Map<string, string>();

export function SourceFigureCard({ figure, materialId, request, compact = false, contextChunkIds = [] }: SourceFigureCardProps) {
  const [busy, setBusy] = useState(false);
  const [imageSrc, setImageSrc] = useState(figure.assetUrl);
  const [imageError, setImageError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");
  const fallbackAttemptedRef = useRef(false);
  const mountedRef = useRef(false);
  const fallbackCacheKey = `${materialId}:${figure.id}`;

  useEffect(() => {
    mountedRef.current = true;
    fallbackAttemptedRef.current = false;
    setImageSrc(figure.assetUrl);
    setImageError("");
    return () => {
      mountedRef.current = false;
    };
  }, [fallbackCacheKey, figure.assetUrl]);

  async function loadFallbackAsset() {
    if (fallbackAttemptedRef.current) {
      setImageError("그림 파일을 불러오지 못했습니다.");
      return;
    }
    fallbackAttemptedRef.current = true;
    const cached = figureDataUrlCache.get(fallbackCacheKey);
    if (cached) {
      setImageSrc(cached);
      return;
    }

    try {
      const result = (await request("figures.getAsset", { materialId, figureId: figure.id })) as { dataUrl?: string };
      if (!mountedRef.current) return;
      if (!result.dataUrl) {
        setImageError("그림 파일을 불러오지 못했습니다.");
        return;
      }
      figureDataUrlCache.set(fallbackCacheKey, result.dataUrl);
      setImageSrc(result.dataUrl);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = (err as Error).message || String(err);
      setImageError(userFacingFigureError(message) || "그림 파일을 불러오지 못했습니다.");
    }
  }

  async function explain() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request("figures.explain", { materialId, figureId: figure.id, contextChunkIds })) as { explanation: string; model: string };
      setExplanation(result.explanation);
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

  return (
    <figure className={`source-figure-card ${compact ? "compact" : ""}`}>
      <div className="source-figure-media">
        {imageError ? (
          <div className="source-figure-image-error">
            <ImageIcon size={18} />
            <span>{imageError}</span>
          </div>
        ) : (
          <img
            src={imageSrc}
            alt={captionFor(figure)}
            loading="lazy"
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
          <MarkdownContent content={explanation} compact />
        </div>
      ) : null}
    </figure>
  );
}
