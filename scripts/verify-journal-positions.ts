import { verifyJournalSharedRead } from './verify-journal-shared-read';
import { verifyJournalRootProjection } from './verify-journal-root-projection';
/** Local PostgreSQL-compatible verification; no credentials or remote traffic. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { journalAccountsFixture } from '../tests/fixtures/journalAccounts';
import { importJournalPositions } from '../server/journalPositionImport';
import { compactJournalInputEntities } from '../lib/journalInputCompaction';
import { prepareJournalInput } from '../server/journalIncrementalInput';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite } from '../lib/journalTradeFacts';
import { readOwnedJournalDetails, mergeJournalDetailSelection } from '../services/journalTradeDetail';
import { hydrateOwnedJournalTrades } from '../services/journalTradeHydration';
import { readTradeListPages } from '../services/tradeListPages';
import type { Trade } from '../types';

if (!process.argv[2]) throw new Error('Pass an isolated verification dependency directory.');
const requireVerification = createRequire(resolve(process.argv[2], 'package.json'));
const { PGlite } = requireVerification('@electric-sql/pglite');
const db = new PGlite();
const root = fileURLToPath(new URL('../', import.meta.url));
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const device = '44444444-4444-4444-8444-444444444444';
const { events, accounts } = journalAccountsFixture(connection, 12, true);
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    create table public.tradovate_oauth_connections (id uuid primary key, user_id uuid not null references auth.users, environment text not null);
    create table public.tradovate_copier_devices (id uuid primary key, user_id uuid not null references auth.users,
      connection_id uuid not null references public.tradovate_oauth_connections, environment text not null, revoked_at timestamptz);
    create table public.accounts (id uuid primary key, user_id uuid not null, meta jsonb not null);
    create table public.tradovate_copier_trades (user_id uuid not null, connection_id uuid, trade_id text not null,episode_id uuid);
    create table public.trades (id uuid primary key, user_id uuid not null, account_id uuid not null,
      instrument text, signal text, pnl numeric not null, direction text, date text not null, timestamp bigint not null, data jsonb not null,
      drawings jsonb, is_public boolean default false, created_at timestamptz default now(), share_notes boolean default false);
    create table public.trade_private_notes (trade_id uuid primary key, user_id uuid not null, notes jsonb);
    grant select, insert on public.trade_private_notes to service_role;
    alter table public.trades enable row level security;
    grant select, insert, update on public.trades to authenticated;
    create policy owner_trade_read on public.trades for select to authenticated using (user_id = (select auth.uid()));
    create policy owner_trade_insert on public.trades for insert to authenticated with check (user_id = (select auth.uid()));
    create policy owner_trade_update on public.trades for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    grant all on public.tradovate_oauth_connections, public.tradovate_copier_devices, public.accounts, public.trades, public.tradovate_copier_trades to service_role;
  `);
  await db.query('insert into auth.users values ($1), ($2)', [owner, other]);
  await db.query('insert into public.tradovate_oauth_connections values ($1, $2, $3)', [connection, owner, 'demo']);
  await db.query('insert into public.tradovate_copier_devices values ($1, $2, $3, $4, null)', [device, owner, connection, 'demo']);
  const snapshotMigration=await readFile(resolve(root,'supabase/migrations/20260822055450_copier_trade_snapshots.sql'),'utf8');
  await db.exec(snapshotMigration.slice(snapshotMigration.indexOf('create table if not exists public.copier_trade_snapshots'),snapshotMigration.indexOf('-- Serverless instance')));
  await db.exec(`alter table public.tradovate_copier_trades enable row level security;
    grant select on public.tradovate_copier_trades to authenticated;
    create policy ledger_owner on public.tradovate_copier_trades for select to authenticated using(user_id=(select auth.uid()));`);
  // Load the actual existing helper definitions; no simplified privacy stubs.
  const privacyMigration = await readFile(resolve(root, 'supabase/migrations/20260905193801_trade_legacy_notes_privacy_and_owner_consent.sql'), 'utf8');
  for (const name of ['strip_trade_private_note_fields_v1', 'trade_note_fields_v1']) {
    const start = privacyMigration.indexOf(`create function public.${name}(`);
    const end = privacyMigration.indexOf('$$;', privacyMigration.indexOf('as $$', start) + 5);
    assert.ok(start >= 0 && end > start); await db.exec(privacyMigration.slice(start, end + 3));
  }
  for (const filename of ['20260912100450_tradovate_journal_evidence.sql', '20260912115949_journal_trade_projection.sql', '20260912122352_journal_position_persistence.sql', '20260912162137_journal_incremental_input.sql', '20260912164531_journal_snapshot_links.sql', '20260912190422_journal_confirmed_root_projection.sql']) {
    try { await db.exec(await readFile(resolve(root, 'supabase/migrations', filename), 'utf8')); }
    catch (error) { const sql = error as { message: string; position?: string }; throw new Error(`${filename}: ${sql.message} at ${sql.position}`, { cause: error }); }
  }
  await db.exec('set role service_role');
  for (const account of accounts) await db.query('insert into public.accounts values ($1, $2, $3)', [account.id, owner, JSON.stringify({ oauth: account.oauth })]);
  const append = (rows: typeof events) => db.query('select public.append_tradovate_journal_evidence($1,$2,$3,$4::jsonb)', [owner, connection, device, JSON.stringify(rows)]);
  const persist = (revision: number | null, rows: unknown[], userId = owner, receipt: unknown = null) => db.query('select public.persist_tradovate_journal_positions($1,$2,$3,$4::jsonb,$5::jsonb) as ack', [userId, connection, revision, JSON.stringify(rows), receipt == null ? null : JSON.stringify(receipt)]);
  const count = async () => (await db.query('select count(*)::int as count from public.trades')).rows[0].count;
  let writes = 0; let evidenceReads = 0;
  let interruptStage = false;
  const stagedChunkWrites: number[] = [];
  const localApi = createClient('http://127.0.0.1:9914', 'fictional-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const table = url.pathname.split('/').at(-1)!;
      if (url.pathname.includes('/rpc/')) {
        const args = JSON.parse(String(init?.body));
        if (table === 'read_journal_import_checkpoint') {
          const result = await db.query('select public.read_journal_import_checkpoint($1,$2) as ack', [args.p_user_id,args.p_connection_id]);
          return Response.json(result.rows[0].ack);
        }
        const stageArguments: Record<string,string[]> = {
          read_journal_input_batch:['p_user_id','p_connection_id'],
          commit_journal_input_batch:['p_user_id','p_connection_id','p_generation','p_after','p_next','p_updates'],
          read_journal_input_entity_history:['p_user_id','p_connection_id','p_key','p_after','p_through'],
          read_journal_input_snapshot:['p_user_id','p_connection_id','p_generation','p_after'],
          begin_journal_position_stage: ['p_user_id','p_connection_id','p_revision','p_run_key','p_chunk_count','p_position_count','p_import_receipt'],
          write_journal_position_stage: ['p_user_id','p_connection_id','p_run_id','p_chunk_index','p_positions'],
          publish_journal_position_stage: ['p_user_id','p_connection_id','p_run_id'],
        };
        if (stageArguments[table]) {
          if (table==='write_journal_position_stage') {
            stagedChunkWrites.push(args.p_chunk_index);
            if (interruptStage && args.p_chunk_index===1) {
              interruptStage=false;
              return Response.json({ message:'simulated transport interruption' },{ status:503 });
            }
          }
          const keys=stageArguments[table];
          const result=await db.query(`select public.${table}(${keys.map((_key,i)=>`$${i+1}`).join(',')}) as ack`,
            keys.map(key=>typeof args[key]==='object' ? JSON.stringify(args[key]) : args[key])).catch(error=>{ console.error('Local RPC failed:',table,error.message); throw error; });
          if (table==='read_journal_input_batch' || table==='read_journal_input_entity_history') evidenceReads+=result.rows[0].ack.rows.length;
          return Response.json(result.rows[0].ack);
        }
        assert.equal(table, 'persist_tradovate_journal_positions');
        writes++;
        const result = await persist(args.p_revision, args.p_positions, args.p_user_id, args.p_import_receipt);
        return new Response(JSON.stringify(result.rows[0].ack), { headers: { 'Content-Type': 'application/json' } });
      }
      assert.ok(['trades', 'accounts', 'tradovate_journal_evidence', 'tradovate_oauth_connections', 'tradovate_journal_positions', 'tradovate_journal_projection_heads','journal_trade_snapshots'].includes(table));
      if (table === 'tradovate_journal_evidence') evidenceReads++;
      const values: string[] = []; const conditions: string[] = [];
      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'limit'].includes(key)) continue;
        assert.ok(['id', 'user_id', 'connection_id', 'environment', 'ingest_id', 'meta', 'trade_id','page_key'].includes(key));
        const separator = value.indexOf('.');
        if (value.startsWith('in.')) {
          const ids = value.slice(4, -1).split(',');
          for (const id of ids) { assert.match(id, /^[0-9a-f-]+$/); values.push(id); }
          conditions.push(`${key} in (${ids.map((_id, i) => `$${values.length - ids.length + i + 1}`).join(',')})`);
          continue;
        }
        const operator = { eq: '=', gt: '>', lte: '<=', cs: '@>' }[value.slice(0, separator)];
        assert.ok(operator); values.push(value.slice(separator + 1)); conditions.push(`${key} ${operator} $${values.length}${operator === '@>' ? '::jsonb' : ''}`);
      }
      const columns = url.searchParams.get('select'); assert.ok(['*', 'id', 'id,meta', 'ingest_id,evidence', 'connection_id,revision,completed_revision,generation',
        'trade_id,journal_account_id,status,facts,connection_id,external_account_id,revision',
        'trade_id,journal_account_id,status,facts,connection_id,external_account_id,revision,history',
        'page_key,user_id,trade_id,journal_account_id,snapshot_id,episode_id,kind,at,storage_path'].includes(columns!));
      const order = url.searchParams.get('order'); assert.ok(order == null || ['ingest_id.asc', 'ingest_id.desc', 'connection_id.asc','page_key.asc'].includes(order));
      const limit = Number(url.searchParams.get('limit') ?? 1000); assert.ok(Number.isInteger(limit) && limit <= 1000);
      const result = await db.query(`select ${columns} from public.${table} where ${conditions.join(' and ')}${order ? ` order by ${order.split('.')[0]} ${order.endsWith('desc') ? 'desc' : 'asc'}` : ''} limit ${limit}`, values);
      return new Response(JSON.stringify(result.rows), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const scope = { ownerId: owner, connectionId: connection, environment: 'demo' as const };
  let inputContinuations=0;
  const completeImport=async(nextScope:typeof scope)=>{
    const originalHead=(await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[nextScope.connectionId])).rows;
    for(let attempt=0;attempt<100;attempt++) {
      const result=await importJournalPositions(localApi,nextScope);
      if (!result.processing) return result;
      inputContinuations++;
      assert.equal(result.accepted,false); assert.equal(result.confirmed,0); assert.ok(result.targetThrough!>=result.through);
      // Both input and staged-output continuations must leave the last complete
      // published generation in place until the entire projection is accepted.
      assert.deepEqual((await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[nextScope.connectionId])).rows,originalHead);
    }
    throw new Error('journal-input-did-not-complete');
  };
  // Missing fees never become a zero-PnL trade. Identity is reserved privately.
  await append(events.filter(row => row.entityType !== 'fillfee'));
  const inputStart=(await db.query('select public.read_journal_input_batch($1,$2) as data',[owner,connection])).rows[0].data;
  const initialUpdates=await compactJournalInputEntities(inputStart.rows.map((r:any)=>r.event),[],async()=>{throw new Error('unexpected replay');});
  const commitInput=(generation:number,next:number,updates:unknown)=>db.query('select public.commit_journal_input_batch($1,$2,$3,$4,$5,$6::jsonb) as ack',
    [owner,connection,generation,inputStart.after,next,JSON.stringify(updates)]);
  const invalidUpdates=structuredClone(initialUpdates);
  invalidUpdates.at(-1)!.latest.id='f'.repeat(64);
  await assert.rejects(commitInput(inputStart.generation,inputStart.next,invalidUpdates),/invalid-journal-input-entity/);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_input_entities')).rows[0].count,0);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_input_retained')).rows[0].count,0);
  assert.equal((await db.query('select through from public.tradovate_journal_input_heads')).rows[0].through,0);
  await assert.rejects(commitInput(inputStart.generation,inputStart.next+1,initialUpdates),/invalid-journal-input-cursor/);
  assert.deepEqual((await commitInput(inputStart.generation+1,inputStart.next,initialUpdates)).rows[0].ack,{accepted:false,stale:true});
  await assert.rejects(db.query('select public.read_journal_input_batch($1,$2)',[other,connection]),/journal-connection-not-found/);
  const pending = await completeImport(scope);
  assert.equal(pending.pending, 12); assert.equal(await count(), 0);
  assert.deepEqual((await db.query('select distinct pending_reason from public.tradovate_journal_positions')).rows, [{ pending_reason: 'accounting-pending' }]);
  const reserved = (await db.query('select position_id,trade_id from public.tradovate_journal_positions order by position_id')).rows;
  await append(events.filter(row => row.entityType === 'fillfee'));
  const first = await completeImport(scope);
  assert.equal(first.confirmed, 12); assert.equal(first.pending, 0); assert.equal(await count(), 12);
  assert.deepEqual((await db.query('select distinct pending_reason from public.tradovate_journal_positions')).rows, [{ pending_reason: null }]);
  assert.deepEqual((await db.query('select position_id,trade_id from public.tradovate_journal_positions order by position_id')).rows, reserved);
  const snapshotEpisode='77777777-7777-4777-8777-777777777777';
  await db.query('insert into public.tradovate_copier_trades values($1,$2,$3,$4)',[owner,connection,'11',snapshotEpisode]);
  const addSnapshot=async(kind:string,at:number)=>db.query('insert into public.copier_trade_snapshots(user_id,episode_id,kind,at,symbol,storage_path) values($1,$2,$3,$4,$5,$6)',
    [owner,snapshotEpisode,kind,new Date(at).toISOString(),'MNQU6',`${owner}/${snapshotEpisode}/${kind}-${at}.png`]);
  const mediaTrades=(await db.query('select * from public.trades')).rows.map((r:any)=>({...r.data,id:r.id,accountId:r.account_id,pnl:Number(r.pnl)} as Trade));
  await addSnapshot('entry',1100);
  const withEntry=await hydrateOwnedJournalTrades(localApi,mediaTrades,owner,owner,()=>true);
  assert.equal(withEntry.filter(t=>t.copierSnapshots?.length).length,1);
  assert.equal(withEntry.find(t=>t.accountId===accounts[0].id)!.copierSnapshots!.length,1);
  assert.ok(withEntry.every(t=>t.copierSnapshotLoadError===false));
  await addSnapshot('exit',2100); // late upload, with no new evidence or financial import
  const withLateExit=await hydrateOwnedJournalTrades(localApi,mediaTrades,owner,owner,()=>true,{detail:true});
  assert.deepEqual(withLateExit.find(t=>t.accountId===accounts[0].id)!.copierSnapshots!.map(s=>s.kind),['entry','exit']);
  assert.deepEqual(withLateExit.map(t=>t.pnl),mediaTrades.map(t=>t.pnl));
  // Duplicate delivery from another paired device is one artifact, while a
  // conflicting episode or connection must never create a guessed association.
  await db.query('insert into public.tradovate_copier_trades values($1,$2,$3,$4)',[owner,connection,'11',snapshotEpisode]);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,2);
  await db.query('delete from public.tradovate_copier_trades where user_id=$1 and connection_id=$2 and trade_id=$3',[owner,connection,'11']);
  await db.query('insert into public.tradovate_copier_trades values($1,$2,$3,$4)',[owner,connection,'11',snapshotEpisode]);
  await db.query('update public.tradovate_copier_trades set connection_id=$1 where user_id=$2 and episode_id=$3',[device,owner,snapshotEpisode]);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,0);
  await db.query('update public.tradovate_copier_trades set connection_id=$1 where user_id=$2 and episode_id=$3',[connection,owner,snapshotEpisode]);
  await db.query('insert into public.tradovate_copier_trades values($1,$2,$3,$4)',[owner,connection,'11',device]);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,0);
  await db.query('delete from public.tradovate_copier_trades where user_id=$1 and episode_id=$2',[owner,device]);
  const mediaPosition=(await db.query('select trade_id,history from public.tradovate_journal_positions where journal_account_id=$1',[accounts[0].id])).rows[0];
  const duplicateExit={...mediaPosition.history,fills:[...mediaPosition.history.fills,mediaPosition.history.fills.find((f:any)=>f.role==='exit')]};
  await db.query('update public.tradovate_journal_positions set history=$1::jsonb where trade_id=$2',[JSON.stringify(duplicateExit),mediaPosition.trade_id]);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,0);
  await db.query('update public.tradovate_journal_positions set history=$1::jsonb where trade_id=$2',[JSON.stringify(mediaPosition.history),mediaPosition.trade_id]);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${other}',false);`);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,0);
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false);`);
  assert.equal((await db.query('select * from public.journal_trade_snapshots')).rows.length,2);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.journal_trade_snapshots'),/permission denied/);
  await db.exec('set role service_role');
  console.log('PASS: exact final-fill snapshot linkage, owner-only view, no follower duplication, late upload without financial reimport and unchanged PnL/manual review.');
  const readsBeforeNoop = evidenceReads; const writesBeforeNoop = writes;
  const generationBeforeNoop = (await db.query('select generation from public.tradovate_journal_projection_heads')).rows[0].generation;
  const noop = await completeImport(scope);
  assert.deepEqual(noop, { ...first, unchanged: true });
  assert.equal(evidenceReads, readsBeforeNoop); assert.equal(writes,writesBeforeNoop);
  assert.equal((await db.query('select generation from public.tradovate_journal_projection_heads')).rows[0].generation,generationBeforeNoop);
  // Account relinking must reproject even when no source evidence changed.
  await db.query("update public.accounts set meta='{}'::jsonb where id=$1", [accounts[0].id]);
  const unlinked = await completeImport(scope);
  assert.equal(unlinked.confirmed,11); assert.equal(unlinked.pending,1); assert.equal(unlinked.unchanged,undefined);
  await db.query('update public.accounts set meta=$1::jsonb where id=$2', [JSON.stringify({ oauth: accounts[0].oauth }),accounts[0].id]);
  const relinked = await completeImport(scope);
  assert.equal(relinked.confirmed,12); assert.equal(relinked.unchanged,undefined);
  const readCheckpoint = () => db.query('select public.read_journal_import_checkpoint($1,$2) as ack', [owner,connection]);
  await assert.rejects(db.query('select public.read_journal_import_checkpoint($1,$2)', [other,connection]), /journal-connection-not-found/);
  // An incomplete generation or an old projector version cannot certify a no-op.
  const savedHead = (await db.query('select * from public.tradovate_journal_projection_heads')).rows[0];
  await db.query('update public.tradovate_journal_projection_heads set completed_revision=0 where connection_id=$1', [connection]);
  assert.equal((await readCheckpoint()).rows[0].ack,null);
  await db.query("update public.tradovate_journal_projection_heads set completed_revision=$1,import_receipt=jsonb_set(import_receipt,'{version}','0') where connection_id=$2", [savedHead.completed_revision,connection]);
  assert.equal((await readCheckpoint()).rows[0].ack,null);
  await db.query('update public.tradovate_journal_projection_heads set import_receipt=$1::jsonb where connection_id=$2', [JSON.stringify(savedHead.import_receipt),connection]);
  assert.equal((await readCheckpoint()).rows[0].ack.unchanged,true);

  assert.equal(await count(), 12);
  const a = accounts[0].id;
  const before = (await db.query('select * from public.trades where account_id=$1', [a])).rows[0];
  const review = { ...before.data, notes: 'Private review', screenshots: ['my-image'], drawings: [{ id: 'mine' }] };
  await db.query('update public.trades set data=$1 where id=$2', [JSON.stringify(review), before.id]);
  const fee = events.find(row => row.entityType === 'fillfee' && row.entity.id === 10)!;
  const correction = { ...fee, id: 'a'.repeat(64), sequence: 1000, receivedAt: 4000, eventType: 'Updated', entity: { ...fee.entity, commission: 1.5 } };
  await append([correction]);
  const readsBeforeCorrection=evidenceReads;
  const corrected = await completeImport(scope);
  assert.equal(evidenceReads-readsBeforeCorrection,1);
  const after = (await db.query('select * from public.trades where id=$1', [before.id])).rows[0];
  assert.equal(Number(after.pnl), 18); assert.deepEqual(after.data, { ...review, pnl: 18 });
  const rootTrades = (await db.query('select * from public.trades')).rows.map(row => ({ ...row.data, id: row.id, accountId: row.account_id, pnl: Number(row.pnl) })) as Trade[];
  const hydrated = await hydrateOwnedJournalTrades(localApi, rootTrades, owner, owner, () => true, { detail: true });
  assert.equal(hydrated.length, 12);
  assert.equal(hydrated.find(row => row.id === before.id)?.pnl, 18);
  assert.equal(hydrated.find(row => row.id === before.id)?.executionHistory?.accountId, 1);
  const detailSelection = await readOwnedJournalDetails(localApi, hydrated.map(row => String(row.id)), owner, () => true, async rows => rows);
  assert.equal(detailSelection.length,12);
  assert.equal(detailSelection.reduce((sum,row)=>sum+row.pnl,0),19*78-1);
  const latestMember=detailSelection.find(row=>row.id===before.id)!;
  const staleMember={ ...latestMember,pnl:999,entryPrice:123,notes:'Concurrent local review' };
  const currentMember=mergeJournalDetailSelection(staleMember,[staleMember],[latestMember]).trade;
  assert.equal(currentMember.pnl,18); assert.equal(currentMember.entryPrice,latestMember.entryPrice);
  assert.equal(currentMember.notes,'Concurrent local review'); assert.deepEqual(currentMember.executionHistory,latestMember.executionHistory);
  console.log('PASS: complete owner detail reads 12 corrected SQL results, retains own execution history and preserves concurrent review.');
  const published = (await db.query('select * from public.confirmed_journal_trades where id=$1', [before.id])).rows[0];
  assert.equal(Number(published.pnl), 18); assert.equal(published.data.pnl, 18); assert.equal(published.data.notes, review.notes);
  assert.equal(published.data.executionHistory, undefined);
  await verifyJournalRootProjection(db, root, owner, other, before.id);
  await verifyJournalSharedRead(db, root, owner, other, before.id);
  // The anonymous share RPC can expose confirmed public facts, never the
  // private execution ledger or unshared notes. A nonpublic ID remains hidden.
  await db.query('update public.trades set is_public=true where id=$1', [before.id]);
  await db.query('insert into public.trade_private_notes values ($1,$2,$3)', [before.id, owner, JSON.stringify({ notes: 'Explicitly shared only', noteHistory: { private: true }, executionHistory: { private: true } })]);
  await db.exec('set role anon');
  const shared = (await db.query('select public.get_public_trade($1) as trade', [before.id])).rows[0].trade;
  assert.equal(shared.pnl, 18); assert.equal(shared.data.notes, undefined); assert.equal(shared.data.executionHistory, undefined);
  assert.equal((await db.query('select public.get_public_trade($1) as trade', [rootTrades.find(row => row.id !== before.id)!.id])).rows[0].trade, null);
  await db.exec('set role service_role');
  await db.query('update public.trades set share_notes=true where id=$1', [before.id]);
  await db.exec('set role anon');
  const withNotes = (await db.query('select public.get_public_trade($1) as trade', [before.id])).rows[0].trade;
  assert.equal(withNotes.data.notes, 'Explicitly shared only'); assert.equal(withNotes.data.noteHistory, undefined); assert.equal(withNotes.data.executionHistory, undefined);
  await db.exec('set role service_role');
  const projected = projectJournalAccounts([...events, correction], accounts);
  const positions = [...projected.ready.map(journalPositionWrite), ...projected.pending.map(journalPositionWrite)];
  const headBeforeMismatch = (await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1', [connection])).rows[0];
  for (const changed of [{ accounts: [] }, { confirmed: 999 }, { pending: 1 }, { version: 0 }, { unassigned: -1 }]) {
    await assert.rejects(persist(corrected.through,positions,owner,{ ...headBeforeMismatch.import_receipt,...changed }), /journal-import-checkpoint-mismatch/);
    assert.deepEqual((await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1', [connection])).rows[0],headBeforeMismatch);
  }
  assert.deepEqual((await persist(first.through, positions)).rows[0].ack, { accepted: false, stale: true });
  await assert.rejects(persist(corrected.through, positions, other), /invalid-journal-owner/);
  await assert.rejects(persist(null, positions), /invalid-journal-projection/);
  await assert.rejects(persist(corrected.through, [positions[0], positions[0]]), /invalid-journal-duplicate/);
  await assert.rejects(persist(corrected.through, [{ ...positions[0], journalAccountId: accounts[1].id }]), /invalid-journal-account/);
  for (const field of ['direction', 'date', 'positionSize', 'pnlEstimated']) {
    const facts = { ...positions[0].facts }; delete facts[field];
    await assert.rejects(persist(corrected.through, [{ ...positions[0], facts }]), /invalid-journal-confirmed-position/);
  }
  // Duplicate account metadata cannot silently choose a different journal row.
  const duplicate = '99999999-9999-4999-8999-999999999999';
  await db.query('insert into public.accounts values ($1,$2,$3)', [duplicate, owner, JSON.stringify({ oauth: accounts[0].oauth })]);
  await assert.rejects(persist(corrected.through, [positions[0]]), /invalid-journal-ambiguous-account/);
  await db.query('delete from public.accounts where id=$1', [duplicate]);
  // A later invalid member rolls back even the earlier numeric update.
  await assert.rejects(persist(corrected.through, [{ ...positions[0], facts: { ...positions[0].facts, pnl: 100 }, history: { ...positions[0].history, netPnl: 100 } },
    { ...positions[1], status: null }]), /invalid-journal-position/);
  assert.equal(Number((await db.query('select pnl from public.trades where id=$1', [before.id])).rows[0].pnl), 18);
  // A user deletion leaves a tombstone: automatic refresh cannot recreate it.
  await db.query('delete from public.trades where id=$1', [before.id]);
  assert.equal((await completeImport(scope)).unchanged,true); assert.equal(await count(),11);
  // Clearing an old checkpoint forces the write path too; the deletion must
  // still be preserved when the entire evidence snapshot is projected again.
  await db.query('update public.tradovate_journal_projection_heads set import_receipt=null where connection_id=$1', [connection]);
  assert.equal((await completeImport(scope)).unchanged,undefined); assert.equal(await count(),11);
  // A corrected-away episode invalidates the private projection, preserving its review.
  const retained = (await db.query('select * from public.trades where account_id=$1', [accounts[1].id])).rows[0];
  await persist(corrected.through, positions.filter(row => row.positionId !== positions[1].positionId));
  assert.equal((await readCheckpoint()).rows[0].ack,null);
  const invalidated = (await db.query('select status from public.tradovate_journal_positions where position_id=$1', [positions[1].positionId])).rows[0];
  assert.equal(invalidated.status, 'invalidated');
  assert.deepEqual((await db.query('select * from public.trades where id=$1', [retained.id])).rows[0], { ...retained, journal_projection_status: 'invalidated' });
  assert.equal((await db.query('select count(*)::int as count from public.confirmed_journal_trades')).rows[0].count, 10);
  await db.query('update public.trades set is_public=true where id=$1', [retained.id]);
  await db.exec('set role anon');
  assert.equal((await db.query('select public.get_public_trade($1) as trade', [retained.id])).rows[0].trade, null);
  await db.exec('set role service_role');
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_positions')).rows[0].count, 12);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_projection_heads')).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from public.confirmed_journal_trades')).rows[0].count, 10);
  const editable = (await db.query('select * from public.confirmed_journal_trades limit 1')).rows[0];
  const originalReviewRow = (await db.query('select * from public.trades where id=$1', [editable.id])).rows[0];
  await db.query(`update public.trades set pnl=99999,instrument='FAKE',timestamp=1,direction='Short',
    data=$2::jsonb where id=$1`, [editable.id, JSON.stringify({ notes: 'review only', pnl: 99999,
      entryPrice: 1, stopLoss: 2, copierTradeId: 'manual', source: 'manual', executionStatus: 'Missed', unknownInjected: 'no' })]);
  const protectedReviewRow = (await db.query('select * from public.trades where id=$1', [editable.id])).rows[0];
  for (const key of ['pnl','instrument','timestamp','direction','account_id','user_id']) assert.deepEqual(protectedReviewRow[key],originalReviewRow[key]);
  assert.equal(protectedReviewRow.data.notes, 'review only');
  for (const key of ['entryPrice','stopLoss','copierTradeId','source','executionStatus']) assert.deepEqual(protectedReviewRow.data[key],originalReviewRow.data[key]);
  assert.equal(protectedReviewRow.data.unknownInjected, undefined);
  await assert.rejects(db.query('select public.read_journal_import_checkpoint($1,$2)', [owner,connection]), /permission denied/);
  await assert.rejects(persist(corrected.through, positions), /permission denied/);
  await assert.rejects(db.query('update public.tradovate_journal_positions set facts=\'{}\''), /permission denied/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other]);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_positions')).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_projection_heads')).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::int as count from public.confirmed_journal_trades')).rows[0].count, 0);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.tradovate_journal_positions'), /permission denied/);
  await assert.rejects(db.query('select * from public.confirmed_journal_trades'), /permission denied/);
  // A second owner starts with an older leader, its duplicate review and an
  // estimated follower. The exact final fill/group identity adopts both UUIDs.
  await db.exec('set role service_role');
  const legacyConnection = '66666666-6666-4666-8666-666666666666';
  const legacyDevice = '77777777-7777-4777-8777-777777777777';
  const legacyFixture = journalAccountsFixture(legacyConnection, 2);
  const legacyAccounts = legacyFixture.accounts.map(a => ({ ...a, id: a.id.replace('ce4990b0', 'de4990b0') }));
  const legacyEvents = legacyFixture.events.map((e, i) => ({ ...e, id: (10_000 + i).toString(16).padStart(64, '0') }));
  for (let i = 0; i < 2; i++) legacyEvents.push({ ...legacyEvents[0], entityType: 'copylink', id: (20_000+i).toString(16).padStart(64,'0'), sequence: 100+i,
    entity: { id: `copy-${i}`, leaderConnectionId: legacyConnection, leaderAccountId: 1, leaderOrderId: '10', accountId: i+1, orderId: String((i+1)*10), role: 'entry', status: 'linked' } });
  await db.query('insert into public.tradovate_oauth_connections values ($1,$2,$3)', [legacyConnection, other, 'demo']);
  await db.query('insert into public.tradovate_copier_devices values ($1,$2,$3,$4,null)', [legacyDevice, other, legacyConnection, 'demo']);
  for (const a of legacyAccounts) await db.query('insert into public.accounts values ($1,$2,$3)', [a.id, other, JSON.stringify({ oauth: a.oauth })]);
  await db.query('insert into public.tradovate_copier_trades values ($1,$2,$3)', [other, legacyConnection, '11']);
  const legacyMaster = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const legacyDuplicate = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const legacyFollower = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const legacyInsert = async (id: string, logicalId: string, estimated: boolean, notes: string) => db.query(
    `insert into public.trades(id,user_id,account_id,instrument,pnl,direction,date,timestamp,data) values($1,$2,$3,'MNQ',999,'Long','2026-01-01',1,$4)`,
    [id, other, legacyAccounts[1].id, JSON.stringify({ copierTradeId: logicalId, source: 'copier', pnlEstimated: estimated,
      groupId: 'copier-group-11', notes, screenshots: [notes + '.png'] })]);
  await legacyInsert(legacyMaster, 'copier-11', false, 'Leader review');
  await legacyInsert(legacyDuplicate, 'copier-11', false, 'Second review kept');
  await legacyInsert(legacyFollower, 'copier-11-2', true, 'Follower review');
  await db.query('select public.append_tradovate_journal_evidence($1,$2,$3,$4::jsonb)', [other, legacyConnection, legacyDevice, JSON.stringify(legacyEvents)]);
  const legacyRevision = Number((await db.query('select max(ingest_id) as rev from public.tradovate_journal_evidence where user_id=$1', [other])).rows[0].rev);
  const legacyPositions = projectJournalAccounts(legacyEvents, legacyAccounts).ready.map(journalPositionWrite);
  assert.equal(legacyPositions.length, 2); assert.equal(legacyPositions[0].facts.isMaster, true);
  const importLegacy = () => db.query('select public.persist_tradovate_journal_positions($1,$2,$3,$4::jsonb)', [other, legacyConnection, legacyRevision, JSON.stringify([...legacyPositions].reverse())]);
  await importLegacy(); await importLegacy();
  const migrated = (await db.query('select * from public.confirmed_journal_trades where user_id=$1 order by pnl', [other])).rows;
  assert.deepEqual(migrated.map(t => t.id), [legacyMaster, legacyFollower]);
  assert.deepEqual(migrated.map(t => Number(t.pnl)), [19,38]);
  assert.equal(migrated[0].account_id, legacyAccounts[0].id);
  assert.equal(migrated[0].data.notes, 'Leader review'); assert.equal(migrated[1].data.notes, 'Follower review');
  assert.deepEqual(migrated[1].data.screenshots, ['Follower review.png']);
  const duplicateReview = (await db.query('select data from public.trades where id=$1', [legacyDuplicate])).rows[0].data;
  assert.equal(duplicateReview.journalSupersededBy, legacyMaster); assert.equal(duplicateReview.notes, 'Second review kept');
  assert.equal((await db.query('select count(*)::int as count from public.trades where user_id=$1', [other])).rows[0].count, 3);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other]);
  await db.query("update public.trades set data=data-'journalSupersededBy' where id=$1", [legacyDuplicate]);
  assert.equal((await db.query('select data from public.trades where id=$1', [legacyDuplicate])).rows[0].data.journalSupersededBy, legacyMaster);
  await db.query("update public.trades set account_id=$1,data=data-'copierTradeId'-'journalLegacyCopierTradeId' where id=$2", [legacyAccounts[1].id, legacyMaster]);
  assert.equal((await db.query('select account_id from public.trades where id=$1', [legacyMaster])).rows[0].account_id, legacyAccounts[0].id);
  await assert.rejects(legacyInsert('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'copier-11', false, 'old retry'), /journal-legacy-import-retired/);
  await db.exec('set role service_role');
  // A normal manual trade remains visible even after an owner's cutover.
  await db.query(`insert into public.trades(id,user_id,account_id,instrument,pnl,direction,date,timestamp,data) values($1,$2,$3,'MNQ',5,'Long','2026-01-01',1,'{}')`,
    ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', other, legacyAccounts[0].id]);
  assert.equal((await db.query('select count(*)::int as count from public.confirmed_journal_trades where user_id=$1', [other])).rows[0].count, 3);
  // No matching timestamp/name fallback: an absent or cross-connection ledger
  // identity refuses migration before a new position can be claimed.
  const absentHistory = structuredClone(legacyPositions[0].history);
  absentHistory.fills.find(f => f.role === 'exit')!.id = '999';
  await db.query("update public.trades set data=jsonb_set(data,'{copierTradeId}','\"copier-999\"') where id=$1", [legacyDuplicate]);
  await assert.rejects(db.query('select public.journal_legacy_identity($1,$2,$3,$4,$5)', [other,legacyConnection,JSON.stringify(absentHistory),JSON.stringify(legacyPositions[0].facts),JSON.stringify(legacyPositions)]), /journal-legacy-connection-unavailable/);
  await db.query('insert into public.tradovate_copier_trades values ($1,$2,$3)', [other, connection, '11']);
  await assert.rejects(db.query('select public.journal_legacy_identity($1,$2,$3,$4,$5)', [other,legacyConnection,JSON.stringify(legacyPositions[0].history),JSON.stringify(legacyPositions[0].facts),JSON.stringify(legacyPositions)]), /journal-legacy-reference-ambiguous/);
  console.log('PASS: exact legacy leader/follower UUID adoption, wrong-account correction, duplicate review retention, old-browser insert fencing, protected identities and ambiguous-source rejection.');
  assert.equal(writes, 6);
  console.log('PASS: unchanged import performs no evidence reads, writes or generation change; account relinking, source correction, version/incomplete-head invalidation, receipt rollback, owner isolation and deletion with forced reimport.');
  console.log('PASS: raw evidence → server projection → atomic SQL import → owner list/detail hydration and confirmed analytics view for 12 accounts; corrections, review preservation, stale revision, scope/RLS, rollback and deletion tombstone.');

  // 200 separate flat-to-flat episodes on each of 12 accounts exceed the old
  // 2,000-position write cap. Every fill/pair has its own broker identity/time.
  const largeConnection='88888888-8888-4888-8888-888888888888';
  const largeDevice='99999999-9999-4999-8999-999999999999';
  const baseLarge=journalAccountsFixture(largeConnection,12);
  const largeAccounts=baseLarge.accounts.map(a=>({ ...a,id:a.id.replace('ce4990b0','fe4990b0') }));
  const largeEvents: typeof events=[];
  const addLarge=(e: typeof events[number])=>largeEvents.push({ ...e,id:(100_000+largeEvents.length).toString(16).padStart(64,'0'),sequence:largeEvents.length+1 });
  baseLarge.events.filter(e=>['position','contract'].includes(e.entityType)).forEach(addLarge);
  for (let round=0;round<200;round++) for (const e of baseLarge.events.filter(e=>!['position','contract'].includes(e.entityType))) {
    const entity={ ...e.entity };
    for (const key of ['id','orderId','buyFillId','sellFillId']) if (typeof entity[key]==='number') entity[key]+=round*1000;
    if (typeof entity.timestamp==='string') entity.timestamp=new Date(Date.parse(entity.timestamp)+round*10_000).toISOString();
    addLarge({ ...e,entity,receivedAt:e.receivedAt+round*10_000 });
  }
  for (let accountId=1;accountId<=12;accountId++) {
    const orderId=1_000_000+accountId;
    addLarge({ ...baseLarge.events[0],entityType:'order',receivedAt:1100,
      entity:{ id:orderId,accountId,contractId:1,parentId:accountId*10,action:'Sell' } });
    for(let move=0;move<3;move++) {
      const commandId=2_000_000+accountId*10+move,at=1200+move*200;
      addLarge({ ...baseLarge.events[0],entityType:'orderversion',receivedAt:at,
        entity:{ id:commandId,orderId,orderType:'Stop',orderQty:accountId,stopPrice:20_000+move*0.25 } });
      addLarge({ ...baseLarge.events[0],entityType:'command',receivedAt:at,
        entity:{ id:commandId,orderId,commandType:move ? 'Modify' : 'New',timestamp:new Date(at).toISOString() } });
      addLarge({ ...baseLarge.events[0],entityType:'executionreport',receivedAt:at,
        entity:{ id:3_000_000+accountId*10+move,commandId,orderId,accountId,contractId:1,execType:move ? 'Replaced' : 'New',timestamp:new Date(at).toISOString() } });
    }
  }
  await db.query('insert into public.tradovate_oauth_connections values($1,$2,$3)',[largeConnection,owner,'demo']);
  await db.query('insert into public.tradovate_copier_devices values($1,$2,$3,$4,null)',[largeDevice,owner,largeConnection,'demo']);
  for (const a of largeAccounts) await db.query('insert into public.accounts values($1,$2,$3)',[a.id,owner,JSON.stringify({ oauth:a.oauth })]);
  for (let i=0;i<largeEvents.length;i+=100) await db.query('select public.append_tradovate_journal_evidence($1,$2,$3,$4::jsonb)',[owner,largeConnection,largeDevice,JSON.stringify(largeEvents.slice(i,i+100))]);
  const largeScope={ ownerId:owner,connectionId:largeConnection,environment:'demo' as const };
  const largeCount=async()=>(await db.query('select count(*)::int as count from public.confirmed_journal_trades where account_id=any($1::uuid[])',[largeAccounts.map(a=>a.id)])).rows[0].count;
  interruptStage=true;
  await assert.rejects(completeImport(largeScope),/journal-stage-write-failed/);
  assert.equal(await largeCount(),0);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_projection_heads where connection_id=$1',[largeConnection])).rows[0].count,0);
  const stagedRun=(await db.query('select * from public.tradovate_journal_import_runs where connection_id=$1',[largeConnection])).rows[0];
  const stagePublish=(user=owner)=>db.query('select public.publish_journal_position_stage($1,$2,$3) as ack',[user,largeConnection,stagedRun.id]);
  await assert.rejects(stagePublish(),/journal-stage-incomplete/);
  await assert.rejects(stagePublish(other),/journal-stage-not-found/);
  const firstChunk=(await db.query('select positions from public.tradovate_journal_import_chunks where run_id=$1 and chunk_index=0',[stagedRun.id])).rows[0].positions;
  const changedChunk=structuredClone(firstChunk); changedChunk[0].facts.pnl=999;
  await assert.rejects(db.query('select public.write_journal_position_stage($1,$2,$3,0,$4::jsonb)',[owner,largeConnection,stagedRun.id,JSON.stringify(changedChunk)]),/journal-stage-conflict/);
  await db.query("update public.accounts set meta='{}' where id=$1",[largeAccounts[0].id]);
  await assert.rejects(stagePublish(),/journal-import-checkpoint-mismatch/);
  await db.query('update public.accounts set meta=$1::jsonb where id=$2',[JSON.stringify({ oauth:largeAccounts[0].oauth }),largeAccounts[0].id]);
  stagedChunkWrites.length=0;
  const large=await completeImport(largeScope);
  assert.equal(large.confirmed,2400); assert.equal(large.pending,0); assert.equal(await largeCount(),2400);
  assert.equal(stagedChunkWrites.includes(0),false);
  assert.deepEqual(stagedChunkWrites,Array.from({ length:23 },(_,i)=>i+1));
  const headAfterLarge=(await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[largeConnection])).rows[0];
  assert.deepEqual((await stagePublish()).rows[0].ack,{ accepted:true,through:large.through,positionCount:2400 });
  assert.deepEqual((await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[largeConnection])).rows[0],headAfterLarge);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_import_chunks where run_id=$1 and positions is not null',[stagedRun.id])).rows[0].count,0);
  assert.equal((await completeImport(largeScope)).unchanged,true);
  await db.query('select public.write_journal_position_stage($1,$2,$3,0,$4::jsonb)',[owner,largeConnection,stagedRun.id,JSON.stringify(firstChunk)]);
  const totals=(await db.query('select account_id,sum(pnl)::numeric as pnl,count(*)::int as count from public.confirmed_journal_trades where account_id=any($1::uuid[]) group by account_id order by account_id',[largeAccounts.map(a=>a.id)])).rows;
  assert.deepEqual(totals.map(row=>row.count),Array(12).fill(200));
  assert.deepEqual(totals.map(row=>Number(row.pnl)),Array.from({ length:12 },(_,i)=>(i+1)*19*200));
  // Validation of the final member rolls back all earlier root/fact updates.
  const badReceipt={ ...stagedRun.import_receipt,confirmed:2,pending:0 };
  const badStart=(await db.query('select public.begin_journal_position_stage($1,$2,$3,$4,2,2,$5::jsonb) as ack',
    [owner,largeConnection,large.through,'b'.repeat(64),JSON.stringify(badReceipt)])).rows[0].ack;
  const firstChanged=structuredClone(firstChunk[0]); firstChanged.facts.pnl=999; firstChanged.history.netPnl=999;
  const secondInvalid=structuredClone(firstChunk[1]); delete secondInvalid.facts.entryPrice;
  for (const [index,value] of [firstChanged,secondInvalid].entries()) await db.query('select public.write_journal_position_stage($1,$2,$3,$4,$5::jsonb)',
    [owner,largeConnection,badStart.runId,index,JSON.stringify([value])]);
  await assert.rejects(db.query('select public.publish_journal_position_stage($1,$2,$3)',[owner,largeConnection,badStart.runId]),/invalid-journal-confirmed-position/);
  assert.deepEqual((await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[largeConnection])).rows[0],headAfterLarge);
  assert.equal(Number((await db.query('select sum(pnl) as pnl from public.confirmed_journal_trades where account_id=$1',[largeAccounts[0].id])).rows[0].pnl),3800);
  // A late fee correction goes through staging again. During interruption the
  // old complete snapshot/review remains; final publication changes only facts.
  const largeReview=(await db.query('select t.id,t.data from public.trades t join public.tradovate_journal_positions j on j.trade_id=t.id where j.connection_id=$1 order by t.timestamp limit 1',[largeConnection])).rows[0];
  await db.query("update public.trades set data=data || '{\"notes\":\"Keep large history review\"}'::jsonb where id=$1",[largeReview.id]);
  const oldLargeFee=largeEvents.find(e=>e.entityType==='fillfee' && e.entity.id===10)!;
  const lateLargeFee={ ...oldLargeFee,id:'c'.repeat(64),sequence:largeEvents.length+1,receivedAt:3_000_000,eventType:'Updated',entity:{ ...oldLargeFee.entity,commission:1.5 } };
  await db.query('select public.append_tradovate_journal_evidence($1,$2,$3,$4::jsonb)',[owner,largeConnection,largeDevice,JSON.stringify([lateLargeFee])]);
  interruptStage=true;
  await assert.rejects(completeImport(largeScope),/journal-stage-write-failed/);
  assert.equal(await largeCount(),2400);
  assert.deepEqual((await db.query('select * from public.tradovate_journal_projection_heads where connection_id=$1',[largeConnection])).rows[0],headAfterLarge);
  const largeCorrected=await completeImport(largeScope);
  assert.ok(inputContinuations>0);
  assert.equal(largeCorrected.confirmed,2400); assert.ok(largeCorrected.through>large.through);
  assert.equal(Number((await db.query('select sum(pnl) as pnl from public.confirmed_journal_trades where account_id=$1',[largeAccounts[0].id])).rows[0].pnl),3799);
  assert.equal((await db.query('select data from public.trades where id=$1',[largeReview.id])).rows[0].data.notes,'Keep large history review');
  assert.deepEqual((await stagePublish()).rows[0].ack,{ accepted:false,stale:true });
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_import_runs where id=$1',[badStart.runId])).rows[0].count,0);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const pagedLarge=await readTradeListPages(owner,async after=>(await db.query(
    'select * from public.trades where user_id=$1 and account_id=any($2::uuid[]) and ($3::uuid is null or id>$3::uuid) order by id limit 73',
    [owner,largeAccounts.map(a=>a.id),after])).rows,()=>true);
  const largeHydrated=await hydrateOwnedJournalTrades(localApi,pagedLarge.map((r:any)=>({ ...r.data,id:r.id,accountId:r.account_id,pnl:Number(r.pnl) } as Trade)),owner,owner,()=>true);
  assert.equal(largeHydrated.length,2400);
  assert.equal(largeHydrated.filter(t=>t.accountId===largeAccounts[0].id).reduce((sum,t)=>sum+t.pnl,0),3799);
  const movedStops=(await db.query("select history->'protection' as protection from public.tradovate_journal_positions where connection_id=$1 and (facts->>'entryTime')::bigint<3000",[largeConnection])).rows;
  assert.equal(movedStops.length,12);
  for(const row of movedStops) {
    assert.deepEqual(row.protection.map(p=>p.at),[1200,1400,1600]);
    assert.deepEqual(row.protection.map(p=>p.price),[20000,20000.25,20000.5]);
    assert.ok(row.protection.every(p=>p.status==='confirmed'));
  }
  await assert.rejects(db.query('select * from public.tradovate_journal_import_runs'),/permission denied/);
  await assert.rejects(db.query('select * from public.tradovate_journal_import_chunks'),/permission denied/);
  await assert.rejects(stagePublish(),/permission denied/);
  for(const table of ['tradovate_journal_input_heads','tradovate_journal_input_entities','tradovate_journal_input_retained']) {
    await assert.rejects(db.query(`select * from public.${table}`),/permission denied/);
  }
  await assert.rejects(db.query('select public.read_journal_input_batch($1,$2)',[owner,largeConnection]),/permission denied/);
  await db.exec('set role service_role');
  console.log('PASS: 2,400 projected episodes across 12 accounts; initial/correction interruptions retain the complete old snapshot; exact resume, chunk conflict, mapping/owner checks, atomic final-member rollback, late fee with preserved review, stale publication, released payload and individual PnL totals.');
  // A newly uploaded event can belong between earlier receipts. Only its
  // affected entity is replayed; newer accepted state remains authoritative.
  const inputHead=(await db.query('select * from public.tradovate_journal_input_heads where connection_id=$1',[largeConnection])).rows[0];
  const lateInsertion={...oldLargeFee,id:'d'.repeat(64),sequence:largeEvents.length+2,receivedAt:1500,eventType:'Updated',entity:{...oldLargeFee.entity,commission:0.75}};
  await db.query('select public.append_tradovate_journal_evidence($1,$2,$3,$4::jsonb)',[owner,largeConnection,largeDevice,JSON.stringify([lateInsertion])]);
  const deltaReads=evidenceReads;
  const inputResult=await prepareJournalInput(localApi,largeScope,{maxPages:1});
  assert.equal(inputResult.ready,false);
  assert.equal(evidenceReads-deltaReads,4); // one new row plus three raw versions of this fee
  const compactedFee=(await db.query("select latest from public.tradovate_journal_input_entities where connection_id=$1 and entity_key='fillfee:10'",[largeConnection])).rows[0].latest;
  assert.equal(compactedFee.entity.commission,1.5);
  await assert.rejects(db.query('select public.read_journal_input_snapshot($1,$2,$3)',[owner,largeConnection,inputHead.generation]),/journal-input-changed/);
  assert.deepEqual((await db.query('select public.commit_journal_input_batch($1,$2,$3,$4,$5,$6::jsonb) as ack',
    [owner,largeConnection,inputHead.generation,inputHead.through,inputResult.through,'[]'])).rows[0].ack,{accepted:false,stale:true});
  console.log('PASS: durable input rollback, exact cursor/CAS, owner and authenticated-role isolation, bounded continuation, one-row source correction and affected-entity-only replay with stale snapshot rejection.');
} finally { await db.close(); }
