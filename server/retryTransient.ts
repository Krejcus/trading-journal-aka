/**
 * Bounded retry for read-only, idempotent cloud/broker reads whose failure
 * must never turn a persistent worker into a launchd crash loop.
 *
 * 17. 9. 2026: Tradovate needed 17–61 s to renew a token; the worker's 10 s
 * lease deadline threw at startup, the process exited and launchd restarted
 * it more than forty times. The retry stays inside the process, waits with a
 * growing delay and gives up only at the deadline — still fail-closed, never
 * unbounded, and only for errors that are transient by classification.
 */
export interface RetryTransientOptions {
  /** Total budget from the first attempt; 0 disables retries. */
  deadlineMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  isTransient?: (error: unknown) => boolean;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const TRANSIENT_PATTERN = /timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|aborted|-http-(408|425|429|5\d\d)\b|\b(408|425|429|5\d\d)\b|tradovate-pilot-lease-failed/i;

/** Timeouts, network failures, 408/425/429 and 5xx are transient; auth, identity and validation errors are not. */
export function isTransientRemoteError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/-http-(401|403|404)\b|\b(401|403|404)\b|unauthorized|forbidden|mismatch|keychain|decrypt|expired/i.test(message)) return false;
  return TRANSIENT_PATTERN.test(message);
}

export async function retryTransient<T>(task: (attempt: number) => Promise<T>, options: RetryTransientOptions = {}): Promise<T> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  const deadlineMs = Math.max(0, options.deadlineMs ?? 10 * 60_000);
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 5_000);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 60_000);
  const isTransient = options.isTransient ?? isTransientRemoteError;
  const deadlineAt = clock() + deadlineMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (deadlineMs === 0 || !isTransient(error)) throw error;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (clock() + delay > deadlineAt) throw error;
      try { options.onRetry?.(error, attempt, delay); } catch { /* Logging never changes the outcome. */ }
      await sleep(delay);
    }
  }
}
