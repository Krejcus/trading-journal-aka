import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes.js';
import type { TradovateLivePnlTick } from '../lib/tradovateLivePnlTypes.js';
import { applyTradovateLivePnlTick } from '../lib/tradovateLivePnl.js';
import { hasCompleteTradovateRead } from '../lib/tradovateLiveReadState.js';
import { loadTradovateAccountData } from './tradovateAccountData.js';
import { loadTradovateLivePnlTick } from './tradovateLivePnl.js';
import { assertTradovateBackgroundCapacity, TradovateRequestControlError } from './tradovateServerRequestControl.js';
import { peekTradovateSharedRead, sharedTradovateRead, type TradovateSharedReadContext } from './tradovateSharedRead.js';
import { readWorkerSharedTick } from './tradovateSharedWorkerRead.js';

export const SHARED_ACCOUNT_BASELINE_MS = 10 * 60_000;
export const BASELINE_EXPOSURE_FRESH_MS = 5_000;
export const ACCOUNT_BASELINE_CHANNEL = 'accounts:full:v1';
export interface SharedAccountReadOptions {
  context: TradovateSharedReadContext;
  baseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  brokerUserId?: number | null;
}

export async function readSharedTradovateTick(options: SharedAccountReadOptions): Promise<TradovateLivePnlTick> {
  // The persisted worker stream is already a shared source. Prefer it even
  // while an older REST fallback is cached, so recovery/fills are visible immediately.
  const baseline = await peekTradovateSharedRead<TradovateAccountDataResult>(options.context, ACCOUNT_BASELINE_CHANNEL);
  if (baseline) {
    const stream = await readWorkerSharedTick(options.context, baseline);
    if (stream) return stream;
  }
  const result = await sharedTradovateRead<TradovateLivePnlTick>({ context: options.context, channel: 'accounts:tick:v1',
    ttlMs: 30_000,
    read: async previous => {
      // Cursor belongs to the shared collector, not to a particular screen/device.
      // The previous shared cursor survives expiry and is advanced only by the collector.
      return loadTradovateLivePnlTick({ ...options, connectionId: options.context.connectionId,
        environment: options.context.environment, contractCursor: previous?.nextContractCursor ?? 0 });
    },
  });
  return { ...result.value, connectionId: options.context.connectionId, brokerCalls: result.shared ? 0 : result.value.brokerCalls };
}

function mayRetainKnownDisplay(error: unknown): boolean {
  const failure = error as { message?: string; status?: number } | null;
  return failure?.status !== 401 && failure?.status !== 403
    && !['tradovate-not-connected', 'tradovate-reauthorization-required', 'invalid-auth-token', 'missing-auth-token'].includes(failure?.message ?? '');
}

/** Slow account/risk/ledger baseline is shared independently of fast exposure updates. */
export async function readSharedTradovateAccounts(options: SharedAccountReadOptions & { detail?: 'bootstrap' | 'full' }): Promise<TradovateAccountDataResult> {
  const detail = options.detail ?? 'full';
  const existingFull = detail === 'bootstrap'
    ? await peekTradovateSharedRead<TradovateAccountDataResult>(options.context, ACCOUNT_BASELINE_CHANNEL) : null;
  let baselinePending = false;
  let result: TradovateAccountDataResult;
  try {
    result = existingFull ?? (await sharedTradovateRead<TradovateAccountDataResult>({ context: options.context,
      channel: detail === 'full' ? ACCOUNT_BASELINE_CHANNEL : 'accounts:bootstrap:v1',
      ttlMs: detail === 'full' ? SHARED_ACCOUNT_BASELINE_MS : 30_000,
      cacheable: value => hasCompleteTradovateRead(value.coverage.accounts)
        && (detail === 'bootstrap' || Object.values(value.coverage).every(hasCompleteTradovateRead))
        && (detail === 'bootstrap' || value.accounts.every(account => hasCompleteTradovateRead(account.balance.coverage)
          && hasCompleteTradovateRead(account.risk.statusCoverage) && hasCompleteTradovateRead(account.risk.limitsCoverage))),
      read: async previous => {
        const context = { ...options.context, brokerUserId: options.brokerUserId ?? null };
        await assertTradovateBackgroundCapacity(context, (detail === 'full' ? 9 : 4)
          + (detail === 'full' ? 4 : 1) * (previous?.accounts.length ?? 0));
        return loadTradovateAccountData({ ...options, detail,
          beforeAccountReads: async count => {
            try { await assertTradovateBackgroundCapacity(context, (detail === 'full' ? 4 : 1) * count); }
            catch (error) {
              if (error instanceof TradovateRequestControlError && error.precheck) {
                throw new TradovateRequestControlError(error.code, error.retryAfterMs, error.snapshot, error.notDispatched, false);
              }
              throw error;
            }
          },
        });
      },
    })).value;
  } catch (error) {
    if (!mayRetainKnownDisplay(error)) throw error;
    const retained = await peekTradovateSharedRead<TradovateAccountDataResult>(options.context, ACCOUNT_BASELINE_CHANNEL, true);
    if (!retained) throw error;
    result = retained;
    baselinePending = true;
  }
  // A newly collected baseline already includes the exposure. A cached baseline
  // must acquire the COMMON fast tick before cold-start paint, not start another full read.
  if (!baselinePending && Date.now() - Date.parse(result.requestedAt ?? result.capturedAt) <= BASELINE_EXPOSURE_FRESH_MS) return { ...result,
    sharedRead: { baselineAsOf: result.requestedAt ?? result.capturedAt, refreshPending: false } };
  const baselineAsOf = result.requestedAt ?? result.capturedAt;
  try {
    const tick = await readSharedTradovateTick(options);
    return { ...applyTradovateLivePnlTick(result, tick).data, sharedRead: { baselineAsOf, refreshPending: baselinePending } };
  } catch (error) {
    // Invalid/revoked auth must never be hidden by a retained snapshot.
    if (!mayRetainKnownDisplay(error)) throw error;
    return { ...result, sharedRead: { baselineAsOf, refreshPending: true, retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs ?? 5_000 } };
  }
}
