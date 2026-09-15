/**
 * Retries a flaky external call a bounded number of times with backoff. A
 * single failed round trip previously looked identical to "no matching row"
 * / "not signed in" / "not authorized" everywhere this project reads a
 * Supabase result, so a brief network blip could deny a genuinely signed-in,
 * authorized user. `isFailure` must only report a real transport/query
 * error, never a legitimately empty result -- retrying those would just
 * waste time. `delaysMs` bounds the total wait (defaults to ~2.6s across 3
 * attempts); a connection that is still down after that stays denied, since
 * no client-side retry can wait out a genuinely dead connection.
 */
export async function retryTransient<T>(
  run: () => PromiseLike<T>,
  isFailure: (result: T) => boolean,
  delaysMs: readonly number[] = [300, 800, 1500],
): Promise<T> {
  let result = await run();
  for (const delay of delaysMs) {
    if (!isFailure(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await run();
  }
  return result;
}
