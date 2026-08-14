import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnnotationAssetServer } from "./annotation-asset-server";

describe("annotation asset server", () => {
  let root = "";
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("streams a private note attachment without exposing its file path", async () => {
    root = await mkdtemp(join(tmpdir(), "learnie-annotation-asset-server-"));
    const path = join(root, "note.png");
    await writeFile(path, new Uint8Array([137, 80, 78, 71]));
    const assets = createAnnotationAssetServer((annotationId, imageId) => (
      annotationId === "note 1" && imageId === "image/1" ? { path, mimeType: "image/png" } : null
    ));
    stop = assets.stop;

    const url = assets.urlFor("note 1", "image/1");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(url).not.toContain(path);
  });

  test("requires the per-process token", async () => {
    const assets = createAnnotationAssetServer(() => null);
    stop = assets.stop;
    const url = new URL(assets.urlFor("note", "image"));
    url.search = "";
    expect((await fetch(url)).status).toBe(404);
  });
});
