const ZERO_WIDTH_MARKS = /[\u200b\u200c\u200d\ufeff]/gu;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]+\)/gu;
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const DISPLAY_FILE_EXTENSION = /\.(?:md|markdown|mdown|txt|text|pdf|epub|html?|docx?|pptx?|xlsx?)$/iu;
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

export function displayableSourceTitle(title: string, fallbackFileName = "") {
  const rawTitle = plainDisplayText(title);
  if (rawTitle) return rawTitle.replace(DISPLAY_FILE_EXTENSION, "").trim() || rawTitle;

  const rawFallback = plainDisplayText(fallbackFileName);
  const fileName = rawFallback.split(/[\\/]/).filter(Boolean).pop() || rawFallback;
  return fileName.replace(DISPLAY_FILE_EXTENSION, "").trim() || rawFallback;
}

const ROMAN_NUMERAL = /^[IVXLCDM]+$/u;
const ENGLISH_TITLE_SMALL_WORDS = new Set([
  "a", "an", "the",
  "and", "but", "for", "nor", "or", "so", "yet",
  "about", "above", "across", "after", "against", "along", "among", "around", "as", "at",
  "before", "behind", "below", "beneath", "beside", "between", "beyond", "by",
  "despite", "down", "during", "except", "from", "in", "inside", "into", "like", "near",
  "of", "off", "on", "onto", "out", "outside", "over", "past", "per", "since", "through",
  "throughout", "to", "toward", "under", "underneath", "until", "up", "upon", "via", "with",
  "within", "without",
]);
const ENGLISH_TITLE_WORD = /[A-Za-z]+(?:[’'][A-Za-z]+)*/gu;

function applyEnglishTitleCase(displayTitle: string, preserveAuthoredMixedCase: boolean) {
  if (!/[A-Za-z]/u.test(displayTitle)) return displayTitle;
  if (preserveAuthoredMixedCase && /[A-Z]/u.test(displayTitle) && /[a-z]/u.test(displayTitle)) return displayTitle;

  return displayTitle.replace(ENGLISH_TITLE_WORD, (word, offset: number) => {
    if (ROMAN_NUMERAL.test(word)) return word;
    const lower = word.toLocaleLowerCase("en");
    const isSmallWord = ENGLISH_TITLE_SMALL_WORDS.has(lower);
    const followsSubtitleSeparator = /[:–—]\s*$/u.test(displayTitle.slice(0, offset));
    const hasTokenBefore = /[A-Za-z0-9]/u.test(displayTitle.slice(0, offset));
    const hasTokenAfter = /[A-Za-z0-9]/u.test(displayTitle.slice(offset + word.length));
    if (
      hasTokenBefore
      && hasTokenAfter
      && !followsSubtitleSeparator
      && isSmallWord
    ) {
      return lower;
    }
    if (!isSmallWord && /^[A-Z]{2,3}$/u.test(word)) return word;
    if (/[a-z][A-Z]/u.test(word)) return word;
    return `${lower[0]?.toLocaleUpperCase("en") || ""}${lower.slice(1)}`;
  });
}

/**
 * Extracted chapter titles are often emitted in full uppercase. Keep authored
 * mixed-case titles verbatim, but apply English title case to all-uppercase
 * Latin titles. Articles, conjunctions, and prepositions stay lowercase unless
 * they begin/end the title or follow a subtitle separator.
 */
export function titleCasedSourceTitle(title: string, fallbackFileName = "") {
  const displayTitle = displayableSourceTitle(title, fallbackFileName);
  if (!/[A-Z]/u.test(displayTitle) || /[a-z]/u.test(displayTitle)) return displayTitle;
  return applyEnglishTitleCase(displayTitle, true);
}

export function comparableHeadingTitle(title: string) {
  return displayableCourseTitle(title)
    .normalize("NFKC")
    .replace(DISPLAY_FILE_EXTENSION, "")
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    // Treat an ordinal's trailing punctuation as decoration, retaining the
    // number itself so e.g. sections 1.1 and 1.2 remain distinct.
    .replace(/^(\d+(?:\.\d+)*)(?:[.)])?(?=\s)/u, "$1")
    .replace(/^([IVXLCDM]+)[.)](?=\s)/iu, "$1")
    .replace(/[-‐‑‒–—]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function cleanHeadingParts(parts: string[], leadingTitles: string[] = []) {
  const normalized = parts.map((part) => displayableCourseTitle(part.trim())).filter(Boolean)
    .filter((part, index, all) => index === 0 || comparableHeadingTitle(part) !== comparableHeadingTitle(all[index - 1]!));
  while (
    normalized.length > 0
    && leadingTitles.some((title) => comparableHeadingTitle(title) === comparableHeadingTitle(normalized[0] || ""))
  ) {
    normalized.shift();
  }
  if (normalized.length > 1 && /^chapter\s+\d+\b/i.test(normalized[0] || "")) return normalized.slice(1);
  return normalized;
}

export function displayableHeadingPath(parts: string[], separator = " › ", leadingTitles: string[] = []) {
  return cleanHeadingParts(parts, leadingTitles).join(separator);
}

/** Hide only leading Markdown headings already supplied by the reader header. */
export function stripRepeatedSourceHeading(content: string, heading: string) {
  const parts = cleanHeadingParts(heading.split(" › "));
  const titles = new Set(parts.map(comparableHeadingTitle));
  const partTitle = /^part\s+(?:[IVXLCDM]+|\d+)\s+(.+)$/iu.exec(parts.at(-1) || "");
  if (partTitle && comparableHeadingTitle(content) === comparableHeadingTitle(partTitle[1]!)) return "";
  // Some PDF title pages arrive as a one-column table: PART I / title.
  // Match the complete numbered title, never arbitrary cells or real data tables.
  const titleTable = /^\s*\|\s*(?:PART|CHAPTER)\s+([IVXLCDM\d ]+)\s*\|\s*\n\|[-: ]+\|\s*\n\|\s*([^|\n]+?)\s*\|[ \t]*(?:\n\s*\n|$)/iu.exec(content);
  if (titleTable && titles.has(comparableHeadingTitle(`${titleTable[1]!.replace(/\s+/g, "")}. ${titleTable[2]}`))) {
    content = content.slice(titleTable[0].length).trim();
  }
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let removed = false;
  while (true) {
    const index = lines.findIndex((line) => line.trim());
    if (index < 0) break;
    const match = /^#{1,6}\s+(.+)$/.exec(lines[index]!.trim());
    if (!match) break;
    const title = comparableHeadingTitle(match[1]!);
    if (!titles.has(title) && !/^chapter\s+\d+$/iu.test(title)) break;
    lines.splice(index, 1);
    removed = true;
  }
  return removed ? lines.join("\n").trim() : content;
}

export function displayableOutlineTitle(title: string, leadingTitles: string[] = []) {
  const normalized = displayableCourseTitle(title)
    .replace(/^chapter\s+\d+\s*(?:>|›|:|-)\s*/i, "")
    .replace(/\s*(?:>|›)\s*/g, " › ")
    .trim();
  return cleanHeadingParts(normalized.split(" › "), leadingTitles).join(" › ");
}

export function displayableModuleTitle(title: string, leadingTitles: string[] = []) {
  const outlineTitle = displayableOutlineTitle(title, leadingTitles);
  const withoutDecoration = outlineTitle
    .replace(/^\s*(?:#{1,6}|[-–—•·▪▫►▶◆◇■□]+)\s*/u, "")
    .replace(/^\s*(?:(?:chapter|module|section)\s+\d{1,3}|제\s*\d{1,3}\s*장)\s*(?:[.:)\]–—-]+\s*)?/iu, "")
    .replace(/^\s*(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|\{\s*\d{1,3}\s*\}|【\s*\d{1,3}\s*】|#\s*\d{1,3})\s*(?:[.:)\]–—-]+\s*)?/u, "")
    .replace(/^\d{1,3}\s*[.)]\s+/u, "")
    .replace(/^\s*[-–—:|]+\s*/u, "")
    .replace(/\s*(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|\{\s*\d{1,3}\s*\}|【\s*\d{1,3}\s*】)\s*$/u, "")
    .replace(/\s*[-–—:|]+\s*$/u, "")
    .trim();
  return applyEnglishTitleCase(withoutDecoration, false);
}
