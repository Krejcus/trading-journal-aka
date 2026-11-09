import { describe, expect, it } from 'vitest';
import { tradovateRequestContext } from '../server/tradovateRequestContext';
import type { BrokerPort } from '../services/brokerPort';
import { LIFECYCLE_READS_PER_MINUTE, withLifecycleReads } from '../services/lifecycleReadBroker';
import { createMockBroker } from '../services/mockBroker';

function probe() {
  const seen: Array<{ call: string; purpose: string | undefined }> = [];
  const raw = createMockBroker({});
  const note = (call: string) => { seen.push({ call, purpose: tradovateRequestContext.current() }); };
  const broker: BrokerPort = {
    ...raw,
    runWithLifecycleReads: tradovateRequestContext.lifecycleRead,
    listPositions: async id => { note('positions'); return raw.listPositions(id); },
    listOrders: async (id, options) => { note('orders'); return raw.listOrders(id, options); },
    findOrderById: async (id, orderId) => { note('byId'); return raw.findOrderById(id, orderId); },
    findOrdersByTag: async (id, tag) => { note('byTag'); return raw.findOrdersByTag(id, tag); },
  };
  return { broker, seen };
}

describe('lifecycle reads for accepted exposure', () => {
  it('idle controller: position/order reads keep the ordinary (background) class', async () => {
    const { broker, seen } = probe();
    const facade = withLifecycleReads(broker, () => false);
    await Promise.all([facade.listPositions(1), facade.listOrders(1), facade.findOrderById(1, '5'), facade.findOrdersByTag(1, 't')]);
    expect(seen.map(row => row.purpose)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('exposure present: the same reads run in the accepted class and the class ends with the read', async () => {
    const { broker, seen } = probe();
    const facade = withLifecycleReads(broker, () => true);
    let late: string | undefined = 'unset';
    const original = broker.listPositions;
    const inner = withLifecycleReads({ ...broker, listPositions: async id => { setTimeout(() => { late = tradovateRequestContext.current(); }, 5); return original(id); } }, () => true);
    await Promise.all([facade.listPositions(1), facade.listOrders(1, { fresh: true }), facade.findOrderById(1, '5'), facade.findOrdersByTag(1, 't')]);
    expect(seen.map(row => row.purpose)).toEqual(['management', 'management', 'management', 'management']);
    await inner.listPositions(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(late).toBeUndefined();
    expect(tradovateRequestContext.current()).toBeUndefined();
  });

  it('explicit classes are preserved: risk and recovery reads are never promoted', async () => {
    const { broker, seen } = probe();
    const facade = withLifecycleReads(broker, () => true);
    await tradovateRequestContext.risk(() => facade.listPositions(1));
    await tradovateRequestContext.recovery(() => facade.listOrders(1));
    await tradovateRequestContext.accepted(() => facade.findOrderById(1, '5'));
    expect(seen.map(row => row.purpose)).toEqual(['risk', 'control', 'management']);
  });

  it('a local cap returns excess reads to the ordinary class; the account directory read is promoted too', async () => {
    const { broker, seen } = probe();
    let now = 1_000_000;
    const purposes: Array<string | undefined> = [];
    broker.listAccountCapabilities = async () => { purposes.push(tradovateRequestContext.current()); return []; };
    const facade = withLifecycleReads(broker, () => true, () => now);
    await facade.listAccountCapabilities([1]);
    expect(purposes).toEqual(['management']);
    for (let index = 0; index < LIFECYCLE_READS_PER_MINUTE - 1; index += 1) await facade.listPositions(1);
    await facade.listPositions(1);
    expect(seen.slice(0, LIFECYCLE_READS_PER_MINUTE - 1).every(row => row.purpose === 'management')).toBe(true);
    expect(seen[LIFECYCLE_READS_PER_MINUTE - 1].purpose).toBeUndefined();
    now += 60_001;
    await facade.listPositions(1);
    expect(seen[LIFECYCLE_READS_PER_MINUTE].purpose).toBe('management');
  });

  it('a risk read started inside the expiring lease keeps its own risk class', async () => {
    let inner: string | undefined;
    await tradovateRequestContext.lifecycleRead(async () => { await tradovateRequestContext.risk(async () => { inner = tradovateRequestContext.current(); }); });
    expect(inner).toBe('risk');
    let persistent: string | undefined;
    await tradovateRequestContext.accepted(async () => { await tradovateRequestContext.risk(async () => { persistent = tradovateRequestContext.current(); }); });
    expect(persistent).toBe('management');
  });

  it('a throwing condition means not active, and a broker without the scope is returned untouched', async () => {
    const { broker, seen } = probe();
    const facade = withLifecycleReads(broker, () => { throw new Error('not ready'); });
    await facade.listPositions(1);
    expect(seen[0].purpose).toBeUndefined();
    const plain = createMockBroker({});
    expect(withLifecycleReads(plain, () => true)).toBe(plain);
  });

  it('writes and other calls are forwarded unchanged, including methods replaced after wrapping', async () => {
    const { broker } = probe();
    const facade = withLifecycleReads(broker, () => true);
    const purposes: Array<string | undefined> = [];
    const placed = await createMockBroker({}).placeOrder({ accountId: 1, tag: 'seed', symbol: 'MNQZ6', quantity: 1, side: 'Buy', orderType: 'Market' });
    broker.placeOrder = async () => { purposes.push(tradovateRequestContext.current()); return { ...placed, brokerOrderId: '77' }; };
    broker.listPositions = async () => { purposes.push(tradovateRequestContext.current()); return []; };
    await expect(facade.placeOrder({ accountId: 1, tag: 't', symbol: 'MNQZ6', quantity: 1, side: 'Buy', orderType: 'Market' })).resolves.toMatchObject({ brokerOrderId: '77' });
    await facade.listPositions(1);
    expect(purposes).toEqual([undefined, 'management']);
  });
});
