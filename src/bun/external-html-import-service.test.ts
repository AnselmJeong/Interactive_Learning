import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { getMaterialAnnotation, saveMaterialAnnotation } from "./annotation-store";
import { ExternalHtmlImportService, validateExternalHtmlAttachment } from "./external-html-import-service";

describe("external HTML import service", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-external-html-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("prepares, commits, validates, snapshots, and removes an applet", async () => {
    const now = Date.now();
    const projectRoot = join(tempRoot, "projects-root");
    const htmlPath = join(tempRoot, "applet.html");
    const html = "<!doctype html><html><head><title>Offline Applet</title></head><body><input type=range><script>document.body.dataset.value='1'</script></body></html>";
    await writeFile(htmlPath, html, "utf8");
    const database = getDb();
    database.query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, ?)").run(projectRoot, now, now);
    database.query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)").run(now, now);
    const annotation = saveMaterialAnnotation({
      materialId: "material-1",
      chunkId: "chunk-1",
      kind: "note",
      selectedText: "Selection",
      result: {
        kind: "note",
        note: "Note",
        images: [{
          id: "note-image-1",
          fileName: "figure.png",
          mimeType: "image/png",
          byteSize: 128,
          width: 320,
          height: 180,
        }],
      },
    });
    const service = new ExternalHtmlImportService(async () => htmlPath);

    const preview = await service.prepare(null);
    expect(preview?.status).toBe("ready");
    expect(preview?.annotationId).toBeNull();
    const committed = await service.commit(annotation.id, preview!.previewId, annotation.updatedAt);
    const attachment = committed.attachments?.[0];
    expect(attachment).toMatchObject({ kind: "external_html", title: "Offline Applet", compatibility: "self_contained" });
    expect(committed.result).toMatchObject({
      kind: "note",
      images: [{ id: "note-image-1", fileName: "figure.png" }],
    });
    if (!attachment || attachment.kind !== "external_html") throw new Error("attachment missing");
    const validated = await validateExternalHtmlAttachment(committed, attachment);
    expect(await readFile(validated.originalPath, "utf8")).toBe(html);
    expect(existsSync(validated.runnablePath)).toBe(true);
    const row = database.query<{ attachments_json: string; result_json: string }, [string]>("SELECT attachments_json, result_json FROM material_annotations WHERE id = ?").get(annotation.id);
    expect(row?.attachments_json).not.toContain("<html");
    expect(row?.result_json).not.toContain("<html");
    const snapshot = await readFile(join(projectRoot, "project-1", "materials", "material-1", "annotations.json"), "utf8");
    expect(snapshot).toContain(attachment.id);
    expect(snapshot).not.toContain("<html");

    const removed = await service.remove(annotation.id, attachment.id, committed.updatedAt);
    expect(removed.attachments).toEqual([]);
    expect(removed.result).toMatchObject({
      kind: "note",
      images: [{ id: "note-image-1", fileName: "figure.png" }],
    });
    expect(existsSync(validated.dir)).toBe(false);
    expect(getMaterialAnnotation(annotation.id)?.attachments).toEqual([]);
  });

  test("detects one-byte runnable tampering", async () => {
    const now = Date.now();
    const projectRoot = join(tempRoot, "projects-root");
    const htmlPath = join(tempRoot, "applet.html");
    await writeFile(htmlPath, "<!doctype html><html><title>A</title><body>A</body></html>", "utf8");
    const database = getDb();
    database.query("INSERT INTO projects (id, title, root_path, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, ?)").run(projectRoot, now, now);
    database.query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)").run(now, now);
    const annotation = saveMaterialAnnotation({ materialId: "material-1", chunkId: "chunk-1", kind: "highlight", selectedText: "A", result: { kind: "highlight" } });
    const service = new ExternalHtmlImportService(async () => htmlPath);
    const preview = await service.prepare(annotation.id);
    const committed = await service.commit(annotation.id, preview!.previewId, annotation.updatedAt);
    const attachment = committed.attachments?.[0];
    if (!attachment || attachment.kind !== "external_html") throw new Error("attachment missing");
    const validated = await validateExternalHtmlAttachment(committed, attachment);
    await writeFile(validated.runnablePath, "tampered", "utf8");
    await expect(validateExternalHtmlAttachment(committed, attachment)).rejects.toThrow("hash mismatch");
  });
});
