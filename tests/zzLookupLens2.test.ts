import { describe, expect, it } from 'vitest';
import { createTradovateBroker } from '../services/tradovateBroker';
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const mk = (reports: unknown[], cmds: unknown[] = [{ id: 42, orderId: 42, commandType: 'New' }, { id: 43, orderId: 42, commandType: 'Modify' }]) => createTradovateBroker({
  environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
  fetchImpl: (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const path = url.pathname.replace('/v1', '');
    if (path === '/order/item') return json({ id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
    if (path === '/orderVersion/deps') return json([
      { id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 100 },
      { id: 43, orderId: 42, orderQty: 5, orderType: 'Stop', stopPrice: 90 }]);
    if (path === '/command/deps') return json(cmds);
    if (path === '/fill/deps') return json([]);
    if (path === '/executionReport/deps') return json(Number(url.searchParams.get('masterid')) === 43 ? reports : []);
    if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
    throw new Error(path);
  }) as typeof fetch,
});
describe('lens2', () => {
  it('requested-only modify 43 is not promoted', async () => {
    const r = await mk([]).findOrderById(200, '42');
    expect(r.order).toMatchObject({ quantity: 2, stopPrice: 100 });
  });
  it('rejected modify 43 is not promoted', async () => {
    const r = await mk([{ id: 44, commandId: 43, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'Rejected' }]).findOrderById(200, '42');
    expect(r.order).toMatchObject({ quantity: 2, stopPrice: 100 });
  });
  it('replaced modify 43 is promoted even without command deps', async () => {
    const r = await mk([{ id: 44, commandId: 43, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'Replaced' }], []).findOrderById(200, '42');
    expect(r.order).toMatchObject({ quantity: 5, stopPrice: 90 });
  });
  it('older Modify report does not override fresher /order/item status', async () => {
    const b = createTradovateBroker({
      environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input)); const path = url.pathname.replace('/v1', '');
        if (path === '/order/item') return json({ id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
        if (path === '/orderVersion/deps') return json([
          { id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 100 },
          { id: 43, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 90 }]);
        if (path === '/command/deps') return json([{ id: 43, orderId: 42, commandType: 'Modify' }]);
        if (path === '/fill/deps') return json([]);
        if (path === '/executionReport/deps') return json([{ id: 44, commandId: 43, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Suspended', execType: 'Replaced' }]);
        if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
        throw new Error(path);
      }) as typeof fetch,
    });
    const r = await b.findOrderById(200, '42');
    // /order/item said Working; returned status:
    expect(r.order?.status).toBe('working');
  });
});
