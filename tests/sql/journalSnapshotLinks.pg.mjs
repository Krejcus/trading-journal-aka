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
const tables = ['trades', 'tradovate_journal_positions', 'tradovate_journal_projection_heads', 'tradovate_copier_trades', 'copier_trade_snapshots', 'tradovate_journal_evidence'];
const fillIdentity = await readFile(new URL('../../supabase/migrations/20260914125323_journal_snapshots_broker_fill_identity.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../../supabase/migrations/20260917071500_journal_snapshots_follower_copylink.sql', import.meta.url), 'utf8');
const leaderOrder = '647188292538', followerOrder = '655649841563', device = '77777777-7777-4777-8777-777777777777';
const previous = await readFile(new URL('../../supabase/migrations/20260912164531_journal_snapshot_links.sql', import.meta.url), 'utf8');
const db = new PGlite();

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table trades (id uuid,user_id uuid,account_id uuid);
  create table tradovate_journal_positions (trade_id uuid,user_id uuid,connection_id uuid,journal_account_id uuid,
    external_account_id bigint,status text,revision bigint,history jsonb,facts jsonb);
  create table tradovate_journal_projection_heads (user_id uuid,connection_id uuid,revision bigint,completed_revision bigint);
  create table tradovate_copier_trades (user_id uuid,connection_id uuid,trade_id text,episode_id uuid,opened_at timestamptz,closed_at timestamptz,symbol text,side text,
    device_id uuid default '${device}');
  create table copier_trade_snapshots (id uuid,user_id uuid,episode_id uuid,kind text,at timestamptz,storage_path text);
  create table tradovate_journal_evidence (user_id uuid,connection_id uuid,entity_type text,received_at timestamptz,evidence jsonb);
