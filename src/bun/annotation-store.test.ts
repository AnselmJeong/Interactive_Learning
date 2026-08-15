import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { listMaterialAnnotations, listProjectAnnotations, replaceMaterialAnnotations, saveMaterialAnnotation } from "./annotation-store";
import type { ExternalHtmlAttachment, TextSelectionAnchor } from "../shared/artifact-types";

describe("annotation store", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-annotation-store-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
    const now = Date.now();
    getDb()
      .query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, ?)")
      .run(tempRoot, now, now);
    getDb()
      .query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)")
      .run(now, now);
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function anchor(): TextSelectionAnchor {
    return {
      version: 1,
      surface: "source",
      scope: "source-chunk",
      chunkId: "chunk-1",
      selectedText: "alpha beta",
      normalizedText: "alpha beta",
      occurrence: 1,
      startOffset: 11,
      endOffset: 21,
      prefix: "before",
      suffix: "after",
      scopeTextLength: 40,
    };
  }

  test("saves and loads text anchors", () => {
    const saved = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "source",
      kind: "highlight",
      selectedText: "alpha beta",
      textAnchor: anchor(),
      result: { kind: "highlight", style: "yellow" },
      sourceMeta: [],
    });

    const loaded = listMaterialAnnotations("material-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(saved.id);
    expect(loaded[0]?.textAnchor?.occurrence).toBe(1);
    expect(loaded[0]?.textAnchor?.startOffset).toBe(11);
    expect(loaded[0]?.result).toEqual({ kind: "highlight", style: "yellow" });
  });

  test("keeps multiple notes attached to the same selected text anchor", () => {
    const first = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "source",
      kind: "note",
      selectedText: "alpha beta",
      textAnchor: anchor(),
      result: { kind: "note", note: "First note" },
      sourceMeta: [],
    });
    const second = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "source",
      kind: "note",
      selectedText: "alpha beta",
      textAnchor: anchor(),
      result: { kind: "note", note: "Second note" },
      sourceMeta: [],
    });

    const notes = listMaterialAnnotations("material-1");
    expect(notes.map((note) => note.id)).toEqual([first.id, second.id]);
    expect(notes.map((note) => note.result.kind === "note" ? note.result.note : "")).toEqual(["First note", "Second note"]);
  });

  test("replaceMaterialAnnotations preserves text anchors", () => {
    const saved = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      surface: "source",
      kind: "lookup",
      selectedText: "alpha beta",
      textAnchor: anchor(),
      result: {
        kind: "lookup",
        title: "Lookup",
        body: "Body",
        query: "alpha beta",
        provider: "wikipedia",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        sourceMeta: [],
      },
      sourceMeta: [],
    });

    replaceMaterialAnnotations("material-1", [saved]);

    const loaded = listMaterialAnnotations("material-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.textAnchor).toEqual(anchor());
  });

  test("lists annotations across a project for the reading-traces page", () => {
    const first = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      kind: "highlight",
      selectedText: "first trace",
      result: { kind: "highlight", style: "yellow" },
    });
    const second = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-2",
      kind: "note",
      selectedText: "second trace",
      result: { kind: "note", note: "My note" },
    });

    const loaded = listProjectAnnotations("project-1");
    expect(loaded.map((annotation) => annotation.id)).toEqual([second.id, first.id]);
    expect(listProjectAnnotations("missing-project")).toEqual([]);
  });

  test("drops malformed or non-portable attachment fields without losing the annotation", () => {
    const saved = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      kind: "highlight",
      selectedText: "portable trace",
      result: { kind: "highlight" },
    });
    getDb().query("UPDATE material_annotations SET attachments_json = ? WHERE id = ?").run("{bad json", saved.id);
    expect(listMaterialAnnotations("material-1")[0]).toMatchObject({ attachments: [], syncWarning: expect.any(String) });

    const attachment = {
      kind: "external_html",
      schemaVersion: 1,
      id: "12345678-1234-1234-1234-123456789abc",
      title: "Applet",
      originalFileName: "applet.html",
      originalByteSize: 100,
      runnableByteSize: 120,
      originalSha256: "a".repeat(64),
      runnableSha256: "b".repeat(64),
      compatibility: "self_contained",
      importerVersion: 1,
      dependencies: [],
      importedAt: Date.now(),
      rawHtml: "<script>should not persist</script>",
      absolutePath: "/private/file.html",
    } satisfies ExternalHtmlAttachment & { rawHtml: string; absolutePath: string };
    replaceMaterialAnnotations("material-1", [{ ...saved, attachments: [attachment] }]);
    const raw = getDb().query<{ attachments_json: string }, [string]>("SELECT attachments_json FROM material_annotations WHERE id = ?").get(saved.id)?.attachments_json || "";
    expect(raw).not.toContain("should not persist");
    expect(raw).not.toContain("/private/file.html");
    expect(listMaterialAnnotations("material-1")[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, title: "Applet" });
  });
});
