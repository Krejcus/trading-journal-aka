import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';

export interface PendingCopierSnapshot {
  episodeId: string;
  kind: 'entry' | 'exit';
  at: number;
  symbol: string;
  png: string;
  notifyDeadlineAt: number;
}
type Failure = NonNullable<CopierSnapshotHealth['lastFailure']>;
interface State {
  version: 1;
  jobs: PendingCopierSnapshot[];
  lastFailure: Failure | null;
  lastSuccessAt: number | null;
}
export const snapshotDeliveryId = (job: Pick<PendingCopierSnapshot, 'episodeId' | 'kind' | 'at'>) =>
  `${job.episodeId}:${job.kind}:${job.at}`;

/** Local private image spool. It retries the same bytes, never recaptures a trade.
 * All disk mutations serialize; network IO runs outside that lock. No broker port. */
export async function createCopierSnapshotDelivery(options: {
  path: string;
  upload: (job: PendingCopierSnapshot) => Promise<void>;
  onState: (state: Pick<CopierSnapshotHealth, 'lastFailure' | 'lastSuccessAt' | 'pendingUploads'>) => void;
  now?: () => number;
  onFailure?: (failure: Failure) => void;
}) {
  const now = options.now ?? Date.now;
  let state: State = { version: 1, jobs: [], lastFailure: null, lastSuccessAt: null };
  try {
    if ((await stat(options.path)).size > 96 * 1024 * 1024) throw new Error('snapshot-spool-too-large');
    const loaded = JSON.parse(await readFile(options.path, 'utf8')) as State;
    if (loaded.version !== 1 || !Array.isArray(loaded.jobs) || loaded.jobs.length > 32
      || loaded.jobs.some(job => !validJob(job))) throw new Error('snapshot-spool-invalid');
    state = loaded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let tail: Promise<unknown> = Promise.resolve();
  let flushing: Promise<void> | null = null;
  let stopped = false;
  const emit = () => options.onState({
    lastFailure: state.lastFailure, lastSuccessAt: state.lastSuccessAt, pendingUploads: state.jobs.length,
  });
  const persist = async (next: State) => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const handle = await open(`${options.path}.tmp`, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
    await rename(`${options.path}.tmp`, options.path);
    state = next;
    emit();
  };
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const fail = (failure: Failure) => mutate(async () => {
    options.onFailure?.(failure);
    // An older delayed upload must not erase a later capture failure.
    const permanentFailure = state.lastFailure && state.lastFailure.phase !== 'upload';
    if (!(permanentFailure && failure.phase === 'upload')
      && (!state.lastFailure || state.lastFailure.at <= failure.at)) {
      await persist({ ...state, lastFailure: failure });
    }
  });
  emit();
  return {
    fail,
    async enqueue(job: PendingCopierSnapshot) {
      if (!validJob(job)) throw new Error('snapshot-spool-invalid-image');
      await mutate(async () => {
        if (state.jobs.some(item => snapshotDeliveryId(item) === snapshotDeliveryId(job))) return;
        if (state.jobs.length >= 32) throw new Error('snapshot-spool-full');
        await persist({ ...state, jobs: [...state.jobs, job] });
      });
    },
    flush(): Promise<void> {
      if (flushing) return flushing;
      if (stopped) return Promise.resolve();
      const work = (async () => {
        await tail;
        // At most four uploads per pass, bounded load and no starvation behind a failed item.
        for (const job of state.jobs.slice(0, 4)) {
          if (stopped) break;
          const id = snapshotDeliveryId(job);
          try { await options.upload(job); }
          catch (error) {
            const message = error instanceof Error ? error.message : '';
            const code = /^(copier-relay-request-timeout|copier-relay-http-\d{3}|copier-snapshot-store-rejected|snapshot-relay-unavailable)$/.test(message)
              ? message : 'snapshot-upload-pending';
            await fail({ id, at: job.at, phase: 'upload', code });
            await mutate(() => persist({ ...state, jobs: [
              ...state.jobs.filter(item => snapshotDeliveryId(item) !== id), job,
            ] }));
            continue;
          }
          await mutate(() => persist({
            ...state,
            jobs: state.jobs.filter(item => snapshotDeliveryId(item) !== id),
            lastFailure: state.lastFailure?.id === id ? null : state.lastFailure,
            lastSuccessAt: now(),
          }));
        }
      })();
      flushing = work.finally(() => { flushing = null; });
      return flushing;
    },
    async close() { stopped = true; await flushing; await tail; },
  };
}

function validJob(job: PendingCopierSnapshot): boolean {
  return Boolean(job && /^[0-9a-f-]{36}$/i.test(job.episodeId)
    && ['entry', 'exit'].includes(job.kind) && Number.isSafeInteger(job.at) && job.at > 0
    && Number.isSafeInteger(job.notifyDeadlineAt) && job.notifyDeadlineAt >= job.at
    && job.notifyDeadlineAt <= job.at + 60_000
    && typeof job.symbol === 'string' && /^[A-Z0-9._:!-]{1,32}$/.test(job.symbol)
    && typeof job.png === 'string' && job.png.length <= Math.ceil(2 * 1024 * 1024 / 3) * 4
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(job.png));
}
