import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBookCoverAssetServer } from "./book-cover-asset-server";

describe("book cover asset server", () => {
  let root = "";
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("streams a persisted cover through a tokenized renderer-safe URL", async () => {
    root = await mkdtemp(join(tmpdir(), "learnie-cover-server-"));
    const path = join(root, "cover.jpg");
    await writeFile(path, new Uint8Array([255, 216, 255, 217]));
    const assets = createBookCoverAssetServer((documentId) => (
      documentId === "book 1" ? { path, mimeType: "image/jpeg" } : null
    ));
    stop = assets.stop;

    const response = await fetch(assets.urlFor("book 1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([255, 216, 255, 217]);
  });

  test("does not serve a cover without the process token", async () => {
    const assets = createBookCoverAssetServer(() => null);
    stop = assets.stop;
    const url = new URL(assets.urlFor("book"));
    url.search = "";
    expect((await fetch(url)).status).toBe(404);
  });
});
