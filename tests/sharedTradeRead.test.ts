import {describe,expect,it,vi} from 'vitest';
import {readSharedTradePage,readSharedTradeHistory,sharedTradeDisplayModel} from '../services/sharedTradeRead';
const row={id:'trade',user_id:'owner',account_id:'account',account_name:'Account',pnl:2,pnl_format:'usd',date:'2026-09-12',timestamp:1,data:{groupId:'group'}};
const scope={ownerIds:['owner'],groupId:'group',limit:10};
describe('permission-projected trade reader',()=>{
  it('sends scope only to the dedicated RPC and retains the server result unit',async()=>{
    const client={rpc:vi.fn(async()=>({data:{rows:[row],count:1},error:null}))};
    expect(await readSharedTradePage(client,scope,()=>true)).toEqual({data:[row],count:1,error:null});
    expect(client.rpc).toHaveBeenCalledWith('read_shared_trades_v1',{p_owner_ids:['owner'],p_group_id:'group',p_after_id:null,p_limit:10,p_recent:false});
  });
  it('fails closed when the RPC is unavailable, with no raw-table fallback',async()=>{
    const client={rpc:vi.fn(async()=>({data:null,error:{code:'PGRST202'}}))};
    await expect(readSharedTradePage(client,scope,()=>true)).rejects.toThrow('shared-trades-unavailable');
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete counts, duplicate identities, wrong scopes, invalid money and exposed hidden PnL',async()=>{
    for(const value of [{rows:[row],count:null},{rows:[row],count:0},{rows:[row,row],count:2},
      {rows:[{...row,user_id:'other'}],count:1},{rows:[{...row,data:{groupId:'wrong'}}],count:1},
      {rows:[{...row,pnl:NaN}],count:1},{rows:[{...row,pnl_format:'hidden'}],count:1}]){
      await expect(readSharedTradePage({rpc:async()=>({data:value,error:null})},scope,()=>true)).rejects.toThrow('shared-trades-incomplete');
    }
  });
  it('does not publish a response after the session changes',async()=>{
    let current=true;
    await expect(readSharedTradePage({rpc:async()=>{current=false;return {data:{rows:[row],count:1},error:null};}},scope,()=>current)).rejects.toThrow('network-session-changed');
  });
});

const historyRow=(i:number,unit:'usd'|'rr'|'hidden'='usd')=>({...row,id:String(i).padStart(5,'0'),direction:'Long' as const,instrument:'MNQ',pnl_format:unit,pnl:unit==='usd'?i:null});
describe('complete shared history',()=>{
  it('loads every page of 612 individual executions without changing their timestamps or unit',async()=>{
    const rows=Array.from({length:612},(_,i)=>({...historyRow(i),timestamp:1789200000000+i*17}));
    const client={rpc:vi.fn(async(_name:string,args:Record<string,any>)=>{
      const remaining=rows.filter(row=>!args.p_after_id||row.id>args.p_after_id);
      return {data:{rows:remaining.slice(0,args.p_limit),count:remaining.length},error:null};
    })};
    expect(await readSharedTradeHistory(client,'owner',()=>true)).toEqual(rows);
    expect(client.rpc).toHaveBeenCalledTimes(4);
  });
  it('rejects late errors, changed counts/units and a capped empty continuation',async()=>{
    for(const second of [{data:null,error:{}},{data:{rows:[],count:1},error:null},
      {data:{rows:[historyRow(2)],count:2},error:null},
      {data:{rows:[historyRow(2,'rr')],count:1},error:null}]){
      const client={rpc:vi.fn().mockResolvedValueOnce({data:{rows:[historyRow(1)],count:2},error:null}).mockResolvedValueOnce(second)};
      await expect(readSharedTradeHistory(client,'owner',()=>true)).rejects.toThrow();
    }
  });
  it('cancels a continuation after logout',async()=>{
    let current=true;
    const client={rpc:vi.fn(async()=>{current=false;return {data:{rows:[historyRow(1)],count:1},error:null};})};
    await expect(readSharedTradeHistory(client,'owner',()=>current)).rejects.toThrow('network-session-changed');
  });
  it('keeps unknown data non-finite in the transient display model and preserves known break-even',()=>{
    const unknown=sharedTradeDisplayModel({...historyRow(1,'rr'),data:{pnl:123,runUp:9,drawdown:8}});
    expect(unknown.pnl).toBeNaN();expect(unknown.runUp).toBeNaN();expect(unknown.drawdown).toBeNaN();
    expect(unknown.durationMinutes).toBeNaN();expect(unknown.duration).toBe('—');
    expect(sharedTradeDisplayModel({...historyRow(1),pnl:0}).pnl).toBe(0);
  });
});
