import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZipFromDirectory } from "./archive-writer";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function localFileNames(zip: Buffer) {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

describe("archive writer", () => {
  test("writes a cross-platform zip archive without an external zip command", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-zip-test-"));
    const source = join(tempRoot, "source");
    const nested = join(source, "materials", "01 Intro");
    await mkdir(nested, { recursive: true });
    await writeFile(join(source, "README.md"), "# Archive\n", "utf8");
    await writeFile(join(nested, "course_plan.md"), "# Course\n", "utf8");

    const zipPath = join(tempRoot, "archive.zip");
    await writeZipFromDirectory(source, zipPath);

    const zip = await readFile(zipPath);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(localFileNames(zip).sort()).toEqual([
      "README.md",
      "materials/",
      "materials/01 Intro/",
      "materials/01 Intro/course_plan.md",
    ]);
  });
});
