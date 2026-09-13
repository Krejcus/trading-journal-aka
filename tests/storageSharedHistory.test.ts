import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readSharedTradePage, readSharedTradeHistory, sharedTradeDisplayModel } from '../services/sharedTradeRead';
import { sharedResultStats } from '../lib/sharedTradeStats';
import { publicTradeNotes } from '../services/tradeNotePrivacy';
const source=readFileSync(new URL('../services/storageService.ts',import.meta.url),'utf8');
const start=source.indexOf('async getLeaderboardStats('), end=source.indexOf('\n  },',source.indexOf('async getSpectatorData(',start))+5;
const js=ts.transpileModule(`let authStateVersion=0; const service={${source.slice(start,end)}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(count=12){
  const state={viewer:'viewer',unit:'usd',revoke:false,reads:0,failPage:false,cap:false,review:false};
  const rows=Array.from({length:count},(_,i)=>({id:String(i).padStart(5,'0'),user_id:'owner',account_id:`a${i%12}`,account_name:`Účet ${i%12+1}`,instrument:'MNQ',direction:'Long',date:'2026-09-12',timestamp:1789200000000+i*17,pnl:i-5.25,data:{copierTradeId:`journal:${i}`,groupId:'copy-one'}}));
  const calls:Array<{table:string,fields?:string,args?:any}>=[];
  const permissions=()=>({pnlFormat:state.unit,canSeeReviewStats:state.review,allowedAccountIds:[]});
  const db={async rpc(name:string,args:any){
    calls.push({table:`rpc:${name}`,args});
    if(state.failPage&&args.p_after_id) return {data:null,error:{}};
    const remaining=rows.filter(row=>!args.p_after_id||row.id>args.p_after_id);
    return {data:{count:remaining.length,rows:remaining.slice(0,state.cap?1:args.p_limit).map(row=>({...row,pnl_format:state.unit,pnl:state.unit==='usd'?row.pnl:null}))},error:null};
  },from(table:string){
    const call={table,fields:''};calls.push(call);let single=false;
    return {select(fields:string){call.fields=fields;return this;},eq(){return this;},in(){return this;},order(){return this;},limit(){return this;},maybeSingle(){single=true;return this;},then(resolve:any,reject:any){
      let data:any=[];
      if(table==='connections'){
        state.reads++;const connection={receiver_id:'owner',permissions:permissions()};
        data=state.revoke&&state.reads>1?(single?null:[]):single?connection:[connection];
      }
      if(table==='profiles')data=[{id:'owner',full_name:'Fiktivní trader'}];
      if(table==='daily_reviews')data=[{user_id:'owner',rating:4},{user_id:'owner',rating:2}];
      if(table==='trades'||table==='confirmed_journal_trades')throw new Error('raw-trades-forbidden');
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }};
  }};
  const service=new Function('supabase','getUserId','readSharedTradePage','readSharedTradeHistory','sharedTradeDisplayModel','sharedResultStats','hydrateLegacyTradeNotes','publicTradeNotes',`${js};return service;`)(db,async()=>state.viewer,readSharedTradePage,readSharedTradeHistory,sharedTradeDisplayModel,sharedResultStats,async(_db:any,data:any[])=>data,publicTradeNotes);
  Object.assign(service,{getAccounts:async()=>Array.from({length:12},(_,i)=>({id:`a${i}`,name:`Účet ${i+1}`,initialBalance:50000,status:'Active'})),getPreferences:async()=>null,getDailyPreps:async()=>[],getDailyReviews:async()=>[]});
  return {state,calls,rows,spectator:()=>service.getSpectatorData('owner'),leaderboard:()=>service.getLeaderboardStats(['owner','unrelated'])};
}
describe('spectator history uses permission-projected complete rows',()=>{
  it('loads 612 executions, 12 accounts, and preserves exact account times and results',async()=>{
    const f=fixture(612);const result=await f.spectator();
    expect(result.trades).toHaveLength(612);expect(result.accounts).toHaveLength(12);
    expect(result.trades[610]).toMatchObject({id:'00610',accountId:'a10',pnl:f.rows[610].pnl,timestamp:f.rows[610].timestamp});
    expect(f.calls.filter(c=>c.table.startsWith('rpc:'))).toHaveLength(4);
    expect(f.calls.every(c=>c.table!=='trades'&&c.table!=='confirmed_journal_trades')).toBe(true);
  });
  it('retains unknown R instead of manufacturing zero money or risk',async()=>{
    const f=fixture();f.state.unit='rr';const result=await f.spectator();
    expect(result.meta.pnlFormat).toBe('rr');expect(result.trades.every((row:any)=>Number.isNaN(row.pnl))).toBe(true);
    expect(result.accounts.every((row:any)=>Number.isNaN(row.initialBalance))).toBe(true);
  });
  it('does not return partial or revoked history',async()=>{
    const late=fixture(300);late.state.failPage=true;await expect(late.spectator()).rejects.toThrow('shared-trades-unavailable');
    const revoked=fixture();revoked.state.revoke=true;await expect(revoked.spectator()).rejects.toThrow('network-permissions-changed');
  });
});
describe('leaderboard uses a declared per-owner sample',()=>{
  it('does not rank unknown PnL and does not fetch unconsented review ratings',async()=>{
    const f=fixture();f.state.unit='hidden';const [row]=await f.leaderboard();
    expect(row).toMatchObject({id:'owner',tradeCount:12,sampleLimit:100,winRate:null,discipline:null});
    expect(f.calls.some(c=>c.table==='daily_reviews')).toBe(false);
    expect(f.calls.find(c=>c.table.startsWith('rpc:'))?.args).toMatchObject({p_owner_ids:['owner'],p_recent:true,p_limit:100});
  });
  it('fetches only the consented rating projection and rejects incomplete samples',async()=>{
    const f=fixture();f.state.review=true;const [row]=await f.leaderboard();
    expect(row.discipline).toBe(3);expect(row.winRate).toBe(50);
    expect(f.calls.find(c=>c.table==='daily_reviews')?.fields).toBe('user_id,rating:data->rating');
    const capped=fixture(150);capped.state.cap=true;await expect(capped.leaderboard()).rejects.toThrow('shared-trades-incomplete');
  });
});
