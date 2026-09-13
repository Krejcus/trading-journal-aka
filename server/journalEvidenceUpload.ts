import type { JournalEvidence } from '../lib/tradovateJournalEvidence.js';

export const APPROVED_JOURNAL_ORIGIN = 'https://alphatrade-mentor-15.vercel.app';

export function journalUploadUrl(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  if (url.origin !== APPROVED_JOURNAL_ORIGIN || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new Error('journal-upload-origin-not-approved');
  return `${url.origin}/api/tradovate/oauth/copier-journal`;
}

const abortable = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

/** Upload transport only. No broker commands, pairing, restart or ARM operations. */
export function createJournalBatchUploader(options: {
  apiOrigin: string;
  authorizationHeader: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const endpoint = journalUploadUrl(options.apiOrigin);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (events: readonly JournalEvidence[], shutdownSignal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = shutdownSignal ? AbortSignal.any([timeout, shutdownSignal]) : timeout;
    const authorization = await abortable(options.authorizationHeader(), signal);
    const response = await abortable(fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ events }),
    }), signal);
    if (!response.ok) throw new Error(`journal-upload-http-${response.status}`);
    const body = await abortable(response.json(), signal) as { accepted?: unknown; ids?: unknown } | null;
    const ids = body?.ids;
    // Do not advance a durable cursor on a partial, malformed, or unrelated ACK.
    if (body?.accepted !== true || !Array.isArray(ids) || ids.length !== events.length
      || new Set(ids).size !== events.length || events.some(event => !ids.includes(event.id))) {
      throw new Error('journal-upload-incomplete-ack');
    }
  };
}

export function startJournalEvidenceUpload(options: {
  flush: (upload: (events: JournalEvidence[]) => Promise<void>) => Promise<void>;
  apiOrigin: string;
  authorizationHeader: () => Promise<string>;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  onError?: (error: Error) => void;
}) {
  const upload = createJournalBatchUploader(options);
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> | null = null;
  let failures = 0;
  const run = async () => {
    let fullBatch = false;
    try {
      for (let batch = 0; batch < 10 && !shutdown.signal.aborted; batch++) {
        let count = 0;
        await options.flush(async events => { await upload(events, shutdown.signal); count = events.length; });
        fullBatch = count === 100;
        if (!fullBatch) break;
      }
      failures = 0;
    } catch (reason) {
      failures += 1;
      if (!shutdown.signal.aborted) {
        try { options.onError?.(reason instanceof Error ? reason : new Error('journal-upload-failed')); } catch { /* Independent observer. */ }
      }
    } finally {
      pending = null;
      if (!shutdown.signal.aborted) {
        const delay = failures ? Math.min(60_000, (options.pollMs ?? 5_000) * 2 ** Math.min(failures - 1, 5))
          : fullBatch ? 100 : options.pollMs ?? 5_000;
        timer = setTimeout(() => { timer = null; pending = run(); }, delay);
        timer.unref?.();
      }
    }
  };
  // Return immediately. Network and disk work never joins the execution commit.
  pending = run();
  return { async close() { shutdown.abort(new Error('journal-upload-stopped')); if (timer) clearTimeout(timer); await pending; } };
}
