#!/usr/bin/env node

const DATABENTO_COST_URL = 'https://hist.databento.com/v0/metadata.get_cost';

export const DEFAULT_BACKFILL_DATASET = 'GLBX.MDP3';
export const DEFAULT_BACKFILL_SCHEMA = 'ohlcv-1m';
export const DEFAULT_BACKFILL_SYMBOLS = Object.freeze(['MNQ.v.0', 'NQ.v.0']);

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const mostRecentFullyHistoricalUtcDay = (now = new Date()) => {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  return end.toISOString().slice(0, 10);
};

export const subtractUtcYears = (isoDay, years) => {
  if (!ISO_DAY_PATTERN.test(isoDay) || !Number.isInteger(years) || years <= 0) {
    throw new Error('Backfill range requires an ISO day and a positive whole-year count.');
  }

  const source = new Date(`${isoDay}T00:00:00.000Z`);
  const targetYear = source.getUTCFullYear() - years;
  const result = new Date(Date.UTC(targetYear, source.getUTCMonth(), source.getUTCDate()));

  // Date.UTC rolls 29 February into March in a non-leap target year. Keep the
  // range on the final valid day of February instead.
  if (result.getUTCMonth() !== source.getUTCMonth()) {
    result.setUTCDate(0);
  }
  return result.toISOString().slice(0, 10);
};

export const parseCostResponse = (raw) => {
  const trimmed = String(raw ?? '').trim();
  const direct = Number(trimmed);
  if (Number.isFinite(direct) && direct >= 0) return direct;

  try {
    const parsed = JSON.parse(trimmed);
    const nested = Number(parsed?.cost_usd ?? parsed?.cost);
    return Number.isFinite(nested) && nested >= 0 ? nested : Number.NaN;
  } catch {
    return Number.NaN;
  }
};

export const buildCostRequestUrl = ({
  dataset = DEFAULT_BACKFILL_DATASET,
  symbol,
  schema = DEFAULT_BACKFILL_SCHEMA,
  start,
  end,
}) => {
  if (!symbol || !start || !end) throw new Error('symbol, start, and end are required.');
  const params = new URLSearchParams({
    dataset,
    symbols: symbol,
    schema,
    stype_in: 'continuous',
    start: `${start}T00:00:00.000Z`,
    end: `${end}T00:00:00.000Z`,
  });
  return `${DATABENTO_COST_URL}?${params.toString()}`;
};

export const estimateBackfillCost = async ({
  apiKey,
  start,
  end,
  symbols = DEFAULT_BACKFILL_SYMBOLS,
  dataset = DEFAULT_BACKFILL_DATASET,
  schema = DEFAULT_BACKFILL_SCHEMA,
  fetchImpl = globalThis.fetch,
}) => {
  if (!apiKey) throw new Error('DATABENTO_API_KEY is not configured.');
  if (!ISO_DAY_PATTERN.test(start) || !ISO_DAY_PATTERN.test(end) || start >= end) {
    throw new Error('Backfill start/end must be valid ISO days with start before end.');
  }
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('At least one symbol is required.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable.');

  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  const estimates = [];

  // One free quote per symbol makes the audit trail explicit and avoids any
  // ambiguity in how an HTTP client serializes a multi-value symbols field.
  for (const symbol of symbols) {
    const response = await fetchImpl(buildCostRequestUrl({ dataset, symbol, schema, start, end }), {
      headers: { Authorization: authorization },
    });
    const raw = await response.text();
    const costUsd = parseCostResponse(raw);
    if (!response.ok || !Number.isFinite(costUsd)) {
      throw new Error(`Databento cost quote failed for ${symbol} (HTTP ${response.status}).`);
    }
    estimates.push({ symbol, costUsd });
  }

  return {
    dataset,
    schema,
    start,
    end,
    estimates,
    totalCostUsd: estimates.reduce((sum, estimate) => sum + estimate.costUsd, 0),
  };
};

const parseArgs = (args) => {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    values.set(arg.slice(2), value);
    index += 1;
  }
  return values;
};

export const runBackfillCostCli = async ({
  args = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  log = console.log,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const options = parseArgs(args);
  const end = options.get('end') ?? mostRecentFullyHistoricalUtcDay(now);
  const start = options.get('start') ?? subtractUtcYears(end, 5);
  const result = await estimateBackfillCost({
    apiKey: env.DATABENTO_API_KEY,
    start,
    end,
    fetchImpl,
  });

  log(`Databento cost-only quote (no market data downloaded)`);
  log(`${result.dataset} · ${result.schema} · [${result.start}, ${result.end})`);
  for (const estimate of result.estimates) {
    log(`${estimate.symbol}: $${estimate.costUsd.toFixed(6)}`);
  }
  log(`TOTAL: $${result.totalCostUsd.toFixed(6)}`);
  return result;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackfillCostCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
