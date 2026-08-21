import { basename } from "node:path";

export function titleQueryFromFilename(fileName: string) {
  const stem = basename(fileName).replace(/\.[^.]+$/, "");
  const withoutIsbn = stem.replace(/(?:isbn)?\s*97[89][\d\s-]{10,}|(?:isbn)?\s*[\dX][\d\s-]{8,}[\dX]/gi, " ");
  return withoutIsbn
    .replace(/^\s*\d+(?:[._-]\d+)*\s*[-_.]\s*/u, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
