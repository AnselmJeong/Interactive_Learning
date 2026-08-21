import type { DocumentMetadataCandidate } from "../shared/rpc-types";

type CrossrefDate = { "date-parts"?: number[][] };

type CrossrefWork = {
  DOI?: string;
  title?: string[];
  subtitle?: string[];
  abstract?: string;
  author?: Array<{ given?: string; family?: string; name?: string }>;
  publisher?: string;
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
  issued?: CrossrefDate;
  "container-title"?: string[];
  language?: string;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function plainText(value: unknown) {
  return text(value)?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function dateFrom(value: CrossrefDate | undefined) {
  const parts = value?.["date-parts"]?.[0] || [];
  if (!parts.length || !Number.isInteger(parts[0])) return null;
  return parts.slice(0, 3).map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
}

function metadataFromWork(work: CrossrefWork): DocumentMetadataCandidate | null {
  const doi = text(work.DOI)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") || null;
  const title = plainText(work.title?.[0]);
  if (!doi || !title) return null;
  const authors = (work.author || []).map((author) => (
    text(author.name) || [text(author.given), text(author.family)].filter(Boolean).join(" ")
  )).filter(Boolean) as string[];
  return {
    title,
    subtitle: plainText(work.subtitle?.[0]),
    description: plainText(work.abstract),
    authors,
    publisher: text(work.publisher),
    publishedDate: dateFrom(work["published-print"]) || dateFrom(work["published-online"]) || dateFrom(work.issued),
    isbn10: null,
    isbn13: null,
    journal: plainText(work["container-title"]?.[0]),
    doi,
    language: text(work.language),
    coverUrl: null,
    provider: "crossref",
    providerRecordId: doi,
  };
}

export class CrossrefMetadataService {
  constructor(private readonly request: (input: URL, init?: RequestInit) => Promise<Response> = fetch) {}

  async searchByTitle(value: string) {
    const title = text(value);
    if (!title) throw new Error("논문 제목을 입력하세요.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const url = new URL("https://api.crossref.org/v1/works");
      url.searchParams.set("query.title", title);
      url.searchParams.set("rows", "5");
      const response = await this.request(url, {
        headers: { accept: "application/json", "user-agent": "Learnie/0.10.0 desktop metadata client" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(response.status === 429
          ? "Crossref 조회 요청이 많습니다. 잠시 후 다시 시도하세요."
          : "Crossref에서 논문 서지 정보를 조회하지 못했습니다.");
      }
      const payload = await response.json() as { message?: { items?: CrossrefWork[] } };
      return (payload.message?.items || [])
        .map(metadataFromWork)
        .filter((metadata): metadata is DocumentMetadataCandidate => Boolean(metadata));
    } finally {
      clearTimeout(timer);
    }
  }
}
