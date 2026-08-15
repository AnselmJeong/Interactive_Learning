const EXTERNAL_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

type RuntimeGrant = {
  viewerId: string;
  bytes: Uint8Array;
  expiresAt: number;
  served: Promise<void>;
  markServed: () => void;
};

export class ExternalHtmlRuntimeServer {
  private readonly grants = new Map<string, RuntimeGrant>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  private ensureServer() {
    if (this.server) return this.server;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    return this.server;
  }

  private handle(request: Request) {
    const server = this.server;
    if (!server) return new Response("Gone", { status: 410 });
    const url = new URL(request.url);
    const expectedHost = `127.0.0.1:${server.port}`;
    if (url.hostname !== "127.0.0.1" || request.headers.get("host") !== expectedHost || url.search || url.hash) return new Response("Not found", { status: 404 });
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    if ((origin && origin !== "null") || referer) return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const match = /^\/external-html\/([a-f0-9]{32})$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const token = match[1]!;
    const grant = this.grants.get(token);
    if (!grant) return new Response("Not found", { status: 404 });
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      return new Response("Gone", { status: 410 });
    }
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": EXTERNAL_HTML_CSP,
      "cross-origin-resource-policy": "same-origin",
    };
    const body = request.method === "HEAD"
      ? null
      : grant.bytes.buffer.slice(grant.bytes.byteOffset, grant.bytes.byteOffset + grant.bytes.byteLength) as ArrayBuffer;
    grant.markServed();
    return new Response(body, { status: 200, headers });
  }

  issue(viewerId: string, bytes: Uint8Array, ttlMs = 30 * 60 * 1000) {
    const server = this.ensureServer();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    let markServed: () => void = () => undefined;
    const served = new Promise<void>((resolve) => { markServed = resolve; });
    this.grants.set(token, { viewerId, bytes, expiresAt: Date.now() + ttlMs, served, markServed });
    return { token, url: `http://127.0.0.1:${server.port}/external-html/${token}` };
  }

  async waitUntilServed(token: string, timeoutMs = 3_000) {
    const grant = this.grants.get(token);
    if (!grant) throw new Error("External HTML runtime grant is no longer available");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        grant.served,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("HTML 실행 문서가 viewer에 전달되지 않았습니다.")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  revokeViewer(viewerId: string) {
    for (const [token, grant] of this.grants) {
      if (grant.viewerId === viewerId) this.grants.delete(token);
    }
  }

  close() {
    this.grants.clear();
    this.server?.stop(true);
    this.server = null;
  }
}

export { EXTERNAL_HTML_CSP };
