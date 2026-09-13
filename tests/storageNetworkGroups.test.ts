import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { groupNetworkTrades } from '../lib/networkTradeGroups';
import { completeNetworkTradeGroups } from '../services/networkTradeGroupRead';
import { readSharedTradePage } from '../services/sharedTradeRead';
import { publicTradeNotes } from '../services/tradeNotePrivacy';

const source=readFileSync(new URL('../services/storageService.ts',import.meta.url),'utf8');
const start=source.indexOf('async getNetworkActivity('), end=source.indexOf('async getLeaderboardStats(',start);
const js=ts.transpileModule(`let authStateVersion=0; const service={${source.slice(start,end)}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture() {
  const rows=Array.from({length:12},(_,i)=>({id:String(i+1),user_id:'owner',account_id:`a${i+1}`,
    instrument:'MNQ',direction:'Long',pnl:i+0.25,date:new Date(1789225200000+i*17).toISOString(),timestamp:1789225200000+i*17,
    data:{groupId:'copy-one',copierTradeId:`journal:${i}`,entryPrice:20000+i,exitPrice:20005+i,entryTime:1789225140000+i*17}}));
  const state={allowed:[] as string[], unit:'usd', revoke:false, missingCount:false, connectionReads:0, owner:'viewer'};
  const calls: Array<{table:string;filters:Record<string,unknown>;count:boolean}>=[];
  const db={async rpc(name:string,args:Record<string,any>){
    calls.push({table:`rpc:${name}`,filters:args,count:true});
    const data=(args.p_group_id?rows:rows.slice(0,2)).filter(row=>!state.allowed.length||state.allowed.includes(row.account_id));
    return {error:null,data:{count:state.missingCount?null:data.length,rows:data.map(row=>({...row,
      pnl_format:state.unit,account_name:`Jméno ${row.account_id}`,pnl:state.unit==='usd'?row.pnl:null,
      data:state.unit==='usd'?row.data:{groupId:row.data.groupId,copierTradeId:'journal:shared'}
    }))}};
  },from(table:string){const call={table,filters:{} as Record<string,unknown>,count:false};calls.push(call);return {
    select(_fields:string,options?:{count?:string}){call.count=options?.count==='exact';return this;},
    eq(key:string,value:unknown){call.filters[key]=value;return this;},in(key:string,value:unknown){call.filters[key]=value;return this;},order(){return this;},limit(){return this;},
    then(resolve:any,reject:any){let data:any[]=[];let count:number|null=null;
      if(table==='connections'){state.connectionReads++;data=state.revoke&&state.connectionReads>1?[]:[{sender_id:'viewer',receiver_id:'owner',permissions:{pnlFormat:state.unit,allowedAccountIds:state.allowed}}];}
      if(table==='profiles')data=[{id:'owner',full_name:'Trader'}];
      if(table==='accounts')data=rows.map(row=>({id:row.account_id,user_id:'owner',name:`Jméno ${row.account_id}`}));
      if(table==='confirmed_journal_trades'){
        data=call.filters['data->>groupId']?rows:rows.slice(0,2);
        if(Array.isArray(call.filters.account_id))data=data.filter(row=>(call.filters.account_id as string[]).includes(row.account_id));
        count=state.missingCount?null:data.length;
      }
      return Promise.resolve({data,count,error:null}).then(resolve,reject);
    }
  };}};
  const service=new Function('supabase','getUserId','completeNetworkTradeGroups','groupNetworkTrades','readSharedTradePage','hydrateLegacyTradeNotes','publicTradeNotes',`${js}; return service;`)(
    db,async()=>state.owner,completeNetworkTradeGroups,groupNetworkTrades,readSharedTradePage,async(_db:any,rows:any[])=>rows,publicTradeNotes);
  return {read:()=>service.getNetworkActivity(['owner']),state,calls,rows};
}
describe('storage feed uses complete explicit groups',()=>{
  it('expands two recent rows into one 12-account card with named, exact individual executions',async()=>{
    const f=fixture(); const [card]=await f.read();
    expect(card.meta.accountCount).toBe(12);
    expect(card.meta.groupPnl).toBe(69);
    expect(card.members).toHaveLength(12);
    expect(f.calls.some(c=>c.table==='confirmed_journal_trades'||c.table==='trades')).toBe(false);
    expect(card.members[10]).toMatchObject({id:'11',accountId:'a11',accountName:'Jméno a11',entryPrice:20010,exitPrice:20015,pnl:10.25,timestamp:f.rows[10].timestamp});
    expect(f.calls.some(c=>c.table==='rpc:read_shared_trades_v1'&&c.filters.p_group_id==='copy-one'&&JSON.stringify(c.filters.p_owner_ids)==='["owner"]')).toBe(true);
  });
  it('sums and counts only permitted accounts and keeps unknown R unknown',async()=>{
    const f=fixture(); f.state.allowed=['a1','a2','a11'];f.state.unit='rr';
    const [card]=await f.read();
    expect(card.meta.accountCount).toBe(3);expect(card.meta.groupPnl).toBeNull();
    expect(card.members.map((row:any)=>row.accountId)).toEqual(['a1','a2','a11']);
    expect(card.members.every((row:any)=>row.pnl===null)).toBe(true);
  });
  it('rejects revoked permissions and incomplete exact counts rather than returning a partial feed',async()=>{
    const revoked=fixture();revoked.state.revoke=true;
    await expect(revoked.read()).rejects.toThrow('network-permissions-changed');
    const capped=fixture();capped.state.missingCount=true;
    await expect(capped.read()).rejects.toThrow('shared-trades-incomplete');
  });
});
