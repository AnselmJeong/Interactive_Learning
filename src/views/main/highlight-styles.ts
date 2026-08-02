import type { HighlightResult } from "../../shared/artifact-types";

export type HighlightStyle = NonNullable<HighlightResult["style"]>;

export const DEFAULT_SHORTCUT_HIGHLIGHT_STYLE: HighlightStyle = "red-underline";

export const HIGHLIGHT_STYLE_OPTIONS: ReadonlyArray<{
  style: HighlightStyle;
  label: string;
}> = [
  { style: "marker-yellow", label: "노란색 형광펜" },
  { style: "marker-green", label: "초록색 형광펜" },
  { style: "marker-blue", label: "파란색 형광펜" },
  { style: "red-underline", label: "빨간 밑줄 (U)" },
];
