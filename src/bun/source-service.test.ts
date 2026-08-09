import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { DocumentService } from "./document-service";
import type { SourceFigure } from "../shared/artifact-types";
import { normalizeMarkdownChunks, normalizeSourceFigureChunkIds, sanitizeHeadingPath, SourceService } from "./source-service";

describe("markdown chunk heading paths", () => {
  test("does not create sparse heading paths when a document starts at h2", () => {
    const chunks = normalizeMarkdownChunks("source", "## Opening\n\nFirst body.");
    expect(chunks[0]?.headingPath).toEqual(["Opening"]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("does not create sparse heading paths when heading levels are skipped", () => {
    const chunks = normalizeMarkdownChunks("source", "# Top\n\nIntro.\n\n### Deep\n\nDetail.");
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([["Top"], ["Top", "Deep"]]);
    expect(JSON.stringify(chunks)).not.toContain("null");
  });

  test("sanitizes stored null and non-string heading path parts", () => {
    expect(sanitizeHeadingPath(["Top", null, 42, "  Deep  ", ""])).toEqual(["Top", "Deep"]);
  });
});

describe("source figure reading order", () => {
  test("keeps the image chunk first and does not attach every figure to the document's first caption", () => {
    const chunks = normalizeMarkdownChunks(
      "source",
      [
        "# Paper",
        "",
        "![](file:///tmp/assets/fig-0001.png)",
        "",
        "Opening image.",
        "",
        "## Results",
        "",
        "Figure 2.7 shows the gating variables.",
        "",
        "![Figure 2.7 Gating variables](file:///tmp/assets/fig-0009.png)",
        "",
        "The discussion continues.",
      ].join("\n")
    );
    const figure = {
      id: "figure-2.7",
      sourceId: "source",
      title: "Figure 2.7 Gating variables",
      assetPath: "/tmp/assets/fig-0009.png",
      assetUrl: "file:///tmp/assets/fig-0009.png",
      mimeType: "image/png",
      caption: "Figure 2.7 Gating variables",
      captionStatus: "docling_caption",
      width: 800,
      height: 600,
      locator: "page 12",
      pageRange: [12, 12],
      sourceChunkIds: [chunks[0]!.id],
    } satisfies SourceFigure;

    const [normalized] = normalizeSourceFigureChunkIds([figure], chunks);
    const imageChunk = chunks.find((chunk) => chunk.text.includes("fig-0009.png"));
    const mentionChunk = chunks.find((chunk) => chunk.text.startsWith("Figure 2.7 shows"));

    expect(normalized?.sourceChunkIds[0]).toBe(imageChunk?.id);
    expect(normalized?.sourceChunkIds).toContain(mentionChunk?.id);
    expect(normalized?.sourceChunkIds).not.toContain(chunks[0]?.id);
  });

  test("places an uncaptioned figure by its exact asset link", () => {
    const chunks = normalizeMarkdownChunks(
      "source",
      "# Paper\n\nOpening text.\n\n![](file:///tmp/assets/fig-0013.png)\n\nLater text."
    );
    const figure = {
      id: "figure-13",
      sourceId: "source",
      title: "Figure 13",
      assetPath: "/tmp/assets/fig-0013.png",
      assetUrl: "file:///tmp/assets/fig-0013.png",
      mimeType: "image/png",
      caption: null,
      captionStatus: "missing",
      width: 800,
      height: 600,
      locator: "page 16",
      pageRange: [16, 16],
      sourceChunkIds: [chunks[0]!.id],
    } satisfies SourceFigure;

    const [normalized] = normalizeSourceFigureChunkIds([figure], chunks);
    const imageChunk = chunks.find((chunk) => chunk.text.includes("fig-0013.png"));

    expect(imageChunk).toBeDefined();
    expect(normalized?.sourceChunkIds).toEqual([imageChunk!.id]);
  });
});

describe("source title rename", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-source-rename-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("persists the title in both the database and source manifest", async () => {
    const project = await new ProjectService().create({ title: "Rename Project" });
    const sourceId = "source-1";
    const sourceDir = join(project.rootPath, project.id, "sources", sourceId);
    const manifestPath = join(sourceDir, "source_manifest.json");
    const importedPath = join(sourceDir, "original.md");
    const now = Date.now();
    await mkdir(sourceDir, { recursive: true });
    await writeFile(importedPath, "# Source\n\nBody", "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      id: sourceId,
      projectId: project.id,
      title: "OLD TITLE",
      sourceType: "markdown",
      importedAt: new Date(now).toISOString(),
      extractionMethod: "test",
      language: "en",
      quality: { status: "good", warnings: [] },
    }, null, 2)}\n`, "utf8");
    getDb()
      .query(
        `INSERT INTO project_sources
         (id, project_id, title, source_type, original_file_name, imported_file_path, content_hash,
          manifest_path, quality_status, created_at, updated_at)
         VALUES (?, ?, 'OLD TITLE', 'markdown', 'original.md', ?, 'rename-hash', ?, 'good', ?, ?)`
      )
      .run(sourceId, project.id, importedPath, manifestPath, now, now);

    const renamed = await new SourceService().rename(project.id, sourceId, "  A clearer source title  ");
    const row = getDb().query<{ title: string }, [string]>("SELECT title FROM project_sources WHERE id = ?").get(sourceId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(renamed.title).toBe("A clearer source title");
    expect(row?.title).toBe("A clearer source title");
    expect(manifest.title).toBe("A clearer source title");
    expect(typeof manifest.updatedAt).toBe("string");
  });

  test("rejects an empty title", async () => {
    await expect(new SourceService().rename("project", "source", "   ")).rejects.toThrow("Source title is required");
  });
});

describe("article source packs", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-article-source-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("merges every selected article pack section into one article source", async () => {
    const project = await new ProjectService().create({ title: "Article Project" });
    const pack = join(tempRoot, "paper.preppy");
    const introductionPath = "chapters/001-introduction.md";
    const resultsPath = "chapters/002-results.md";
    await mkdir(join(pack, "chapters"), { recursive: true });
    await writeFile(join(pack, introductionPath), "# A Reliable Paper\n\nThis paper studies a focused question.", "utf8");
    await writeFile(join(pack, resultsPath), "## Results\n\nThe result belongs to the same paper.", "utf8");
    await writeFile(join(pack, "figures.json"), "{\"figures\":[]}", "utf8");
    await writeFile(join(pack, "manifest.json"), JSON.stringify({
      schema_version: 2,
      source: { document_type: "article" },
      output: { chapters_dir: "chapters", assets_dir: "assets" },
      chapters: [
        { index: 1, title: "A Reliable Paper", kind: "article", path: introductionPath, char_count: 54 },
        { index: 2, title: "Results", kind: "article", path: resultsPath, char_count: 47 },
      ],
    }), "utf8");

    const service = new SourceService();
    const prepared = await service.prepareImport(project.id, [pack], "article");
    const imported = await service.commitPreparedImport(project.id, prepared.id, prepared.items.map((item) => item.id));

    expect(prepared.documentType).toBe("article");
    expect(prepared.items).toHaveLength(2);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.documentType).toBe("article");
    expect(imported[0]?.documentId).toBeTruthy();
    expect(service.list(project.id)[0]?.documentType).toBe("article");
    const documents = new DocumentService().list(project.id);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ documentType: "article", sourceCount: 1 });
    expect(new DocumentService().listSources(project.id, documents[0]!.id)[0]?.id).toBe(imported[0]?.id);
    const chunks = await service.loadChunks(imported[0]!.id);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("focused question");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("same paper");
    const persistedDocuments = JSON.parse(await readFile(join(project.rootPath, project.id, "documents.json"), "utf8"));
    expect(persistedDocuments.documents[0]).toMatchObject({ id: documents[0]?.id, documentType: "article" });
  });
});
