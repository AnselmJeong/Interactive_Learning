import { randomBytes } from "node:crypto";

export type BookCoverAsset = {
  path: string;
  mimeType: string;
};

type BookCoverResolver = (documentId: string) => Promise<BookCoverAsset | null> | BookCoverAsset | null;

/** Streams persisted book covers to the renderer without exposing file:// paths. */
export function createBookCoverAssetServer(resolveCover: BookCoverResolver) {
  const token = randomBytes(24).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
      const match = /^\/covers\/([^/]+)$/.exec(url.pathname);
      if (!match) return new Response("Not found", { status: 404 });

      let documentId: string;
      try {
        documentId = decodeURIComponent(match[1]!);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const asset = await Promise.resolve(resolveCover(documentId)).catch(() => null);
      if (!asset) return new Response("Not found", { status: 404 });
      const file = Bun.file(asset.path);
      if (!await file.exists()) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "cache-control": "private, max-age=86400, immutable",
          "content-type": asset.mimeType || file.type || "image/jpeg",
          "cross-origin-resource-policy": "cross-origin",
          "x-content-type-options": "nosniff",
        },
      });
    },
  });
  server.unref();

  return {
    urlFor(documentId: string) {
      const url = new URL(`http://127.0.0.1:${server.port}/covers/${encodeURIComponent(documentId)}`);
      url.searchParams.set("token", token);
      return url.toString();
    },
    stop() {
      return server.stop(true);
    },
  };
}
