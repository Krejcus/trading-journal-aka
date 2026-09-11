import { explicitTradovateTradeDate, tradovateDisplayTradeDate } from '../lib/tradovateDisplayDay.js';
import type { TradovateAccountDisplaySnapshot } from '../lib/tradovateAccountDisplayTypes.js';

/** Existing read-only cash snapshot endpoint; no trading or configuration request. */
export async function readTradovateAccountDisplay(options: {
  baseUrl: string; accessToken: string; accountId: number; signal: AbortSignal; fetchImpl?: typeof fetch; now?: number;
}): Promise<TradovateAccountDisplaySnapshot['fields']> {
  if (!Number.isSafeInteger(options.accountId) || options.accountId <= 0) throw new Error('invalid-display-account');
  const request = async (path: string, method: 'POST' | 'GET' = 'GET') => {
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? {body: JSON.stringify({ accountId: options.accountId })} : {}), signal: options.signal,
  });
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const seconds = retry == null ? NaN : Number(retry);
    const retryAfterMs = Number.isFinite(seconds) ? seconds * 1_000 : retry ? Date.parse(retry) - Date.now() : undefined;
    throw Object.assign(new Error(`display-read-http-${response.status}`), { status: response.status, retryAfterMs });
  }
  const body = await response.json();
  if (!body || typeof body !== 'object' || body.errorText || body['p-ticket']) {
    throw Object.assign(new Error('display-read-unavailable'), body?.['p-ticket'] ? {status:429,retryAfterMs: Math.max(1_000, Number(body['p-time']) * 1_000 || 60_000)} : {});
  }
    return body;
  };
  const requestedAt = options.now ?? Date.now();
  const body = await request('/cashBalance/getcashbalancesnapshot', 'POST');
  const fields: TradovateAccountDisplaySnapshot['fields'] = {};
  for (const key of ['totalCashValue', 'totalCashValueSOD', 'realizedPnL', 'netLiq', 'openPnL'] as const) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) fields[key] = body[key];
  }
  // CashBalance explicitly carries tradeDate and currency; the generic
  // snapshot's realizedPnL has neither and is never relabelled as daily.
  const balances = await request(`/cashBalance/deps?masterid=${options.accountId}`);
  const currencies = await request('/currency/list');
  const usdIds = new Set(Array.isArray(currencies) ? currencies.filter(c => c?.symbol === 'USD' && Number.isSafeInteger(c.id)).map(c => c.id) : []);
  const tradeDate = tradovateDisplayTradeDate(requestedAt);
  if (tradeDate === tradovateDisplayTradeDate(options.now ?? Date.now()) && Array.isArray(balances)) {
    const candidates = balances.filter(row => row?.accountId === options.accountId && usdIds.has(row.currencyId)
      && explicitTradovateTradeDate(row.tradeDate) === tradeDate && Number.isFinite(Date.parse(row.timestamp))
      && Date.parse(row.timestamp) <= (options.now ?? Date.now()) + 1_000)
      .sort((a,b) => Date.parse(b.timestamp)-Date.parse(a.timestamp));
    const daily = candidates[0]?.realizedPnL;
    if (typeof daily === 'number' && Number.isFinite(daily)) fields.dailyRealizedPnL = daily;
  }
  return fields;
}
