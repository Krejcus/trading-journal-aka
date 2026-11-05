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

describe('Tradovate pozastavená noha OSO (žurnál 5. 11. 2026)', () => {
  const suspended = async (gate = true) => {
    const { wire, id } = await setup();
    wire.setHeldGate(gate);
    const raw = { ...wire.orders.get(id)!, ordStatus: 'Suspended' };
    wire.orders.set(id, raw);
    wire.props({ entityType: 'order', entity: raw });
    await expect.poll(() => latest(wire)?.status).toBe('pending');
    return { wire, id };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it('bez zapnuté brány se držený Modify neprojeví: žádná událost, stará cena', async () => {
    const { wire, id } = await suspended(false);
    const before = wire.events.length;
    wire.hold(id, { stopPrice: 28_930.5 });
    await settle();
    expect(wire.events.slice(before).filter(event => event.type === 'order')).toEqual([]);
    expect(latest(wire)).toMatchObject({ status: 'pending', stopPrice: 28_941.25 });
    wire.setModifyOutcome('held');
    await expect(wire.broker.modifyOrder(100, String(id), { quantity: 1, orderType: 'Stop', stopPrice: 28_920 })).rejects.toThrow('was not confirmed');
  });

  it('posun mimo appku (TradingView): OnHold bez ExecutionReportu změní cenu ve streamu', async () => {
    const { wire, id } = await suspended();
    wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    expect(latest(wire)).toMatchObject({ status: 'pending' });
  });

  it('Modify z appky potvrdí držený Modify jako stream-held s přesným tvarem', async () => {
    const { wire, id } = await suspended();
    wire.setModifyOutcome('held');
    await expect(wire.broker.modifyOrder(100, String(id), { quantity: 1, orderType: 'Stop', stopPrice: 28_930.5 })).resolves
      .toMatchObject({ confirmedBy: 'stream-held', order: { brokerOrderId: String(id), status: 'pending', stopPrice: 28_930.5 } });
  });

  it('CommandReport OnHold bez změny Command entity stačí stejně jako Command OnHold', async () => {
    const { wire, id } = await suspended();
    const commandId = 9_001;
    const shape = { ...[...wire.versions.values()].filter(row => row.orderId === id).at(-1)!, id: commandId, orderId: id, stopPrice: 28_925 };
    wire.versions.set(commandId, shape);
    wire.props({ entityType: 'command', entity: { id: commandId, orderId: id, commandType: 'Modify', commandStatus: 'Pending' } },
      { entityType: 'orderVersion', entity: shape }, { entityType: 'commandReport', entity: { id: 9_002, commandId, commandStatus: 'OnHold' } });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_925);
  });

  it('pracující příkaz se samotným OnHold bez ExecutionReportu cenu nezmění', async () => {
    const { wire, id } = await setup();
    wire.setHeldGate(true);
    wire.hold(id, { stopPrice: 28_930.5 });
    await settle();
    expect(latest(wire)).toMatchObject({ status: 'working', stopPrice: 28_941.25 });
  });

  it('držený Modify s jiným počtem se neprojeví (změna qty je přechod u brokera)', async () => {
    const { wire, id } = await suspended();
    wire.hold(id, { stopPrice: 28_930.5, orderQty: 3 });
    await settle();
    expect(latest(wire)).toMatchObject({ stopPrice: 28_941.25, quantity: 1 });
  });

  it('odmítnutí drženého Modify vrátí příkaz na cenu, kterou broker opravdu drží', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    wire.props({ entityType: 'commandReport', entity: { id: 9_003, commandId, commandStatus: 'ExecutionRejected', rejectReason: 'InvalidPrice' } });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_941.25);
  });

  it('ExecutionStopped u otevřené nohy vrátí cenu také', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    wire.props({ entityType: 'command', entity: { id: commandId, orderId: id, commandType: 'Modify', commandStatus: 'ExecutionStopped' } });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_941.25);
  });

  it('REST verzi povýší dřív než stream: událost přesto přijde', async () => {
    const { wire, id } = await suspended();
    const commandId = 9_030;
    const shape = { ...[...wire.versions.values()].filter(row => row.orderId === id).at(-1)!, id: commandId, orderId: id, stopPrice: 28_915 };
    const command = { id: commandId, orderId: id, commandType: 'Modify', commandStatus: 'OnHold' };
    wire.versions.set(commandId, shape);
    wire.commands.set(commandId, command);
    await wire.broker.listOrders(100, { fresh: true });
    wire.props({ entityType: 'command', entity: command });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_915);
  });

  it('opakovaný stejný OnHold nevydá další událost', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    const before = wire.events.filter(event => event.type === 'order').length;
    wire.props({ entityType: 'command', entity: { id: commandId, orderId: id, commandType: 'Modify', commandStatus: 'OnHold' } });
    await settle();
    expect(wire.events.filter(event => event.type === 'order')).toHaveLength(before);
  });

  it('ExecutionReport Rejected drženého Modify vrátí cenu', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    const raw = wire.orders.get(id)!;
    wire.props({ entityType: 'executionReport', entity: { ...raw, id: 9_040, orderId: id, commandId, execType: 'Rejected', ordStatus: 'Suspended', rejectReason: 'InvalidPrice' } });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_941.25);
  });

  it('aktivace bez potvrzení drženého Modify: příkaz nese příznak nepotvrzené ceny, potvrzení ho sundá', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    const raw = { ...wire.orders.get(id)!, ordStatus: 'Working' };
    wire.orders.set(id, raw);
    wire.props({ entityType: 'order', entity: raw });
    await expect.poll(() => latest(wire)?.status).toBe('working');
    expect(latest(wire)).toMatchObject({ heldPriceUnconfirmed: true });
    wire.props({ entityType: 'executionReport', entity: { ...raw, id: 9_050, orderId: id, commandId, execType: 'New', ordStatus: 'Working' } });
    await expect.poll(() => latest(wire)?.heldPriceUnconfirmed).toBeUndefined();
  });

  it('čtení s nerozhodnutou novější verzí není důkaz staré ceny (eventual)', async () => {
    const { wire, id } = await suspended();
    const commandId = 9_010;
    const shape = { ...[...wire.versions.values()].filter(row => row.orderId === id).at(-1)!, id: commandId, orderId: id, stopPrice: 28_920 };
    wire.versions.set(commandId, shape);
    wire.props({ entityType: 'orderVersion', entity: shape });
    await settle();
    expect((await wire.broker.findOrderById(100, String(id))).completeness).toBe('eventual');
  });

  it('po aktivaci nese stejný command ExecutionReport New: cena drží a stav je working', async () => {
    const { wire, id } = await suspended();
    const commandId = wire.hold(id, { stopPrice: 28_930.5 });
    await expect.poll(() => latest(wire)?.stopPrice).toBe(28_930.5);
    const raw = { ...wire.orders.get(id)!, ordStatus: 'Working' };
    wire.orders.set(id, raw);
    wire.props({ entityType: 'executionReport', entity: { ...raw, id: 9_020, orderId: id, commandId, execType: 'New', ordStatus: 'Working' } });
    await expect.poll(() => latest(wire)?.status).toBe('working');
    expect(latest(wire)?.stopPrice).toBe(28_930.5);
  });
});
