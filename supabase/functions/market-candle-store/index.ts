// Private, owner-only completed-period candle archive. No browser storage keys,
// service key, or direct Storage path is returned to clients.
import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  CANDLE_STORE_BUCKET,
  CANDLE_STORE_VERSION,
  groupAdjacentPeriods,
  mergeWindow,
  parseStoreRequest,
  slicePeriod,
  validateProviderCandles,
  validateStoredPeriod,
  type CandleStoreCandle,
  type CandleStorePeriod,
  type CandleStoreRequest,
  type StoredCandlePeriod,
} from './shared.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const OWNER_ID = Deno.env.get('CANDLE_STORE_OWNER_USER_ID') || '';
const createAdminClient = () => createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
type AdminClient = ReturnType<typeof createAdminClient>;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

type Claim = {
  state: 'fetching' | 'ready' | 'failed';
  lease_token: string | null;
  lease_until: string | null;
  object_path: string | null;
  content_sha256: string | null;
  record_count: number | null;
  source_symbol: string | null;
  acquired: boolean;
};
type ClaimedPeriod = { period: CandleStorePeriod; token: string; claim: Claim };
type ResolvedPeriod = { period: CandleStorePeriod; candles: CandleStoreCandle[]; sourceSymbol?: string };

class StoreError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const gzip = async (text: string): Promise<Uint8Array> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
const gunzip = (bytes: Uint8Array): Promise<string> => {
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
};

const rpcOne = async (admin: AdminClient, name: string, args: Record<string, unknown>): Promise<unknown> => {
  // This migration's RPCs are intentionally absent from the generated app DB
  // types. The cast is confined to this service-role-only boundary.
  // bind: rpc je metoda klienta (volá this.rest) — oddělená od něj padá na TypeError.
  const rpc = admin.rpc.bind(admin) as unknown as (functionName: string, params: Record<string, unknown>) => Promise<{
    data: unknown; error: { code?: string } | null;
  }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new StoreError('store-unavailable', 503, `Metadata skladu není dostupná (${error.code || 'rpc'}).`);
  return data;
};

async function claimPeriod(admin: AdminClient, request: CandleStoreRequest, period: CandleStorePeriod): Promise<ClaimedPeriod> {
  const token = crypto.randomUUID();
  const data = await rpcOne(admin, 'market_candle_claim_period_v1', {
    p_schema: request.schema, p_symbol: request.symbol,
    p_start: new Date(period.startMs).toISOString(), p_end: new Date(period.endMs).toISOString(),
    p_token: token, p_lease_seconds: 180,
  });
  const claim = Array.isArray(data) ? data[0] as Claim | undefined : undefined;
  if (!claim || !['fetching', 'ready', 'failed'].includes(claim.state)) throw new StoreError('store-unavailable', 503, 'Sklad nevrátil platný stav období.');
  return { period, token, claim };
}

async function readReady(admin: AdminClient, request: CandleStoreRequest, item: ClaimedPeriod): Promise<ResolvedPeriod> {
  const { period, claim } = item;
  if (!claim.object_path || !claim.content_sha256 || claim.record_count === null) throw new StoreError('store-corrupt', 503, 'Chybí potvrzený objekt svíček.');
  const { data, error } = await admin.storage.from(CANDLE_STORE_BUCKET).download(claim.object_path);
  if (error || !data) throw new StoreError('store-corrupt', 503, 'Potvrzený objekt svíček ve skladu chybí.');
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (await sha256(bytes) !== claim.content_sha256) throw new StoreError('store-corrupt', 503, 'Kontrolní součet svíček nesouhlasí.');
  try {
    const stored = validateStoredPeriod(JSON.parse(await gunzip(bytes)), request, period, claim.record_count);
    return { period, candles: stored.candles, sourceSymbol: stored.sourceSymbol };
  } catch {
    throw new StoreError('store-corrupt', 503, 'Uložený soubor svíček není platný.');
  }
}

