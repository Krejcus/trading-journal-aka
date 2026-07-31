// Edge Function: import-trades (v1)
//
// Příjmová strana Tradecopia auto-importu. Lokální sync agent (scripts/tradecopia-sync)
// čte read-only SQLite Tradecopie a posílá sem nové řádky. Autentizace NENÍ přes
// user JWT (agent běží headless bez session) ale přes import token:
//   - sha256(token) se porovná s import_tokens.token_hash → user_id
//   - deploy s --no-verify-jwt, token je 256bit random, hash v DB, plaintext jen
//     v ~/.alphatrade/tradecopia-sync.json na Macu (chmod 600)
//
// Zápis přes service role (RLS bypass), user_id se bere VÝHRADNĚ z tokenu.
//
// Dedup: imported_trades unique (user_id, source, external_key) — external_key
// zrcadlí business key Tradecopie. Obchody se upsertují s ignoreDuplicates
// (immutable řádky), ordery s merge (status Working→Filled se může změnit).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_ROWS_PER_CALL = 5000;
const BATCH_SIZE = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface RawTrade {
  entity_id?: string;
  account_id: number;
  account_name?: string | null;
  symbol: string;
  qty: number;
  buy_price: number;
  sell_price: number;
  pnl: number;
  bought_timestamp: string;
  sold_timestamp: string;
  duration?: string | null;
  platform?: string | null;
  pair_id?: string | null;
}

interface RawOrder {
  entity_id?: string;
  account_id: number;
  account_name?: string | null;
  broker_order_id: string;
  symbol?: string | null;
  side?: string | null;
  order_type?: string | null;
  quantity?: number | null;
  filled_qty?: number | null;
  price?: number | null;
  stop_price?: number | null;
  avg_fill_price?: number | null;
  status?: string | null;
  platform?: string | null;
  placed_at?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const token = req.headers.get('x-import-token');
  if (!token || token.length < 32) return json({ error: 'missing-token' }, 401);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const tokenHash = await sha256Hex(token);
  const { data: tokenRow, error: tokenErr } = await supabase
    .from('import_tokens')
    .select('user_id')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (tokenErr || !tokenRow) return json({ error: 'invalid-token' }, 401);
  const userId = tokenRow.user_id as string;

  let body: {
    trades?: RawTrade[];
    orders?: RawOrder[];
    accounts?: Array<{ account_id: number; name?: string | null; entity_id?: string | null }>;
  };
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  const trades = (body.trades || []).slice(0, MAX_ROWS_PER_CALL);
  const orders = (body.orders || []).slice(0, MAX_ROWS_PER_CALL);
  const accounts = (body.accounts || []).slice(0, 500).filter(a => a && a.account_id != null && a.name);

  // ── Transform trades ──
  const tradeRows = [];
  for (const t of trades) {
    if (!t || t.account_id == null || !t.symbol || !t.bought_timestamp || !t.sold_timestamp) continue;
    const externalKey = [
      t.account_id, t.entity_id || '', t.symbol, t.bought_timestamp, t.sold_timestamp,
      t.platform || 'tradovate', t.pair_id || '',
    ].join('|');
    // Fan-out kopie: stejný obchod na N účtech sdílí group_key. BEZ qty — kopie
    // mají různou velikost podle copyMultiplier účtu a množství v klíči by jeden
    // obchod rozpadlo na několik skupin.
    const timeBucket = (value: string) => Math.round(new Date(value).getTime() / 5_000);
    const priceBucket = (value: number) => Math.round(Number(value) * 2) / 2;
    const groupKey = await sha256Hex([
      t.symbol,
      timeBucket(t.bought_timestamp),
      timeBucket(t.sold_timestamp),
      priceBucket(t.buy_price),
      priceBucket(t.sell_price),
    ].join('|'));
    const bought = new Date(t.bought_timestamp);
    const sold = new Date(t.sold_timestamp);
    const direction = bought < sold ? 'Long' : bought > sold ? 'Short' : null;
    tradeRows.push({
      user_id: userId,
      source: 'tradecopia',
      external_key: externalKey,
      account_ext_id: t.account_id,
      account_name: t.account_name || null,
      entity_id: t.entity_id || null,
      symbol: t.symbol,
      qty: t.qty,
      buy_price: t.buy_price,
      sell_price: t.sell_price,
      pnl: t.pnl,
      bought_at: t.bought_timestamp,
      sold_at: t.sold_timestamp,
      duration: t.duration || null,
      platform: t.platform || 'tradovate',
      direction,
      group_key: groupKey.slice(0, 32),
      raw: t,
    });
  }

