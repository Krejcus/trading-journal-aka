/**
 * DOČASNÁ read-only sonda (7. 11. 2026): co nabízí připojení prop organizace na hostech z \`apiHosts\`.
 * Jen GET z pevného seznamu na povolené hosty, bez následování přesměrování. Do logu jdou jen stavové kódy,
 * názvy polí a pravdivostní hodnoty; žádné tokeny, čísla účtů ani zůstatky. Výsledek nic nerozhoduje.
 */
import { isAllowedTradovateApiHost, type TradovateApiHosts } from '../lib/tradovateApiHosts.js';

const TRADING_PATHS = [
  '/v1/accountRiskStatus/list', '/v1/userAccountAutoLiq/list', '/v1/permissionedAccountAutoLiq/list',
  '/v1/userAccountPositionLimit/list', '/v1/userAccountRiskParameter/list', '/v1/marketDataSubscription/list', '/v1/tradingPermission/list',
];
const SERVICE_PATHS = ['/', '/v1', '/health', '/v1/health'];

const describe = (value: unknown): unknown => {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== 'object') return Array.isArray(value) ? { items: value.length } : typeof value;
  const booleans = Object.fromEntries(Object.entries(first as Record<string, unknown>).filter(([, item]) => typeof item === 'boolean'));
  const enums = Object.fromEntries(Object.entries(first as Record<string, unknown>)
    .filter(([key, item]) => typeof item === 'string' && /status|action|mode|type/i.test(key) && !/account|user|email/i.test(key))
    .map(([key, item]) => [key, String(item).slice(0, 40)]));
  return { items: Array.isArray(value) ? value.length : 1, keys: Object.keys(first).sort(), booleans, enums };
};

export async function probeTradovateCapabilities(accessToken: string, apiHosts: TradovateApiHosts | null): Promise<unknown[]> {
  const get = async (host: string | undefined, path: string) => {
    if (!host || !isAllowedTradovateApiHost(host)) return { host: host ?? null, path, skipped: 'host' };
    const started = Date.now();
    try {
      const response = await fetch(`https://${host}${path}`, {
        method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(4_000),
      });
      const text = await response.text().catch(() => '');
      let body: unknown = null;
      try { body = text ? describe(JSON.parse(text)) : null; } catch { body = { textLength: text.length, contentType: response.headers.get('content-type') }; }
      return { host, path, status: response.status, ms: Date.now() - started, body };
    } catch (error) {
      return { host, path, failed: error instanceof Error ? error.name : 'unknown' };
    }
  };
  return Promise.all([
    ...TRADING_PATHS.map(path => get(apiHosts?.demo, path)),
    ...SERVICE_PATHS.map(path => get(apiHosts?.riskMonitorDemo, path)),
    ...SERVICE_PATHS.map(path => get(apiHosts?.userContext, path)),
  ]);
}
