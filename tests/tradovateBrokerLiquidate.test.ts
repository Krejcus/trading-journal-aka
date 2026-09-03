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
    })).resolves.toEqual({ status: 'submitted', brokerOrderId: '991' });

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
    })).resolves.toEqual({ status: 'already-flat' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a successful response without orderId as submitted for state verification', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/position/list')) {
        return json([{ accountId: 200, contractId: 77, netPos: 1 }]);
      }
      if (path.endsWith('/contract/items')) return json([{ id: 77, name: 'MNQU6' }]);
      if (path.endsWith('/order/liquidateposition')) return json({ failureReason: 'Success' });
      throw new Error(`unexpected request ${path}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 200: 'FOLLOWER' },
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.liquidatePosition?.({
      tag: 'emergency-flat-200', accountId: 200, symbol: 'MNQU6',
    })).resolves.toEqual({ status: 'submitted' });
  });

  it('returns indeterminate on a transport failure after the liquidate attempt', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/position/list')) {
        return json([{ accountId: 200, contractId: 77, netPos: 1 }]);
      }
      if (path.endsWith('/contract/items')) return json([{ id: 77, name: 'MNQU6' }]);
      if (path.endsWith('/order/liquidateposition')) throw new Error('socket lost');
      throw new Error(`unexpected request ${path}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 200: 'FOLLOWER' },
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.liquidatePosition?.({
      tag: 'emergency-flat-200', accountId: 200, symbol: 'MNQU6',
    })).resolves.toMatchObject({
      status: 'indeterminate',
      reason: expect.stringContaining('phase=rest socket lost'),
    });
  });

  it('preserves an explicit HTTP rejection separately from an indeterminate transport failure', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/position/list')) {
        return json([{ accountId: 200, contractId: 77, netPos: 1 }]);
      }
      if (path.endsWith('/contract/items')) return json([{ id: 77, name: 'MNQU6' }]);
      if (path.endsWith('/order/liquidateposition')) {
        return new Response('Liquidation blocked', { status: 400 });
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
    })).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('failed (400)'),
    });
  });
});
