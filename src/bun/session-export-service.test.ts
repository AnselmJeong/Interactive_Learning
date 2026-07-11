import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAppDataBase, configureDatabaseBase } from "./paths";
import { closeDbForTests, getDb } from "./project-db";
import { SessionExportService } from "./session-export-service";
import { readZipEntries } from "./archive-reader";

let tempRoot = "";

afterEach(async () => {
  closeDbForTests();
  configureAppDataBase(null);
  configureDatabaseBase(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("session readable export", () => {
  test("exports only the selected visible conversation", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-session-export-test-"));
    configureAppDataBase(join(tempRoot, "data"));
    configureDatabaseBase(join(tempRoot, "db"));
    const now = Date.now();
    getDb().query("INSERT INTO projects (id, title, root_path, learning_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("p1", "Project", join(tempRoot, "projects"), "medium", now, now);
    getDb().query("INSERT INTO learning_materials (id, project_id, title, material_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("m1", "p1", "Material", "course", "ready", now, now);
    getDb().query("INSERT INTO learning_sessions (id, project_id, material_id, title, status, completed_module_ids_json, covered_chunk_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "p1", "m1", "A Session", "active", "[]", "[]", now, now);
    getDb().query("INSERT INTO learning_messages (id, session_id, role, content, source_refs_json, choices_json, blocks_json, delivery_state, conversation_kind, created_at, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("msg1", "s1", "assistant", "Visible lesson", "[]", "[]", "[]", "visible", "main", now, 0);
    getDb().query("INSERT INTO learning_messages (id, session_id, role, content, source_refs_json, choices_json, blocks_json, delivery_state, conversation_kind, created_at, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("msg2", "s1", "assistant", "Prepared secret", "[]", "[]", "[]", "prepared", "main", now, 1);

    const result = await new SessionExportService().exportReadable("s1", join(tempRoot, "exports"));
    const files = readZipEntries(await Bun.file(result.zipPath).bytes());
    const markdownFile = [...files.entries()].find(([path]) => path.endsWith("/session.md"))?.[1];
    const markdown = markdownFile ? new TextDecoder().decode(markdownFile) : "";
    expect(markdown).toContain("Visible lesson");
    expect(markdown).not.toContain("Prepared secret");
    expect(result.messageCount).toBe(1);
  });
});
