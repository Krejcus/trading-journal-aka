import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>(), tickByTick: [] as unknown[][] }));

vi.mock('@stoqey/ib', async importOriginal => {
  const actual = await importOriginal<typeof import('@stoqey/ib')>();
  class FakeIBApi {
    isConnected = false;
    on(event: string, listener: (...args: unknown[]) => void) { api.listeners.set(event, listener); return this; }
    reqTickByTickData(...args: unknown[]) { api.tickByTick.push(args); }
  }
  return { ...actual, IBApi: FakeIBApi };
});

import { EventName } from '@stoqey/ib';
import { createReadOnlyIbClient } from '../services/ibkrMarketData';

describe('klient IBKR: mapování cen', () => {
  beforeEach(() => {
    api.listeners.clear();
    api.tickByTick.length = 0;
  });

  it('pole 4 z tickPrice volá onLast, bid a ask onQuote, ostatní nic', () => {
    const onLast = vi.fn();
    const onQuote = vi.fn();
    createReadOnlyIbClient({ port: 4001, clientId: 91 }, { onLast, onQuote });
    const tickPrice = api.listeners.get(EventName.tickPrice)!;
    tickPrice(3, 4, 100.25);
    tickPrice(3, 1, 100);
    tickPrice(3, 2, 100.5);
    tickPrice(3, 6, 101);
    tickPrice(3, 4, Number.NaN);
    expect(onLast.mock.calls).toEqual([[3, 100.25]]);
    expect(onQuote.mock.calls).toEqual([[3, 'bid', 100], [3, 'ask', 100.5]]);
  });

  it('odběr obchodů žádá typ Last', () => {
    const client = createReadOnlyIbClient({ port: 4001, clientId: 91 }, {});
    client.subscribeTrades(2, { conId: 1, exchange: 'CME' });
    expect(api.tickByTick).toEqual([[2, { conId: 1, exchange: 'CME' }, 'Last', 0, false]]);
  });
});
