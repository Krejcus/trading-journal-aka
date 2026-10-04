import { LIVE_READ_MAX_AGE_MS } from './liveReadFreshness';
export interface RetainedRiskDisplay { key: string; value: number; confirmedAt: string; stale: boolean }
/** Display only. Never use this retained value to authorize an order or risk action. */
export function retainedRiskDisplay(previous: RetainedRiskDisplay | null, input: {
  key: string; enabled: boolean; value: number | null; confirmedAt: string | null; verified: boolean;
  /** Vstup se právě načítá (např. obnova denního reportu po návratu na LIVE). */
  pending?: boolean;
}, now = Date.now()): RetainedRiskDisplay | null {
  if (!input.enabled) return null;
  const old = previous?.key === input.key ? previous : null;
  const at = Date.parse(input.confirmedAt ?? '');
  if (input.value != null && Number.isFinite(input.value) && Number.isFinite(at) && at <= now + 1_000
    && (!old || at >= Date.parse(old.confirmedAt))) {
    return {key:input.key,value:input.value,confirmedAt:input.confirmedAt!,stale:!input.verified || now - at > LIVE_READ_MAX_AGE_MS};
  }
  if (!old) return null;
  // Ověřená hodnota mladší než ověřovací okno zůstává ověřená, pokud ji nic
  // nevyvrací: vstup se právě načítá, nebo je to ověřený, jen o chvíli starší
  // důkaz o STEJNÉ částce (čtení zahájené dřív doběhlo po novějším). Jinak by
  // číslo při každé obnově ztmavlo a rozsvítilo se. Selhání čtení nebo jiná
  // částka ji dál označí jako poslední známou.
  const agrees = input.verified && input.value != null && Math.abs(input.value - old.value) < 0.005;
  const stillFresh = (input.pending === true || agrees)
    && !old.stale && now - Date.parse(old.confirmedAt) <= LIVE_READ_MAX_AGE_MS;
  return {...old,stale:!stillFresh};
}
