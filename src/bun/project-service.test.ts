import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { ProjectService } from "./project-service";

describe("project learning level", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-project-service-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("defaults new projects to medium", async () => {
    const project = await new ProjectService().create({ title: "Default Level" });

    expect(project.learningLevel).toBe("medium");
    expect(new ProjectService().open(project.id).learningLevel).toBe("medium");
  });

  test("persists explicit learning level in the DB and project manifest", async () => {
    const project = await new ProjectService().create({ title: "Hard Level", learningLevel: "hard" });
    const row = getDb().query<{ learning_level: string }, [string]>("SELECT learning_level FROM projects WHERE id = ?").get(project.id);
    const manifest = JSON.parse(await readFile(join(project.rootPath, project.id, "project.json"), "utf8"));

    expect(project.learningLevel).toBe("hard");
    expect(row?.learning_level).toBe("hard");
    expect(manifest.learningLevel).toBe("hard");
  });
});
