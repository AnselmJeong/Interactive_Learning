import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { listMaterialAnnotations, replaceMaterialAnnotations, saveMaterialAnnotation } from "./annotation-store";
import type { TextSelectionAnchor } from "../shared/artifact-types";

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
});
