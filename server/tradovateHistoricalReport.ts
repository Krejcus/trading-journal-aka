import { tradovateReportBaseUrl } from './tradovateHistoricalProbe.js';

export type TradovateHistoricalReportStatus =
  | 'available'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid-response'
  | 'unavailable';

export interface TradovateHistoricalReportResult {
  status: TradovateHistoricalReportStatus;
  httpStatus: number | null;
  reportName: 'Performance';
  accountId: number;
  startDate: string;
  endDate: string;
  contentType: string | null;
  byteLength: number;
  columns: string[];
  rowCount: number;
  rows: string[][];
  truncated: boolean;
  diagnostic: string | null;
}

const REPORT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 1_000;

const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  return rows;
};

const blank = (options: {
  status: TradovateHistoricalReportStatus;
  httpStatus: number | null;
  accountId: number;
  startDate: string;
  endDate: string;
  contentType?: string | null;
  byteLength?: number;
  diagnostic?: string | null;
}): TradovateHistoricalReportResult => ({
  status: options.status,
  httpStatus: options.httpStatus,
  reportName: 'Performance',
  accountId: options.accountId,
  startDate: options.startDate,
  endDate: options.endDate,
  contentType: options.contentType ?? null,
  byteLength: options.byteLength ?? 0,
  columns: [],
  rowCount: 0,
  rows: [],
  truncated: false,
  diagnostic: options.diagnostic ?? null,
});

/** Generates only the read-only Performance CSV report. */
export async function requestTradovatePerformanceReport(options: {
  environment: 'demo' | 'live';
  accessToken: string;
  accountId: number;
  accountSpec: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TradovateHistoricalReportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REPORT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${tradovateReportBaseUrl(options.environment)}/reports/requestReport`, {
      method: 'POST',
      headers: {
        Accept: 'text/csv, application/json;q=0.9, */*;q=0.8',
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Performance',
        representationType: 'csv',
        timezone: -300,
        params: [
          { name: 'startDate', value: options.startDate },
          { name: 'endDate', value: options.endDate },
          { name: 'account', value: options.accountSpec },
        ],
      }),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type');
    const responseText = await response.text();
    if (!response.ok) {
      return blank({
        status: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unavailable',
        httpStatus: response.status,
        accountId: options.accountId,
        startDate: options.startDate,
        endDate: options.endDate,
        contentType,
        byteLength: responseText.length,
        diagnostic: responseText.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300) || null,
      });
    }
    if (!responseText.trim()) {
      return {
        status: 'available',
        httpStatus: response.status,
        reportName: 'Performance',
        accountId: options.accountId,
        startDate: options.startDate,
        endDate: options.endDate,
        contentType,
        byteLength: responseText.length,
        columns: [],
        rowCount: 0,
        rows: [],
        truncated: false,
        diagnostic: null,
      };
    }
    let text = responseText;
    if (/^\s*\{/.test(responseText)) {
      let diagnostic = responseText.slice(0, 300);
      try {
        const wrapped = JSON.parse(responseText) as { data?: unknown; errorText?: unknown; failureText?: unknown };
        if (typeof wrapped.data === 'string') {
          text = wrapped.data;
        } else {
          diagnostic = String(wrapped.errorText ?? wrapped.failureText ?? diagnostic);
        }
      } catch {
        // Keep the bounded raw diagnostic.
      }
      if (text === responseText) {
        return blank({
          status: 'invalid-response',
          httpStatus: response.status,
          accountId: options.accountId,
          startDate: options.startDate,
          endDate: options.endDate,
          contentType,
          byteLength: responseText.length,
          diagnostic,
        });
      }
    }
    if (!text.trim()) {
      return {
        status: 'available',
        httpStatus: response.status,
        reportName: 'Performance',
        accountId: options.accountId,
        startDate: options.startDate,
        endDate: options.endDate,
        contentType,
        byteLength: responseText.length,
        columns: [],
        rowCount: 0,
        rows: [],
        truncated: false,
        diagnostic: null,
      };
    }
    const parsed = parseCsv(text);
    if (parsed.length === 0 || parsed[0].length === 0) {
      return blank({
        status: 'invalid-response',
        httpStatus: response.status,
        accountId: options.accountId,
        startDate: options.startDate,
        endDate: options.endDate,
        contentType,
        byteLength: responseText.length,
        diagnostic: text.slice(0, 300) || 'Prázdná odpověď',
      });
    }
    const dataRows = parsed.slice(1);
    return {
      status: 'available',
      httpStatus: response.status,
      reportName: 'Performance',
      accountId: options.accountId,
      startDate: options.startDate,
      endDate: options.endDate,
      contentType,
      byteLength: responseText.length,
      columns: parsed[0],
      rowCount: dataRows.length,
      rows: dataRows.slice(0, MAX_ROWS),
      truncated: dataRows.length > MAX_ROWS,
      diagnostic: null,
    };
  } catch (error) {
    return blank({
      status: 'unavailable',
      httpStatus: null,
      accountId: options.accountId,
      startDate: options.startDate,
      endDate: options.endDate,
      diagnostic: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network-error',
    });
  } finally {
    clearTimeout(timeout);
  }
}
