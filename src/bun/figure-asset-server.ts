import { randomBytes } from "node:crypto";

export type FigureAsset = {
  path: string;
  mimeType: string;
};

type FigureAssetResolver = (materialId: string, figureId: string) => Promise<FigureAsset | null>;

export function createFigureAssetServer(resolveAsset: FigureAssetResolver) {
  const token = randomBytes(24).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
      const match = /^\/figures\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!match) return new Response("Not found", { status: 404 });

      let materialId: string;
      let figureId: string;
      try {
        materialId = decodeURIComponent(match[1]!);
        figureId = decodeURIComponent(match[2]!);
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      const asset = await resolveAsset(materialId, figureId).catch(() => null);
      if (!asset) return new Response("Not found", { status: 404 });
      const file = Bun.file(asset.path);
      if (!await file.exists()) return new Response("Not found", { status: 404 });
      const headers = {
        "cache-control": "private, max-age=86400, immutable",
        "content-type": asset.mimeType || file.type || "application/octet-stream",
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff",
      };
      return new Response(request.method === "HEAD" ? null : file, { headers });
    },
  });
  server.unref();

  return {
    urlFor(materialId: string, figureId: string) {
      const url = new URL(`http://127.0.0.1:${server.port}/figures/${encodeURIComponent(materialId)}/${encodeURIComponent(figureId)}`);
      url.searchParams.set("token", token);
      return url.toString();
    },
    stop() {
      return server.stop(true);
    },
  };
}
