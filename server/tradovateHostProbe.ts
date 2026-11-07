/**
 * Dočasná sonda přechodu Tradovate na dynamické hosty (`apiHosts`, docs.ninjatrader.com/api/dynamic-api-hosts).
 * Jen zapisuje do logu: názvy polí, stavové kódy a hostname. Tokeny ani hodnoty přihlášení do výstupu nejdou
 * a token se posílá jen na hosty z povoleného seznamu. Výsledek nikdy nerozhoduje o připojení.
 */
const ALLOWED_HOST_SUFFIXES = ['.tradovateapi.com', '.tradovate.com', '.ninjatrader.com', '.ninjatrader.dev'];
const HOSTNAME_PATTERN = /^[a-z0-9.-]{1,253}$/i;

export const isAllowedTradovateHost = (host: string): boolean => HOSTNAME_PATTERN.test(host)
  && ALLOWED_HOST_SUFFIXES.some(suffix => host.toLowerCase().endsWith(suffix));

export function describeApiHosts(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, host]) => typeof host === 'string' && HOSTNAME_PATTERN.test(host))
    .map(([key, host]) => [key, host as string]));
}

export function describeTokenShape(value: unknown): { responseKeys: string[]; apiHosts: Record<string, string> | null } {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { responseKeys: Object.keys(body).sort(), apiHosts: describeApiHosts(body.apiHosts) };
}

interface ProbeStep {
  url: string;
  status: number | null;
  locationHost?: string | null;
  keys?: string[];
  errorText?: string;
  apiHosts?: Record<string, string> | null;
  failed?: string;
}

const hostOf = (location: string | null): string | null => {
  if (!location) return null;
  try { return new URL(location).hostname; } catch { return null; }
};

async function step(host: string, path: string, accessToken: string, fetchImpl: typeof fetch): Promise<ProbeStep> {
  const url = `https://${host}/v1${path}`;
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(3_000),
    });
    const result: ProbeStep = { url, status: response.status, locationHost: hostOf(response.headers.get('location')) };
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* není JSON */ }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const shape = describeTokenShape(body);
      result.keys = shape.responseKeys;
      result.apiHosts = shape.apiHosts;
      const errorText = (body as Record<string, unknown>).errorText;
      if (typeof errorText === 'string') result.errorText = errorText.slice(0, 160);
    } else if (!response.ok && text && !text.includes(accessToken)) {
      result.errorText = text.slice(0, 160);
    }
    return result;
  } catch (error) {
    return { url, status: null, failed: error instanceof Error ? error.name : 'unknown' };
  }
}

/**
 * Po selhání identity: kam Tradovate tento login posílá. Volá se jen s tokenem, který se stejně zahodí,
 * proto smí zkusit i obnovu; ta podle dokumentace vrací `apiHosts`.
 */
export async function probeTradovateHosts(options: {
  baseHost: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeStep[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const steps = [await step(options.baseHost, '/auth/me', options.accessToken, fetchImpl)];
  const redirected = steps[0].locationHost;
  const usable = redirected && redirected !== options.baseHost && isAllowedTradovateHost(redirected) ? redirected : null;
  if (usable) steps.push(await step(usable, '/auth/me', options.accessToken, fetchImpl));
  const renewal = await step(usable ?? options.baseHost, '/auth/renewaccesstoken', options.accessToken, fetchImpl);
  steps.push(renewal);
  const fromRenewal = renewal.apiHosts?.demo;
  if (fromRenewal && !usable && fromRenewal !== options.baseHost && isAllowedTradovateHost(fromRenewal)) {
    steps.push(await step(fromRenewal, '/auth/me', options.accessToken, fetchImpl));
  }
  return steps;
}
