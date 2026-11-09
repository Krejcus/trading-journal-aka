import { readTradovatePenaltyBody } from '../lib/tradovatePenaltyBody';
import { parseTradovateRequestPenalty, type TradovateRequestPurpose } from '../lib/tradovateRequestControl';
import type { TradovateRequestGovernor } from './tradovateRequestControlGovernor';

/** Raw display/discovery client uses the same governor as execution adapters. */
export function createTradovateControlledFetch(governor: TradovateRequestGovernor, fetchImpl: typeof fetch = fetch, purpose: TradovateRequestPurpose = 'background', beforeDispatch?: () => void): typeof fetch {
  return async (input, init) => {
    const permit = await governor.prepare(purpose);
    beforeDispatch?.();
    const release = governor.dispatch(purpose, permit);
    let response: Response;
    try { response = await fetchImpl(input, init); governor.response(); }
    catch (error) { governor.transportUnknown(); release(); throw error; }
    const releaseInspection = response.status === 423 ? governor.holdPenaltyInspection('Tradovate HTTP423 penalty is being inspected') : null;
    try {
      const headerLatch = response.status === 429
        ? governor.penalize(parseTradovateRequestPenalty(429, null, response.headers.get('retry-after'))!) : null;
      void headerLatch?.catch(() => {});
      let body: unknown = null;
      if (response.status === 423 || response.status === 429) body = await readTradovatePenaltyBody(response);
      else if (response.headers.get('content-type')?.includes('json') || response.ok) {
        try { body = await response.clone().json(); } catch { /* original reader handles invalid JSON */ }
      }
      const penalty = parseTradovateRequestPenalty(response.status, body, response.headers.get('retry-after'));
      if (headerLatch) await headerLatch;
      if (penalty) await governor.penalize(penalty);
      return response;
    } finally { releaseInspection?.(); release(); }
  };
}
