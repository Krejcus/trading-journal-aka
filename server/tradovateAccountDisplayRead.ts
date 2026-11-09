import { createHash } from 'node:crypto';
import { parseTradovateRequestPenalty } from '../lib/tradovateRequestControl.js';
import { explicitTradovateTradeDate, tradovateDisplayTradeDate } from '../lib/tradovateDisplayDay.js';
import type { TradovateAccountDisplaySnapshot } from '../lib/tradovateAccountDisplayTypes.js';

const currencyMetadata = new Map<string, { expiresAt: number; pending: Promise<unknown> }>();
const CURRENCY_TTL_MS = 60 * 60_000;
/** Test-only reset; financial snapshots and timestamps are never cached here. */
export function resetTradovateDisplayCurrencyCacheForTests(): void { currencyMetadata.clear(); }

/** Existing read-only cash snapshot endpoint; no trading or configuration request. */
export async function readTradovateAccountDisplay(options: {
  baseUrl: string; accessToken: string; accountId: number; signal: AbortSignal; fetchImpl?: typeof fetch; now?: number; onBrokerRequest?: () => void;
}): Promise<TradovateAccountDisplaySnapshot['fields']> {
  if (!Number.isSafeInteger(options.accountId) || options.accountId <= 0) throw new Error('invalid-display-account');
  const request = async (path: string, method: 'POST' | 'GET' = 'GET') => {
  options.onBrokerRequest?.();
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? {body: JSON.stringify({ accountId: options.accountId })} : {}), redirect: 'manual', signal: options.signal,
  });
  const body = await response.json().catch(() => null);
  const penalty = parseTradovateRequestPenalty(response.status, body, response.headers.get('retry-after'));
  if (penalty) throw Object.assign(new Error('display-read-penalized'), {
    status: 429, retryAfterMs: penalty.retryAfterMs, evidence: penalty.evidence,
    captchaRequired: penalty.captchaRequired === true,
  });
  if (!response.ok) throw Object.assign(new Error(`display-read-http-${response.status}`), { status: response.status });
  if (!body || typeof body !== 'object' || body.errorText) throw new Error('display-read-unavailable');
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
  // Currency definitions are metadata. Cache only successful definitions, not
  // cash/PnL values or their freshness. Hash avoids retaining credentials as keys.
  const cacheKey = createHash('sha256').update(options.baseUrl).update('\0').update(options.accessToken).digest('hex');
  const metadataNow = Date.now();
  let cached = currencyMetadata.get(cacheKey);
  if (!cached || cached.expiresAt <= metadataNow) {
    const pending = request('/currency/list').then(value => {
      if (!Array.isArray(value)) throw new Error('display-currency-metadata-unavailable');
      return value;
    });
    cached = { expiresAt: metadataNow + CURRENCY_TTL_MS, pending };
    currencyMetadata.set(cacheKey, cached);
    pending.catch(() => { if (currencyMetadata.get(cacheKey)?.pending === pending) currencyMetadata.delete(cacheKey); });
    if (currencyMetadata.size > 200) {
      for (const [key, value] of currencyMetadata) if (value.expiresAt <= metadataNow) currencyMetadata.delete(key);
      if (currencyMetadata.size > 200) currencyMetadata.delete(currencyMetadata.keys().next().value!);
    }
  }
  const currencies = await cached.pending;
  const usdIds = new Set(Array.isArray(currencies) ? currencies.filter(c => c?.name === 'USD' && Number.isSafeInteger(c.id)).map(c => c.id) : []);
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
