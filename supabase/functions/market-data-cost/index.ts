// Admin-only, cost-only Databento backfill quote.
// This function never calls timeseries.get_range and never downloads or stores market data.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  BACKFILL_DATASET,
  BACKFILL_SCHEMA,
  BACKFILL_SYMBOLS,
  buildBackfillCostParams,
  isAllowedCostUser,
  parseBackfillCost,
  validateBackfillCostRange,
} from './shared.ts';

const DATABENTO_API_KEY = Deno.env.get('DATABENTO_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ALLOWED_USER_IDS = Deno.env.get('MARKET_DATA_COST_ADMIN_USER_IDS');
const COST_URL = 'https://hist.databento.com/v0/metadata.get_cost';
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 4;
const rateWindows = new Map<string, number[]>();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
  },
});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!DATABENTO_API_KEY) return json({ error: 'provider-not-configured' }, 503);
  if (!ALLOWED_USER_IDS?.trim()) return json({ error: 'admin-allowlist-not-configured' }, 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing-auth' }, 401);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return json({ error: 'auth-failed' }, 401);
  if (!isAllowedCostUser(data.user.id, ALLOWED_USER_IDS)) return json({ error: 'forbidden' }, 403);

  const now = Date.now();
  const recent = (rateWindows.get(data.user.id) ?? []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return json({ error: 'rate-limit' }, 429);
  recent.push(now);
  rateWindows.set(data.user.id, recent);

  let payload: { start?: unknown; end?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid-json' }, 400);
  }
  const range = validateBackfillCostRange(payload.start, payload.end);
  if (!range) return json({ error: 'invalid-range' }, 400);

  const authorization = `Basic ${btoa(`${DATABENTO_API_KEY}:`)}`;
  const estimates: Array<{ symbol: string; costUsd: number }> = [];
  for (const symbol of BACKFILL_SYMBOLS) {
    let response: Response;
    try {
      response = await fetch(`${COST_URL}?${buildBackfillCostParams(symbol, range)}`, {
        headers: { Authorization: authorization },
      });
    } catch {
      return json({ error: 'provider-cost-unavailable' }, 502);
    }
    const raw = await response.text();
    const costUsd = parseBackfillCost(raw);
    if (!response.ok || !Number.isFinite(costUsd)) {
      return json({
        error: response.status === 401 || response.status === 403
          ? 'provider-auth'
          : 'provider-cost-check',
        providerStatus: response.status,
      }, 502);
    }
    estimates.push({ symbol, costUsd });
  }

  return json({
    quoteOnly: true,
    downloadedRecords: 0,
    dataset: BACKFILL_DATASET,
    schema: BACKFILL_SCHEMA,
    start: range.start,
    end: range.end,
    estimates,
    totalCostUsd: estimates.reduce((total, estimate) => total + estimate.costUsd, 0),
  });
});
