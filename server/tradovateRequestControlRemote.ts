import { isTradovateRequestGrant, isTradovateControlSnapshot, TradovateRemoteControlError, type TradovateRequestControlRemote, type TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';

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
    const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      // Never discard a real penalty or turn a local budget refusal into an outage.
      if (responseBody && typeof responseBody.error === 'string' && responseBody.error.startsWith('tradovate-request-')) {
        if (responseBody.snapshot !== undefined && !isTradovateControlSnapshot(responseBody.snapshot)) {
          throw new TradovateRemoteControlError(['tradovate-request-cooldown', 'tradovate-request-captcha'].includes(responseBody.error)
            ? responseBody.error : 'tradovate-request-control-invalid-response');
        }
        const retry = typeof responseBody.retryAfterMs === 'number' && Number.isFinite(responseBody.retryAfterMs) && responseBody.retryAfterMs >= 0
          ? responseBody.retryAfterMs : null;
        throw new TradovateRemoteControlError(responseBody.error, retry, responseBody.snapshot as TradovateRequestControlSnapshot | undefined);
      }
      throw new TradovateRemoteControlError(`request-control-remote-${response.status}`);
    }
    if (!responseBody || typeof responseBody !== 'object') throw new TradovateRemoteControlError('tradovate-request-control-invalid-response');
    return responseBody;
  };
  const snapshot = (value: unknown): TradovateRequestControlSnapshot => {
    const row = value as TradovateRequestControlSnapshot;
    if (!isTradovateControlSnapshot(row)) throw new Error('request-control-remote-snapshot-invalid');
    return row;
  };
  return {
    async read() { return snapshot((await call({ mode: 'read' })).snapshot); },
    async reserve(input) { const value = (await call({ mode: 'reserve', ...input })).grant; if (!isTradovateRequestGrant(value)) throw new Error('request-control-remote-grant-invalid'); return value; },
    async penalize(penalty) { return snapshot((await call({ mode: 'penalize', penalty })).snapshot); },
  };
}
