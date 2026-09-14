// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/journalSnapshotLinks.pg.mjs
// Creates an isolated in-memory database; never connects to a broker or Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const owner = '11111111-1111-4111-8111-111111111111';
const foreign = '99999999-9999-4999-8999-999999999999';
const lucid = '22222222-2222-4222-8222-222222222222';
const tradeify = '33333333-3333-4333-8333-333333333333';
const episode = '44444444-4444-4444-8444-444444444444';
const otherEpisode = '55555555-5555-4555-8555-555555555555';
const opened = 1789383123321, closed = 1789383190336;
const id = n => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
const tables = ['trades', 'tradovate_journal_positions', 'tradovate_journal_projection_heads', 'tradovate_copier_trades', 'copier_trade_snapshots'];
const migration = await readFile(new URL('../../supabase/migrations/20260914125323_journal_snapshots_broker_fill_identity.sql', import.meta.url), 'utf8');
const previous = await readFile(new URL('../../supabase/migrations/20260912164531_journal_snapshot_links.sql', import.meta.url), 'utf8');
const db = new PGlite();

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table trades (id uuid,user_id uuid,account_id uuid);
  create table tradovate_journal_positions (trade_id uuid,user_id uuid,connection_id uuid,journal_account_id uuid,
    external_account_id bigint,status text,revision bigint,history jsonb,facts jsonb);
  create table tradovate_journal_projection_heads (user_id uuid,connection_id uuid,revision bigint,completed_revision bigint);
  create table tradovate_copier_trades (user_id uuid,connection_id uuid,trade_id text,episode_id uuid,opened_at timestamptz,closed_at timestamptz,symbol text,side text);
  create table copier_trade_snapshots (id uuid,user_id uuid,episode_id uuid,kind text,at timestamptz,storage_path text);
