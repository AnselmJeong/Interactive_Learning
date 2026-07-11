import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFigureAssetServer } from "./figure-asset-server";

describe("figure asset server", () => {
  let root = "";
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("streams runtime figure files without embedding them in RPC responses", async () => {
    root = await mkdtemp(join(tmpdir(), "learnie-figure-server-"));
    const path = join(root, "figure.png");
    await writeFile(path, new Uint8Array([137, 80, 78, 71]));
    const assets = createFigureAssetServer(async (materialId, figureId) => (
      materialId === "material 1" && figureId === "figure/1" ? { path, mimeType: "image/png" } : null
    ));
    stop = assets.stop;

    const url = assets.urlFor("material 1", "figure/1");
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(url).not.toContain(path);
  });

  test("does not expose figure routes without the per-process token", async () => {
    const assets = createFigureAssetServer(async () => null);
    stop = assets.stop;
    const validUrl = new URL(assets.urlFor("material", "figure"));
    validUrl.search = "";
    expect((await fetch(validUrl)).status).toBe(404);
  });
});
