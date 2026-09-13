import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { groupNetworkTrades, type NetworkTradeActivity, type NetworkTradeMember } from '../lib/networkTradeGroups';
import { completeNetworkTradeGroups, type NetworkTradeRow } from '../services/networkTradeGroupRead';
import NetworkTradeAccountSelect, { networkTradeTime } from '../components/NetworkTradeAccountSelect';

const member = (id: number, changes: Partial<NetworkTradeMember> = {}): NetworkTradeMember => ({
  id: String(id), user_id: 'owner', accountId: `account-${id}`, accountName: `Účet ${id}`, groupId: 'copy-one',
  instrument: 'MNQ', direction: 'Long', pnl: id - 4.52, entryPrice: 20000 + id, exitPrice: 20005 + id,
  entryTime: 1789225200100 + id * 17, timestamp: 1789225260200 + id * 23,
  date: new Date(1789225260200 + id * 23).toISOString(), signal: '', duration: '1m', durationMinutes: 1,
  runUp: 0, drawdown: 0, ...changes,
});
const activity = (data: NetworkTradeMember, unit: 'usd' | 'rr' | 'hidden' = 'usd'): NetworkTradeActivity => ({
  type: 'trade', id: data.id, date: data.date, data, meta: { pnlFormat: unit },
});
const row = (id: number): NetworkTradeRow => ({id: String(id), user_id: 'owner', account_id: `account-${id}`, data: {groupId: 'copy-one'}});

describe('explicit shared trade groups', () => {
  it('preserves 12 member executions and sums their actual results, without mutating them', () => {
    const source = Array.from({length: 12}, (_, index) => activity(member(index + 1)));
    const before = JSON.stringify(source);
    const grouped = groupNetworkTrades(source);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].meta.accountCount).toBe(12);
    expect(grouped[0].meta.groupPnl).toBeCloseTo(23.76);
    expect(grouped[0].members?.[10]).toEqual(source[10].data);
    expect(grouped[0].data.pnl).toBe(-3.5199999999999996);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('does not merge same-day manual trades or unrelated explicit groups/users/units', () => {
    const same = member(1);
    const source = [activity({...same,groupId:undefined}), activity({...same,id:'2',groupId:undefined}),
      activity({...same,id:'3',groupId:'other'}), activity({...same,id:'4'}),
      activity({...same,id:'5',user_id:'other'}), activity({...same,id:'6'},'rr')];
    expect(groupNetworkTrades(source)).toHaveLength(6);
  });
  it('counts distinct allowed accounts, de-duplicates repeated rows, and retains unknown totals', () => {
    const first = activity(member(1));
    const group = groupNetworkTrades([first, first, activity(member(2, {accountId:first.data.accountId})), activity(member(3, {pnl:null}))])[0];
    expect(group.meta.accountCount).toBe(2);
    expect(group.members).toHaveLength(3);
    expect(group.meta.groupPnl).toBeNull();
    expect(groupNetworkTrades([activity(member(1),'hidden')])[0].meta.groupPnl).toBeNull();
  });
  it('selects only an explicitly marked master as representative and keeps both account times', () => {
    const first=member(1), second=member(2,{isMaster:true});
    const group=groupNetworkTrades([activity(first),activity(second)])[0];
    expect(group.data).toEqual(second);
    expect(group.members?.map(row=>row.entryTime)).toEqual([first.entryTime,second.entryTime]);
  });
  it('renders a compact selector for all 12 accounts, per-account money and millisecond times', () => {
    const members=Array.from({length:12},(_,i)=>member(i+1));
    const html=renderToStaticMarkup(React.createElement(NetworkTradeAccountSelect,{members,selectedId:'11',unit:'usd',isDark:false,onSelect:()=>{}}));
    expect(html.match(/<option /g)).toHaveLength(12);
    expect(html).toContain('value="11" selected=""');
    expect(html).toContain('12 účtů');
    expect(html).toContain(networkTradeTime(members[10].timestamp));
    expect(html).toContain('Účet 11');
    expect(networkTradeTime(undefined)).toBe('—');
    const unknown=renderToStaticMarkup(React.createElement(NetworkTradeAccountSelect,{members:members.map(row=>({...row,pnl:null})),selectedId:'11',unit:'rr',isDark:true,onSelect:()=>{}}));
    expect(unknown).not.toContain('0R');
    expect(unknown).not.toContain('$');
  });
});

describe('complete recent copy groups', () => {
  it('expands a recent fragment to the exact 12-account response and replaces stale initial rows', async () => {
    const all=Array.from({length:12},(_,i)=>row(i+1));
    const read=vi.fn(async()=>({data:all,count:12}));
    expect(await completeNetworkTradeGroups(all.slice(0,2),read,()=>true)).toEqual(all);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('owner','copy-one');
  });
  it('never converts a capped, duplicate, wrong-owner or missing response into a smaller count', async () => {
    for (const result of [{data:[row(1)],count:12}, {data:null,count:0}, {data:[row(1)],count:null},
      {data:[row(1),row(1)],count:2}, {data:[{...row(1),user_id:'wrong'}],count:1},
      {data:[{...row(1),data:{groupId:'wrong'}}],count:1}, {data:[],count:0,error:new Error('offline')}]) {
      await expect(completeNetworkTradeGroups([row(1)],async()=>result,()=>true)).rejects.toThrow('network-copy-group-incomplete');
    }
  });
  it('drops a removed group rather than keeping the initial stale fragment', async () => {
    expect(await completeNetworkTradeGroups([row(1)],async()=>({data:[],count:0}),()=>true)).toEqual([]);
  });
  it('rejects a session change during the read', async () => {
    let current=true;
    await expect(completeNetworkTradeGroups([row(1)],async()=>{current=false;return {data:[row(1)],count:1};},()=>current)).rejects.toThrow('network-session-changed');
  });
});
