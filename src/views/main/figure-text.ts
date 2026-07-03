import type { SourceFigure } from "../../shared/artifact-types";

function sameText(a: string, b: string) {
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function captionLikeText(value: string) {
  return normalized(
    value
      .replace(/^!\s*\[/, "")
      .replace(/\]\s*\([^)]*\)\s*$/, "")
      .replace(/\]\s*$/, "")
      .replace(/\(\s*file:\/\/.*$/i, "")
  );
}

function isCaptionFragment(content: string, figures: SourceFigure[]) {
  const candidate = captionLikeText(content);
  if (candidate.length < 40) return false;
  return figures.some((figure) => {
    const caption = normalized(figure.caption || "");
    return caption.length >= 40 && (caption.includes(candidate) || candidate.includes(caption));
  });
}

export function stripFigureMarkdown(content: string, figures: SourceFigure[]) {
  if (!figures.length) return content;
  if (isCaptionFragment(content, figures)) return "";
  if (!content.includes("![")) return content;
  const assetUrls = new Set(figures.map((figure) => figure.assetUrl));
  const captions = figures.map((figure) => figure.caption || "").filter(Boolean);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let skipCaption = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skipCaption && captions.some((caption) => sameText(trimmed, caption))) {
      skipCaption = false;
      continue;
    }
    skipCaption = false;
    if (trimmed.startsWith("![") && [...assetUrls].some((url) => trimmed.includes(url))) {
      skipCaption = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
