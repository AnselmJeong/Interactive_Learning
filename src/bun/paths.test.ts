import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAppDataBase, configureDatabaseBase, databasePath, dataPath, stableDatabaseBase } from "./paths";

describe("app data paths", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-paths-test-"));
    delete process.env.LEARNIE_APP_DATA_ROOT;
    configureAppDataBase(null);
    configureDatabaseBase(null);
  });

  afterEach(async () => {
    delete process.env.LEARNIE_APP_DATA_ROOT;
    configureAppDataBase(null);
    configureDatabaseBase(null);
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("uses the stable database from a dev runtime while keeping other app data in dev", () => {
    const devBase = join(tempRoot, "dev");
    configureAppDataBase(devBase);
    configureDatabaseBase(stableDatabaseBase(devBase));

    expect(dataPath("settings.json")).toBe(join(tempRoot, "dev", "learnie", "settings.json"));
    expect(databasePath("projects.sqlite")).toBe(join(tempRoot, "stable", "learnie", "projects.sqlite"));
  });

  test("keeps the stable runtime on its own database path", () => {
    const stableBase = join(tempRoot, "stable");

    expect(stableDatabaseBase(stableBase)).toBe(stableBase);
  });

  test("keeps explicit test data roots isolated from the shared database", () => {
    const overrideBase = join(tempRoot, "test-override");
    process.env.LEARNIE_APP_DATA_ROOT = overrideBase;
    configureAppDataBase(join(tempRoot, "dev"));
    configureDatabaseBase(join(tempRoot, "stable"));

    expect(databasePath("projects.sqlite")).toBe(join(overrideBase, "learnie", "projects.sqlite"));
  });
});
