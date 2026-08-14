import { randomBytes } from "node:crypto";

export type AnnotationAsset = { path: string; mimeType: string };
type AnnotationAssetResolver = (annotationId: string, imageId: string) => Promise<AnnotationAsset | null> | AnnotationAsset | null;

/** Streams private note attachments without exposing local file paths to the renderer. */
export function createAnnotationAssetServer(resolveAsset: AnnotationAssetResolver) {
  const token = randomBytes(24).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
      const match = /^\/annotation-assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!match) return new Response("Not found", { status: 404 });
      let annotationId: string;
      let imageId: string;
      try {
        annotationId = decodeURIComponent(match[1]!);
        imageId = decodeURIComponent(match[2]!);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const asset = await Promise.resolve(resolveAsset(annotationId, imageId)).catch(() => null);
      if (!asset) return new Response("Not found", { status: 404 });
      const file = Bun.file(asset.path);
      if (!await file.exists()) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "cache-control": "private, max-age=86400, immutable",
          "content-type": asset.mimeType,
          "cross-origin-resource-policy": "cross-origin",
          "x-content-type-options": "nosniff",
        },
      });
    },
  });
  server.unref();
  return {
    urlFor(annotationId: string, imageId: string) {
      const url = new URL(`http://127.0.0.1:${server.port}/annotation-assets/${encodeURIComponent(annotationId)}/${encodeURIComponent(imageId)}`);
      url.searchParams.set("token", token);
      return url.toString();
    },
    stop() { return server.stop(true); },
  };
}
