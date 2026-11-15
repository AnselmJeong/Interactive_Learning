import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { numberedSeriesOrder, repairNumberedSeriesOrder } from "./source-order";

const titles = (items: Array<{ title: string }> | null) => items?.map((item) => item.title) ?? null;
const of = (...names: string[]) => names.map((title, index) => ({ id: String(index), title }));

describe("numbered series order", () => {
  test("orders one numbered series by number", () => {
    expect(titles(numberedSeriesOrder(of("Chapter 02", "Chapter 12", "Chapter 35", "Chapter 13")))).toEqual(["Chapter 02", "Chapter 12", "Chapter 13", "Chapter 35"]);
    expect(titles(numberedSeriesOrder(of("Chapter 2: Sampling", "Chapter 10 Spectra", "chapter 3")))).toEqual(["Chapter 2: Sampling", "chapter 3", "Chapter 10 Spectra"]);
  });

  test("leaves mixed or unnumbered books alone", () => {
    expect(numberedSeriesOrder(of("Chapter 1", "Chapter 2", "Appendix A"))).toBeNull();
    expect(numberedSeriesOrder(of("Chapter 2", "Lecture 1"))).toBeNull();
    expect(numberedSeriesOrder(of("Chapter 1"))).toBeNull();
  });
});

describe("startup repair", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "learnie-source-order-"));
    process.env.LEARNIE_APP_DATA_ROOT = root;
    closeDbForTests();
  });
  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  test("moves a chapter appended at the end back into number order", async () => {
    const project = await new ProjectService().create({ title: "Repair" });
    const db = getDb();
    const now = Date.now();
    const insertDocument = (id: string) => db.query(`INSERT INTO project_documents
      (id, project_id, document_type, title, original_file_name, original_file_path, content_hash, imported_at, updated_at)
      VALUES (?, ?, 'book', ?, ?, ?, '', ?, ?)`).run(id, project.id, id, id, id, now, now);
    const insertSource = (documentId: string, title: string, ordinal: number) => db.query(`INSERT INTO project_sources
      (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path, document_type,
       document_id, source_ordinal, source_kind, content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at)
      VALUES (?, ?, ?, 'markdown', ?, ?, ?, 'book', ?, ?, 'chapter', ?, '', '', 'good', ?, ?)`)
      .run(`${documentId}-${title}`, project.id, title, title, title, title, documentId, ordinal, title, now, now);
    insertDocument("series");
    ["Chapter 12", "Chapter 14", "Chapter 13"].forEach((title, ordinal) => insertSource("series", title, ordinal));
    insertDocument("custom");
    ["Preface", "Chapter 2", "Chapter 1"].forEach((title, ordinal) => insertSource("custom", title, ordinal));

    const order = (documentId: string) => db.query<{ title: string }, [string]>(
      "SELECT title FROM project_sources WHERE document_id = ? ORDER BY source_ordinal"
    ).all(documentId).map((row) => row.title);
    expect(repairNumberedSeriesOrder(db)).toBe(1);
    expect(order("series")).toEqual(["Chapter 12", "Chapter 13", "Chapter 14"]);
    expect(order("custom")).toEqual(["Preface", "Chapter 2", "Chapter 1"]);
    expect(repairNumberedSeriesOrder(db)).toBe(0);
  });
});
