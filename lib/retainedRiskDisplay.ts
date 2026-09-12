import { LIVE_READ_MAX_AGE_MS } from './liveReadFreshness';
export interface RetainedRiskDisplay { key: string; value: number; confirmedAt: string; stale: boolean }
/** Display only. Never use this retained value to authorize an order or risk action. */
export function retainedRiskDisplay(previous: RetainedRiskDisplay | null, input: {
  key: string; enabled: boolean; value: number | null; confirmedAt: string | null; verified: boolean;
}, now = Date.now()): RetainedRiskDisplay | null {
  if (!input.enabled) return null;
  const old = previous?.key === input.key ? previous : null;
  const at = Date.parse(input.confirmedAt ?? '');
  if (input.value != null && Number.isFinite(input.value) && Number.isFinite(at) && at <= now + 1_000
    && (!old || at >= Date.parse(old.confirmedAt))) {
    return {key:input.key,value:input.value,confirmedAt:input.confirmedAt!,stale:!input.verified || now - at > LIVE_READ_MAX_AGE_MS};
  }
  return old ? {...old,stale:true} : null;
}
