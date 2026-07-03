import { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2, Sparkles } from "lucide-react";
import type { SourceFigure } from "../../../shared/artifact-types";
import { MarkdownContent } from "./MarkdownContent";

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;

type SourceFigureCardProps = {
  figure: SourceFigure;
  materialId: string;
  request: RpcRequest;
  compact?: boolean;
};

function cleanLocator(locator: string) {
  return locator.replace(/^before\s+/i, "").replace(/^document$/i, "").trim();
}

function captionFor(figure: SourceFigure) {
  return figure.caption?.trim() || "Figure from source";
}

export function SourceFigureCard({ figure, materialId, request, compact = false }: SourceFigureCardProps) {
  const [busy, setBusy] = useState(false);
  const [imageSrc, setImageSrc] = useState(figure.assetUrl);
  const [imageError, setImageError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    setImageSrc(figure.assetUrl);
    setImageError("");

    void request("figures.getAsset", { materialId, figureId: figure.id })
      .then((result) => {
        if (!mounted) return;
        const asset = result as { dataUrl?: string };
        if (asset.dataUrl) setImageSrc(asset.dataUrl);
      })
      .catch((err) => {
        if (!mounted) return;
        const message = (err as Error).message || String(err);
        setImageError(message.replace(/^FIGURE_ASSET_MISSING:\s*/, "") || "그림 파일을 불러오지 못했습니다.");
      });

    return () => {
      mounted = false;
    };
  }, [figure.assetUrl, figure.id, materialId, request]);

  async function explain() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request("figures.explain", { materialId, figureId: figure.id })) as { explanation: string; model: string };
      setExplanation(result.explanation);
    } catch (err) {
      const message = (err as Error).message || String(err);
      setError(
        message.includes("VISION_MODEL_REQUIRED")
          ? "이 그림 설명에는 vision-capable model이 필요합니다. Settings에서 Figure vision model을 선택하세요."
          : message.replace(/^FIGURE_ASSET_MISSING:\s*/, "")
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
            onError={() => setImageError("그림 파일을 불러오지 못했습니다.")}
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