async function fetchProvider(request: CandleStoreRequest, startMs: number, endMs: number, authHeader: string): Promise<{
  candles: CandleStoreCandle[]; sourceSymbol?: string; estimatedCostUsd: number;
}> {
  const upstream = await fetch(`${SUPABASE_URL}/functions/v1/market-candles`, {
    method: 'POST',
    headers: { Authorization: authHeader, apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: request.symbol, schema: request.schema, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }),
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok || payload?.error) throw new StoreError(
    typeof payload?.error === 'string' ? payload.error : 'provider-unavailable',
    upstream.status === 402 || upstream.status === 429 ? upstream.status : 503,
    typeof payload?.message === 'string' ? payload.message : 'Historická data nejsou dostupná.',
  );
  if (payload?.provider !== 'databento' || payload?.dataset !== 'GLBX.MDP3' || payload?.schema !== request.schema
    || payload?.symbol !== request.symbol || payload?.start !== new Date(startMs).toISOString()
    || payload?.end !== new Date(endMs).toISOString()) throw new StoreError('provider-incomplete', 503, 'Poskytovatel nepotvrdil celé požadované období.');
  let candles: CandleStoreCandle[];
  try { candles = validateProviderCandles(payload.candles, startMs, endMs); }
  catch { throw new StoreError('provider-invalid', 503, 'Poskytovatel vrátil neplatné svíčky.'); }
  return {
    candles,
    sourceSymbol: typeof payload.sourceSymbol === 'string' ? payload.sourceSymbol : undefined,
    estimatedCostUsd: Number.isFinite(payload.estimatedCostUsd) ? payload.estimatedCostUsd : 0,
  };
}

async function storePeriod(admin: AdminClient, request: CandleStoreRequest,
  item: ClaimedPeriod, candles: CandleStoreCandle[], sourceSymbol?: string): Promise<ResolvedPeriod> {
  const { period, token } = item;
  const stored: StoredCandlePeriod = {
    version: CANDLE_STORE_VERSION, schema: request.schema, symbol: request.symbol,
    start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString(),
    sourceSymbol, candles,
  };
  const bytes = await gzip(JSON.stringify(stored));
  const digest = await sha256(bytes);
  const path = `${request.schema}/${request.symbol}/${period.key}/${token}.json.gz`;
  const { error } = await admin.storage.from(CANDLE_STORE_BUCKET).upload(path, bytes, {
    contentType: 'application/gzip', cacheControl: '31536000', upsert: false,
  });
  if (error) throw new StoreError('store-write-failed', 503, 'Soukromé uložení svíček selhalo.');
  const completed = await rpcOne(admin, 'market_candle_complete_period_v1', {
    p_schema: request.schema, p_symbol: request.symbol,
    p_start: new Date(period.startMs).toISOString(), p_token: token,
    p_object_path: path, p_sha256: digest, p_record_count: candles.length,
    p_source_symbol: sourceSymbol ?? null,
  });
  if (completed !== true) {
    try { await admin.storage.from(CANDLE_STORE_BUCKET).remove([path]); } catch { /* orphan is private and harmless */ }
    throw new StoreError('store-lease-lost', 503, 'Zámek stahování vypršel; výsledek nebyl publikován.');
  }
  return { period, candles, sourceSymbol };
}

