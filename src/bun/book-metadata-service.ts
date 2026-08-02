import { extractIsbns, isValidIsbn10, isValidIsbn13 } from "./isbn";

export type BookMetadata = {
  title: string;
  subtitle: string | null;
  description: string | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  language: string | null;
  coverUrl: string | null;
  providerVolumeId: string;
};

type GoogleVolume = {
  id?: string;
  volumeInfo?: {
    title?: string; subtitle?: string; description?: string; authors?: string[]; publisher?: string;
    publishedDate?: string; language?: string; industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    imageLinks?: { thumbnail?: string; smallThumbnail?: string; small?: string; medium?: string; large?: string };
  };
};

function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function plainDescription(value: unknown) { return text(value)?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null; }
function identifiers(volume: GoogleVolume) {
  const items = volume.volumeInfo?.industryIdentifiers || [];
  return {
    isbn10: text(items.find((item) => item.type === "ISBN_10")?.identifier),
    isbn13: text(items.find((item) => item.type === "ISBN_13")?.identifier),
  };
}

function canonicalIsbn(value: string | null) {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^0-9X]/g, "");
  return isValidIsbn13(normalized) || isValidIsbn10(normalized) ? normalized : null;
}

function safeCoverUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

function metadataFromVolume(volume: GoogleVolume): BookMetadata | null {
  if (!volume.id || !text(volume.volumeInfo?.title)) return null;
  const ids = identifiers(volume);
  return {
    title: text(volume.volumeInfo?.title)!, subtitle: text(volume.volumeInfo?.subtitle), description: plainDescription(volume.volumeInfo?.description),
    authors: Array.isArray(volume.volumeInfo?.authors) ? volume.volumeInfo.authors.filter((author): author is string => Boolean(text(author))) : [],
    publisher: text(volume.volumeInfo?.publisher), publishedDate: text(volume.volumeInfo?.publishedDate),
    isbn10: ids.isbn10, isbn13: ids.isbn13, language: text(volume.volumeInfo?.language),
    coverUrl: safeCoverUrl(volume.volumeInfo?.imageLinks?.large || volume.volumeInfo?.imageLinks?.medium || volume.volumeInfo?.imageLinks?.small || volume.volumeInfo?.imageLinks?.thumbnail || volume.volumeInfo?.imageLinks?.smallThumbnail),
    providerVolumeId: volume.id,
  };
}

const TITLE_STOP_WORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "the", "to", "with"]);

function titleTokens(value: string) {
  return value.toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !TITLE_STOP_WORDS.has(token));
}

export function titleQueryFromFilename(fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const withoutIsbn = stem.replace(/(?:isbn)?\s*97[89][\d\s-]{10,}|(?:isbn)?\s*[\dX][\d\s-]{8,}[\dX]/gi, " ");
  return withoutIsbn
    .replace(/^\s*\d+(?:[._-]\d+)*\s*[-_.]\s*/u, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function selectExactIsbnVolume(volumes: GoogleVolume[], isbn: string) {
  const requested = canonicalIsbn(isbn);
  if (!requested) return null;
  return volumes.find((volume) => {
    const ids = identifiers(volume);
    return canonicalIsbn(ids.isbn10) === requested || canonicalIsbn(ids.isbn13) === requested;
  }) || null;
}

export function selectConfidentTitleVolume(volumes: GoogleVolume[], queryTitle: string) {
  const query = titleTokens(queryTitle);
  if (!query.length) return null;
  let best: { volume: GoogleVolume; matched: number; score: number } | null = null;
  for (const volume of volumes) {
    const candidate = text(volume.volumeInfo?.title);
    if (!candidate) continue;
    const candidateTokens = new Set(titleTokens(`${candidate} ${text(volume.volumeInfo?.subtitle) || ""}`));
    const matched = query.filter((token) => candidateTokens.has(token)).length;
    const score = matched / query.length;
    if (!best || score > best.score || (score === best.score && matched > best.matched)) best = { volume, matched, score };
  }
  if (!best) return null;
  const normalizedQuery = query.join(" ");
  const normalizedCandidate = titleTokens(`${text(best.volume.volumeInfo?.title) || ""} ${text(best.volume.volumeInfo?.subtitle) || ""}`).join(" ");
  const exact = normalizedCandidate === normalizedQuery;
  return exact || (best.matched >= 2 && best.score >= 0.7) ? best.volume : null;
}

export class BookMetadataService {
  constructor(private readonly request: (input: URL, init?: RequestInit) => Promise<Response> = fetch) {}

  isbnFromFilename(fileName: string) { return extractIsbns(fileName)[0] || null; }

  async lookupByIsbn(isbn: string, apiKey: string): Promise<BookMetadata | null> {
    return this.lookup(`isbn:${isbn}`, apiKey, (volumes) => selectExactIsbnVolume(volumes, isbn));
  }

  async lookupByFilename(fileName: string, apiKey: string): Promise<BookMetadata | null> {
    const isbn = this.isbnFromFilename(fileName)?.value;
    if (isbn) return this.lookupByIsbn(isbn, apiKey);
    const title = titleQueryFromFilename(fileName);
    if (!title) return null;
    return this.lookup(`intitle:${title}`, apiKey, (volumes) => selectConfidentTitleVolume(volumes, title));
  }

  async searchManually(input: { title?: string; isbn?: string }, apiKey: string): Promise<BookMetadata[]> {
    const requestedIsbn = input.isbn?.trim() || "";
    const isbn = requestedIsbn ? canonicalIsbn(requestedIsbn) : null;
    if (requestedIsbn && !isbn) throw new Error("ISBN-10 또는 ISBN-13 형식으로 입력하세요.");
    const title = text(input.title);
    if (!isbn && !title) throw new Error("책 제목 또는 ISBN을 입력하세요.");

    const volumes = await this.volumes(isbn ? `isbn:${isbn}` : `intitle:${title}`, apiKey);
    const eligible = isbn
      ? volumes.filter((volume) => Boolean(selectExactIsbnVolume([volume], isbn)))
      : volumes;
    return eligible.map(metadataFromVolume).filter((metadata): metadata is BookMetadata => Boolean(metadata));
  }

  private async lookup(query: string, apiKey: string, select: (volumes: GoogleVolume[]) => GoogleVolume | null): Promise<BookMetadata | null> {
    const volume = select(await this.volumes(query, apiKey));
    return volume ? metadataFromVolume(volume) : null;
  }

  private async volumes(query: string, apiKey: string): Promise<GoogleVolume[]> {
    if (!apiKey.trim()) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const url = new URL("https://www.googleapis.com/books/v1/volumes");
      url.searchParams.set("q", query);
      url.searchParams.set("key", apiKey.trim());
      url.searchParams.set("maxResults", "5");
      const response = await this.request(url, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? "서지정보 조회 요청이 많습니다. 잠시 후 다시 시도하세요." : "서지정보를 자동 조회하지 못했습니다.");
      const payload = await response.json() as { items?: GoogleVolume[] };
      return payload.items || [];
    } finally { clearTimeout(timer); }
  }
}
