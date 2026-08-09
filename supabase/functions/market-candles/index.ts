// Authenticated historical CME candle proxy for AlphaTrade.
// DATABENTO_API_KEY remains a Supabase secret and is never returned to the browser.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  isAllowedSymbol,
  isAllowedSchema,
  MAX_CANDLE_RECORDS,
  normalizeMarketSymbol,
  parseDatabentoOhlcvJsonl,
  parseEstimatedCost,
  providerCostError,
  shouldRetryProviderCost,
  validateEstimatedCost,
  validateRequestedRange,
} from './shared.ts';

const DATABENTO_API_KEY = Deno.env.get('DATABENTO_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const DATASET = 'GLBX.MDP3';
const HISTORICAL_DELAY_MS = 24 * 60 * 60 * 1000;
const configuredCostLimit = Number(Deno.env.get('DATABENTO_MAX_REQUEST_COST_USD') || '1');
const MAX_REQUEST_COST_USD = Number.isFinite(configuredCostLimit) && configuredCostLimit > 0 ? configuredCostLimit : 1;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const rateWindows = new Map<string, number[]>();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' },
});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!DATABENTO_API_KEY) return json({ error: 'provider-not-configured', message: 'Na serveru chybí DATABENTO_API_KEY.' }, 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json({ error: 'auth-failed' }, 401);

  const now = Date.now();
  const recent = (rateWindows.get(userData.user.id) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return json({ error: 'rate-limit', message: 'Příliš mnoho požadavků na tržní data.' }, 429);
  recent.push(now);
  rateWindows.set(userData.user.id, recent);

  let payload: { symbol?: unknown; start?: unknown; end?: unknown; schema?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400);
  }

  const symbol = normalizeMarketSymbol(String(payload.symbol || ''));
  const schema = String(payload.schema || 'ohlcv-1m');
  const requestedStart = new Date(String(payload.start || ''));
  const requestedEnd = new Date(String(payload.end || ''));
  if (!isAllowedSymbol(symbol)) return json({ error: 'invalid-symbol' }, 400);
  if (!isAllowedSchema(schema)) return json({ error: 'invalid-schema' }, 400);
  if (!Number.isFinite(requestedStart.getTime()) || !Number.isFinite(requestedEnd.getTime())) return json({ error: 'invalid-range' }, 400);
  if (!validateRequestedRange(requestedStart.getTime(), requestedEnd.getTime(), schema)) {
    return json({
      error: 'invalid-range',
      message: schema === 'ohlcv-1h'
        ? 'HTF okno musí být kladné a nejvýše 370 dní.'
        : 'Minutové okno musí být kladné a nejvýše 16 dní.',
    }, 400);
  }

  const historicalCutoff = now - HISTORICAL_DELAY_MS;
  if (requestedStart.getTime() >= historicalCutoff) {
    return json({
      error: 'data-not-yet-historical',
      message: 'Databento historical feed zpřístupní tento obchod přibližně 24 hodin po trhu.',
      availableAt: new Date(requestedStart.getTime() + HISTORICAL_DELAY_MS).toISOString(),
    }, 409);
  }
  const end = new Date(Math.min(requestedEnd.getTime(), historicalCutoff));
  const stypeIn = symbol.includes('.') ? 'continuous' : 'raw_symbol';
  const auth = `Basic ${btoa(`${DATABENTO_API_KEY}:`)}`;
  const costParams = new URLSearchParams({
    dataset: DATASET,
    symbols: symbol,
    schema,
    stype_in: stypeIn,
    start: requestedStart.toISOString(),
    end: end.toISOString(),
    limit: String(MAX_CANDLE_RECORDS),
  });
  const costUrl = 'https://hist.databento.com/v0/metadata.get_cost';
  let costResponse: Response | null = null;
  let rawCost = '';
  let estimatedCostUsd = Number.NaN;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      costResponse = await fetch(`${costUrl}?${costParams}`, { headers: { Authorization: auth } });
      rawCost = await costResponse.text();
      estimatedCostUsd = parseEstimatedCost(rawCost);
      if (costResponse.ok && Number.isFinite(estimatedCostUsd)) break;
      if (!shouldRetryProviderCost(costResponse.status)) break;
    } catch (reason) {
      console.warn('[market-candles] Databento cost check transport failure', attempt + 1, reason);
      costResponse = null;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }

  // Databento officially supports both GET and POST for metadata.get_cost.
  // A second transport attempt preserves the hard cost gate while recovering
  // from gateways that reject or mangle a long query string.
  if (!costResponse || (!shouldRetryProviderCost(costResponse.status) && (!costResponse.ok || !Number.isFinite(estimatedCostUsd)))) {
    console.warn('[market-candles] Databento GET cost check failed; retrying with POST', costResponse?.status ?? 'network');
    costResponse = await fetch(costUrl, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: costParams,
    });
    rawCost = await costResponse.text();
    estimatedCostUsd = parseEstimatedCost(rawCost);
  }
  const costValidation = validateEstimatedCost(estimatedCostUsd, MAX_REQUEST_COST_USD);
  if (!costResponse || !costResponse.ok) {
    const providerStatus = costResponse?.status ?? 503;
    console.error('[market-candles] Databento cost check failed', providerStatus, rawCost.slice(0, 300));
    const providerError = providerCostError(providerStatus);
    return json({ error: providerError.error, message: providerError.message }, providerError.status);
  }
  if (costValidation === 'invalid') {
    console.error('[market-candles] Databento returned an invalid cost payload', rawCost.slice(0, 300));
    return json({ error: 'provider-cost-check', message: 'Databento vrátilo neplatný odhad ceny; data se z bezpečnostních důvodů nestáhla.' }, 502);
  }
  if (costValidation === 'over-limit') {
    return json({
      error: 'provider-cost-limit',
      message: `Databento odhadlo cenu tohoto requestu na $${estimatedCostUsd.toFixed(4)}, nad limitem $${MAX_REQUEST_COST_USD.toFixed(2)}.`,
      estimatedCostUsd,
      maxRequestCostUsd: MAX_REQUEST_COST_USD,
    }, 402);
  }

  const params = new URLSearchParams({
    dataset: DATASET,
    symbols: symbol,
    schema,
    stype_in: stypeIn,
    start: requestedStart.toISOString(),
    end: end.toISOString(),
    encoding: 'json',
    compression: 'none',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    limit: String(MAX_CANDLE_RECORDS),
  });

  const upstream = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const raw = await upstream.text();
  if (upstream.status === 206) {
    console.error('[market-candles] Databento only partially resolved the requested symbol', raw.slice(0, 500));
    return json({
      error: 'provider-partial',
      message: 'Databento vyřešilo symbol jen částečně; neúplný graf se nezobrazí.',
    }, 502);
  }
  if (!upstream.ok) {
    console.error('[market-candles] Databento error', upstream.status, raw.slice(0, 500));
    const providerCode = upstream.status === 401 || upstream.status === 403 ? 'provider-auth' : 'provider-error';
    return json({ error: providerCode, message: 'Databento odmítlo požadavek na historická data.' }, upstream.status >= 500 ? 502 : upstream.status);
  }

  const parsed = parseDatabentoOhlcvJsonl(raw, symbol);
  if (parsed.truncated) {
    console.error('[market-candles] Databento response reached record limit', MAX_CANDLE_RECORDS);
    return json({
      error: 'provider-truncated',
      message: 'Databento odpověď dosáhla bezpečnostního limitu; graf by nebyl kompletní.',
    }, 502);
  }
  if (parsed.malformedRecords > 0) {
    console.warn('[market-candles] Skipped malformed Databento records', parsed.malformedRecords);
  }

  return json({
    provider: 'databento', dataset: DATASET, schema, symbol, sourceSymbol: parsed.sourceSymbol,
    start: requestedStart.toISOString(), end: end.toISOString(), estimatedCostUsd, candles: parsed.candles,
  });
});
