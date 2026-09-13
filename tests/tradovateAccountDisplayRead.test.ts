import { describe, expect, it, vi } from 'vitest';
import { readTradovateAccountDisplay } from '../server/tradovateAccountDisplayRead';
const read = (fetchImpl: typeof fetch) => readTradovateAccountDisplay({baseUrl:'https://demo.tradovateapi.com/v1',accessToken:'test',accountId:10,signal:new AbortController().signal,fetchImpl});
describe('cash display adapter', () => {
  it('reads only the exact account and preserves zero without accepting arbitrary properties', async () => {
    const fetcher=vi.fn().mockImplementation(() => Promise.resolve(Response.json({totalCashValue:0,realizedPnL:0,netLiq:'10',unexpected:1})));
    expect(await read(fetcher)).toEqual({totalCashValue:0,realizedPnL:0});
    expect(fetcher).toHaveBeenCalledWith('https://demo.tradovateapi.com/v1/cashBalance/getcashbalancesnapshot',expect.objectContaining({method:'POST',body:'{"accountId":10}'}));
  });
  it('preserves Retry-After and rejects penalty responses', async () => {
    await expect(read(vi.fn().mockResolvedValue(new Response('',{status:429,headers:{'retry-after':'90'}})))).rejects.toMatchObject({status:429,retryAfterMs:90000});
    await expect(read(vi.fn().mockResolvedValue(Response.json({'p-ticket':'hidden','p-time':42})))).rejects.toMatchObject({status:429,retryAfterMs:42000});
  });
  it('rejects broker error responses even when numeric-looking fields coexist', async () => {
    await expect(read(vi.fn().mockResolvedValue(Response.json({errorText:'denied',totalCashValue:50000})))).rejects.toThrow('display-read-unavailable');
  });
  it('takes the latest explicit USD trade-date result, never the generic snapshot or another currency', async () => {
    const now = Date.UTC(2026,8,11,12);
    const rows = [
      {accountId:10,currencyId:2,tradeDate:{year:2026,month:9,day:11},timestamp:'2026-09-11T11:00:00Z',realizedPnL:0},
      {accountId:10,currencyId:3,tradeDate:{year:2026,month:9,day:11},timestamp:'2026-09-11T11:59:00Z',realizedPnL:999},
      {accountId:11,currencyId:2,tradeDate:{year:2026,month:9,day:11},timestamp:'2026-09-11T11:59:00Z',realizedPnL:888},
    ];
    const fetcher=vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes('/currency/') ? [{id:2,name:'USD',symbol:'$'},{id:3,name:'CAD',symbol:'$'}] : String(url).includes('/deps?') ? rows : {totalCashValue:51000,realizedPnL:1000}));
    const result=await readTradovateAccountDisplay({baseUrl:'https://demo.tradovateapi.com/v1',accessToken:'test',accountId:10,signal:new AbortController().signal,fetchImpl:fetcher,now});
    expect(result).toMatchObject({totalCashValue:51000,realizedPnL:1000,dailyRealizedPnL:0});
    rows[0].tradeDate.day=10;
    expect((await readTradovateAccountDisplay({baseUrl:'https://demo.tradovateapi.com/v1',accessToken:'test',accountId:10,signal:new AbortController().signal,fetchImpl:fetcher,now})).dailyRealizedPnL).toBeUndefined();
  });

});
