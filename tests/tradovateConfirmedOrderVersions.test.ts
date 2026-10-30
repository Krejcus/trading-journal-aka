import { afterEach, describe, expect, it } from 'vitest';
import { createTradovateWireHarness } from './helpers/tradovateWireHarness';

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const setup = async () => {
  const wire = createTradovateWireHarness();
  stops.push(wire.stop);
  wire.sync();
  await expect.poll(() => wire.events.some(event => event.type === 'connection' && event.connected)).toBe(true);
  const id = wire.place({ accountId: 100, action: 'Buy', orderType: 'Stop', stopPrice: 28_941.25 });
  await expect.poll(() => latest(wire)?.stopPrice).toBe(28_941.25);
  return { wire, id };
};
const latest = (wire: ReturnType<typeof createTradovateWireHarness>) => wire.events
  .filter(event => event.type === 'order').at(-1)?.order;

describe('Tradovate confirmed execution versions', () => {
  it.each(['version-first', 'report-first'] as const)('copies confirmed SL replacement with %s delivery', async order => {
    const { wire, id } = await setup();
    wire.replace(id, { stopPrice: 28_930.50 }, order);
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.50);
    expect(wire.events.filter(event => event.type === 'error')).toEqual([]);
  });

  it('does not promote requested, rejected or unrelated co-batched versions, including REST refresh', async () => {
    const { wire, id } = await setup();
    const requested = { id: 50_000, orderId: id, orderType: 'Stop', orderQty: 1, stopPrice: 999 };
    wire.versions.set(requested.id, requested);
    wire.commands.set(requested.id, { id: requested.id, orderId: id, commandType: 'Modify' });
    wire.props({ entityType: 'orderVersion', entity: requested }, { entityType: 'order', entity: wire.orders.get(id)! });
    await wire.drain();
    expect(latest(wire)?.stopPrice).toBe(28_941.25);
    expect((await wire.broker.findOrderById(100, String(id))).order?.stopPrice).toBe(28_941.25);
    wire.props({ entityType: 'command', entity: wire.commands.get(requested.id)! },
      { entityType: 'commandReport', entity: { id: 50_001, commandId: requested.id, commandStatus: 'ExecutionRejected', ordStatus: 'Rejected' } });
    await wire.drain();
    expect(latest(wire)).toMatchObject({ stopPrice: 28_941.25, status: 'working' });
  });

  it('accepts a version arriving after its confirmation and an empty REST dependency read', async () => {
    const { wire, id } = await setup();
    wire.props({ entityType: 'executionReport', entity: { ...wire.orders.get(id)!, id: 50_001, orderId: id,
      commandId: 50_000, execType: 'Replaced' } });
    await wire.drain();
    expect(latest(wire)?.stopPrice).toBe(28_941.25);
    await expect(wire.broker.listOrders(100)).rejects.toThrow('Missing confirmed OrderVersion');
    wire.props({ entityType: 'orderVersion', entity: { id: 50_000, orderId: id, orderType: 'Stop', orderQty: 1, stopPrice: 28_930.5 } });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
  });

  it('keeps the newest confirmed SL during rapid changes, duplicates and late old reports', async () => {
    const { wire, id } = await setup();
    wire.replace(id, { stopPrice: 28_935 });
    wire.replace(id, { stopPrice: 28_932 });
    wire.replace(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    for (const report of [...wire.reports.values()].reverse()) wire.props({ entityType: 'executionReport', entity: report });
    await wire.drain();
    expect(latest(wire)?.stopPrice).toBe(28_930.5);
    expect((await wire.broker.listOrders(100))[0].stopPrice).toBe(28_930.5);
  });

  it('accepts a delayed Replaced after a newer terminal report without resurrecting the order', async () => {
    const { wire, id } = await setup();
    wire.props({ entityType: 'executionReport', entity: { ...wire.orders.get(id)!, id: 50_002, orderId: id,
      commandId: 50_000, execType: 'Trade', ordStatus: 'Filled' } });
    await expect.poll(() => latest(wire)?.status).toBe('filled');
    wire.props({ entityType: 'orderVersion', entity: { id: 50_000, orderId: id, orderType: 'Stop', orderQty: 1, stopPrice: 28_930.5 } },
      { entityType: 'executionReport', entity: { ...wire.orders.get(id)!, id: 50_001, orderId: id, commandId: 50_000, execType: 'Replaced' } });
    await expect.poll(() => latest(wire)).toMatchObject({ stopPrice: 28_930.5, status: 'filled' });
  });

  it('preserves OSO/OCO lineage on sparse execution reports and ignores late Working after fill', async () => {
    const { wire, id } = await setup();
    wire.props({ entityType: 'order', entity: { ...wire.orders.get(id)!, parentId: 800, ocoId: 900, linkedId: 901 } });
    wire.replace(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    expect(latest(wire)).toMatchObject({ parentOrderId: '800', ocoId: '900', linkedOrderId: '901' });
    wire.fill(id);
    await expect.poll(() => latest(wire)?.status).toBe('filled');
    wire.props({ entityType: 'order', entity: { ...wire.orders.get(id)!, ordStatus: 'Working' } });
    await wire.drain();
    expect(latest(wire)?.status).toBe('filled');
  });

  it('refreshes a missed confirmed replacement from REST while excluding a newer pending request', async () => {
    const { wire, id } = await setup();
    wire.versions.set(40_000, { id: 40_000, orderId: id, orderType: 'Stop', orderQty: 1, stopPrice: 28_930.5 });
    wire.versions.set(50_000, { id: 50_000, orderId: id, orderType: 'Stop', orderQty: 1, stopPrice: 999 });
    wire.reports.set(40_001, { ...wire.orders.get(id)!, id: 40_001, orderId: id, commandId: 40_000, execType: 'Replaced' });
    expect((await wire.broker.findOrderById(100, String(id))).order?.stopPrice).toBe(28_930.5);
  });

  it('does not mistake a modify rejection for cancellation of the existing working stop', async () => {
    const { wire, id } = await setup();
    wire.props({ entityType: 'executionReport', entity: { ...wire.orders.get(id)!, id: 50_001, orderId: id,
      commandId: 50_000, execType: 'Rejected', ordStatus: 'Working', text: 'Invalid price' } });
    await wire.drain();
    expect(latest(wire)).toMatchObject({ stopPrice: 28_941.25, status: 'working' });
  });

  it('confirms a follower modify only after the exact command is accepted', async () => {
    const { wire, id } = await setup();
    // Potvrzení nese Replaced přesně tohoto commandu + příkaz v odeslaném tvaru (zrychlení 30. 10.).
    await expect(wire.broker.modifyOrder(100, String(id), { quantity: 1, orderType: 'Stop', stopPrice: 28_930.5 })).resolves
      .toMatchObject({ confirmedBy: 'stream-replaced', order: { brokerOrderId: String(id), accountId: 100, status: 'working', stopPrice: 28_930.5 } });
    expect(wire.requests.filter(request => request.path === '/order/modifyorder')).toHaveLength(1);
    expect(latest(wire)?.stopPrice).toBe(28_930.5);
  });

  it.each(['ack-only', 'rejected'] as const)('does not confirm a %s modify even when the requested price equals the previous price', async outcome => {
    const { wire, id } = await setup();
    wire.setModifyOutcome(outcome);
    await expect(wire.broker.modifyOrder(100, String(id), { quantity: 1, orderType: 'Stop', stopPrice: 28_941.25 }))
      .rejects.toThrow(outcome === 'rejected' ? 'InvalidPrice' : 'was not confirmed');
    expect((await wire.broker.findOrderById(100, String(id))).order).toMatchObject({ status: 'working', stopPrice: 28_941.25 });
    expect(wire.requests.filter(request => request.path === '/order/modifyorder')).toHaveLength(1);
  });
});

describe('Tradovate snímek příkazů ze streamu (zrychlení posunu 30. 10.)', () => {
  it('dohnaný stream: příkazy jen daného účtu, beze změny stavu adaptéru a bez REST', async () => {
    const { wire, id } = await setup();
    const other = wire.place({ accountId: 200, action: 'Sell', orderType: 'Limit', price: 29_100 });
    await expect.poll(() => latest(wire)?.brokerOrderId).toBe(String(other));
    const events = wire.events.length;
    const requests = wire.requests.length;
    const snapshot = wire.broker.streamOrderSnapshot!(100);
    expect(snapshot?.orders.map(order => order.brokerOrderId)).toEqual([String(id)]);
    expect(snapshot?.orders[0]).toMatchObject({ accountId: 100, status: 'working', stopPrice: 28_941.25 });
    expect(wire.events.length).toBe(events);
    expect(wire.requests.length).toBe(requests);
  });

  it('rozpracovaný rámec nebo ticho socketu = null (předčtení jde přes REST)', async () => {
    const { wire, id } = await setup();
    expect(wire.broker.streamOrderSnapshot!(100)).not.toBeNull();
    // Rámec přijatý, ještě nezpracovaný ve frontě adaptéru.
    wire.props({ entityType: 'order', entity: wire.orders.get(id)! });
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).not.toBeNull();
    // Socket dlouho mlčí (zombie po spánku Macu).
    wire.advance(5_000);
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
    wire.socket.onmessage?.({ data: 'h' });
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).not.toBeNull();
  });

  it('aktivní příkaz bez potvrzené verze = null, ne vynechání', async () => {
    const { wire, id } = await setup();
    // Replaced dorazil dřív než jeho OrderVersion: potvrzená verze je novější než známá.
    const commandId = 60_000;
    wire.commands.set(commandId, { id: commandId, orderId: id, commandType: 'Modify' });
    wire.props({ entityType: 'command', entity: wire.commands.get(commandId)! },
      { entityType: 'executionReport', entity: { ...wire.orders.get(id)!, id: 60_001, orderId: id, commandId, execType: 'Replaced' } });
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
  });

  it('rate limit breaker (REST 429) = null', async () => {
    const { wire } = await setup();
    wire.setRestHook(path => (path === '/order/list' ? new Response('', { status: 429 }) : null));
    await expect(wire.broker.listOrders(100, { fresh: true })).rejects.toThrow();
    wire.setRestHook(null);
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
  });

  it.each([
    ['listOrders(fresh)', '/order/list', (wire: ReturnType<typeof createTradovateWireHarness>, _id: number) => wire.broker.listOrders(100, { fresh: true })],
    ['findOrderById', '/order/item', (wire: ReturnType<typeof createTradovateWireHarness>, id: number) => wire.broker.findOrderById(100, String(id))],
    ['findModifiedOrderById', '/order/item', (wire: ReturnType<typeof createTradovateWireHarness>, id: number) => wire.broker.findModifiedOrderById!(100, String(id), { quantity: 1, orderType: 'Stop', stopPrice: 1 }).catch(() => null)],
  ] as const)('běžící REST merge (%s) = null, po dokončení zase snímek', async (_name, path, read) => {
    const { wire, id } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    wire.setRestHook(async requested => { if (requested === path) await gate; return null; });
    const pending = read(wire, id);
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
    release();
    await pending;
    wire.setRestHook(null);
    expect(wire.broker.streamOrderSnapshot!(100)).not.toBeNull();
  });

  it('command report před svým commandem (čeká v pendingCommandReports) = null', async () => {
    const { wire } = await setup();
    wire.props({ entityType: 'commandReport', entity: { id: 70_001, commandId: 70_000, commandStatus: 'AtExecution', ordStatus: 'Working' } });
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
  });

  it('zavřený socket (bez syncu) = null', async () => {
    const { wire } = await setup();
    wire.socket.onclose?.({ code: 1006, reason: 'test' } as never);
    await wire.drain();
    expect(wire.broker.streamOrderSnapshot!(100)).toBeNull();
  });
});
