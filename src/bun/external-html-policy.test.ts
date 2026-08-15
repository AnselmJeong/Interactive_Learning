import { describe, expect, test } from "bun:test";
import { prepareExternalHtmlBytes } from "./external-html-policy";

const encode = (value: string) => new TextEncoder().encode(value);

describe("external HTML import policy", () => {
  test("prepares self-contained HTML deterministically", async () => {
    const html = "<!doctype html><html><head><title>  작은 실험  </title><style>body{color:#123}</style></head><body><canvas></canvas><script>document.body.dataset.ready='yes'</script></body></html>";
    const first = await prepareExternalHtmlBytes(encode(html), "experiment.html");
    const second = await prepareExternalHtmlBytes(encode(html), "experiment.html");

    expect(first.rejectionReasons).toEqual([]);
    expect(first.title).toBe("작은 실험");
    expect(first.dependencies).toEqual([]);
    expect(first.runnableText).toBe(second.runnableText);
    expect(first.runnableText).toContain("document.body.dataset.ready='yes'");
  });

  test("localizes the exact Chart.js 4.4.1 dependency from verified package bytes", async () => {
    const html = `<!doctype html><html><head><title>Chart</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script></head><body><canvas id="chart"></canvas></body></html>`;
    const result = await prepareExternalHtmlBytes(encode(html), "chart.html");

    expect(result.rejectionReasons).toEqual([]);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toMatchObject({ name: "chart.js", version: "4.4.1", license: "MIT" });
    expect(result.runnableText).not.toContain("<script src=");
    expect(result.runnableText).toContain("window.Chart=An");
    expect(result.dependencyLicenses[0]?.fileName).toBe("chart.js.txt");
  });

  test("rejects network, popup, nested frame, file input, and remote resources", async () => {
    const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0;https://example.com"></head><body><iframe src="https://example.com"></iframe><input type="file"><a target="_blank" href="https://example.com">open</a><script>fetch('https://example.com'); window.open('about:blank')</script></body></html>`;
    const result = await prepareExternalHtmlBytes(encode(html), "hostile.html");
    const codes = result.rejectionReasons.map((item) => item.code);

    expect(codes).toContain("forbidden_iframe");
    expect(codes).toContain("meta_refresh");
    expect(codes).toContain("file_input");
    expect(codes).toContain("popup_target");
    expect(codes).toContain("network_api");
    expect(codes).toContain("popup");
    expect(codes).toContain("remote_resource");
  });

  test("rejects invalid UTF-8, NUL bytes, and incomplete fragments", async () => {
    const invalid = new Uint8Array([0xff, 0x00, 0x61]);
    const result = await prepareExternalHtmlBytes(invalid, "bad.html");
    const codes = result.rejectionReasons.map((item) => item.code);
    expect(codes).toContain("invalid_utf8");
    expect(codes).toContain("nul_byte");
    expect(codes).toContain("missing_html_root");
  });
});
