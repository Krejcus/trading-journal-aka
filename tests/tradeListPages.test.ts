import { describe,expect,it,vi } from 'vitest';
import { readTradeListPages } from '../services/tradeListPages';

const rows=Array.from({ length:2400 },(_,i)=>({ id:String(i).padStart(6,'0'),user_id:'owner',pnl:i }));
describe('complete trade list pagination',()=>{
  it('loads 2400 rows through a server cap lower than the requested page size',async()=>{
    const read=vi.fn(async(after:string|null)=>rows.filter(row=>after===null || row.id>after).slice(0,73));
    expect(await readTradeListPages('owner',read,()=>true)).toEqual(rows);
    expect(read).toHaveBeenLastCalledWith('002399',250);
    expect(read).toHaveBeenCalledTimes(34);
  });
  it('discards partial prefixes after a later error or missing response',async()=>{
    const read=vi.fn().mockResolvedValueOnce(rows.slice(0,250)).mockRejectedValueOnce(new Error('offline'));
    await expect(readTradeListPages('owner',read,()=>true)).rejects.toThrow('offline');
    await expect(readTradeListPages('owner',async()=>null as never,()=>true)).rejects.toThrow('trade-list-incomplete');
  });
  it.each([
    [rows[1],rows[0]], [rows[0],rows[0]], [{ ...rows[0],user_id:'other' }], [{ ...rows[0],id:'' }],
  ].map(page=>({ page })))('rejects unordered, duplicate or foreign rows $page',async({page})=>{
    await expect(readTradeListPages('owner',async()=>page,()=>true)).rejects.toThrow('trade-list-incomplete');
  });
  it('rejects cursor regression and an owner change after a page returns',async()=>{
    const read=vi.fn().mockResolvedValueOnce(rows.slice(0,2)).mockResolvedValueOnce(rows.slice(0,2));
    await expect(readTradeListPages('owner',read,()=>true)).rejects.toThrow('trade-list-incomplete');
    const current=vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(readTradeListPages('owner',async()=>rows.slice(0,2),current)).rejects.toThrow('trade-list-session-changed');
  });
});
