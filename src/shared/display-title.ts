const ZERO_WIDTH_MARKS = /[\u200b\u200c\u200d\ufeff]/gu;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]+\)/gu;
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const MARKDOWN_WRAPPED_SPAN =
  /(^|[\s([{>"'“‘])(\*{1,3}|_{1,3})(?=\S)([^\n]*?\S)\2(?=$|[\s.,;:!?)}\]"'”’가-힣])/gu;

export function plainDisplayText(value: string) {
  let text = value
    .replace(ZERO_WIDTH_MARKS, "")
    .replace(/\\([*_`\[\]()])/gu, "$1")
    .replace(MARKDOWN_IMAGE, "$1")
    .replace(MARKDOWN_LINK, "$1")
    .replace(INLINE_CODE, "$1");

  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(MARKDOWN_WRAPPED_SPAN, "$1$3");
    if (next === text) break;
    text = next;
  }

  return text.replace(/\s+/g, " ").trim();
}

export function displayableCourseTitle(title: string) {
  return plainDisplayText(title).replace(/\s+course$/i, "").trim();
}

export function comparableHeadingTitle(title: string) {
  return displayableCourseTitle(title)
    .replace(/\.[A-Za-z0-9]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function cleanHeadingParts(parts: string[], leadingTitles: string[] = []) {
  const normalized = parts.map((part) => displayableCourseTitle(part.trim())).filter(Boolean);
  if (
    normalized.length > 1
    && leadingTitles.some((title) => comparableHeadingTitle(title) === comparableHeadingTitle(normalized[0] || ""))
  ) {
    return normalized.slice(1);
  }
  if (normalized.length > 1 && /^chapter\s+\d+\b/i.test(normalized[0] || "")) return normalized.slice(1);
  return normalized;
}

export function displayableHeadingPath(parts: string[], separator = " › ", leadingTitles: string[] = []) {
  return cleanHeadingParts(parts, leadingTitles).join(separator);
}

export function displayableOutlineTitle(title: string, leadingTitles: string[] = []) {
  const normalized = displayableCourseTitle(title)
    .replace(/^chapter\s+\d+\s*(?:>|›|:|-)\s*/i, "")
    .replace(/\s*(?:>|›)\s*/g, " › ")
    .trim();
  const parts = normalized.split(" › ").map((part) => part.trim()).filter(Boolean);
  if (
    parts.length > 1
    && leadingTitles.some((leadingTitle) => comparableHeadingTitle(leadingTitle) === comparableHeadingTitle(parts[0] || ""))
  ) {
    return parts.slice(1).join(" › ");
  }
  return normalized;
}
