import type { Database } from "bun:sqlite";

type OrderedSource = { id: string; title: string };

// "Chapter 13", "Chapter 13: Wavelets", "Lecture 2" → { prefix: "chapter", number: 13 }.
function seriesKey(title: string) {
  const match = /^(\D*?)\s*(\d+)/u.exec(title.trim());
  if (!match) return null;
  return { prefix: match[1]!.trim().toLowerCase(), number: Number(match[2]) };
}

/**
 * When every source of a book is one numbered series with the same prefix ("Chapter 02" …
 * "Chapter 35"), returns the sources ordered by that number (stable for equal numbers).
 * Returns null for anything else (front matter, appendices, unnumbered titles), whose order
 * must be left as imported.
 */
export function numberedSeriesOrder<T extends OrderedSource>(sources: T[]): T[] | null {
  if (sources.length < 2) return null;
  const keys = sources.map((source) => seriesKey(source.title));
  if (keys.some((key) => !key)) return null;
  const prefix = keys[0]!.prefix;
  if (keys.some((key) => key!.prefix !== prefix)) return null;
  return sources
    .map((source, index) => ({ source, index, number: keys[index]!.number }))
    .sort((a, b) => a.number - b.number || a.index - b.index)
    .map((item) => item.source);
}

function documentSources(database: Database, documentId: string) {
  return database.query<OrderedSource, [string]>(`
    SELECT id, title FROM project_sources WHERE document_id = ?
    ORDER BY COALESCE(source_ordinal, 2147483647), created_at ASC, id ASC
  `).all(documentId);
}

/** Renumbers a book's sources into numbered-series order. Returns true when anything moved. */
export function orderNumberedSeries(database: Database, documentId: string) {
  const current = documentSources(database, documentId);
  const ordered = numberedSeriesOrder(current);
  if (!ordered || ordered.every((source, index) => source.id === current[index]!.id)) return false;
  database.transaction(() => {
    ordered.forEach((source, ordinal) =>
      database.query("UPDATE project_sources SET source_ordinal = ? WHERE id = ?").run(ordinal, source.id));
  })();
  return true;
}

/**
 * One-time-in-effect repair (idempotent, runs at startup): a chapter re-added to a book before
 * sources were placed by number sits at the end ("… Chapter 35, Chapter 13"). Books that are a
 * single numbered series are put back in number order; every other book is left alone.
 */
export function repairNumberedSeriesOrder(database: Database) {
  const books = database.query<{ id: string }, []>(
    "SELECT id FROM project_documents WHERE document_type = 'book'"
  ).all();
  let repaired = 0;
  for (const book of books) if (orderNumberedSeries(database, book.id)) repaired += 1;
  return repaired;
}
