import { isTradovateRequestGrant, type TradovateRequestControlRemote, type TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';

export function createTradovateRequestControlRemote(options: {
  apiOrigin: string; connectionId: string; authorizationHeader(): Promise<string>; fetchImpl?: typeof fetch;
}): TradovateRequestControlRemote {
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = async (body: Record<string, unknown>) => {
    const authorization = await options.authorizationHeader();
    const response = await fetchImpl(`${options.apiOrigin.replace(/\/$/, '')}/api/tradovate/oauth/request-control`, {
      method: 'POST', redirect: 'error', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: options.connectionId, scope: 'owner', ...body }), signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`request-control-remote-${response.status}`); }
    return response.json() as Promise<Record<string, unknown>>;
  };
  const snapshot = (value: unknown): TradovateRequestControlSnapshot => {
    const row = value as TradovateRequestControlSnapshot;
    if (!row || row.version !== 1 || !Number.isSafeInteger(row.brokerUserId) || row.brokerUserId <= 0 || !Number.isFinite(row.serverNow)
      || !Number.isSafeInteger(row.epoch) || row.epoch < 0 || typeof row.captchaRequired !== 'boolean') throw new Error('request-control-remote-snapshot-invalid');
    return row;
  };
  return {
    async read() { return snapshot((await call({ mode: 'read' })).snapshot); },
    async reserve(input) { const value = (await call({ mode: 'reserve', ...input })).grant; if (!isTradovateRequestGrant(value)) throw new Error('request-control-remote-grant-invalid'); return value; },
    async penalize(penalty) { return snapshot((await call({ mode: 'penalize', penalty })).snapshot); },
  };
}
