import { describe, expect, test } from "bun:test";
import { directImageUrl, isPublicImageAddress, loadDirectImage } from "./direct-image-service";

describe("direct image links", () => {
  test("loads a public image URL into a durable data URL", async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    })) as unknown as typeof fetch;
    const image = await loadDirectImage(
      new URL("https://images.example.org/diagrams/cell-membrane.png"),
      fetchImpl,
      async () => ["93.184.216.34"]
    );

    expect(image).toMatchObject({
      title: "cell membrane",
      thumbnailUrl: "data:image/png;base64,AQID",
      imageUrl: "https://images.example.org/diagrams/cell-membrane.png",
      sourceTitle: "images.example.org",
      provider: "direct",
    });
  });

  test("validates every redirect target before fetching it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } });
    }) as unknown as typeof fetch;

    await expect(loadDirectImage(new URL("https://example.org/image"), fetchImpl, async (hostname) => (
      hostname === "example.org" ? ["93.184.216.34"] : ["127.0.0.1"]
    ))).rejects.toThrow("사설 네트워크");
    expect(calls).toBe(1);
  });

  test("recognizes only raw http image-link input and blocks private addresses", () => {
    expect(directImageUrl("https://example.org/image.jpg")?.hostname).toBe("example.org");
    expect(directImageUrl("cell membrane")).toBeNull();
    expect(isPublicImageAddress("8.8.8.8")).toBe(true);
    expect(isPublicImageAddress("127.0.0.1")).toBe(false);
    expect(isPublicImageAddress("192.168.1.2")).toBe(false);
    expect(isPublicImageAddress("::1")).toBe(false);
  });
});
