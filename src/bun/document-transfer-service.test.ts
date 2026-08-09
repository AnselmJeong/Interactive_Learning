import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZipEntries } from "./archive-reader";
import { DocumentTransferService } from "./document-transfer-service";
import { DocumentService } from "./document-service";
import { configureAppDataBase, configureDatabaseBase } from "./paths";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { SettingsService } from "./settings-service";

let tempRoot = "";

afterEach(async () => {
  closeDbForTests();
  configureAppDataBase(null);
  configureDatabaseBase(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

async function seedDocument() {
  tempRoot = await mkdtemp(join(tmpdir(), "learnie-document-transfer-test-"));
  const data = join(tempRoot, "data");
  const database = join(tempRoot, "database");
  const root = join(tempRoot, "projects");
  const exports = join(tempRoot, "exports");
  configureAppDataBase(data);
  configureDatabaseBase(database);
  await new SettingsService().update({ projectRootFolder: root, defaultDownloadFolder: exports });
  const project = await new ProjectService().create({ title: "Transfer project" });
  const now = Date.now();
  const sourceDir = join(root, project.id, "sources", "source-1");
  const materialDir = join(root, project.id, "materials", "material-1");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(materialDir, { recursive: true });
  await writeFile(join(sourceDir, "original.md"), "# Source", "utf8");
  await writeFile(join(materialDir, "material_manifest.json"), "{}", "utf8");
  getDb().query("INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, original_file_path, imported_at, updated_at) VALUES (?, ?, 'book', 'A book', 'book.pdf', ?, ?, ?)")
    .run("document-1", project.id, "/Users/private/book.pdf", now, now);
  getDb().query("INSERT INTO project_sources (id, project_id, document_id, source_ordinal, source_kind, title, source_type, document_type, original_file_name, original_file_path, imported_file_path, content_hash, quality_status, created_at, updated_at) VALUES (?, ?, ?, 0, 'chapter', 'Chapter one', 'markdown', 'book', 'chapter.md', ?, ?, 'hash-source', 'good', ?, ?)")
    .run("source-1", project.id, "document-1", "/Users/private/book.pdf#chapter-1", join(sourceDir, "original.md"), now, now);
  getDb().query("INSERT INTO learning_materials (id, project_id, title, status, manifest_path, created_at, updated_at) VALUES ('material-1', ?, 'Course', 'ready', ?, ?, ?)")
    .run(project.id, join(materialDir, "material_manifest.json"), now, now);
  getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES ('material-1', 'source-1', 0)").run();
  return { project, exports, now };
}

describe("document transfer bridge", () => {
  test("exports one document as a self-validating portable bundle", async () => {
    const { project } = await seedDocument();
    const service = new DocumentTransferService();
    const preview = service.preview(project.id, "document-1");
    expect(preview.classification).toBe("ready");
    expect(preview.counts).toMatchObject({ sources: 1, materials: 1, crossDocumentMaterials: 0 });

    const exported = await service.export(project.id, "document-1");
    expect(exported.validated).toBe(true);
    const files = readZipEntries(await Bun.file(exported.zipPath).bytes());
    expect(files.has("document-transfer.json")).toBe(true);
    expect(files.has("document/state.json")).toBe(true);
    expect(files.has("document/sources/source-1/original.md")).toBe(true);
    expect([...files.values()].some((bytes) => new TextDecoder().decode(bytes).includes("/Users/private"))).toBe(false);
  });

  test("imports a document into another project with remapped IDs and portable paths", async () => {
    const { project } = await seedDocument();
    const destination = await new ProjectService().create({ title: "Destination" });
    const service = new DocumentTransferService();
    const exported = await service.export(project.id, "document-1");
    const preview = await service.prepareImport(exported.zipPath, destination.id);
    expect(preview.classification).toBe("create_document");

    const result = await service.commitImport(preview.importId);
    expect(result.imported).toBe(true);
    expect(result.documentId).not.toBe("document-1");
    const imported = getDb().query<{ id: string; original_file_path: string | null }, [string]>(
      "SELECT id, original_file_path FROM project_documents WHERE project_id = ?"
    ).get(destination.id);
    expect(imported?.id).toBe(result.documentId!);
    expect(imported?.original_file_path).toBeNull();
    const source = getDb().query<{ id: string; document_id: string; imported_file_path: string }, [string]>(
      "SELECT id, document_id, imported_file_path FROM project_sources WHERE project_id = ?"
    ).get(destination.id);
    expect(source?.id).not.toBe("source-1");
    expect(source?.document_id).toBe(result.documentId!);
    expect(source?.imported_file_path).toContain(join("projects", destination.id));
    expect(await readFile(source!.imported_file_path, "utf8")).toBe("# Source");
    expect(new DocumentService().list(destination.id)).toMatchObject([
      { id: result.documentId, title: "A book", sourceCount: 1 },
    ]);

    const duplicate = await service.prepareImport(exported.zipPath, destination.id);
    expect(duplicate.classification).toBe("no_changes");
    const duplicateResult = await service.commitImport(duplicate.importId);
    expect(duplicateResult.imported).toBe(false);
  });

  test("blocks a document whose material also includes another document", async () => {
    const { project, now } = await seedDocument();
    getDb().query("INSERT INTO project_documents (id, project_id, document_type, title, original_file_name, imported_at, updated_at) VALUES ('document-2', ?, 'book', 'Other book', 'other.pdf', ?, ?)")
      .run(project.id, now, now);
    getDb().query("INSERT INTO project_sources (id, project_id, document_id, source_ordinal, source_kind, title, source_type, document_type, original_file_name, imported_file_path, content_hash, quality_status, created_at, updated_at) VALUES ('source-2', ?, 'document-2', 0, 'chapter', 'Other chapter', 'markdown', 'book', 'other.md', 'other.md', 'hash-other', 'good', ?, ?)")
      .run(project.id, now, now);
    getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES ('material-1', 'source-2', 1)").run();

    const preview = new DocumentTransferService().preview(project.id, "document-1");
    expect(preview.classification).toBe("cross_document_blocked");
    await expect(new DocumentTransferService().export(project.id, "document-1")).rejects.toThrow("Project 전체 transfer");
  });
});
