import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Fencing lease copier workeru.
 *
 * Na Macu byl jeden proces samozřejmostí. Na trvale běžícím kontejneru ne:
 * při deployi se instance překrývají a hostitel restartuje bez ptaní. Dva
 * workery nad jednou skupinou = duplicitní objednávky, tedy přesně to, proti
 * čemu stojí celý outbox.
 *
 * Ochrana stojí na `fence`, které se při každém převzetí zvýší. Worker ho
 * předkládá u každého zápisu stavu a zastaralý zápis odmítne databáze. Proto
 * nezáleží na tom, jestli starý worker o své ztrátě ví — psát už nemůže.
 *
 * Ztráta lease je pro runtime terminální: nesmí se zkoušet znovu získat za
 * běhu. Mezitím mohl převzít jiný worker a rozdělaný stav už nemusí platit.
 */

export class CopierLeaseHeldError extends Error {
  constructor() {
    super('Copier worker lease drží jiná instance; tenhle worker nesmí startovat');
    this.name = 'CopierLeaseHeldError';
  }
}

export class CopierLeaseLostError extends Error {
  constructor(reason: string) {
    super(`Copier worker přišel o lease: ${reason}`);
    this.name = 'CopierLeaseLostError';
  }
}

export interface WorkerLeaseOptions {
  runtimeId: string;
  /** Čitelné označení instance, např. `fly:ord:148e2f`. */
  holder: string;
  ttlSeconds?: number;
}

export interface WorkerLease {
  readonly leaseId: string;
  /** Aktuální fence. Po ztrátě lease se už nemění. */
  fence(): number;
  lost(): boolean;
  /** Prodloužení. Při selhání označí lease za ztracený a vyhodí. */
  renew(): Promise<void>;
  release(): Promise<void>;
}

export const DEFAULT_LEASE_TTL_SECONDS = 30;

/** Renew výrazně dřív, než lease vyprší — jeden zameškaný tik nesmí stačit. */
export const leaseRenewIntervalMs = (ttlSeconds: number) => Math.max(2_000, (ttlSeconds * 1_000) / 3);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LeaseRow {
  lease_id: string;
  fence: number | string;
}

const asFence = (value: unknown): number => {
  const fence = Number(value);
  if (!Number.isSafeInteger(fence) || fence <= 0) {
    throw new Error('Copier lease vrátil neplatný fence');
  }
  return fence;
};

export async function acquireWorkerLease(
  client: SupabaseClient,
  options: WorkerLeaseOptions,
): Promise<WorkerLease> {
  const { runtimeId, holder } = options;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  if (!uuidPattern.test(runtimeId)) throw new Error('Copier runtimeId must be a UUID');
  if (!holder.trim()) throw new Error('Copier lease holder nesmí být prázdný');

  const { data, error } = await client.rpc('acquire_copier_worker_lease', {
    p_runtime_id: runtimeId,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) {
    if (error.message.includes('COPIER_LEASE_HELD')) throw new CopierLeaseHeldError();
    throw new Error(`Copier lease acquire failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as LeaseRow | null;
  if (!row?.lease_id) throw new Error('Copier lease acquire nevrátil lease_id');

  const leaseId = row.lease_id;
  let fence = asFence(row.fence);
  let isLost = false;

  return {
    leaseId,
    fence: () => fence,
    lost: () => isLost,

    async renew() {
      if (isLost) throw new CopierLeaseLostError('lease už byl označen za ztracený');
      const { data: renewed, error: renewError } = await client.rpc('renew_copier_worker_lease', {
        p_runtime_id: runtimeId,
        p_lease_id: leaseId,
        p_ttl_seconds: ttlSeconds,
      });
      if (renewError) {
        isLost = true;
        throw new CopierLeaseLostError(
          renewError.message.includes('COPIER_LEASE_LOST')
            ? 'převzala ho jiná instance nebo vypršel'
            : renewError.message,
        );
      }
      const current = asFence(renewed);
      if (current !== fence) {
        // Fence se za běhu změnit nemůže, aniž bychom o lease přišli.
        isLost = true;
        throw new CopierLeaseLostError(`fence se změnil z ${fence} na ${current}`);
      }
    },

    async release() {
      isLost = true;
      const { error: releaseError } = await client.rpc('release_copier_worker_lease', {
        p_runtime_id: runtimeId,
        p_lease_id: leaseId,
      });
      if (releaseError) throw new Error(`Copier lease release failed: ${releaseError.message}`);
    },
  };
}

export interface LeaseRenewalOptions {
  intervalMs?: number;
  onLost: (error: Error) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Pravidelné prodlužování. První selhání je konečné — zavolá `onLost` a
 * přestane. Runtime na to musí reagovat okamžitým DISARM.
 */
export function startLeaseRenewal(
  lease: WorkerLease,
  options: LeaseRenewalOptions,
): () => void {
  const interval = options.intervalMs ?? leaseRenewIntervalMs(DEFAULT_LEASE_TTL_SECONDS);
  const schedule = options.setIntervalFn ?? setInterval;
  const cancel = options.clearIntervalFn ?? clearInterval;
  const timer = schedule(() => {
    void lease.renew().catch((reason: unknown) => {
      cancel(timer);
      options.onLost(reason instanceof Error ? reason : new Error(String(reason)));
    });
  }, interval);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => cancel(timer);
}
