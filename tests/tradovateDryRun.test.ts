import { describe, expect, it, vi } from 'vitest';
import { dryRunTradovateOrder } from '../services/tradovateDryRun';
import { TradovateRateLimitError, TradovateTransportError } from '../services/tradovateBroker';

const order = {
  tag: 'at-dry-test',
  accountId: 123,
  symbol: 'MNQU6',
  side: 'Buy' as const,
  quantity: 1,
  orderType: 'Limit' as const,
  limitPrice: 10_000,
};

describe('Tradovate dry-run', () => {
  it('resolves the contract and sends the documented dry-run envelope', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 78910, name: 'MNQU6' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rejectReason: 'Success', errorText: '' }), { status: 200 }));
    const result = await dryRunTradovateOrder({
      environment: 'demo', accessToken: 'secret', order, fetchImpl,
    });

    expect(result.accepted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://demo.tradovateapi.com/v1/contract/find?name=MNQU6');
    const [url, init] = fetchImpl.mock.calls[1] as Parameters<typeof fetch>;
    expect(url).toBe('https://demo.tradovateapi.com/v1/order/dryrun');
    expect(fetchImpl.mock.calls.flatMap(call => String(call[0]))).not.toContain('placeorder');
    expect(JSON.parse(String(init?.body))).toEqual({
      accountId: 123,
      orders: [expect.objectContaining({
        contractId: 78910,
        action: 'Buy',
        orderQty: 1,
        isAutomated: true,
      })],
    });
  });

  it('returns a business rejection without treating it as accepted', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 78910, name: 'MNQU6' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rejectReason: 'MaxPosLimitReached', comment: 'Risk limit',
      }), { status: 200 }));
    const result = await dryRunTradovateOrder({
      environment: 'demo', accessToken: 'secret', order, fetchImpl,
    });

    expect(result).toMatchObject({ accepted: false, rejectReason: 'Risk limit' });
  });

  it('fails closed on penalty tickets and live environment', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 78910, name: 'MNQU6' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'p-ticket': 'wait', 'p-time': 2,
      }), { status: 200 }));
    await expect(dryRunTradovateOrder({
      environment: 'demo', accessToken: 'secret', order, fetchImpl,
    })).rejects.toBeInstanceOf(TradovateRateLimitError);
    await expect(dryRunTradovateOrder({
      environment: 'live', accessToken: 'secret', order, fetchImpl,
    })).rejects.toBeInstanceOf(TradovateTransportError);
  });

  it('fails closed when the exact symbol cannot be resolved to a contract ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(null), { status: 200 }));
    await expect(dryRunTradovateOrder({
      environment: 'demo', accessToken: 'secret', order, fetchImpl,
    })).rejects.toThrow('Tradovate nenalezlo kontrakt MNQU6');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
