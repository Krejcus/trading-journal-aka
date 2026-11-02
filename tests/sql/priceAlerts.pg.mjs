// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/priceAlerts.pg.mjs
// Upozornění na cenu: jen vlastník, stav spouštění mění jen RPC, „jednou“ atomicky,
// rearm s očekávaným trigger_count, fronta doručení v téže transakci, rozpočet,
// konec seance přes DST a víkend, obecný plán.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const migration = await readFile(new URL('../../supabase/migrations/20261102140000_price_alerts.sql', import.meta.url), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
const PC = '44444444-4444-4444-8444-444444444444';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  insert into auth.users values ('${A}'), ('${B}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid() to authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.native_push_subscriptions (id uuid primary key, user_id uuid not null, expired_at timestamptz);
  create table public.push_subscriptions (id uuid primary key, user_id uuid not null, expired_at timestamptz);
  insert into public.native_push_subscriptions values ('${PHONE}', '${A}', null), (gen_random_uuid(), '${A}', now()), (gen_random_uuid(), '${B}', null);
  insert into public.push_subscriptions values ('${PC}', '${A}', null);
  create publication supabase_realtime;
`);
await db.exec(migration);

const as = async (uid, sql, params = []) => {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role; reset test.uid;'); }
};
const asService = async (sql, params = []) => {
  await db.exec('set role service_role;');
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
};
const upsert = (uid, id, patch = {}) => {
  const row = { price: 21480, condition: 'up', frequency: 'once', expiry: 'gtc', note: '', channels: { phone: true, pc: true }, edited_at: new Date().toISOString(), ...patch };
  return as(uid,
    `insert into public.price_alerts (id, price, condition, frequency, expiry, note, channels, edited_at, deleted_at, status, trigger_count, version)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
     on conflict (user_id, id) do update set price = excluded.price, condition = excluded.condition, frequency = excluded.frequency,
       expiry = excluded.expiry, note = excluded.note, channels = excluded.channels, edited_at = excluded.edited_at,
       deleted_at = excluded.deleted_at, status = excluded.status, trigger_count = excluded.trigger_count, version = excluded.version`,
    [id, row.price, row.condition, row.frequency, row.expiry, row.note, JSON.stringify(row.channels), row.edited_at, row.deleted_at ?? null,
      row.status ?? 'triggered', row.trigger_count ?? 9, row.version ?? 99]);
};
// Příprava testu bez triggerů (trigger úpravy jinak drží obsah vlastníka beze změny).
const raw = sql => db.exec(`set session_replication_role = replica; ${sql}; set session_replication_role = origin;`);
const alert = async id => (await db.query(`select * from public.price_alerts where user_id = '${A}' and id = $1`, [id])).rows[0];
const trigger = (id, version, triggerId = randomUUID(), user = A) => asService(
  `select * from public.trigger_price_alert($1, $2, $3, $4, now(), 'MNQZ2026')`, [user, id, version, triggerId]).then(r => r.rows[0]);
const later = (ms = 1_000) => new Date(Date.now() + ms).toISOString();

test('vlastník: stav spouštění vynucen při založení; cizí uživatel nic nevidí ani nezaloží', async () => {
  await upsert(A, 'pa-own-1');
  const row = await alert('pa-own-1');
  assert.equal(row.status, 'active');
  assert.equal(row.trigger_count, 0);
  assert.equal(Number(row.version), 1);
  assert.equal(row.expires_at, null);
  assert.equal((await as(B, `select count(*)::int as n from public.price_alerts`)).rows[0].n, 0);
  await assert.rejects(() => as(B, `insert into public.price_alerts (user_id, id, price) values ('${A}', 'pa-foreign', 100)`));
  await assert.rejects(() => as(A, `delete from public.price_alerts where id = 'pa-own-1'`));
  await assert.rejects(() => as(A, `insert into public.price_alerts (id, price) values ('pa-bad', 100.1)`));
  await assert.rejects(() => as(A, `insert into public.price_alerts (id, price) values ('bad', 100)`));
});

test('úprava vlastníkem: verze roste jen se změnou podmínky; stav spouštění nemění; LWW; smazání konečné', async () => {
  await upsert(A, 'pa-edit-1');
  await upsert(A, 'pa-edit-1', { note: 'jen poznámka', edited_at: later(1_000) });
  assert.equal(Number((await alert('pa-edit-1')).version), 1);
  await upsert(A, 'pa-edit-1', { price: 21490, edited_at: later(2_000) });
  let row = await alert('pa-edit-1');
  assert.equal(Number(row.version), 2);
  assert.equal(row.status, 'active');
  assert.equal(row.trigger_count, 0);
  await as(A, `update public.price_alerts set status = 'triggered', trigger_count = 5, last_triggered_at = now(), edited_at = $1 where id = 'pa-edit-1'`, [later(3_000)]);
  row = await alert('pa-edit-1');
  assert.equal(row.status, 'active');
  assert.equal(row.trigger_count, 0);
  // Starší úprava (pozdě nahraná z jiného zařízení) novější nepřepíše.
  await upsert(A, 'pa-edit-1', { price: 21000, edited_at: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(Number((await alert('pa-edit-1')).price), 21490);
  await upsert(A, 'pa-edit-1', { deleted_at: new Date().toISOString(), edited_at: later(4_000) });
  await upsert(A, 'pa-edit-1', { deleted_at: null, edited_at: later(5_000) });
  assert.notEqual((await alert('pa-edit-1')).deleted_at, null);
});

test('strop 50 neodstraněných; upsert existujícího na stropu projde', async () => {
  await raw(`update public.price_alerts set deleted_at = coalesce(deleted_at, now()) where user_id = '${A}'`);
  for (let i = 0; i < 50; i += 1) await upsert(A, `pa-cap-${i}`);
  await assert.rejects(() => upsert(A, 'pa-cap-50'), /price-alerts-limit/);
  await upsert(A, 'pa-cap-3', { note: 'na stropu', edited_at: later(1_000) });
  assert.equal((await alert('pa-cap-3')).note, 'na stropu');
  await raw(`update public.price_alerts set deleted_at = now() where user_id = '${A}' and id like 'pa-cap-%'`);
});

test('trigger_price_alert: jen service_role; „jednou“ atomicky; duplicita stejným id; verze; fronta doručení', async () => {
  await upsert(A, 'pa-once-1');
  await assert.rejects(() => as(A, `select * from public.trigger_price_alert('${A}', 'pa-once-1', 1, gen_random_uuid(), now(), null)`), /permission denied/);
  const id = randomUUID();
  const first = await trigger('pa-once-1', 1, id);
  assert.equal(first.status, 'triggered');
  assert.equal(first.suppressed, false);
  assert.deepEqual(await trigger('pa-once-1', 1, id), { event_id: first.event_id, status: 'duplicate', suppressed: false });
  assert.equal((await trigger('pa-once-1', 1)).status, 'rejected:triggered');
  const row = await alert('pa-once-1');
  assert.equal(row.status, 'triggered');
  assert.equal(row.trigger_count, 1);
  // Spuštění verzi nemění (jinak by „pokaždé“ odmítalo vlastní další spuštění).
  assert.equal(Number(row.version), 1);
  const event = (await db.query(`select * from public.price_alert_events where id = $1`, [first.event_id])).rows[0];
  assert.equal(Number(event.level), 21480);
  assert.equal(event.front, 'MNQZ2026');
  const outbox = (await db.query(`select channel, subscription_id from public.price_alert_outbox where event_id = $1 order by channel`, [first.event_id])).rows;
  assert.deepEqual(outbox, [{ channel: 'apns', subscription_id: PHONE }, { channel: 'web', subscription_id: PC }]);
  // Vlastník vidí jen své události, frontu vůbec.
  assert.equal((await as(A, `select count(*)::int as n from public.price_alert_events where id = $1`, [first.event_id])).rows[0].n, 1);
  assert.equal((await as(B, `select count(*)::int as n from public.price_alert_events`)).rows[0].n, 0);
  await assert.rejects(() => as(A, `select * from public.price_alert_outbox`), /permission denied/);
  // Stejné id spuštění pro jiné upozornění = odmítnuto, ne „duplicita“.
  await upsert(A, 'pa-once-2', { channels: { phone: false, pc: true } });
  assert.equal((await trigger('pa-once-2', 1, id)).status, 'rejected:trigger-id');
  assert.equal((await trigger('pa-once-2', 7)).status, 'rejected:version');
  const pcOnly = await trigger('pa-once-2', 1);
  assert.deepEqual((await db.query(`select channel from public.price_alert_outbox where event_id = $1`, [pcOnly.event_id])).rows, [{ channel: 'web' }]);
  assert.equal((await trigger('pa-missing', 1)).status, 'rejected:missing');
});

test('„pokaždé“: cooldown 60 s; smazané a vypršelé neodpálí; automatický směr se v události netvrdí', async () => {
  await upsert(A, 'pa-every-1', { frequency: 'every' });
  await raw(`update public.price_alerts set condition_auto = true where id = 'pa-every-1'`);
  const ok = await trigger('pa-every-1', 1);
  assert.equal(ok.status, 'triggered');
  assert.equal((await db.query(`select condition from public.price_alert_events where id = $1`, [ok.event_id])).rows[0].condition, 'cross');
  assert.equal((await trigger('pa-every-1', 1)).status, 'rejected:cooldown');
  await raw(`update public.price_alerts set last_triggered_at = now() - interval '61 seconds' where id = 'pa-every-1'`);
  assert.equal((await trigger('pa-every-1', 1)).status, 'triggered');
  await upsert(A, 'pa-del-1');
  await upsert(A, 'pa-del-1', { deleted_at: new Date().toISOString(), edited_at: later(1_000) });
  assert.equal((await trigger('pa-del-1', 2)).status, 'rejected:deleted');
  await upsert(A, 'pa-exp-1', { expiry: 'session' });
  await raw(`update public.price_alerts set expires_at = now() - interval '1 second' where id = 'pa-exp-1'`);
  assert.equal((await trigger('pa-exp-1', 1)).status, 'rejected:expired');
  assert.equal((await alert('pa-exp-1')).status, 'expired');
});

test('rearm: jen vlastník, jen s očekávaným trigger_count; zvedne verzi', async () => {
  await upsert(A, 'pa-rearm-1');
  await trigger('pa-rearm-1', 1);
  await db.exec(`set role anon;`);
  await assert.rejects(() => db.query(`select public.rearm_price_alert('pa-rearm-1', 1)`), /permission denied/);
  await db.exec('reset role;');
  assert.equal((await as(B, `select public.rearm_price_alert('pa-rearm-1', 1) as ok`)).rows[0].ok, false);
  assert.equal((await as(A, `select public.rearm_price_alert('pa-rearm-1', 0) as ok`)).rows[0].ok, false);
  assert.equal((await as(A, `select public.rearm_price_alert('pa-rearm-1', 1) as ok`)).rows[0].ok, true);
  const row = await alert('pa-rearm-1');
  assert.equal(row.status, 'active');
  assert.equal(Number(row.version), 2);
  assert.equal((await trigger('pa-rearm-1', 1)).status, 'rejected:version');
  assert.equal((await trigger('pa-rearm-1', 2)).status, 'triggered');
});

test('rozpočet 20 notifikací / 10 min: 21. spuštění je zapsané, ale bez fronty doručení', async () => {
  await db.exec(`delete from public.price_alert_outbox; delete from public.price_alert_events;`);
  await raw(`update public.price_alerts set deleted_at = coalesce(deleted_at, now()) where user_id = '${A}'`);
  const results = [];
  for (let i = 0; i < 21; i += 1) {
    await upsert(A, `pa-budget-${i}`);
    results.push(await trigger(`pa-budget-${i}`, 1));
  }
  assert.equal(results.slice(0, 20).every(result => result.status === 'triggered' && !result.suppressed), true);
  assert.deepEqual({ status: results[20].status, suppressed: results[20].suppressed }, { status: 'triggered', suppressed: true });
  assert.equal((await db.query(`select count(*)::int as n from public.price_alert_outbox where event_id = $1`, [results[20].event_id])).rows[0].n, 0);
  assert.equal((await db.query(`select suppressed_reason from public.price_alert_events where id = $1`, [results[20].event_id])).rows[0].suppressed_reason, 'budget');
});

test('konec seance: 17:00 Chicago v pracovní den, přes DST i víkend', async () => {
  const end = async at => (await db.query(`select public.price_alert_session_end($1::timestamptz) as e`, [at])).rows[0].e.toISOString();
  // Pátek dopoledne (CDT) → týž den 17:00 CDT.
  assert.equal(await end('2026-10-30T15:00:00Z'), '2026-10-30T22:00:00.000Z');
  // Pátek po uzavření → pondělí 17:00 CST (letní čas skončil 1. 11.).
  assert.equal(await end('2026-10-30T22:30:00Z'), '2026-11-02T23:00:00.000Z');
  // Sobota před přechodem na letní čas (8. 3. 2026) → pondělí 17:00 CDT.
  assert.equal(await end('2026-03-07T20:00:00Z'), '2026-03-09T22:00:00.000Z');
  // Přesně 17:00 patří už další seanci.
  assert.equal(await end('2026-11-03T23:00:00Z'), '2026-11-04T23:00:00.000Z');
});

test('expire_price_alerts a obecný plán (force_generic_plan) se chovají stejně', async () => {
  await upsert(A, 'pa-generic-1', { expiry: 'session' });
  await raw(`update public.price_alerts set expires_at = now() - interval '1 second' where id = 'pa-generic-1'`);
  await assert.rejects(() => as(A, `select public.expire_price_alerts()`), /permission denied/);
  assert.equal((await asService(`select public.expire_price_alerts('${A}') as n`)).rows[0].n >= 1, true);
  assert.equal((await alert('pa-generic-1')).status, 'expired');
  await upsert(A, 'pa-generic-2');
  await db.exec(`set plan_cache_mode = force_generic_plan;`);
  try {
    const id = randomUUID();
    assert.equal((await trigger('pa-generic-2', 1, id)).status, 'triggered');
    assert.equal((await trigger('pa-generic-2', 1, id)).status, 'duplicate');
  } finally {
    await db.exec('reset plan_cache_mode;');
  }
});

test('migrace jde pustit znovu (částečně proběhlý běh); tabulky jsou v realtime publikaci', async () => {
  await db.exec(migration);
  const { rows } = await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`);
  assert.deepEqual(rows.map(row => row.tablename), ['price_alert_defaults', 'price_alert_events', 'price_alerts']);
});
