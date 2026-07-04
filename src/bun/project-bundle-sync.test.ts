import { describe, expect, test } from "bun:test";
import { shouldImportSessionSnapshot, shouldPurgeProjectsMissingFromRoot } from "./project-bundle-sync";

describe("project root purge safety", () => {
  test("does not purge cached projects when a root has no project manifests", () => {
    expect(shouldPurgeProjectsMissingFromRoot(new Set())).toBe(false);
  });

  test("allows pruning only after at least one project manifest is visible", () => {
    expect(shouldPurgeProjectsMissingFromRoot(new Set(["project-a"]))).toBe(true);
  });
});

describe("session snapshot import staleness", () => {
  test("imports only snapshots newer than the cached session", () => {
    expect(shouldImportSessionSnapshot(undefined, 100)).toBe(true);
    expect(shouldImportSessionSnapshot(99, 100)).toBe(true);
    expect(shouldImportSessionSnapshot(100, 100)).toBe(false);
    expect(shouldImportSessionSnapshot(101, 100)).toBe(false);
  });
});