`);
await db.exec('alter table tradovate_copier_trades add column leader_entry_order_ids text[]');
for (const table of tables) await db.exec(`alter table ${table} enable row level security;
  grant select on ${table} to authenticated;
  create policy owner_read on ${table} for select to authenticated using (user_id=current_setting('app.test_user')::uuid);`);

async function position(n = 1, connection = lucid, who = owner, fill = 'exit-fill', account = 10, facts = {}, times = {}) {
  const openedAt = times.openedAt ?? opened, closedAt = times.closedAt ?? closed;
  const history = { environment: 'demo', connectionId: connection, accountId: account,
    position: { status: 'closed', openedAt, closedAt },
    fills: [{ id: `entry-${fill}`, role: 'entry', at: openedAt, accountId: account, orderId: facts.entryOrderId ?? leaderOrder },
      { id: fill, role: 'exit', at: closedAt, accountId: account }] };
  await db.query('insert into trades values ($1,$2,$3)', [id(n), who, id(n+100)]);
  await db.query('insert into tradovate_journal_positions values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id(n), who, connection, id(n+100), account, 'confirmed', 1, JSON.stringify(history),
      JSON.stringify({ instrument: 'MNQ', direction: 'Short', groupId: `execution:demo:${lucid}:${leaderOrder}`, isMaster: true, ...facts })]);
  await db.query(`insert into tradovate_journal_projection_heads select $1,$2,1,1
    where not exists(select 1 from tradovate_journal_projection_heads where user_id=$1 and connection_id=$2)`, [who, connection]);
}
async function ledger(connection = tradeify, who = owner, fill = 'exit-fill', ep = episode, orders = [leaderOrder]) {
  await db.query('insert into tradovate_copier_trades (user_id,connection_id,trade_id,episode_id,opened_at,closed_at,symbol,side,leader_entry_order_ids) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [who, connection, fill, ep, new Date(opened).toISOString(), new Date(closed).toISOString(), 'MNQU6', 'Short', orders]);
}
/** A follower copy: own broker fills, own account, later exit through its own protective leg. */
async function follower(n = 2, facts = {}, times = { openedAt: opened + 400, closedAt: closed + 2000 }, account = 20, connection = tradeify) {
  await position(n, connection, owner, `follower-exit-${n}`, account,
    { isMaster: false, entryOrderId: followerOrder, groupId: `execution:demo:${lucid}:${leaderOrder}`, ...facts }, times);
}
async function evidence(connection, type, entity, receivedAt, who = owner) {
  await db.query('insert into tradovate_journal_evidence values ($1,$2,$3,$4,$5)',
    [who, connection, type, new Date(receivedAt).toISOString(), JSON.stringify({ source: 'stream', entityType: type, entity })]);
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
    await db.exec(fillIdentity);
    assert.equal((await rows()).length, 2, 'fill identity resolves the leader card');
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
    await t.test('follower copy links through the exact copied leader entry order', async () => {
      await reset(); await follower();
      const result = await rows(); assert.equal(result.length, 4);
      const mine = result.filter(r => r.trade_id === id(2));
      assert.equal(mine.length, 2); assert.ok(mine.every(r => r.connection_id === tradeify && r.journal_account_id === id(102) && r.episode_id === episode));
      assert.deepEqual(mine.map(r => r.kind).sort(), ['entry', 'exit']);
    });
    await t.test('twelve followers of one episode each receive the episode images once', async () => {
      await reset(); for (let n = 2; n <= 13; n++) await follower(n, {}, { openedAt: opened + n, closedAt: closed + n }, 10 + n, n % 2 ? lucid : tradeify);
      const result = await rows(); assert.equal(result.length, 2 + 12 * 2);
      assert.equal(new Set(result.map(r => r.page_key)).size, result.length);
    });
    await t.test('follower link survives a missing leader card (leader history incomplete)', async () => {
      await reset(); await follower(); await db.query('delete from tradovate_journal_positions where trade_id=$1', [id(1)]);
      const result = await rows(); assert.equal(result.length, 2); assert.ok(result.every(r => r.trade_id === id(2)));
    });
    const followerBlocked = [
      ['a different copied leader order', { groupId: `execution:demo:${lucid}:999999999999` }, {}],
      ['a group without an order id', { groupId: `execution:demo:${lucid}:` }, {}],
      ['a group with extra parts', { groupId: `execution:demo:${lucid}:${leaderOrder}:x` }, {}],
      ['a live environment group', { groupId: `execution:live:${lucid}:${leaderOrder}` }, {}],
      ['a card that claims to be the leader', { isMaster: true }, {}],
      ['a different instrument', { instrument: 'NQ' }, {}],
      ['a different direction', { direction: 'Long' }, {}],
      ['an entry three seconds before the leader opened', {}, { openedAt: opened - 3000, closedAt: closed }],
      ['an entry three seconds after the leader closed', {}, { openedAt: closed + 3000, closedAt: closed + 9000 }],
    ];
    for (const [name, facts, times] of followerBlocked) await t.test(`follower with ${name} gets no images`, async () => {
      await reset(); await follower(2, facts, { openedAt: opened + 400, closedAt: closed + 2000, ...times });
      const result = await rows(); assert.ok(result.every(r => r.trade_id === id(1)), name);
    });
    await t.test('a copy stamped one millisecond before the leader fill (same broker batch) still links', async () => {
      await reset(); await follower(2, {}, { openedAt: opened - 1, closedAt: closed + 2000 });
      assert.equal((await rows()).filter(r => r.trade_id === id(2)).length, 2);
    });
    await t.test('follower without a recorded leader entry order on the ledger gets no images', async () => {
      await reset(); await follower(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      assert.ok((await rows()).every(r => r.trade_id === id(1)));
    });
    await t.test('one leader order claimed by two episodes fails closed for followers only', async () => {
      await reset(); await follower(); await ledger(lucid, owner, 'other-fill', otherEpisode);
      const result = await rows(); assert.ok(result.every(r => r.trade_id === id(1)), 'leader fill identity unaffected'); assert.equal(result.length, 2);
    });
    await t.test('a pending follower projection gets no images', async () => {
      await reset(); await follower(); await db.query(`update tradovate_journal_positions set status='pending' where trade_id=$1`, [id(2)]);
      assert.ok((await rows()).every(r => r.trade_id === id(1)));
    });
    await t.test('follower rows respect owner RLS', async () => {
      await reset(); await follower(); await db.exec(`set app.test_user='${foreign}'; set role authenticated`);
      assert.equal((await rows()).length, 0); await db.exec('reset role');
    });
    await t.test('backfill resolves the leader entry order from the exact broker fill and its copylink root', async () => {
      await reset(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      await db.query('delete from tradovate_journal_positions where trade_id=$1', [id(1)]); // no leader position: evidence proof only
      await evidence(lucid, 'fill', { id: 11, orderId: Number(leaderOrder), action: 'Sell', timestamp: new Date(opened).toISOString() }, opened + 150);
      await evidence(tradeify, 'fill', { id: 12, orderId: Number(followerOrder), action: 'Sell', timestamp: new Date(opened + 400).toISOString() }, opened + 500);
      await evidence(lucid, 'copylink', { id: `${lucid}:${leaderOrder}:10:${leaderOrder}:entry`, role: 'entry', leaderOrderId: leaderOrder, orderId: leaderOrder, accountId: 10, leaderAccountId: 10 }, opened + 900);
      await db.exec(migration);
      const [row] = (await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows;
      assert.deepEqual(row.leader_entry_order_ids, [leaderOrder]);
      await follower(); assert.equal((await rows()).length, 2);
    });
    await t.test('backfill takes the leader entry order from the confirmed leader position first', async () => {
      await reset(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      await db.query(`update tradovate_journal_positions set history=jsonb_set(history,'{fills,0,orderId}','"111222333"') where trade_id=$1`, [id(1)]);
      await db.exec(migration);
      assert.deepEqual((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, ['111222333']);
    });
    await t.test('backfill falls back to the unique copied order of confirmed followers inside the episode', async () => {
      await reset(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      await db.query('delete from tradovate_journal_positions where trade_id=$1', [id(1)]);
      await follower(2, { groupId: `execution:demo:${lucid}:424242` }); await follower(3, { groupId: `execution:demo:${lucid}:424242` }, { openedAt: opened - 1, closedAt: closed + 1 }, 21);
      await db.exec(migration);
      assert.deepEqual((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, ['424242']);
      const result = await rows(); assert.equal(result.length, 4); assert.ok(result.every(r => [id(2), id(3)].includes(r.trade_id)));
    });
    await t.test('backfill refuses followers that disagree about the copied leader order', async () => {
      await reset(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      await db.query('delete from tradovate_journal_positions where trade_id=$1', [id(1)]);
      await follower(2, { groupId: `execution:demo:${lucid}:424242` }); await follower(3, { groupId: `execution:demo:${lucid}:434343` }, undefined, 21);
      await db.exec(migration);
      assert.equal((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, null);
      assert.equal((await rows()).length, 0);
    });
    await t.test('backfill leaves ambiguous or unproven episodes untouched', async () => {
      await reset(); await db.exec('update tradovate_copier_trades set leader_entry_order_ids=null');
      await db.query('delete from tradovate_journal_positions where trade_id=$1', [id(1)]); // no leader position: evidence proof only
      await evidence(lucid, 'fill', { id: 11, orderId: Number(leaderOrder), action: 'Sell', timestamp: new Date(opened).toISOString() }, opened + 150);
      await db.exec(migration);
      assert.equal((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, null, 'no copylink root');
      await evidence(lucid, 'copylink', { id: 'a', role: 'entry', leaderOrderId: leaderOrder, orderId: leaderOrder, accountId: 10, leaderAccountId: 10 }, opened + 900);
      await evidence(lucid, 'fill', { id: 13, orderId: 123456, action: 'Sell', timestamp: new Date(opened).toISOString() }, opened + 160);
      await evidence(lucid, 'copylink', { id: 'b', role: 'entry', leaderOrderId: '123456', orderId: '123456', accountId: 10, leaderAccountId: 10 }, opened + 900);
      await db.exec(migration);
      assert.equal((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, null, 'two leader orders at one instant');
      await db.exec(`update tradovate_copier_trades set leader_entry_order_ids='{555}'`); await db.exec(migration);
      assert.deepEqual((await db.query('select leader_entry_order_ids from tradovate_copier_trades')).rows[0].leader_entry_order_ids, ['555'], 'existing key never overwritten');
    });
  } finally { await db.close(); }
});
