import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAppDataBase, configureDatabaseBase } from "./paths";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";
import { ProjectTransferService } from "./project-transfer-service";
import { SettingsService } from "./settings-service";
import { readZipEntries } from "./archive-reader";

let tempRoot = "";

afterEach(async () => {
  closeDbForTests();
  configureAppDataBase(null);
  configureDatabaseBase(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("project transfer", () => {
  test("exports a validated transfer and imports it into a clean installation", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-transfer-test-"));
    const sourceData = join(tempRoot, "source-data");
    const sourceDb = join(tempRoot, "source-db");
    const sourceProjects = join(tempRoot, "source-projects");
    const exportsDir = join(tempRoot, "exports");
    configureAppDataBase(sourceData);
    configureDatabaseBase(sourceDb);
    await new SettingsService().update({ projectRootFolder: sourceProjects, defaultDownloadFolder: exportsDir });
    const project = await new ProjectService().create({ title: "Portable Philosophy" });
    const projectDir = join(sourceProjects, project.id);
    const sourceDir = join(projectDir, "sources", "source-1");
    const materialDir = join(projectDir, "materials", "material-1");
    await mkdir(join(sourceDir, "assets"), { recursive: true });
    await mkdir(materialDir, { recursive: true });
    await writeFile(join(sourceDir, "original.md"), "# Portable source\n", "utf8");
    await writeFile(join(sourceDir, "asset.png"), "image", "utf8");
    await writeFile(join(sourceDir, "source_manifest.json"), JSON.stringify({ id: "source-1", originalPath: "/Users/private/book.md" }), "utf8");
    await writeFile(join(sourceDir, "source_chunks.json"), "[]", "utf8");
    await writeFile(join(materialDir, "material_manifest.json"), "{}", "utf8");
    await writeFile(join(materialDir, "figures.json"), JSON.stringify([{ assetPath: join(sourceDir, "asset.png"), assetUrl: `file://${join(sourceDir, "asset.png")}` }]), "utf8");
    const now = Date.now();
    getDb().query(`INSERT INTO project_sources (id, project_id, title, source_type, original_file_name, original_file_path, imported_file_path, content_hash, manifest_path, chunks_path, quality_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("source-1", project.id, "Source", "markdown", "book.md", "/Users/private/book.md", join(sourceDir, "original.md"), "hash-1", join(sourceDir, "source_manifest.json"), join(sourceDir, "source_chunks.json"), "good", now, now);
    getDb().query(`INSERT INTO learning_materials (id, project_id, title, material_type, status, manifest_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("material-1", project.id, "Material", "source_course", "ready", join(materialDir, "material_manifest.json"), now, now);
    getDb().query("INSERT INTO material_sources (material_id, source_id, ordinal) VALUES (?, ?, ?)").run("material-1", "source-1", 0);
    const exported = await new ProjectTransferService().exportTransfer(project.id);

    const files = readZipEntries(await Bun.file(exported.zipPath).bytes());
    expect(files.has("transfer.json")).toBe(true);
    expect(files.has("project/state.json")).toBe(true);
    expect([...files.values()].some((bytes) => new TextDecoder().decode(bytes).includes("/Users/private"))).toBe(false);

    closeDbForTests();
    const targetData = join(tempRoot, "target-data");
    const targetDb = join(tempRoot, "target-db");
    const targetProjects = join(tempRoot, "target-projects");
    configureAppDataBase(targetData);
    configureDatabaseBase(targetDb);
    await new SettingsService().update({ projectRootFolder: targetProjects });
    const targetTransfers = new ProjectTransferService();
    const preview = await targetTransfers.prepareImport(exported.zipPath);
    expect(preview.classification).toBe("create_new");
    const result = await targetTransfers.commitImport(preview.importId, "create_new");
    expect(result.imported).toBe(true);
    expect(getDb().query<{ title: string }, [string]>("SELECT title FROM projects WHERE id = ?").get(project.id)?.title).toBe("Portable Philosophy");
    const importedSource = getDb().query<{ imported_file_path: string; manifest_path: string }, []>("SELECT imported_file_path, manifest_path FROM project_sources").get();
    expect(importedSource?.imported_file_path.startsWith(join(targetProjects, project.id))).toBe(true);
    expect(importedSource?.manifest_path.startsWith(join(targetProjects, project.id))).toBe(true);
    const importedFigures = JSON.parse(await readFile(join(targetProjects, project.id, "materials", "material-1", "figures.json"), "utf8")) as Array<{ assetPath: string; assetUrl: string }>;
    expect(importedFigures[0]?.assetPath.startsWith(join(targetProjects, project.id))).toBe(true);
    expect(importedFigures[0]?.assetUrl.startsWith("file:")).toBe(true);
  });

  test("fast-forwards a sequential handoff without treating project open as a local edit", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-transfer-fast-forward-"));
    const homeData = join(tempRoot, "home-data");
    const homeDb = join(tempRoot, "home-db");
    const homeProjects = join(tempRoot, "home-projects");
    const transfersDir = join(tempRoot, "transfers");
    configureAppDataBase(homeData);
    configureDatabaseBase(homeDb);
    await new SettingsService().update({ projectRootFolder: homeProjects, defaultDownloadFolder: transfersDir });
    const project = await new ProjectService().create({ title: "Handoff" });
    const first = await new ProjectTransferService().exportTransfer(project.id);

    closeDbForTests();
    const officeData = join(tempRoot, "office-data");
    const officeDb = join(tempRoot, "office-db");
    const officeProjects = join(tempRoot, "office-projects");
    configureAppDataBase(officeData);
    configureDatabaseBase(officeDb);
    await new SettingsService().update({ projectRootFolder: officeProjects, defaultDownloadFolder: transfersDir });
    const officeTransfers = new ProjectTransferService();
    const firstPreview = await officeTransfers.prepareImport(first.zipPath);
    await officeTransfers.commitImport(firstPreview.importId, "create_new");
    new ProjectService().open(project.id);
    getDb().query("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").run("Handoff from office", Date.now(), project.id);
    const second = await officeTransfers.exportTransfer(project.id);

    closeDbForTests();
    configureAppDataBase(homeData);
    configureDatabaseBase(homeDb);
    const homeTransfers = new ProjectTransferService();
    const secondPreview = await homeTransfers.prepareImport(second.zipPath);
    expect(secondPreview.classification).toBe("fast_forward");
    await homeTransfers.commitImport(secondPreview.importId, "fast_forward");
    expect(getDb().query<{ title: string }, [string]>("SELECT title FROM projects WHERE id = ?").get(project.id)?.title).toBe("Handoff from office");
  });
});