async function failClaim(admin: AdminClient, request: CandleStoreRequest, item: ClaimedPeriod, reason: string): Promise<void> {
  try {
    await rpcOne(admin, 'market_candle_fail_period_v1', {
      p_schema: request.schema, p_symbol: request.symbol,
      p_start: new Date(item.period.startMs).toISOString(), p_token: item.token, p_reason: reason,
    });
  } catch { /* original error is returned; lease still expires safely */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method-not-allowed' }, 405);
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !/^[a-f0-9-]{36}$/i.test(OWNER_ID)) {
    return reply({ error: 'store-not-configured' }, 503);
  }
  const authHeader = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authHeader)) return reply({ error: 'missing-auth' }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return reply({ error: 'auth-failed' }, 401);
  if (userData.user.id !== OWNER_ID) return reply({ error: 'not-authorized' }, 403);

  let request: CandleStoreRequest;
  try { request = parseStoreRequest(await req.json()); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'invalid-request';
    return reply({ error: code }, code === 'data-not-yet-historical' ? 409 : 400);
  }

  const admin = createAdminClient();
  const acquired: ClaimedPeriod[] = [];
  const resolved: ResolvedPeriod[] = [];
  let estimatedCostUsd = 0;
  try {
    // Claims are concurrent across devices and atomic in Postgres. A lease
    // owner alone may call the billable upstream function.
    const attempts = await Promise.allSettled(request.cacheablePeriods.map(period => claimPeriod(admin, request, period)));
    const claims = attempts.filter((item): item is PromiseFulfilledResult<ClaimedPeriod> => item.status === 'fulfilled').map(item => item.value);
    acquired.push(...claims.filter(item => item.claim.acquired));
    const rejected = attempts.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (rejected) throw rejected.reason;
    const ready = claims.filter(item => item.claim.state === 'ready');
    resolved.push(...await Promise.all(ready.map(item => readReady(admin, request, item))));

    const ownedByStart = new Map(acquired.map(item => [item.period.startMs, item]));
    for (const group of groupAdjacentPeriods(acquired.map(item => item.period), request.schema === 'ohlcv-1m' ? 14 : 300)) {
      const provider = await fetchProvider(request, group[0].startMs, group.at(-1)!.endMs, authHeader);
      estimatedCostUsd += provider.estimatedCostUsd;
      for (const period of group) {
        const item = ownedByStart.get(period.startMs)!;
        const stored = await storePeriod(admin, request, item, slicePeriod(provider.candles, period), provider.sourceSymbol);
        resolved.push(stored);
        ownedByStart.delete(period.startMs);
      }
    }
    if (claims.some(item => !item.claim.acquired && item.claim.state !== 'ready')) {
      return reply({ error: 'store-pending', retryAfterMs: 1000 }, 202, { 'Retry-After': '1' });
    }
    // The current UTC day/month cannot be made immutable yet. Fetch only the
    // requested historical slice and never publish it to the persistent store.
    for (const period of request.transientPeriods) {
      const startMs = Math.max(request.startMs, period.startMs);
      const endMs = Math.min(request.endMs, period.endMs);
      const provider = await fetchProvider(request, startMs, endMs, authHeader);
      estimatedCostUsd += provider.estimatedCostUsd;
      resolved.push({ period, candles: provider.candles, sourceSymbol: provider.sourceSymbol });
    }
    const candles = mergeWindow(resolved, request.startMs, request.endMs);
    if (!candles.length) return reply({ error: 'no-data' }, 404);
    const sources = [...new Set(resolved.map(item => item.sourceSymbol).filter(Boolean))];
    return reply({
      provider: 'databento', dataset: 'GLBX.MDP3', schema: request.schema, symbol: request.symbol,
      sourceSymbol: sources.length === 1 ? sources[0] : undefined,
      start: new Date(request.startMs).toISOString(), end: new Date(request.endMs).toISOString(),
      estimatedCostUsd: estimatedCostUsd || undefined,
      store: request.transientPeriods.length
        ? request.cacheablePeriods.length ? 'mixed' : 'uncached'
        : acquired.length ? ready.length ? 'mixed' : 'filled' : 'hit', candles,
    });
  } catch (error) {
    const failure = error instanceof StoreError ? error : new StoreError('store-unavailable', 503, 'Sklad svíček je dočasně nedostupný.');
    await Promise.all(acquired.map(item => failClaim(admin, request, item, failure.code)));
    console.error('[market-candle-store]', failure.code, error);
    return reply({ error: failure.code, message: failure.message }, failure.status);
  }
});
