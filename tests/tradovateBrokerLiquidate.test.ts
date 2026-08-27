import { describe, expect, it, vi } from 'vitest';
import { createTradovateBroker } from '../services/tradovateBroker';

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate native emergency liquidation', () => {
  it('resolves contractId from a fresh broker position and calls liquidatePosition', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, init });
      if (path.endsWith('/position/list')) {
        return json([{ accountId: 200, contractId: 77, netPos: -11 }]);
      }
      if (path.endsWith('/contract/items')) {
        return json([{ id: 77, name: 'MNQU6' }]);
      }
      if (path.endsWith('/order/liquidateposition')) {
        return json({ orderId: 991 });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 200: 'FOLLOWER' },
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.liquidatePosition?.({
      tag: 'emergency-flat-200', accountId: 200, symbol: 'MNQU6',
    })).resolves.toEqual({ brokerOrderId: '991', accepted: true, definitive: true });

    const request = calls.find(call => call.path.endsWith('/order/liquidateposition'));
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      accountId: 200, contractId: 77, admin: false, isAutomated: true,
    });
  });

  it('is a safe no-op when the fresh broker snapshot is already flat', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/position/list')) return json([]);
      throw new Error(`unexpected request ${path}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 200: 'FOLLOWER' },
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.liquidatePosition?.({
      tag: 'emergency-flat-200', accountId: 200, symbol: 'MNQU6',
    })).resolves.toMatchObject({ accepted: true, definitive: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
