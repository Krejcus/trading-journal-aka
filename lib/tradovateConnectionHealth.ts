/** Display evidence only; never authorizes execution or removes accounts. */
export interface TradovateConnectionHealth {
  state: 'verified' | 'reconnect-required' | 'unavailable' | 'budget-limited' | 'cooldown' | 'captcha';
  requestedAt: number;
}
export type TradovateConnectionHealthMap = Record<string, TradovateConnectionHealth>;

export function applyTradovateConnectionHealth(
  current: TradovateConnectionHealthMap, connectionId: string, requestedAt: number, error?: unknown,
): TradovateConnectionHealthMap {
  if ((current[connectionId]?.requestedAt ?? -Infinity) > requestedAt) return current;
  const message = error instanceof Error ? error.message : '';
  const state = error == null ? 'verified'
    : message === 'tradovate-reauthorization-required' ? 'reconnect-required'
      : message === 'tradovate-request-budget' ? 'budget-limited'
      : message === 'tradovate-request-cooldown' ? 'cooldown'
      : message === 'tradovate-request-captcha' ? 'captcha' : 'unavailable';
  // A timeout must not hide an already confirmed invalid login and its remedy.
  if (state !== 'verified' && state !== 'reconnect-required' && current[connectionId]?.state === 'reconnect-required') return current;
  return { ...current, [connectionId]: { state, requestedAt } };
}

export function tradovateConnectionPresentation(connected: boolean, health?: TradovateConnectionHealth) {
  if (!connected) return { label: 'Disconnected', reconnect: true, healthy: false };
  if (health?.state === 'reconnect-required') return { label: 'Obnov přihlášení', reconnect: true, healthy: false };
  if (health?.state === 'budget-limited') return { label: 'Načítání omezeno rozpočtem', reconnect: false, healthy: false };
  if (health?.state === 'cooldown') return { label: 'Broker dočasně omezil požadavky', reconnect: false, healthy: false };
  if (health?.state === 'captcha') return { label: 'Broker vyžaduje ověření', reconnect: false, healthy: false };
  if (health?.state === 'unavailable') return { label: 'Data nedostupná', reconnect: false, healthy: false };
  if (!health) return { label: 'Ověřuji připojení', reconnect: false, healthy: false };
  return { label: 'Connected', reconnect: false, healthy: true };
}