  // ── Transform orders ──
  const orderRows = [];
  for (const o of orders) {
    if (!o || o.account_id == null || !o.broker_order_id) continue;
    orderRows.push({
      user_id: userId,
      source: 'tradecopia',
      account_ext_id: o.account_id,
      broker_order_id: String(o.broker_order_id),
      account_name: o.account_name || null,
      entity_id: o.entity_id || null,
      symbol: o.symbol || null,
      side: o.side || null,
      order_type: o.order_type || null,
      quantity: o.quantity ?? null,
      filled_qty: o.filled_qty ?? null,
      limit_price: o.price ?? null,
      stop_price: o.stop_price ?? null,
      avg_fill_price: o.avg_fill_price ?? null,
      status: o.status || null,
      platform: o.platform || 'tradovate',
      placed_at: o.placed_at || null,
      raw: o,
    });
  }

  // ── Upsert in batches ──
  let tradesUpserted = 0;
  for (let i = 0; i < tradeRows.length; i += BATCH_SIZE) {
    const batch = tradeRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('imported_trades')
      .upsert(batch, { onConflict: 'user_id,source,external_key', ignoreDuplicates: true });
    if (error) return json({ error: 'trades-upsert-failed', detail: error.message, at: i }, 500);
    tradesUpserted += batch.length;
  }

  let ordersUpserted = 0;
  for (let i = 0; i < orderRows.length; i += BATCH_SIZE) {
    const batch = orderRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('imported_orders')
      .upsert(batch, { onConflict: 'user_id,source,account_ext_id,broker_order_id', ignoreDuplicates: false });
    if (error) return json({ error: 'orders-upsert-failed', detail: error.message, at: i }, 500);
    ordersUpserted += batch.length;
  }

  // ── Backfill názvů účtů ── Hlavní accounts tabulka Tradecopie zná jména jen
  // pro aktuálně připojené účty; doplň je do dřívějších řádků bez jména
  // (staging i mapa účtů), ať UI neukazuje holá broker id.
  for (const a of accounts) {
    await supabase.from('imported_trades')
      .update({ account_name: a.name })
      .eq('user_id', userId).eq('account_ext_id', a.account_id).is('account_name', null);
    await supabase.from('import_account_map')
      .update({ account_name: a.name })
      .eq('user_id', userId).eq('account_ext_id', a.account_id).is('account_name', null);
  }

  // ── Connected flag ── accounts = seznam AKTUÁLNĚ připojených účtů v Tradecopii.
  // Vše ostatní (spálené/odpojené challenge) označ jako odpojené, ať UI umí
  // oddělit aktivní účty od historie. Jen když seznam reálně přišel.
  if (accounts.length > 0) {
    // Založ map řádky i pro připojené účty BEZ obchodů (čerstvě koupené challenge)
    // — jinak by v UI chyběly, dokud na nich nepadne první trade.
    const mapRows = accounts.map(a => ({
      user_id: userId,
      source: 'tradecopia',
      account_ext_id: a.account_id,
      account_name: a.name || null,
      entity_id: a.entity_id || null,
      status: 'new',
      is_connected: true,
    }));
    const { error: mapErr } = await supabase.from('import_account_map')
      .upsert(mapRows, { onConflict: 'user_id,source,account_ext_id', ignoreDuplicates: true });
    if (mapErr) console.warn('[import-trades] account map upsert failed:', mapErr.message);

    const connectedIds = accounts.map(a => a.account_id);
    await supabase.from('import_account_map')
      .update({ is_connected: true })
      .eq('user_id', userId).eq('source', 'tradecopia')
      .in('account_ext_id', connectedIds);
    await supabase.from('import_account_map')
      .update({ is_connected: false })
      .eq('user_id', userId).eq('source', 'tradecopia')
      .not('account_ext_id', 'in', `(${connectedIds.join(',')})`);
  }

  await supabase.from('import_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('user_id', userId);

  return json({ ok: true, trades_received: tradeRows.length, orders_received: orderRows.length, trades_upserted: tradesUpserted, orders_upserted: ordersUpserted });
});
