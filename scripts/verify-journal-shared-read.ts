import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readSharedTradePage } from '../services/sharedTradeRead';

/** Real SQL under simulated database roles; no remote schema/data writes. */
export async function verifyJournalSharedRead(db: {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>;
}, root: string, owner: string, viewer: string, tradeId: string) {
  await db.exec('begin');
  try {
    await db.exec(`reset role;
      alter table public.accounts add column name text;
      create table public.connections(id uuid primary key, sender_id uuid, receiver_id uuid, status text, permissions jsonb);
      alter table public.connections enable row level security;
      grant usage on schema auth to anon;
      grant select on public.connections, public.trades to anon,authenticated;
      create policy connection_parties on public.connections for select to authenticated
        using(sender_id=(select auth.uid()) or receiver_id=(select auth.uid()));
      -- Matches the production catalog inspected read-only on 2026-09-12.
      create policy "Trades visibility" on public.trades for select using (
        (select auth.uid())=user_id or is_public=true or exists(select 1 from public.connections c
          where c.status='accepted' and ((c.sender_id=(select auth.uid()) and c.receiver_id=trades.user_id)
            or (c.receiver_id=(select auth.uid()) and c.sender_id=trades.user_id))));`);
    const before=(await db.query('select * from public.trades where id=$1',[tradeId])).rows[0];
    const connection='99999999-9999-4999-8999-999999999999';
    const permissions=async(value:unknown)=>{
      await db.exec('reset role');
      await db.query('update public.connections set permissions=$2::jsonb where id=$1',[connection,JSON.stringify(value)]);
      await db.exec('set role authenticated');
    };
    const asViewer=async()=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);};
    const read=async(ids=[owner],group:string|null=null,after:string|null=null,limit=250,recent=false)=>(await db.query(
      'select public.read_shared_trades_v1($1::uuid[],$2,$3::uuid,$4,$5) as result',[`{${ids.join(',')}}`,group,after,limit,recent])).rows[0].result;
    const reject=async(action:()=>Promise<unknown>,pattern:RegExp)=>{
      await db.exec('savepoint rejection');
      try {await assert.rejects(action,pattern);} finally {await db.exec('rollback to rejection; release rejection');}
    };
    await db.query("insert into public.connections values($1,$2,$3,'accepted',$4::jsonb)",[connection,viewer,owner,JSON.stringify({pnlFormat:'usd'})]);
    await db.query('update public.accounts set name=$2 where id=$1',[before.account_id,'Allowed account']);
    await db.query(`update public.trades set is_public=true,data=data || $2::jsonb where id=$1`,[tradeId,JSON.stringify({
      screenshot:'https://example.invalid/public-image',screenshots:['https://example.invalid/second-image',{private:'nested-media-canary'}],
      notes:'private-note-canary',custom:{pnl:999,raw:'private-evidence-canary'},runUp:999,drawdown:100,
    })]);
    await asViewer();
    assert.equal((await db.query('select count(*)::int n from public.trades where id=$1',[tradeId])).rows[0].n,1);
    await db.exec('reset role');
    await db.exec(await readFile(resolve(root,'supabase/migrations/20260912193935_journal_shared_read_boundary.sql'),'utf8'));
    await asViewer();
    assert.equal((await db.query('select count(*)::int n from public.trades where id=$1',[tradeId])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from public.confirmed_journal_trades where id=$1',[tradeId])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from public.tradovate_journal_positions')).rows[0].n,0);
    await permissions({pnlFormat:'usd',allowedAccountIds:[before.account_id]});
    const usd=await read(); const shared=usd.rows.find((row:any)=>row.id===tradeId);
    const wire=await readSharedTradePage({rpc:async(name,args)=>{
      assert.equal(name,'read_shared_trades_v1');
      const result=await read(args.p_owner_ids as string[],args.p_group_id as string|null,args.p_after_id as string|null,args.p_limit as number,args.p_recent as boolean);
      return {data:result,error:null};
    }},{ownerIds:[owner]},()=>true);
    assert.deepEqual(wire.data,usd.rows);assert.equal(wire.count,usd.count);
    assert.ok(shared);assert.equal(shared.pnl,18);assert.equal(shared.account_name,'Allowed account');
    assert.equal(shared.pnl_format,'usd');assert.equal(shared.data.copierTradeId,'journal:shared');
    assert.equal(shared.data.entryPrice,before.data.entryPrice);
    assert.ok(usd.rows.every((row:any)=>row.account_id===before.account_id));
    for(const canary of ['private-note-canary','private-evidence-canary','nested-media-canary','public-image','second-image']) assert.ok(!JSON.stringify(usd).includes(canary));
    await permissions({pnlFormat:'hidden',allowedAccountIds:[before.account_id]});
    const hidden=(await read()).rows.find((row:any)=>row.id===tradeId);
    assert.equal(hidden.pnl,null);assert.equal(hidden.data.riskAmount,undefined);
    for(const key of ['entryPrice','exitPrice','positionSize','stopLoss','takeProfit','runUp','drawdown','notes','executionHistory','data']) assert.equal(hidden.data[key],undefined);
    await permissions({pnlFormat:'rr',allowedAccountIds:[before.account_id],canSeeScreenshots:true});
    const rr=(await read()).rows.find((row:any)=>row.id===tradeId);
    assert.equal(rr.pnl,null);assert.equal(rr.data.entryPrice,undefined);assert.equal(rr.data.riskAmount,undefined);
    assert.equal(rr.data.screenshot,'https://example.invalid/public-image');assert.deepEqual(rr.data.screenshots,['https://example.invalid/second-image']);
    // Known manual risk is converted exactly once; raw dollar fields do not survive.
    const manualId='88888888-8888-4888-8888-888888888888';
    await db.exec('reset role');
    await db.query(`insert into public.trades(id,user_id,account_id,instrument,pnl,direction,date,timestamp,data)
      values($1,$2,$3,'MNQ',-3,'Long','2026-09-10',2,'{"riskAmount":2,"pnl":-3,"entryPrice":20000,"positionSize":10}')`,[manualId,owner,before.account_id]);
    await asViewer();
    const manual=(await read()).rows.find((row:any)=>row.id===manualId);
    assert.equal(manual.pnl,-1.5);assert.deepEqual(manual.data,{riskAmount:1,screenshots:[]});
    // Stable UUID pages retain exact remaining count rather than row-cap guesses.
    const first=await read([owner],null,null,1);assert.equal(first.rows.length,1);assert.ok(first.count>=2);
    const next=await read([owner],null,first.rows[0].id,1);assert.ok(next.rows[0].id>first.rows[0].id);assert.equal(next.count,first.count-1);
    for (const status of ['pending','invalidated','confirmed']) {
      await db.exec('reset role');
      await db.query('update public.tradovate_journal_positions set status=$2 where trade_id=$1',[tradeId,status]);
      await asViewer();
      assert.equal((await read()).rows.some((row:any)=>row.id===tradeId),status==='confirmed');
    }
    await permissions({pnlFormat:'usd',allowedAccountIds:['00000000-0000-4000-8000-000000000000']});
    assert.equal((await read()).rows.length,0);
    await permissions({pnlFormat:'usd',allowedAccountIds:{bad:true}});
    assert.equal((await read()).rows.length,0);
    await permissions({pnlFormat:'usd'});
    await db.exec('reset role');
    await db.query("update public.connections set sender_id=$2,receiver_id=$3 where id=$1",[connection,owner,viewer]);
    await asViewer();assert.equal((await read()).rows.length,0);
    await db.exec('reset role');
    await db.query("update public.connections set status='accepted',sender_id=$2,receiver_id=$3 where id=$1",[connection,viewer,owner]);
    await db.query("insert into public.connections values('77777777-7777-4777-8777-777777777777',$1,$2,'accepted','{}')",[viewer,owner]);
    await asViewer();assert.equal((await read()).rows.length,0);
    await db.exec('reset role');
    await db.exec("delete from public.connections where id='77777777-7777-4777-8777-777777777777'");
    await asViewer();assert.ok((await read()).rows.length>0);
    await db.exec('reset role');
    await db.query("update public.connections set sender_id=$2,receiver_id=$3,status='rejected' where id=$1",[connection,viewer,owner]);
    await asViewer();assert.equal((await read()).rows.length,0);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    assert.ok((await read()).rows.some((row:any)=>row.id===tradeId));
    assert.equal((await db.query('select count(*)::int n from public.trades where id=$1',[tradeId])).rows[0].n,1);
    await reject(()=>read([],null,null,1),/invalid-shared-trade-scope/);
    await reject(()=>read([owner],null,null,1001),/invalid-shared-trade-scope/);
    await reject(()=>read([owner],null,tradeId,1,true),/invalid-shared-trade-scope/);
    await db.exec('set role anon');await db.query("select set_config('request.jwt.claim.sub','',false)");
    assert.equal((await db.query('select count(*)::int n from public.trades where id=$1',[tradeId])).rows[0].n,0);
    await reject(()=>read(),/permission denied/);
    const publicLink=(await db.query('select public.get_public_trade($1) as row',[tradeId])).rows[0].row;
    assert.equal(publicLink.id,tradeId);assert.equal(publicLink.data.executionHistory,undefined);
    await db.exec('set role authenticated');
    await reject(()=>read(),/authentication-required/);
    await db.exec('reset role');
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.trades'::regclass")).rows[0].relrowsecurity,true);
    const functions=(await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='read_shared_trades_v1' order by n.nspname")).rows;
    assert.deepEqual(functions.map((row:any)=>[row.nspname,row.prosecdef]),[['journal_private',true],['public',false]]);
    assert.ok(functions.every((row:any)=>row.proconfig.includes('search_path=""')));
    console.log('PASS: shared SQL DTO enforces direction/account/unit/media permission, exact pagination, no raw journal reads, no private canaries, manual R conversion, revocation, owner/public-link continuity and denied anonymous/invalid scopes.');
  } finally {await db.exec('rollback');}
}
