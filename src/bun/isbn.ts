export type Isbn = { value: string; kind: "isbn10" | "isbn13" };

function normalize(value: string) { return value.toUpperCase().replace(/[^0-9X]/g, ""); }

export function isValidIsbn10(value: string) {
  const isbn = normalize(value);
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  return [...isbn].reduce((sum, character, index) => sum + (character === "X" ? 10 : Number(character)) * (10 - index), 0) % 11 === 0;
}

export function isValidIsbn13(value: string) {
  const isbn = normalize(value);
  if (!/^\d{13}$/.test(isbn)) return false;
  return [...isbn].reduce((sum, character, index) => sum + Number(character) * (index % 2 ? 3 : 1), 0) % 10 === 0;
}

export function extractIsbns(value: string): Isbn[] {
  const normalized = value.normalize("NFKC");
  const labelled = [...normalized.matchAll(/ISBN(?:[-_ ]?(?:1[03]))?\s*[:#]?\s*([0-9Xx][0-9Xx\s-]{8,20})/gi)].map((match) => match[1] || "");
  const standalone = normalized.match(/\b(?:97[89][0-9 -]{10,16}|[0-9][0-9 -]{8,14}[0-9Xx])\b/g) || [];
  const candidates = [...labelled, ...standalone];
  const found: Isbn[] = [];
  for (const candidate of candidates) {
    const isbn = normalize(candidate);
    if (isValidIsbn13(isbn)) found.push({ value: isbn, kind: "isbn13" });
    else if (isValidIsbn10(isbn)) found.push({ value: isbn, kind: "isbn10" });
  }
  return [...new Map(found.map((item) => [item.value, item])).values()].sort((a, b) => a.kind === b.kind ? 0 : a.kind === "isbn13" ? -1 : 1);
}
