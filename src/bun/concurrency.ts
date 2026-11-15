// Runs `worker` over `items` with at most `limit` calls in flight and returns the results in input
// order. Learning-material analysis makes one LLM call per module and per passage; the calls are
// independent, so running a few at once shortens the wait without flooding the provider CLI.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

// LLM calls a single material analysis may run at once.
export const ANALYSIS_CONCURRENCY = 3;
