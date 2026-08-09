const INLINE_MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\(\s*(?:<[^>\r\n]*>|(?:\\.|[^)\r\n])*)\s*\)/g;
const REFERENCE_MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\s*\[[^\]\r\n]*\]/g;

/**
 * Removes Markdown image tokens while preserving any prose that shares the line.
 * Images are rendered separately in Learnie, so their asset URLs must never leak
 * into source excerpts or learner-facing tutor copy.
 */
export function stripMarkdownImageTokens(value: string) {
  if (!value.includes("![")) return value;
  return value
    .replace(INLINE_MARKDOWN_IMAGE, "")
    .replace(REFERENCE_MARKDOWN_IMAGE, "")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
