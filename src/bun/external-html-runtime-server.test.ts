import { describe, expect, test } from "bun:test";
import { EXTERNAL_HTML_CSP, ExternalHtmlRuntimeServer } from "./external-html-runtime-server";

describe("external HTML runtime server", () => {
  test("serves only a live opaque token with restrictive headers", async () => {
    const server = new ExternalHtmlRuntimeServer();
    try {
      const grant = server.issue("viewer-1", new TextEncoder().encode("<!doctype html><title>Applet</title>"));
      const response = await fetch(grant.url);
      await expect(server.waitUntilServed(grant.token, 50)).resolves.toBeUndefined();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Applet");
      expect(response.headers.get("content-security-policy")).toBe(EXTERNAL_HTML_CSP);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${grant.url}?path=other`)).status).toBe(404);
      expect((await fetch(grant.url, { method: "POST" })).status).toBe(405);
      expect((await fetch(grant.url, { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
      server.revokeViewer("viewer-1");
      expect((await fetch(grant.url)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("reports when a viewer never requests its runnable document", async () => {
    const server = new ExternalHtmlRuntimeServer();
    try {
      const grant = server.issue("viewer-1", new TextEncoder().encode("<!doctype html><title>Applet</title>"));
      await expect(server.waitUntilServed(grant.token, 5)).rejects.toThrow("viewer에 전달되지 않았습니다");
    } finally {
      server.close();
    }
  });
});
