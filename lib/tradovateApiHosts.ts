/**
 * Dynamické hosty Tradovate (docs.ninjatrader.com/api/dynamic-api-hosts). Od přechodu na infrastrukturu
 * NinjaTraderu mají prop organizace vlastní demo hosty (Lucid: `demo-api.lucid.ninjatrader.com`, 7. 11. 2026).
 * Hosty se berou z odpovědi autentizace a ukládají k připojení; bez nich platí výchozí sdílené hosty.
 * Token se smí poslat jen na host z povoleného seznamu.
 */
export type TradovateApiHosts = Readonly<Record<string, string>>;
export type TradovateHostEnvironment = 'demo' | 'live';

const ALLOWED_SUFFIXES = ['.tradovateapi.com', '.tradovate.com', '.ninjatrader.com'];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export const TRADOVATE_DEFAULT_API_HOSTS = {
  live: 'live.tradovateapi.com',
  demo: 'demo.tradovateapi.com',
  reportingLive: 'rpt-live.tradovateapi.com',
  reportingDemo: 'rpt-demo.tradovateapi.com',
} as const;

export const isAllowedTradovateApiHost = (host: unknown): host is string => typeof host === 'string'
  && HOSTNAME.test(host) && ALLOWED_SUFFIXES.some(suffix => host.toLowerCase().endsWith(suffix));

/**
 * Demo klíč nesmí mířit na live host a naopak: worker s `environment: 'demo'` by jinak obchodoval přes live.
 * Pojistka „jen demo“ tak nezávisí na tom, co pošle broker.
 */
const crossesEnvironment = (key: string, host: string): boolean => {
  const lower = host.toLowerCase();
  if (/demo/i.test(key)) return /^(live|rpt-live|md)\./.test(lower) || lower.startsWith('live-') || lower.startsWith('rpt-live');
  if (/live/i.test(key)) return lower.includes('demo');
  return false;
};

/** Jen povolené hostname; cizí nebo poškozený klíč se zahodí. Prázdný výsledek = null (výchozí hosty). */
export function sanitizeTradovateApiHosts(value: unknown): TradovateApiHosts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, host]) => /^[a-zA-Z]{1,40}$/.test(key) && isAllowedTradovateApiHost(host) && !crossesEnvironment(key, host))
    .map(([key, host]) => [key, (host as string).toLowerCase()] as const);
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : null;
}

export const tradovateTradingHost = (environment: TradovateHostEnvironment, hosts?: TradovateApiHosts | null): string =>
  hosts?.[environment] ?? TRADOVATE_DEFAULT_API_HOSTS[environment];

export const tradovateRestBaseUrl = (environment: TradovateHostEnvironment, hosts?: TradovateApiHosts | null): string =>
  `https://${tradovateTradingHost(environment, hosts)}/v1`;

export const tradovateWebSocketUrl = (environment: TradovateHostEnvironment, hosts?: TradovateApiHosts | null): string =>
  `wss://${tradovateTradingHost(environment, hosts)}/v1/websocket`;

export const tradovateReportingBaseUrl = (environment: TradovateHostEnvironment, hosts?: TradovateApiHosts | null): string => {
  const key = environment === 'live' ? 'reportingLive' : 'reportingDemo';
  return `https://${hosts?.[key] ?? TRADOVATE_DEFAULT_API_HOSTS[key]}/v1`;
};
