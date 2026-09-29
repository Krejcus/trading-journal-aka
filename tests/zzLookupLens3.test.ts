import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createTradovateBroker } from '../services/tradovateBroker';
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
describe('lens3', () => {
  it('OSO child modified while Suspended, later activated; /order/item = Working', async () => {
    const reports = [
      { id: 44, commandId: 43, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Suspended', execType: 'Replaced' },
      { id: 45, commandId: 42, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'Restated' },
    ];
    const b = createTradovateBroker({
      environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input)); const path = url.pathname.replace('/v1', '');
        const m = Number(url.searchParams.get('masterid'));
        if (path === '/order/item') return json({ id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
        if (path === '/orderVersion/deps') return json([
          { id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 100 },
          { id: 43, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 90 }]);
        if (path === '/command/deps' || path === '/command/list') return json([{ id: 42, orderId: 42, commandType: 'New' }, { id: 43, orderId: 42, commandType: 'Modify' }]);
        if (path === '/fill/deps') return json([]);
        if (path === '/executionReport/deps') return json(reports.filter(r => r.commandId === m));
        if (path === '/executionReport/list') return json(reports);
        if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
        throw new Error(path);
      }) as typeof fetch,
    });
    const r = await b.findOrderById(200, '42');
    appendFileSync(process.env.LENS_OUT ?? '/dev/null', `lens3 status=${r.order?.status} stop=${r.order?.stopPrice}\n`);
    expect(r.order).toMatchObject({ status: 'working', stopPrice: 90 });
  });
});
