import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SOURCE = 'tradecopia';
const MAX_ROWS = 5000;
const MAX_KEYS = 10000;
const BATCH = 500;
const PAGE = 1000;

const ALLOWED_TABLES: Record<string, Set<string>> = {
  main: new Set([
    'accounts', 'cash_balances', 'positions', 'orders', 'fills',
    'account_risk_statuses', 'account_risk_configs', 'order_strategies',
    'groups', 'group_leader_accounts', 'group_follower_accounts',
    'prop_firm_accounts',
  ]),
  logs: new Set([]),
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-import-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ShadowRow = {
  source_key: string;
  account_ext_id?: number | null;
  source_updated_at?: string | null;
  payload_hash: string;
  payload: Record<string, unknown>;
};

type ShadowTable = {
  source_db: 'main' | 'logs';
  source_table: string;
  present_keys: string[];
  rows: ShadowRow[];
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function chunks<T>(items: T[], size = BATCH): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function readCurrentRows(
  db: any,
  userId: string,
  columns: string,
  sourceDb?: string,
  sourceTable?: string,
): Promise<{ data: any[] | null; error: any | null }> {
  const allRows: any[] = [];
  const limit = sourceTable ? MAX_KEYS : MAX_KEYS * 20;
  for (let offset = 0; ; offset += PAGE) {
    let query = db.from('tradecopia_shadow_current')
      .select(columns).eq('user_id', userId).eq('source', SOURCE);
    if (sourceDb) query = query.eq('source_db', sourceDb);
    if (sourceTable) query = query.eq('source_table', sourceTable);
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) return { data: null, error };
    const page = data || [];
    allRows.push(...page);
    if (allRows.length > limit) {
      return { data: null, error: new Error(`shadow-current-limit-exceeded:${sourceDb || '*'}:${sourceTable || '*'}`) };
    }
    if (page.length < PAGE) return { data: allRows, error: null };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateTable(table: ShadowTable): string | null {
  if (!ALLOWED_TABLES[table.source_db]?.has(table.source_table)) return `table-not-allowed:${table.source_db}.${table.source_table}`;
  if (!Array.isArray(table.present_keys) || table.present_keys.length > MAX_KEYS) return `invalid-present-keys:${table.source_table}`;
  if (!Array.isArray(table.rows) || table.rows.length > MAX_ROWS) return `invalid-rows:${table.source_table}`;
  const present = new Set(table.present_keys);
  if (present.size !== table.present_keys.length) return `duplicate-present-key:${table.source_table}`;
  for (const row of table.rows) {
    if (!row || typeof row.source_key !== 'string' || !row.source_key || row.source_key.length > 300) return `invalid-source-key:${table.source_table}`;
    if (!present.has(row.source_key)) return `changed-row-not-present:${table.source_table}`;
    if (!/^[0-9a-f]{64}$/i.test(row.payload_hash || '')) return `invalid-payload-hash:${table.source_table}`;
    if (!row.payload || Array.isArray(row.payload) || typeof row.payload !== 'object') return `invalid-payload:${table.source_table}`;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const token = req.headers.get('x-import-token');
  if (!token || token.length < 32) return json({ error: 'missing-token' }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const tokenHash = await sha256Hex(token);
  const { data: tokenRow, error: tokenError } = await db.from('import_tokens')
    .select('user_id').eq('token_hash', tokenHash).maybeSingle();
  if (tokenError || !tokenRow) return json({ error: 'invalid-token' }, 401);
  const userId = String(tokenRow.user_id);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  if (body?.action === 'status') {
    const [{ data: run, error: runError }, { data: current, error: currentError }] = await Promise.all([
      db.from('tradecopia_shadow_sync_runs')
        .select('id,status,captured_at,completed_at,schema_hash,row_counts,changed_counts,error')
        .eq('user_id', userId).eq('source', SOURCE)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
      readCurrentRows(db, userId, 'source_db,source_table,source_key,payload_hash,is_present,last_seen_at'),
    ]);
    if (runError || currentError) return json({ error: 'status-query-failed', detail: runError?.message || currentError?.message }, 500);
    const tables: Record<string, { present: number; latest_seen_at: string | null; digest: string; entries: [string, string][] }> = {};
    for (const row of current || []) {
      const key = `${row.source_db}.${row.source_table}`;
      tables[key] ||= { present: 0, latest_seen_at: null, digest: '', entries: [] };
      if (row.is_present) {
        tables[key].present++;
        tables[key].entries.push([String(row.source_key), String(row.payload_hash)]);
      }
      if (!tables[key].latest_seen_at || String(row.last_seen_at) > tables[key].latest_seen_at!) tables[key].latest_seen_at = String(row.last_seen_at);
    }
    for (const table of Object.values(tables)) {
      table.entries.sort(([left], [right]) => left.localeCompare(right));
      table.digest = await sha256Hex(JSON.stringify(table.entries));
      delete (table as any).entries;
    }
    // Empty source tables have no row in current; expose the same deterministic
    // digest the local collector computes for an empty snapshot.
    const emptyDigest = await sha256Hex('[]');
    for (const [sourceDb, names] of Object.entries(ALLOWED_TABLES)) {
      for (const name of names) tables[`${sourceDb}.${name}`] ||= { present: 0, latest_seen_at: null, digest: emptyDigest, entries: [] };
    }
    return json({ ok: true, latest_run: run || null, tables });
  }

  const run = body?.run;
  const tables = body?.tables as ShadowTable[];
  if (!run || !validUuid(run.id) || !Array.isArray(tables) || tables.length > 20) return json({ error: 'invalid-request' }, 400);
  if (typeof run.agent_version !== 'string' || !/^[0-9a-f]{64}$/i.test(run.schema_hash || '')) return json({ error: 'invalid-run' }, 400);
  const capturedAt = new Date(run.captured_at);
  if (Number.isNaN(capturedAt.getTime())) return json({ error: 'invalid-captured-at' }, 400);
  for (const table of tables) {
    const validationError = validateTable(table);
    if (validationError) return json({ error: validationError }, 400);
  }

  const runRow = {
    id: run.id,
    user_id: userId,
    source: SOURCE,
    agent_version: run.agent_version.slice(0, 40),
    status: 'processing',
    captured_at: capturedAt.toISOString(),
    main_db_mtime_ms: Number.isFinite(run.main_db_mtime_ms) ? Math.trunc(run.main_db_mtime_ms) : null,
    logs_db_mtime_ms: Number.isFinite(run.logs_db_mtime_ms) ? Math.trunc(run.logs_db_mtime_ms) : null,
    schema_hash: run.schema_hash,
    schemas: run.schemas || {},
    row_counts: run.row_counts || {},
    changed_counts: {},
    error: null,
  };
  const { data: existingRun } = await db.from('tradecopia_shadow_sync_runs')
    .select('status').eq('id', run.id).eq('user_id', userId).maybeSingle();
  if (existingRun?.status === 'completed') return json({ ok: true, replayed: true, run_id: run.id });
  const { error: runInsertError } = await db.from('tradecopia_shadow_sync_runs')
    .upsert(runRow, { onConflict: 'id' });
  if (runInsertError) return json({ error: 'run-create-failed', detail: runInsertError.message }, 500);

  const changedCounts: Record<string, { inserted: number; updated: number; deleted: number }> = {};
  try {
    for (const table of tables) {
      const tableKey = `${table.source_db}.${table.source_table}`;
      changedCounts[tableKey] = { inserted: 0, updated: 0, deleted: 0 };
      const { data: existingRows, error: existingError } = await readCurrentRows(
        db,
        userId,
        'source_key,payload_hash,payload,account_ext_id,source_updated_at,is_present,first_seen_at,last_changed_at',
        table.source_db,
        table.source_table,
      );
      if (existingError) throw new Error(`${tableKey}:current-read:${existingError.message}`);
      const existingByKey = new Map((existingRows || []).map((row: any) => [String(row.source_key), row]));
      const presentKeys = new Set(table.present_keys);

      for (const keyBatch of chunks(table.present_keys)) {
        const { error } = await db.from('tradecopia_shadow_current')
          .update({ is_present: true, last_seen_at: capturedAt.toISOString(), sync_run_id: run.id, updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('source', SOURCE)
          .eq('source_db', table.source_db).eq('source_table', table.source_table)
          .in('source_key', keyBatch);
        if (error) throw new Error(`${tableKey}:touch:${error.message}`);
      }

      const currentUpserts: any[] = [];
      const changeRows: any[] = [];
      for (const row of table.rows) {
        const previous: any = existingByKey.get(row.source_key);
        const isChanged = !previous || previous.payload_hash !== row.payload_hash || !previous.is_present;
        if (!isChanged) continue;
        const changeType = !previous || !previous.is_present ? 'inserted' : 'updated';
        changedCounts[tableKey][changeType]++;
        currentUpserts.push({
          user_id: userId, source: SOURCE, source_db: table.source_db,
          source_table: table.source_table, source_key: row.source_key,
          account_ext_id: row.account_ext_id ?? null,
          source_updated_at: row.source_updated_at || null,
          payload_hash: row.payload_hash, payload: row.payload, is_present: true,
          first_seen_at: previous?.first_seen_at || capturedAt.toISOString(),
          last_seen_at: capturedAt.toISOString(), last_changed_at: capturedAt.toISOString(),
          sync_run_id: run.id, updated_at: new Date().toISOString(),
        });
        changeRows.push({
          user_id: userId, source: SOURCE, source_db: table.source_db,
          source_table: table.source_table, source_key: row.source_key,
          account_ext_id: row.account_ext_id ?? null, change_type: changeType,
          observed_at: capturedAt.toISOString(), source_updated_at: row.source_updated_at || null,
          payload_hash: row.payload_hash, payload: row.payload, sync_run_id: run.id,
        });
      }

      const removed = (existingRows || []).filter((row: any) => row.is_present && !presentKeys.has(String(row.source_key)));
      for (const row of removed) {
        changedCounts[tableKey].deleted++;
        changeRows.push({
          user_id: userId, source: SOURCE, source_db: table.source_db,
          source_table: table.source_table, source_key: String(row.source_key),
          account_ext_id: row.account_ext_id ?? null, change_type: 'deleted',
          observed_at: capturedAt.toISOString(), source_updated_at: row.source_updated_at || null,
          payload_hash: row.payload_hash, payload: row.payload, sync_run_id: run.id,
        });
      }

      for (const batch of chunks(currentUpserts)) {
        const { error } = await db.from('tradecopia_shadow_current').upsert(batch, {
          onConflict: 'user_id,source,source_db,source_table,source_key', ignoreDuplicates: false,
        });
        if (error) throw new Error(`${tableKey}:current-upsert:${error.message}`);
      }
      for (const batch of chunks(changeRows)) {
        const { error } = await db.from('tradecopia_shadow_changes').upsert(batch, {
          onConflict: 'sync_run_id,source_db,source_table,source_key', ignoreDuplicates: true,
        });
        if (error) throw new Error(`${tableKey}:changes-insert:${error.message}`);
      }
      for (const batch of chunks(removed.map((row: any) => String(row.source_key)))) {
        const { error } = await db.from('tradecopia_shadow_current')
          .update({ is_present: false, last_changed_at: capturedAt.toISOString(), sync_run_id: run.id, updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('source', SOURCE)
          .eq('source_db', table.source_db).eq('source_table', table.source_table)
          .in('source_key', batch);
        if (error) throw new Error(`${tableKey}:tombstone:${error.message}`);
      }
    }

    const { error: completionError } = await db.from('tradecopia_shadow_sync_runs').update({
      status: 'completed', completed_at: new Date().toISOString(), changed_counts: changedCounts, error: null,
    }).eq('id', run.id).eq('user_id', userId);
    if (completionError) throw new Error(`run-complete:${completionError.message}`);
    await db.from('import_tokens').update({ last_used_at: new Date().toISOString() }).eq('user_id', userId);
    return json({ ok: true, run_id: run.id, changed_counts: changedCounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from('tradecopia_shadow_sync_runs').update({
      status: 'failed', completed_at: new Date().toISOString(), changed_counts: changedCounts, error: message.slice(0, 2000),
    }).eq('id', run.id).eq('user_id', userId);
    return json({ error: 'shadow-sync-failed', detail: message }, 500);
  }
});
