export type TradovateHistoricalSyncStatus =
  | 'available'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'invalid-response'
  | 'unavailable';

export interface TradovateReportParameterDefinition {
  name: string;
  paramType: string | null;
  optional: boolean | null;
}

export interface TradovateReportDefinitionSummary {
  name: string;
  parameters: TradovateReportParameterDefinition[];
}

export interface TradovateHistoricalSyncCapability {
  status: TradovateHistoricalSyncStatus;
  httpStatus: number | null;
  checkedAt: string;
  reportBaseUrl: string;
  definitionCount: number;
  reports: TradovateReportDefinitionSummary[];
  supportsPerformance: boolean;
  supportsOrders: boolean;
  supportsCashHistory: boolean;
  supportsAccountBalanceHistory: boolean;
  responseShape: {
    kind: 'array' | 'object' | 'null' | 'primitive';
    topLevelKeys: string[];
    arrayKeys: string[];
  };
}

interface RawReportParameter {
  name?: unknown;
  paramType?: unknown;
  optional?: unknown;
}

interface RawReportDefinition {
  name?: unknown;
  params?: unknown;
}

const REPORT_TIMEOUT_MS = 8_000;

export const tradovateReportBaseUrl = (environment: 'demo' | 'live') =>
  environment === 'live'
    ? 'https://rpt-live.tradovateapi.com/v1'
    : 'https://rpt-demo.tradovateapi.com/v1';

const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const summarizeDefinitions = (value: unknown): TradovateReportDefinitionSummary[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TradovateReportDefinitionSummary[] => {
    const raw = candidate as RawReportDefinition;
    if (typeof raw?.name !== 'string' || !raw.name.trim()) return [];
    const parameters = Array.isArray(raw.params)
      ? raw.params.flatMap((parameter): TradovateReportParameterDefinition[] => {
        const item = parameter as RawReportParameter;
        if (typeof item?.name !== 'string' || !item.name.trim()) return [];
        return [{
          name: item.name.trim(),
          paramType: typeof item.paramType === 'string' ? item.paramType : null,
          optional: typeof item.optional === 'boolean' ? item.optional : null,
        }];
      })
      : [];
    return [{ name: raw.name.trim(), parameters }];
  });
};

const responseShape = (value: unknown): TradovateHistoricalSyncCapability['responseShape'] => {
  if (Array.isArray(value)) return { kind: 'array', topLevelKeys: [], arrayKeys: [] };
  if (value === null) return { kind: 'null', topLevelKeys: [], arrayKeys: [] };
  if (typeof value !== 'object') return { kind: 'primitive', topLevelKeys: [], arrayKeys: [] };
  const record = value as Record<string, unknown>;
  return {
    kind: 'object',
    topLevelKeys: Object.keys(record).slice(0, 20),
    arrayKeys: Object.entries(record)
      .filter(([, candidate]) => Array.isArray(candidate))
      .map(([key]) => key)
      .slice(0, 20),
  };
};

const definitionCandidates = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'items', 'reports', 'definitions', 'reportDefinitions', 'result']) {
    if (Array.isArray(record[key])) return record[key];
  }
  const soleArray = Object.values(record).filter(Array.isArray);
  return soleArray.length === 1 ? soleArray[0] : null;
};

const hasReport = (reports: TradovateReportDefinitionSummary[], candidates: string[]) => {
  const names = new Set(reports.map(report => normalizeName(report.name)));
  return candidates.some(candidate => names.has(normalizeName(candidate)));
};

const result = (options: {
  status: TradovateHistoricalSyncStatus;
  httpStatus: number | null;
  reportBaseUrl: string;
  reports?: TradovateReportDefinitionSummary[];
  response?: unknown;
  now?: number;
}): TradovateHistoricalSyncCapability => {
  const reports = options.reports ?? [];
  return {
    status: options.status,
    httpStatus: options.httpStatus,
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    reportBaseUrl: options.reportBaseUrl,
    definitionCount: reports.length,
    reports,
    supportsPerformance: hasReport(reports, ['Performance']),
    supportsOrders: hasReport(reports, ['Orders', 'Order']),
    supportsCashHistory: hasReport(reports, ['Cash History', 'CashHistory']),
    supportsAccountBalanceHistory: hasReport(reports, ['Account Balance History', 'AccountBalanceHistory']),
    responseShape: responseShape(options.response),
  };
};

/**
 * Read-only capability probe. It only requests report definitions and never
 * generates a report, places an order, or mutates the broker account.
 */
export async function probeTradovateHistoricalSync(options: {
  environment: 'demo' | 'live';
  accessToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}): Promise<TradovateHistoricalSyncCapability> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reportBaseUrl = tradovateReportBaseUrl(options.environment);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REPORT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${reportBaseUrl}/reports/requestReportDefinitions`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.accessToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const status = response.status === 401
        ? 'unauthorized'
        : response.status === 403
          ? 'forbidden'
          : response.status === 404
            ? 'not-found'
            : 'unavailable';
      return result({ status, httpStatus: response.status, reportBaseUrl, now: options.now });
    }
    const body = await response.json().catch(() => null);
    const candidates = definitionCandidates(body);
    const reports = summarizeDefinitions(candidates);
    return result({
      status: Array.isArray(candidates) ? 'available' : 'invalid-response',
      httpStatus: response.status,
      reportBaseUrl,
      reports,
      response: body,
      now: options.now,
    });
  } catch {
    return result({ status: 'unavailable', httpStatus: null, reportBaseUrl, now: options.now });
  } finally {
    clearTimeout(timeout);
  }
}
