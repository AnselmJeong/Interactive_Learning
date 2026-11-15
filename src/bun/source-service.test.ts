import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { DocumentService } from "./document-service";
import type { SourceFigure } from "../shared/artifact-types";
import { describeImportSelection, normalizeMarkdownChunks, normalizeSourceFigureChunkIds, sanitizeHeadingPath, SourceService } from "./source-service";

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

describe("source figure placement in HTML chunks", () => {
  test("places each figure at the HTML chunk that inlines its asset instead of the first chunk", async () => {
    const { normalizeHtmlChunks } = await import("./source-html");
    const root = await mkdtemp(join(tmpdir(), "learnie-figure-html-"));
    try {
      const assets = [Buffer.alloc(300, 1), Buffer.alloc(300, 2)];
      const paths = await Promise.all(assets.map(async (bytes, index) => {
        const path = join(root, `fig-000${index + 1}.png`);
        await writeFile(path, bytes);
        return path;
      }));
      const img = (bytes: Buffer) => `<figure><img src="data:image/png;base64,${bytes.toString("base64")}"></figure>`;
      const chunks = normalizeHtmlChunks("source", [
        "<h1>Chapter</h1><p>Opening text mentions nothing.</p>",
        "<h2>First</h2><p>First section text.</p>", img(assets[0]!),
        "<h2>Second</h2><p>Second section text.</p>", img(assets[1]!),
      ].join(""));
      const figures = paths.map((assetPath, index) => ({
        id: `figure-${index + 1}`,
        sourceId: "source",
        title: `Figure 13.${index + 6}`,
        assetPath,
        assetUrl: `file://${assetPath}`,
        mimeType: "image/png",
        caption: null,
        captionStatus: "missing",
        width: 10,
        height: 10,
        locator: "page 9",
        pageRange: [9, 9] as [number, number],
        sourceChunkIds: [],
      } satisfies SourceFigure));

      const normalized = normalizeSourceFigureChunkIds(figures, chunks);
      const first = chunks.find((chunk) => chunk.headingPath.at(-1) === "First");
      const second = chunks.find((chunk) => chunk.headingPath.at(-1) === "Second");
      expect(normalized[0]?.sourceChunkIds[0]).toBe(first!.id);
      expect(normalized[1]?.sourceChunkIds[0]).toBe(second!.id);
      expect(normalized.flatMap((figure) => figure.sourceChunkIds)).not.toContain(chunks[0]!.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("imports selected chapter PDFs as one ordered book or as independent articles", async () => {
    const folder = join(tempRoot, "Signal Analysis 2.0");
    const nested = join(folder, "Part A");
    await mkdir(nested, { recursive: true });
    await mkdir(join(folder, ".cache"));
    for (const file of ["10 Spectrum.PDF", "2 Sampling.pdf", "3 Skip.pdf", "notes.md"]) {
      await writeFile(join(nested, file), file);
    }
    await writeFile(join(folder, ".cache", "ignored.pdf"), "hidden");
    const standalone = join(nested, "2 Sampling.pdf");
    const selection = await describeImportSelection([folder, standalone]);
    expect(selection).toMatchObject({ supportsArticles: true, pdfFolderCount: 1 });
    expect((await describeImportSelection([join(nested, "notes.md")])).supportsArticles).toBe(false);

    const project = await new ProjectService().create({ title: "Folder import" });
    const calls: string[] = [];
    let failOn = "10 Spectrum.PDF";
    const service = new SourceService(async (file, type, singleChapter) => {
      calls.push([basename(file), type, singleChapter].join("|"));
      if (basename(file) === failOn) throw new Error("conversion failed");
      const outputPath = await mkdtemp(join(tempRoot, "pack-"));
      await mkdir(join(outputPath, "chapters"));
      const path = "chapters/001-section.md";
      await writeFile(join(outputPath, path), `# Introduction\n\n${basename(file)} content.\n\n## Results\n\nFinal paragraph.`);
      await writeFile(join(outputPath, "manifest.json"), JSON.stringify({
        source: { document_type: type }, chapters: [{ index: 1, title: "Section", path }],
      }));
      return { outputPath, cleanup: () => rm(outputPath, { recursive: true, force: true }) };
    });
    const prepared = await service.prepareImport(project.id, selection.paths, "book");
    expect(prepared.sourceName).toBe(basename(folder));
    expect(prepared.items.map((item) => item.fileName)).toEqual(["2 Sampling.pdf", "3 Skip.pdf", "10 Spectrum.PDF"]);
    expect(prepared.items.every((item) => item.selected)).toBe(true);
    expect(calls).toHaveLength(0);
    const selected = [prepared.items[2]!.id, prepared.items[0]!.id];
    await expect(service.commitPreparedImport(project.id, prepared.id, selected)).rejects.toThrow("10 Spectrum.PDF");
    const documents = new DocumentService();
    expect(documents.list(project.id)).toHaveLength(0);
    expect(service.list(project.id)).toHaveLength(0);
    expect(await readdir(join(project.rootPath, project.id, "source_folders"))).toEqual([]);

    failOn = "";
    calls.length = 0;
    const chapters = await service.commitPreparedImport(project.id, prepared.id, selected);
    expect(calls).toEqual(["2 Sampling.pdf|book|true", "10 Spectrum.PDF|book|true"]);
    expect(documents.list(project.id)).toMatchObject([{ title: basename(folder), documentType: "book", hasPdfChapters: true, sourceCount: 2 }]);
    expect(documents.listSources(project.id, chapters[0]!.documentId!).map((item) => item.id)).toEqual(chapters.map((item) => item.id));
    expect(chapters.map((item) => item.originalFileName)).toEqual(["2 Sampling.pdf", "10 Spectrum.PDF"]);
    expect(service.getRow(chapters[0]!.id).original_file_path).toBe(standalone);
    expect((await service.loadChunks(chapters[0]!.id)).at(-1)?.text).toContain("Final paragraph");

    calls.length = 0;
    const articles = await service.importPaths(project.id, [folder], "article");
    expect(new Set(articles.map((source) => source.documentId)).size).toBe(3);
    expect(documents.list(project.id).filter((doc) => doc.documentType === "article").map((doc) => doc.sourceCount)).toEqual([1, 1, 1]);
    expect(calls.every((call) => call.endsWith("|article|false"))).toBe(true);
  });

  test("imports native HTML and restores legacy formatting without changing stored source chunks", async () => {
    const project = await new ProjectService().create({ title: "HTML reader" });
    const pack = join(tempRoot, "book.preppy");
    await mkdir(join(pack, "chapters"), { recursive: true });
    await writeFile(join(pack, "chapters/001.md"), "# A chapter\n\nA precise original statement remains readable.");
    await writeFile(join(pack, "chapters/001.html"), '<h1>A chapter</h1><p>A <em>precise</em> original statement remains readable.</p>');
    await writeFile(join(pack, "manifest.json"), JSON.stringify({ schema_version: 2, source: { document_type: "book" }, output: { chapters_dir: "chapters", assets_dir: "assets" }, chapters: [{ index: 1, title: "A chapter", kind: "chapter", path: "chapters/001.md", char_count: 60 }] }));
    const service = new SourceService();
    const prepared = await service.prepareImport(project.id, [pack], "book");
    const [source] = await service.commitPreparedImport(project.id, prepared.id, prepared.items.map((item) => item.id));
    const imported = await service.loadChunks(source!.id);
    expect(imported[0]?.html).toContain('<em>precise</em>');
    const legacy = imported.map(({ html, ...chunk }) => chunk);
    const row = getDb().query<{chunks_path: string}, [string]>("SELECT chunks_path FROM project_sources WHERE id = ?").get(source!.id)!;
    const originalBytes = JSON.stringify(legacy);
    await writeFile(row.chunks_path, originalBytes);
    expect(await service.refreshReaderHtml(source!.id, legacy)).toEqual({ formatted: 1, total: 1 });
    expect(await readFile(row.chunks_path, "utf8")).toBe(originalBytes);
    const restored = await service.enrichReaderHtml(source!.id, legacy);
    expect(restored[0]?.html).toContain('<em>precise</em>');
    expect(restored.map(({html, ...chunk}) => chunk)).toEqual(legacy);
    const modified = legacy.map((chunk) => ({ ...chunk, text: 'A changed source must never inherit old HTML.' }));
    expect((await service.enrichReaderHtml(source!.id, modified))[0]?.html).toBeUndefined();
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
