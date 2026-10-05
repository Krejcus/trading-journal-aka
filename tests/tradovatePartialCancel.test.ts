import { afterEach, describe, expect, it } from 'vitest';
import { createTradovateWireHarness } from './helpers/tradovateWireHarness';

// Incident 5. 10. 2026: leader zrušil zbytek vstupu 18 po vyplnění 6. Tradovate
// to hlásí jako ordStatus Filled + execType Completed (cumQty 6). Copier to
// bral jako plné vyplnění a zbytek followerům nezrušil.

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const setup = async () => {
  const wire = createTradovateWireHarness();
  stops.push(wire.stop);
  wire.sync();
  await expect.poll(() => wire.events.some(event => event.type === 'connection' && event.connected)).toBe(true);
  const id = wire.place({ accountId: 100, action: 'Buy', orderType: 'Limit', price: 31_241.5, orderQty: 18 });
  await expect.poll(() => latest(wire, id)?.status).toBe('working');
  return { wire, id };
};
const latest = (wire: ReturnType<typeof createTradovateWireHarness>, id: number) => wire.events
  .flatMap(event => (event.type === 'order' && event.order.brokerOrderId === String(id) ? [event.order] : []))
  .at(-1);

describe('Tradovate zrušený zbytek částečně vyplněné objednávky', () => {
  it('Cancel + Completed + cumQty 6/18 je zrušení zbytku, ne plné vyplnění', async () => {
    const { wire, id } = await setup();
    wire.fill(id, 6, 31_241.5);
    await expect.poll(() => latest(wire, id)?.filledQuantity).toBe(6);
    expect(wire.cancelLikeTradovate(id)).toBe(true);
    await expect.poll(() => latest(wire, id)?.status).toBe('canceled');
    expect(latest(wire, id)).toMatchObject({ quantity: 18, filledQuantity: 6, status: 'canceled' });
  });

  it('copier cancel followera s částečným plněním se potvrdí jako zrušení', async () => {
    const { wire, id } = await setup();
    wire.fill(id, 6, 31_241.5);
    await expect.poll(() => latest(wire, id)?.filledQuantity).toBe(6);
    wire.setPartialCancelAsFilled(true);
    await expect(wire.broker.cancelOrder(100, String(id))).resolves.toBeUndefined();
    expect(latest(wire, id)).toMatchObject({ status: 'canceled', filledQuantity: 6 });
    expect(wire.requests.filter(request => request.path === '/order/cancelorder')).toHaveLength(1);
  });

  it('plné vyplnění zůstává filled', async () => {
    const { wire, id } = await setup();
    wire.fill(id, 18, 31_241.5);
    await expect.poll(() => latest(wire, id)?.status).toBe('filled');
    expect(latest(wire, id)).toMatchObject({ quantity: 18, filledQuantity: 18 });
  });

  it('Filled s menším plněním bez Cancel commandu se nepřepisuje na zrušení', async () => {
    const { wire, id } = await setup();
    wire.fill(id, 6, 31_241.5);
    await expect.poll(() => latest(wire, id)?.filledQuantity).toBe(6);
    const raw = { ...wire.orders.get(id)!, ordStatus: 'Filled' };
    wire.orders.set(id, raw);
    wire.props({ entityType: 'order', entity: raw }, { entityType: 'executionReport', entity: {
      id: 90_001, orderId: id, accountId: 100, contractId: 7, execType: 'Trade', ordStatus: 'Filled', action: 'Buy', cumQty: 6,
    } });
    await expect.poll(() => latest(wire, id)?.status).toBe('filled');
  });

  it('Completed report patřící jinému commandu než Cancel nic nemění', async () => {
    const { wire, id } = await setup();
    wire.fill(id, 6, 31_241.5);
    await expect.poll(() => latest(wire, id)?.filledQuantity).toBe(6);
    wire.commands.set(80_000, { id: 80_000, orderId: id, commandType: 'New' });
    const raw = { ...wire.orders.get(id)!, ordStatus: 'Filled' };
    wire.orders.set(id, raw);
    wire.props({ entityType: 'command', entity: wire.commands.get(80_000)! }, { entityType: 'order', entity: raw },
      { entityType: 'executionReport', entity: {
        id: 90_002, commandId: 80_000, orderId: id, accountId: 100, contractId: 7, execType: 'Completed', ordStatus: 'Filled', action: 'Buy', cumQty: 6,
      } });
    await expect.poll(() => latest(wire, id)?.status).toBe('filled');
  });
});
