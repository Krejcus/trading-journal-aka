import { TRADOVATE_REQUEST_CONTROL_POLICY } from './tradovateRequestControl';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';

/** Display reads only. This is neither an OAuth error nor a broker429 penalty. */
export function tradovateSoftReadDelay(error: unknown): number | null {
  if (!(error instanceof TradovateRequestError) || error.status !== 503 || error.message !== 'tradovate-request-budget') return null;
  const retry = error.retryAfterMs;
  return Math.max(15_000, typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 && retry <= 3_600_000 + TRADOVATE_REQUEST_CONTROL_POLICY.maxGrantTtlMs ? retry : 0);
}

export function createTradovateSoftReadDeferrals() {
  const until = new Map<string, number>();
  return {
    record(connectionId: string, error: unknown, now = Date.now()) {
      const delay = tradovateSoftReadDelay(error);
      if (delay != null) until.set(connectionId, Math.max(until.get(connectionId) ?? 0, now + delay));
    },
    resumeAt(connectionId: string, brokerPenaltyUntil = 0) { return Math.max(until.get(connectionId) ?? 0, brokerPenaltyUntil); },
  };
}
