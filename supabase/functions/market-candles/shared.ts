export type DatabentoOhlcvSchema = 'ohlcv-1m' | 'ohlcv-1h';

export const MAX_RANGE_MS = 16 * 24 * 60 * 60 * 1000;
export const MAX_HTF_RANGE_MS = 370 * 24 * 60 * 60 * 1000;
export const MAX_CANDLE_RECORDS = 25_000;

const nyClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const nyParts = (at: number) => Object.fromEntries(nyClock.formatToParts(at).map(part => [part.type, part.value]));

/** Only trim a CLOSED trailing weekend, never a trading interval or a holiday.
 * CME NQ/MNQ: Friday 17:00 ET to Sunday 18:00 ET is closed.
 * https://www.cmegroup.com/articles/faqs/micro-e-mini-equity-index-futures-frequently-asked-questions.html
 * A continuous mapping need not exist for the unpublished Sunday business day.
 * Asking for that mapping can turn an otherwise valid history into HTTP 206.
 * The response must disclose the excluded closed interval; no bars are filled. */
export function historicalProviderEnd(endMs: number): number {
  if (!Number.isFinite(endMs)) return endMs;
  // Exclusive end: Sunday 18:00:00.000 still ends BEFORE the reopening.
  const parts = nyParts(endMs - 1);
  const backDays = parts.weekday === 'Sat' ? 1 : parts.weekday === 'Sun' && Number(parts.hour) < 18 ? 2
    : parts.weekday === 'Fri' && Number(parts.hour) >= 17 ? 0 : null;
  if (backDays === null) return endMs;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - backDays, 17);
  // Compute Friday's own offset, not Sunday's: US DST can change mid-weekend.
  let at = wall;
  for (let pass = 0; pass < 2; pass++) {
    const p = nyParts(at);
    at += wall - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  }
  return Math.min(endMs, at);
}

export interface ParsedMarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ParsedDatabentoResponse {
  candles: ParsedMarketCandle[];
  sourceSymbol: string;
  malformedRecords: number;
  truncated: boolean;
}

export const isAllowedSymbol = (value: string): boolean =>
  /^(MNQ|NQ)([HMUZ]\d{1,2}|\.(c|n|v)\.\d+)$/i.test(value);

export const normalizeMarketSymbol = (value: string): string => {
  const trimmed = value.trim();
  const continuous = /^(MNQ|NQ)\.([cnv])\.(\d+)$/i.exec(trimmed);
  if (continuous) {
    return `${continuous[1].toUpperCase()}.${continuous[2].toLowerCase()}.${continuous[3]}`;
  }
  return trimmed.toUpperCase();
};

export const isAllowedSchema = (value: string): value is DatabentoOhlcvSchema =>
  value === 'ohlcv-1m' || value === 'ohlcv-1h';

export function validateRequestedRange(
  startMs: number,
  endMs: number,
  schema: DatabentoOhlcvSchema = 'ohlcv-1m',
): boolean {
  const maxRange = schema === 'ohlcv-1h' ? MAX_HTF_RANGE_MS : MAX_RANGE_MS;
  return Number.isFinite(startMs)
    && Number.isFinite(endMs)
    && endMs > startMs
    && endMs - startMs <= maxRange;
}

export type CostValidation = 'allowed' | 'invalid' | 'over-limit';

export function parseEstimatedCost(value: string): number {
  const trimmed = value.trim();
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'number') return parsed;
    if (parsed && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      const nested = Number(row.cost_usd ?? row.cost ?? row.value);
      if (Number.isFinite(nested)) return nested;
    }
  } catch {
    // The caller treats an invalid response as a hard failure.
  }
  return Number.NaN;
}

export function providerCostError(status: number): { error: string; message: string; status: number } {
  if (status === 401 || status === 403) return {
    error: 'provider-auth',
    message: 'Databento odmítlo API oprávnění. Zkontroluj platnost klíče a přístup k GLBX.MDP3.',
    status: 502,
  };
  if (status === 402) return {
    error: 'provider-payment',
    message: 'Databento účet momentálně nepovoluje placený historický request. Zkontroluj kredit nebo platební stav.',
    status: 402,
  };
  if (status === 429) return {
    error: 'provider-rate-limit',
    message: 'Databento dočasně omezilo metadata requesty. Počkej chvíli a zkus to znovu.',
    status: 429,
  };
  return {
    error: status >= 500 ? 'provider-cost-unavailable' : 'provider-cost-request',
    message: status >= 500
      ? 'Databento kontrola ceny je dočasně nedostupná.'
      : 'Databento odmítlo parametry kontroly ceny historických dat.',
    status: 502,
  };
}

export const shouldRetryProviderCost = (status: number): boolean =>
  status === 429 || status >= 500;

export function validateEstimatedCost(estimatedCostUsd: number, maxCostUsd: number): CostValidation {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0 || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    return 'invalid';
  }
  return estimatedCostUsd <= maxCostUsd ? 'allowed' : 'over-limit';
}

const timestampToMs = (value: unknown): number => {
  if (typeof value === 'number') return value > 1e15 ? value / 1e6 : value;
  if (typeof value !== 'string') return Number.NaN;

  // Databento returns ISO 8601 when pretty_ts=true. Supporting an integer
  // string as well keeps this parser safe if that response option changes.
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric > 1e15 ? numeric / 1e6 : numeric;
  }
  return Date.parse(value);
};

export function parseDatabentoOhlcvJsonl(
  raw: string,
  requestedSymbol: string,
  maxRecords = MAX_CANDLE_RECORDS,
): ParsedDatabentoResponse {
  const candles: ParsedMarketCandle[] = [];
  let sourceSymbol = '';
  let malformedRecords = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (candles.length >= maxRecords) {
      return { candles, sourceSymbol, malformedRecords, truncated: true };
    }

    try {
      const row = JSON.parse(line) as Record<string, any>;
      const timestamp = row.ts_event ?? row.hd?.ts_event;
      const timeMs = timestampToMs(timestamp);
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (![timeMs, open, high, low, close].every(Number.isFinite)) {
        malformedRecords += 1;
        continue;
      }

      sourceSymbol ||= String(row.symbol || requestedSymbol);
      candles.push({
        time: Math.floor(timeMs / 1000),
        open,
        high,
        low,
        close,
        volume: Number(row.volume) || 0,
      });
    } catch {
      malformedRecords += 1;
    }
  }

  return { candles, sourceSymbol, malformedRecords, truncated: candles.length >= maxRecords };
}
