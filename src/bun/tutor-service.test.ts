import { describe, expect, test } from "bun:test";
import { SessionMutationQueue, prefetchConsumeWaitMs, repairedCurrentChunkId, repairedModuleCurrentChunkId, tutorLanguageInstruction } from "./tutor-service";

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
