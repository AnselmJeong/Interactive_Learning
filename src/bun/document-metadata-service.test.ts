import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentMetadataCandidate } from "../shared/rpc-types";
import { DocumentService } from "./document-service";
import { configureAppDataBase, configureDatabaseBase } from "./paths";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { SettingsService } from "./settings-service";

let tempRoot = "";

afterEach(async () => {
  closeDbForTests();
  configureAppDataBase(null);
  configureDatabaseBase(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

async function seedArticle() {
  tempRoot = await mkdtemp(join(tmpdir(), "learnie-document-metadata-test-"));
  const projectRoot = join(tempRoot, "projects");
  configureAppDataBase(join(tempRoot, "data"));
  configureDatabaseBase(join(tempRoot, "database"));
  await new SettingsService().update({ projectRootFolder: projectRoot });
  const project = await new ProjectService().create({ title: "Metadata project" });
  const now = Date.now();
  getDb().query("INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, original_file_path, imported_at, updated_at) VALUES ('article-1', ?, 'article', 'filename title', 'filename-title.pdf', '/tmp/filename-title.pdf', ?, ?)")
    .run(project.id, now, now);
  getDb().query("INSERT INTO project_sources (id, project_id, document_id, source_ordinal, source_kind, title, source_type, document_type, original_file_name, original_file_path, imported_file_path, content_hash, quality_status, created_at, updated_at) VALUES ('source-1', ?, 'article-1', 0, 'article', 'filename title', 'markdown', 'article', 'filename-title.md', '/tmp/filename-title.pdf', '/tmp/imported.md', 'hash', 'good', ?, ?)")
    .run(project.id, now, now);
  return project;
}

describe("document metadata persistence", () => {
  test("manual fallback saves a title and keeps an article source in sync", async () => {
    const project = await seedArticle();
    const updated = await new DocumentService().applyManualMetadata(project.id, "article-1", "  A local research note  ");
    const source = getDb().query<{ title: string }, []>("SELECT title FROM project_sources WHERE id = 'source-1'").get();
    const provider = getDb().query<{ provider: string }, []>("SELECT provider FROM project_documents WHERE id = 'article-1'").get();

    expect(updated).toMatchObject({ title: "A local research note", metadataStatus: "manual" });
    expect(source?.title).toBe("A local research note");
    expect(provider?.provider).toBe("manual");
  });

  test("applies Crossref fields and the canonical article title", async () => {
    const project = await seedArticle();
    const metadata: DocumentMetadataCandidate = {
      title: "Canonical paper title",
      subtitle: null,
      description: "Abstract text",
      authors: ["Ada Lovelace"],
      publisher: "Example Press",
      publishedDate: "2025-07-04",
      isbn10: null,
      isbn13: null,
      journal: "Journal of Useful Systems",
      doi: "10.5555/example.42",
      language: "en",
      coverUrl: null,
      provider: "crossref",
      providerRecordId: "10.5555/example.42",
    };

    const updated = await new DocumentService().applyMetadata(project.id, "article-1", metadata);
    const source = getDb().query<{ title: string }, []>("SELECT title FROM project_sources WHERE id = 'source-1'").get();

    expect(updated).toMatchObject({
      title: "Canonical paper title",
      metadataStatus: "found",
      journal: "Journal of Useful Systems",
      doi: "10.5555/example.42",
      authors: ["Ada Lovelace"],
    });
    expect(source?.title).toBe("Canonical paper title");
  });
});
