import { describe, expect, it } from 'vitest';
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
});
