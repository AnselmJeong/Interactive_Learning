import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "./project-db";
import type { SourceChunk } from "../shared/artifact-types";
import {
  estimateInitialMessageSetSize,
  MESSAGE_SET_GENERATION_BATCH_SIZE,
  outOfFocusFigureNumbers,
  repairTutorContextChunks,
  SessionMutationQueue,
  prefetchConsumeWaitMs,
  repairedCurrentChunkId,
  repairedModuleCurrentChunkId,
  sequentialTutorContext,
  tutorLanguageInstruction,
} from "./tutor-service";
import { TutorService } from "./tutor-service";

describe("prefetch consume wait policy", () => {
  test("does not wait the full consume window when provider timeout is nearly exhausted", () => {
    expect(prefetchConsumeWaitMs(0, 115_000, 100_000, 120_000)).toBe(6_000);
  });

  test("uses the consume cap for a fresh prefetch", () => {
    expect(prefetchConsumeWaitMs(0, 1_000, 100_000, 120_000)).toBe(100_000);
  });
});

describe("prepared message generation sizing", () => {
  const chunk = (id: string, length: number): SourceChunk => ({
    id,
    headingPath: [],
    locator: id,
    kind: "body",
    text: "x".repeat(length),
    confidence: 1,
  });

  test("uses 50 messages as a work batch without capping the full route", () => {
    const chunks = [
      ...Array.from({ length: 60 }, (_, index) => chunk(`short-${index}`, 700)),
      ...Array.from({ length: 126 }, (_, index) => chunk(`medium-${index}`, 701)),
      ...Array.from({ length: 2 }, (_, index) => chunk(`long-${index}`, 1601)),
    ];

    expect(MESSAGE_SET_GENERATION_BATCH_SIZE).toBe(50);
    expect(estimateInitialMessageSetSize(chunks)).toBe(319);
    expect(estimateInitialMessageSetSize(chunks)).toBeGreaterThan(chunks.length);
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

describe("sequential tutor grounding", () => {
  const chunk = (id: string, text: string): SourceChunk => ({
    id,
    headingPath: ["Paper"],
    locator: id,
    kind: "body",
    text,
    confidence: 1,
  });
  const chunks = [
    chunk("chunk-001", "Opening image and quotation."),
    chunk("chunk-002", "Cajal compares neurons to butterflies of the soul."),
    chunk("chunk-003", "The introduction begins with neurons and synapses."),
    chunk("chunk-050", "Figure 2.7 shows Hodgkin-Huxley gating variables."),
  ];

  test("gives a progression turn only the focus chunk and preceding local context", () => {
    expect(sequentialTutorContext(chunks, "chunk-002").map((item) => item.id)).toEqual(["chunk-002", "chunk-001"]);
    expect(sequentialTutorContext(chunks, "chunk-002").map((item) => item.id)).not.toContain("chunk-050");
  });

  test("rejects a numbered figure that is absent from the current chunk", () => {
    expect(outOfFocusFigureNumbers({ message: "이제 Figure 2.7을 보겠습니다." }, chunks[1])).toEqual(["2.7"]);
    expect(outOfFocusFigureNumbers({ message: "Figure 2.7의 변수를 봅니다." }, chunks[3])).toEqual([]);
  });

  test("limits the final repair pass to the current chunk on a progression turn", () => {
    expect(repairTutorContextChunks(chunks, chunks[2], true).map((item) => item.id)).toEqual(["chunk-003"]);
    expect(repairTutorContextChunks(chunks, chunks[2], false).map((item) => item.id)).toEqual(chunks.map((item) => item.id));
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

describe("immutable prepared message route", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "learnie-message-set-test-"));
    process.env.LEARNIE_APP_DATA_ROOT = tempRoot;
    closeDbForTests();
  });

  afterEach(async () => {
    closeDbForTests();
    delete process.env.LEARNIE_APP_DATA_ROOT;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function seedRoute() {
    const now = Date.now();
    const db = getDb();
    db.query("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('project-route', 'Project', ?, ?)").run(now, now);
    db.query("INSERT INTO learning_materials (id, project_id, title, status, created_at, updated_at) VALUES ('material-route', 'project-route', 'Material', 'ready', ?, ?)").run(now, now);
    db.query(
      `INSERT INTO learning_message_sets
       (id, material_id, status, provider, model, tutor_language, learning_level, material_fingerprint,
        annotation_snapshot_hash, prompt_version, generation_context_hash, total_messages, completed_messages,
        next_route_index, created_at, updated_at)
       VALUES ('set-route', 'material-route', 'ready', 'openai', 'model', 'ko', 'medium', 'material', 'annotations',
        'prompt', 'context', 3, 3, 3, ?, ?)`
    ).run(now, now);
    db.query(
      `INSERT INTO learning_sessions
       (id, project_id, material_id, title, status, current_module_id, completed_module_ids_json, current_chunk_id,
        covered_chunk_ids_json, model, message_set_id, last_revealed_route_index, created_at, updated_at)
       VALUES ('session-route', 'project-route', 'material-route', 'Session', 'active', 'module-a', '[]', 'chunk-a1', '[]',
        'model', 'set-route', -1, ?, ?)`
    ).run(now, now);
    const insert = db.query(
      `INSERT INTO prepared_learning_messages
       (id, message_set_id, route_index, module_id, module_index, source_chunk_id, target_event, content, blocks_json,
        source_refs_json, choices_json, state_update_json, route_before_json, route_after_json, created_at)
       VALUES (?, 'set-route', ?, ?, ?, ?, ?, ?, '[]', ?, '[]', ?, ?, ?, ?)`
    );
    const state = (moduleId: string, chunkId: string, covered: string[] = []) => JSON.stringify({
      currentModuleId: moduleId,
      currentChunkId: chunkId,
      coveredChunkIds: covered,
      completedModuleIds: [],
    });
    const update = JSON.stringify({ nextPhase: "explain", readyToContinue: true, nextSuggestedStep: "continue", detectedConfusion: null, turnMode: "teach" });
    insert.run("prepared-a0", 0, "module-a", 0, "chunk-a1", "start_module", "A0", '["chunk-a1"]', update, state("module-a", "chunk-a1"), state("module-a", "chunk-a1"), now);
    insert.run("prepared-a1", 1, "module-a", 1, "chunk-a2", "next_chunk", "A1", '["chunk-a2"]', update, state("module-a", "chunk-a1"), state("module-a", "chunk-a2", ["chunk-a1"]), now + 1);
    insert.run("prepared-b0", 2, "module-b", 0, "chunk-b1", "start_module", "B0", '["chunk-b1"]', update, state("module-a", "chunk-a2", ["chunk-a1"]), state("module-b", "chunk-b1", ["chunk-a1", "chunk-a2"]), now + 2);
  }

  test("detours add only visible transcript rows and return reveals the exact unread route message", async () => {
    seedRoute();
    const service = new TutorService();
    const internal = service as unknown as {
      revealPreparedMessageUnlocked: (id: string, options?: { returning?: boolean }) => Promise<{ message: string }>;
      insertMessage: (input: { sessionId: string; role: "user" | "assistant"; content: string; sourceRefs: string[]; conversationKind: "detour" }) => void;
    };
    expect((await internal.revealPreparedMessageUnlocked("session-route")).message).toBe("A0");
    internal.insertMessage({ sessionId: "session-route", role: "user", content: "Detour question", sourceRefs: [], conversationKind: "detour" });
    internal.insertMessage({ sessionId: "session-route", role: "assistant", content: "Detour answer", sourceRefs: [], conversationKind: "detour" });
    expect((await internal.revealPreparedMessageUnlocked("session-route", { returning: true })).message).toContain("A1");

    const db = getDb();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM prepared_learning_messages WHERE message_set_id = 'set-route'").get()?.count).toBe(3);
    expect(db.query<{ value: string }, []>("SELECT group_concat(origin_prepared_message_id, ',') AS value FROM learning_messages WHERE origin_prepared_message_id IS NOT NULL ORDER BY ordinal").get()?.value).toBe("prepared-a0,prepared-a1");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM learning_messages WHERE conversation_kind = 'detour'").get()?.count).toBe(2);
  });

  test("module jump preserves the prior module pointer and resumes at its next unread message", async () => {
    seedRoute();
    const service = new TutorService();
    const internal = service as unknown as {
      revealPreparedMessageUnlocked: (id: string, options?: { moduleId?: string }) => Promise<{ message: string }>;
    };
    expect((await internal.revealPreparedMessageUnlocked("session-route")).message).toBe("A0");
    expect((await internal.revealPreparedMessageUnlocked("session-route", { moduleId: "module-b" })).message).toBe("B0");
    const jumpProgress = getDb().query<{ covered_chunk_ids_json: string; completed_module_ids_json: string }, []>(
      "SELECT covered_chunk_ids_json, completed_module_ids_json FROM learning_sessions WHERE id = 'session-route'"
    ).get();
    expect(JSON.parse(jumpProgress?.covered_chunk_ids_json || "[]")).toEqual(["chunk-a1"]);
    expect(JSON.parse(jumpProgress?.completed_module_ids_json || "[]")).toEqual([]);
    expect((await internal.revealPreparedMessageUnlocked("session-route", { moduleId: "module-a" })).message).toBe("A1");

    const origins = getDb()
      .query<{ origin_prepared_message_id: string }, []>(
        "SELECT origin_prepared_message_id FROM learning_messages WHERE origin_prepared_message_id IS NOT NULL ORDER BY ordinal"
      )
      .all()
      .map((row) => row.origin_prepared_message_id);
    expect(origins).toEqual(["prepared-a0", "prepared-b0", "prepared-a1"]);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM prepared_learning_messages WHERE message_set_id = 'set-route'").get()?.count).toBe(3);
  });

  test("consumes an obsolete prepared route without adding it to the visible transcript", async () => {
    seedRoute();
    const service = new TutorService();
    const obsolete = getDb().query<Record<string, unknown>, []>("SELECT * FROM prepared_learning_messages WHERE id = 'prepared-a0'").get();
    expect(obsolete).toBeTruthy();
    const internal = service as unknown as {
      discardObsoletePreparedRoute: (sessionId: string, messageSetId: string, row: Record<string, unknown>) => void;
      revealPreparedMessageUnlocked: (id: string) => Promise<{ message: string }>;
      snapshot: (id: string) => { messages: Array<{ content: string }> };
    };

    internal.discardObsoletePreparedRoute("session-route", "set-route", obsolete!);

    expect(internal.snapshot("session-route").messages).toEqual([]);
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM learning_messages WHERE delivery_state = 'discarded'").get()?.count).toBe(1);
    expect((await internal.revealPreparedMessageUnlocked("session-route")).message).toBe("A1");
  });

  test("automatically continues with another 50-message batch after a batch checkpoint", async () => {
    seedRoute();
    const now = Date.now();
    getDb().query(
      `INSERT INTO learning_message_sets
       (id, material_id, status, provider, model, tutor_language, learning_level, material_fingerprint,
        annotation_snapshot_hash, prompt_version, generation_context_hash, total_messages, completed_messages,
        next_route_index, created_at, updated_at)
       VALUES ('set-batched', 'material-route', 'partial', 'openai', 'model', 'ko', 'medium', 'material', 'annotations',
        'prompt', 'batched-context', 100, 0, 0, ?, ?)`
    ).run(now, now);

    const service = new TutorService();
    const batchSizes: number[] = [];
    const internal = service as unknown as {
      generateMessageSet: (messageSetId: string, routeLimit: number) => Promise<void>;
      launchMessageSetGeneration: (messageSetId: string) => Promise<void>;
    };
    internal.generateMessageSet = async (messageSetId, routeLimit) => {
      batchSizes.push(routeLimit);
      if (batchSizes.length === 1) {
        getDb().query(
          `UPDATE learning_message_sets
           SET status = 'queued', completed_messages = 50, next_route_index = 50,
               generation_owner_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`
        ).run(Date.now(), messageSetId);
        return;
      }
      getDb().query(
        `UPDATE learning_message_sets
         SET status = 'ready', completed_messages = 100, next_route_index = 100,
             generation_owner_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(Date.now(), messageSetId);
    };

    await internal.launchMessageSetGeneration("set-batched");
    for (let attempt = 0; attempt < 20 && batchSizes.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(batchSizes).toEqual([50, 50]);
    expect(getDb().query<{ status: string }, []>("SELECT status FROM learning_message_sets WHERE id = 'set-batched'").get()?.status).toBe("ready");
  });
});
