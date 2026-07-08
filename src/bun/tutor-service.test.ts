import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import { SessionMutationQueue, prefetchConsumeWaitMs, repairedCurrentChunkId, repairedModuleCurrentChunkId, tutorLanguageInstruction } from "./tutor-service";
import { TutorService } from "./tutor-service";

describe("prefetch consume wait policy", () => {
  test("does not wait the full consume window when provider timeout is nearly exhausted", () => {
    expect(prefetchConsumeWaitMs(0, 115_000, 100_000, 120_000)).toBe(6_000);
  });

  test("uses the consume cap for a fresh prefetch", () => {
    expect(prefetchConsumeWaitMs(0, 1_000, 100_000, 120_000)).toBe(100_000);
  });
});

describe("session mutation queue", () => {
  test("serializes mutations for the same session while allowing queued callers to resolve", async () => {
    const queue = new SessionMutationQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;

    const first = queue.run("session-a", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first-end");
      return 1;
    });
    const second = queue.run("session-a", async () => {
      events.push("second-start");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("tutor language instruction", () => {
  test("requires Korean for every learner-facing JSON field", () => {
    const instruction = tutorLanguageInstruction("ko");

    expect(instruction).toContain("Reply in Korean");
    expect(instruction).toContain("every learner-facing JSON field");
    expect(instruction).toContain("Do not switch to English");
  });

  test("preserves source schema while keeping original spellings visible", () => {
    const instruction = tutorLanguageInstruction("ko");

    expect(instruction).toContain("Keep JSON keys");
    expect(instruction).toContain("source_quote.quote");
    expect(instruction).toContain("original spelling in parentheses");
  });
});

describe("session cursor repair", () => {
  const curriculum = ["chunk-001", "chunk-002", "chunk-003", "chunk-004"];

  test("moves a covered current chunk to the first uncovered chunk", () => {
    expect(repairedCurrentChunkId("chunk-002", ["chunk-001", "chunk-002"], curriculum)).toBe("chunk-003");
  });

  test("keeps a valid active current chunk", () => {
    expect(repairedCurrentChunkId("chunk-003", ["chunk-001", "chunk-002"], curriculum)).toBe("chunk-003");
  });

  test("uses the last valid chunk once every chunk is covered", () => {
    expect(repairedCurrentChunkId("chunk-002", curriculum, curriculum)).toBe("chunk-004");
    expect(repairedCurrentChunkId("missing", curriculum, curriculum)).toBe("chunk-004");
  });
});

describe("module cursor repair", () => {
  const moduleChunks = ["chunk-001", "chunk-002", "chunk-003"];

  test("restores the last unfinished chunk taught in the selected module", () => {
    expect(repairedModuleCurrentChunkId("chunk-004", ["chunk-001"], moduleChunks, ["chunk-001", "chunk-002"])).toBe("chunk-002");
  });

  test("moves to the next uncovered module chunk after a covered taught chunk", () => {
    expect(repairedModuleCurrentChunkId("chunk-004", ["chunk-001", "chunk-002"], moduleChunks, ["chunk-002"])).toBe("chunk-003");
  });

  test("falls back to the first uncovered module chunk when the module has no prior turns", () => {
    expect(repairedModuleCurrentChunkId("chunk-004", ["chunk-001"], moduleChunks)).toBe("chunk-002");
  });
});

describe("prepared learning messages", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-prepared-messages-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function insertSession() {
    const now = Date.now();
    getDb()
      .query("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?)")
      .run(now, now);
    getDb()
      .query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-1', 'project-1', 'Material', 'ready', ?, ?)")
      .run(now, now);
    getDb()
      .query(
        `INSERT INTO learning_sessions
         (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json,
          current_chunk_id, covered_chunk_ids_json, created_at, updated_at)
         VALUES ('session-1', 'project-1', 'material-1', 'Session', 'active', 'module-1', '[]', 'chunk-1', '[]', ?, ?)`
      )
      .run(now, now);
    return "session-1";
  }

  test("hides prepared rows from normal snapshots and session counts", async () => {
    const sessionId = insertSession();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, source_refs_json, choices_json, blocks_json, delivery_state, created_at, ordinal)
         VALUES
         ('visible-1', ?, 'assistant', 'Visible', '[]', '[]', '[]', 'visible', ?, 0),
         ('prepared-1', ?, 'assistant', 'Prepared', '[]', '[]', '[]', 'prepared', ?, 1)`
      )
      .run(sessionId, now, sessionId, now);

    const service = new TutorService();
    const snapshot = (service as unknown as { snapshot: (id: string) => { messages: Array<{ content: string }> } }).snapshot(sessionId);
    const summaries = await service.listSessions("material-1");

    expect(snapshot.messages.map((message) => message.content)).toEqual(["Visible"]);
    expect(summaries[0]?.messageCount).toBe(1);
  });

  test("inserting a visible detour shifts prepared future messages behind it", () => {
    const sessionId = insertSession();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, source_refs_json, choices_json, blocks_json, delivery_state, created_at, ordinal)
         VALUES
         ('visible-1', ?, 'assistant', 'Visible', '[]', '[]', '[]', 'visible', ?, 0),
         ('prepared-1', ?, 'assistant', 'Prepared', '[]', '[]', '[]', 'prepared', ?, 1)`
      )
      .run(sessionId, now, sessionId, now);

    const service = new TutorService();
    (service as unknown as {
      insertMessage: (input: { sessionId: string; role: "user"; content: string; sourceRefs: string[] }) => void;
    }).insertMessage({ sessionId, role: "user", content: "Question", sourceRefs: [] });

    const rows = getDb()
      .query<{ id: string; delivery_state: string; ordinal: number }, []>("SELECT id, delivery_state, ordinal FROM learning_messages ORDER BY ordinal ASC")
      .all();

    expect(rows).toEqual([
      { id: "visible-1", delivery_state: "visible", ordinal: 0 },
      { id: expect.any(String), delivery_state: "visible", ordinal: 1 },
      { id: "prepared-1", delivery_state: "prepared", ordinal: 2 },
    ]);
  });

  test("does not schedule default prefetch while prepared messages remain", async () => {
    const sessionId = insertSession();
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO learning_messages
         (id, session_id, role, content, source_refs_json, choices_json, blocks_json, delivery_state,
          batch_run_id, cursor_before_json, cursor_after_json, created_at, ordinal)
         VALUES
         ('prepared-1', ?, 'assistant', 'Prepared', '[]', '[]', '[]', 'prepared',
          'run-1', '{}', '{}', ?, 1)`
      )
      .run(sessionId, now);
    getDb()
      .query(
        `INSERT INTO tutor_prefetches
         (id, session_id, material_id, kind, status, base_message_count, base_current_chunk_id,
          base_covered_chunk_ids_json, base_session_fingerprint, target_event, target_module_id,
          target_chunk_id, cursor_after_json, provider, model, settings_fingerprint, material_fingerprint,
          prompt_version, output_json, created_at, updated_at, expires_at)
         VALUES
         ('prefetch-1', ?, 'material-1', 'default_continue', 'generating', 1, 'chunk-1',
          '[]', 'fingerprint-1', 'next_chunk', 'module-1',
          'chunk-2', '{}', 'openai', 'model', 'settings', 'material',
          'prefetch-v1', '{}', ?, ?, ?)`
      )
      .run(sessionId, now, now, now + 60_000);

    const service = new TutorService();
    await (service as unknown as {
      scheduleDefaultContinueAsync: (id: string, reason: "assistant_turn") => Promise<void>;
    }).scheduleDefaultContinueAsync(sessionId, "assistant_turn");

    const row = getDb().query<{ status: string }, []>("SELECT status FROM tutor_prefetches WHERE id = 'prefetch-1'").get();
    expect(row?.status).toBe("stale");
  });
});
