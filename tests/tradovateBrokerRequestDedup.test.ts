import { describe, expect, it } from 'vitest';
import { tradovateRequestContext } from '../server/tradovateRequestContext';
import { createTradovateBroker } from '../services/tradovateBroker';

/**
 * Reconciliation/flatten volají list metody per účet, ale Tradovate vrací
 * seznamy globálně. Souběžná volání musí sdílet jeden REST dotaz — jinak
 * ARM pro N účtů dělá N× tytéž fetche a throttling je natahuje na sekundy.
 */

const harness = () => {
  const hits = new Map<string, number>();
  const broker = createTradovateBroker({
    environment: 'demo',
    accessToken: 'token',
    accountSpecsByAccountId: { 100: 'L', 200: 'F1', 300: 'F2' },
    fetchImpl: (async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [],
        text: async () => '[]',
      };
    }) as unknown as typeof fetch,
    webSocketFactory: () => {
      throw new Error('test nepoužívá WebSocket');
    },
  });
  return { broker, hits };
};

describe('in-flight dedup globálních čtení', () => {
  it('souběžné listPositions pro N účtů = jeden /position/list', async () => {
    const { broker, hits } = harness();
    await Promise.all([100, 200, 300].map(accountId => broker.listPositions(accountId)));
    expect(hits.get('/v1/position/list') ?? hits.get('/position/list')).toBe(1);
  });

  it('souběžné listOrders pro N účtů = jeden order graph', async () => {
    const { broker, hits } = harness();
    await Promise.all([100, 200, 300].map(accountId => broker.listOrders(accountId)));
    const orderListHits = [...hits.entries()]
      .filter(([path]) => path.endsWith('/order/list'))
      .reduce((total, [, count]) => total + count, 0);
    expect(orderListHits).toBe(1);
  });

  it('sekvenční volání dedup nesdílí — data zůstávají čerstvá', async () => {
    const { broker, hits } = harness();
    await broker.listPositions(100);
    await broker.listPositions(200);
    const positionHits = [...hits.entries()]
      .filter(([path]) => path.endsWith('/position/list'))
      .reduce((total, [, count]) => total + count, 0);
    expect(positionHits).toBe(2);
  });
  it.each(['positions','orders','accounts','risk'] as const)('accepted %s read never joins a held background read',async kind=>{
    let release!:()=>void;let first=true;const held=new Promise<void>(r=>{release=r;});const hits:string[]=[];
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestPurpose:tradovateRequestContext.current,
      fetchImpl:async input=>{const path=new URL(String(input)).pathname;hits.push(path);
        if(first){first=false;await held;}
        const rows=path.endsWith('/currency/list')?[{id:1,name:'USD'}]:path.endsWith('/cashBalance/list')?[{accountId:101,currencyId:1,amount:50000}]:[];
        return Response.json(rows);}});
    const read=():Promise<unknown>=>kind==='positions'?broker.listPositions(101):kind==='orders'?broker.listOrders(101,{fresh:true}):kind==='accounts'?broker.refreshAccountDirectory():broker.listAccountRiskSnapshots([101]);
    const background=read();await Promise.resolve();await Promise.resolve();
    let completed=false;const urgent=tradovateRequestContext.accepted(read).then(()=>{completed=true;});
    for(let i=0;i<100;i++)await Promise.resolve();expect(completed).toBe(true);expect(hits.length).toBeGreaterThan(1);
    release();await Promise.all([background,urgent]);
  });

});
