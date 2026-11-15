import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  test("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (delay, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(delay);
      inFlight -= 1;
      return index * 10;
    });
    expect(result).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  test("handles empty input", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