`);
for (const table of tables) await db.exec(`alter table ${table} enable row level security;
  grant select on ${table} to authenticated;
  create policy owner_read on ${table} for select to authenticated using (user_id=current_setting('app.test_user')::uuid);`);

async function position(n = 1, connection = lucid, who = owner, fill = 'exit-fill', account = 10) {
  const history = { environment: 'demo', connectionId: connection, accountId: account,
    position: { status: 'closed', openedAt: opened, closedAt: closed },
    fills: [{ id: 'entry-fill', role: 'entry', at: opened, accountId: account },
      { id: fill, role: 'exit', at: closed, accountId: account }] };
  await db.query('insert into trades values ($1,$2,$3)', [id(n), who, id(n+100)]);
  await db.query('insert into tradovate_journal_positions values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id(n), who, connection, id(n+100), account, 'confirmed', 1, JSON.stringify(history), JSON.stringify({ instrument: 'MNQ', direction: 'Short' })]);
  await db.query(`insert into tradovate_journal_projection_heads select $1,$2,1,1
    where not exists(select 1 from tradovate_journal_projection_heads where user_id=$1 and connection_id=$2)`, [who, connection]);
}
async function ledger(connection = tradeify, who = owner, fill = 'exit-fill', ep = episode) {
  await db.query('insert into tradovate_copier_trades values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [who, connection, fill, ep, new Date(opened).toISOString(), new Date(closed).toISOString(), 'MNQU6', 'Short']);
}
async function images(who = owner) {
  for (const [n, kind, at] of [[201,'entry',opened],[202,'exit',closed]]) {
    await db.query('insert into copier_trade_snapshots values ($1,$2,$3,$4,$5,$6)',
      [id(n),who,episode,kind,new Date(at).toISOString(),`${who}/${episode}/${kind}-${at}.png`]);
  }
}
async function reset() {
  await db.exec(`reset role; truncate ${tables.join(',')};`);
  await position(); await ledger(); await images();
}
const rows = async () => (await db.query('select * from journal_trade_snapshots order by page_key')).rows;

test('real SQL screenshot linkage across OAuth connections', async t => {
  try {
    await reset();
    await db.exec(previous);
    assert.equal((await rows()).length, 0, 'old view reproduces Lucid/Tradeify incident');
    await db.exec(migration);

    await t.test('cross-connection close resolves both images to actual Lucid account', async () => {
      const result = await rows(); assert.equal(result.length, 2);
      assert.ok(result.every(r => r.connection_id === lucid && r.journal_account_id === id(101)));
    });
    await t.test('same-connection legacy trades still resolve', async () => {
      await reset(); await db.query('update tradovate_copier_trades set connection_id=$1',[lucid]);
      assert.equal((await rows()).length,2);
    });
    await t.test('twelve simultaneous followers do not inherit leader screenshots', async () => {
      await reset(); for(let n=2;n<=13;n++) await position(n, n%2 ? lucid : tradeify, owner, `follower-exit-${n}`,10+n);
      const result=await rows(); assert.equal(result.length,2); assert.ok(result.every(r=>r.trade_id===id(1)));
    });
    await t.test('partial exit before final close preserves exact final fill link', async () => {
      await reset(); await db.query(`update tradovate_journal_positions set history=jsonb_set(history,'{fills}',history->'fills' || $1::jsonb)`,
        [JSON.stringify([{ id:'partial',role:'exit',at:closed-500,accountId:10 }])]);
      assert.equal((await rows()).length,2);
    });
    await t.test('duplicate relay delivery of same episode does not duplicate images', async () => {
      await reset(); await ledger(lucid); assert.equal((await rows()).length,2);
    });
    await t.test('late upload heals existing journal trade on next read', async () => {
      await reset(); await db.exec('truncate copier_trade_snapshots'); assert.equal((await rows()).length,0);
      await images(); assert.equal((await rows()).length,2);
    });
    const blocked = [
      ['different closed timestamp', `update tradovate_copier_trades set closed_at=closed_at+interval '1 millisecond'`],
      ['different opened timestamp', `update tradovate_copier_trades set opened_at=opened_at+interval '1 millisecond'`],
      ['different instrument', `update tradovate_copier_trades set symbol='NQU6'`],
      ['different direction', `update tradovate_copier_trades set side='Long'`],
      ['wrong fill account', `update tradovate_journal_positions set history=jsonb_set(history,'{fills,1,accountId}','11')`],
      ['wrong history connection', `update tradovate_journal_positions set history=jsonb_set(history,'{connectionId}','"${tradeify}"')`],
      ['wrong environment', `update tradovate_journal_positions set history=jsonb_set(history,'{environment}','"live"')`],
      ['pending journal', `update tradovate_journal_positions set status='pending'`],
      ['incomplete projection', `update tradovate_journal_projection_heads set completed_revision=0`],
      ['stale journal revision', `update tradovate_journal_positions set revision=0`],
      ['deleted review row', 'truncate trades'],
      ['multiple final fills at the same instant', `update tradovate_journal_positions set history=jsonb_set(history,'{fills}',history->'fills' || jsonb_build_array(history->'fills'->1))`],
    ];
    for (const [name, sql] of blocked) await t.test(`rejects ${name}`, async () => {
      await reset(); await db.exec(sql); assert.equal((await rows()).length,0);
    });
    await t.test('ambiguous same broker fill across connections/accounts fails closed', async () => {
      await reset(); await position(2,tradeify,owner,'exit-fill',20); assert.equal((await rows()).length,0);
    });
    await t.test('one broker fill cannot claim multiple episodes', async () => {
      await reset(); await ledger(lucid,owner,'exit-fill',otherEpisode); assert.equal((await rows()).length,0);
    });
    await t.test('one episode cannot claim multiple broker fills', async () => {
      await reset(); await ledger(lucid,owner,'different-fill'); assert.equal((await rows()).length,0);
    });
    await t.test('no cross-owner media link even with identical fill/episode', async () => {
      await reset(); await db.query('update copier_trade_snapshots set user_id=$1',[foreign]); assert.equal((await rows()).length,0);
    });
    await t.test('security invoker enforces owner RLS and denies anonymous reads', async () => {
      await reset(); await db.exec(`set app.test_user='${owner}'; set role authenticated`);
      assert.equal((await rows()).length,2);
      await db.exec(`set app.test_user='${foreign}'`); assert.equal((await rows()).length,0);
      await db.exec('reset role; set role anon'); await assert.rejects(rows,/permission denied/);
      await db.exec('reset role');
    });
    await t.test('migration is repeatable and read-only for source rows', async () => {
      await reset(); const before=await db.query('select * from tradovate_copier_trades');
      await db.exec(migration); assert.deepEqual(await db.query('select * from tradovate_copier_trades'),before);
      assert.equal((await rows()).length,2);
    });
  } finally { await db.close(); }
});
