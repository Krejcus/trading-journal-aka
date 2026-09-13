import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Called against the existing real-migration/import harness, never a remote DB. */
export async function verifyJournalRootProjection(db: {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>;
}, root: string, owner: string, viewer: string, tradeId: string) {
  await db.exec('begin');
  try {
    await db.exec(`reset role;
      create table public.connections(id uuid primary key, sender_id uuid, receiver_id uuid, status text, permissions jsonb);
      alter table public.connections enable row level security;
      grant select on public.connections to authenticated;
      create policy connection_parties on public.connections for select to authenticated
        using(sender_id=(select auth.uid()) or receiver_id=(select auth.uid()));`);
    // Use the actual legacy follower rule, not an invented permissive view stub.
    const existingRls = await readFile(resolve(root, 'migrations/FIX_RLS_POLICIES.sql'), 'utf8');
    const policy = existingRls.match(/CREATE POLICY "Followers can view trades" ON public\.trades[\s\S]*?;/)?.[0];
    assert.ok(policy); await db.exec(policy);
    const connection = '99999999-9999-4999-8999-999999999999';
    await db.query('insert into public.connections values ($1,$2,$3,\'accepted\',\'{}\')', [connection, viewer, owner]);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [viewer]);
    const read = async () => (await db.query('select * from public.confirmed_journal_trades where id=$1', [tradeId])).rows;
    const before = (await read())[0];
    assert.equal(Number(before.pnl), 18); assert.equal(before.data.pnl, 18);
    assert.equal(before.journal_projection_status, 'confirmed');
    assert.equal(before.data.executionHistory, undefined);
    assert.equal((await db.query('select count(*)::int as n from public.tradovate_journal_positions')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.tradovate_journal_evidence')).rows[0].n, 0);
    await db.exec('reset role');
    await db.query("update public.connections set status='rejected' where id=$1", [connection]);
    await db.exec('set role authenticated');
    assert.equal((await read()).length, 0);
    await db.exec('reset role');
    await db.query("update public.connections set status='accepted' where id=$1", [connection]);
    // Corrections and removal of a stale initial protection value reach the root
    // in the same transaction while all review fields survive exactly.
    await db.query(`update public.tradovate_journal_positions set facts=(facts - 'stopLoss') ||
      '{"pnl":17.25,"exitPrice":20012,"timestamp":2002,"date":"1970-01-01T00:00:02.002Z"}'::jsonb
      where trade_id=$1`, [tradeId]);
    await db.exec('set role authenticated');
    const corrected = (await read())[0];
    assert.equal(Number(corrected.pnl), 17.25); assert.equal(corrected.data.pnl, 17.25);
    assert.equal(corrected.data.exitPrice, 20012); assert.equal(Number(corrected.timestamp), 2002);
    assert.equal(corrected.data.stopLoss, undefined); assert.equal(corrected.data.riskAmount, undefined);
    for (const key of ['notes','screenshots','drawings','copierTradeId','needsReview']) assert.deepEqual(corrected.data[key],before.data[key]);
    // The owner cannot transplant the database certificate to another ID or
    // rewrite its state through a stale/full client update.
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("update public.trades set id=$2,journal_projection_status='pending' where id=$1", [tradeId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    assert.equal((await read())[0].journal_projection_status, 'confirmed');
    assert.equal((await db.query('select count(*)::int as n from public.trades where id=$1',['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).rows[0].n,0);
    await db.exec('reset role');
    await db.query("update public.tradovate_journal_positions set status='pending' where trade_id=$1", [tradeId]);
    await db.exec('set role authenticated');
    await db.query("update public.trades set journal_projection_status='confirmed' where id=$1", [tradeId]);
    assert.equal((await read()).length, 0);
    await db.exec('reset role');
    await db.query("update public.tradovate_journal_positions set status='invalidated' where trade_id=$1", [tradeId]);
    assert.equal((await read()).length, 0);
    await db.query("update public.tradovate_journal_positions set status='confirmed' where trade_id=$1", [tradeId]);
    assert.equal((await read()).length, 1);
    await db.query('delete from public.tradovate_journal_positions where trade_id=$1', [tradeId]);
    assert.equal((await read()).length, 0);
    await db.exec('set role authenticated');
    const account = before.account_id;
    await db.query(`insert into public.trades(id,user_id,account_id,instrument,pnl,direction,date,timestamp,data,journal_projection_status)
      values($1,$2,$3,'MNQ',999,'Long','2026-09-10',1,'{"copierTradeId":"journal:forged","source":"copier"}','confirmed')`,
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', owner, account]);
    assert.equal((await db.query("select * from public.confirmed_journal_trades where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'")).rows.length,0);
    await db.exec('reset role');
    const definition = (await db.query("select pg_get_viewdef('public.confirmed_journal_trades'::regclass) as sql")).rows[0].sql;
    assert.ok(!definition.includes('tradovate_journal_positions'));
    const view = (await db.query("select reloptions from pg_class where oid='public.confirmed_journal_trades'::regclass")).rows[0];
    assert.ok(view.reloptions.includes('security_invoker=true'));
    console.log('PASS: real follower RLS, revocation, private evidence isolation, atomic current root facts/status, immutable certificate, pending/invalidation/deletion and forged-certificate rejection.');
  } finally { await db.exec('rollback'); }
}
