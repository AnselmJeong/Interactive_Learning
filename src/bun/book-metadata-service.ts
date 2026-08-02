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
  providerVolumeId: string;
};

type GoogleVolume = {
  id?: string;
  volumeInfo?: {
    title?: string; subtitle?: string; description?: string; authors?: string[]; publisher?: string;
    publishedDate?: string; language?: string; industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
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

export function selectExactIsbnVolume(volumes: GoogleVolume[], isbn: string) {
  const requested = canonicalIsbn(isbn);
  if (!requested) return null;
  return volumes.find((volume) => {
    const ids = identifiers(volume);
    return canonicalIsbn(ids.isbn10) === requested || canonicalIsbn(ids.isbn13) === requested;
  }) || null;
}

export class BookMetadataService {
  constructor(private readonly request: (input: URL, init?: RequestInit) => Promise<Response> = fetch) {}

  isbnFromFilename(fileName: string) { return extractIsbns(fileName)[0] || null; }

  async lookup(isbn: string): Promise<BookMetadata | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const url = new URL("https://www.googleapis.com/books/v1/volumes");
      url.searchParams.set("q", `isbn:${isbn}`);
      url.searchParams.set("maxResults", "5");
      url.searchParams.set("projection", "lite");
      const response = await this.request(url, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? "서지정보 조회 요청이 많습니다. 잠시 후 다시 시도하세요." : "서지정보를 자동 조회하지 못했습니다.");
      const payload = await response.json() as { items?: GoogleVolume[] };
      const volume = selectExactIsbnVolume(payload.items || [], isbn);
      if (!volume?.id || !text(volume.volumeInfo?.title)) return null;
      const ids = identifiers(volume);
      return {
        title: text(volume.volumeInfo?.title)!, subtitle: text(volume.volumeInfo?.subtitle), description: plainDescription(volume.volumeInfo?.description),
        authors: Array.isArray(volume.volumeInfo?.authors) ? volume.volumeInfo.authors.filter((author): author is string => Boolean(text(author))) : [],
        publisher: text(volume.volumeInfo?.publisher), publishedDate: text(volume.volumeInfo?.publishedDate),
        isbn10: ids.isbn10, isbn13: ids.isbn13, language: text(volume.volumeInfo?.language), providerVolumeId: volume.id,
      };
    } finally { clearTimeout(timer); }
  }
}
