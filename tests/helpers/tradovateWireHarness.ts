import { createTradovateBroker, type WebSocketLike } from '../../services/tradovateBroker';
import type { BrokerEvent } from '../../services/brokerPort';

type Row = Record<string, unknown> & { id: number };

/** In-memory HTTP/WebSocket boundary: uses the production Tradovate adapter.
 * No network fallback and no real credentials. IDs match Tradovate's command /
 * OrderVersion identity, unlike the old hand-mapped BrokerOrder fixtures. */
export const createTradovateWireHarness = (accountIds = [100, 200]) => {
  let nextId = 1_000;
  let timeOffset = 0;
  const clock = () => Date.now() + timeOffset;
  const advance = (ms: number) => { timeOffset += ms; };
  const orders = new Map<number, Row>();
  const versions = new Map<number, Row>();
  const commands = new Map<number, Row>();
  const reports = new Map<number, Row>();
  const fills = new Map<number, Row>();
  const positions = new Map<number, number>();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let modifyOutcome: 'confirmed' | 'ack-only' | 'rejected' = 'confirmed';
  const setModifyOutcome = (value: typeof modifyOutcome) => { modifyOutcome = value; };
  const events: BrokerEvent[] = [];
  const socket: WebSocketLike = {
    readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
    send() {}, close() {},
  };
  const props = (...items: { entityType: string; entity: Record<string, unknown> }[]) => {
    socket.onmessage?.({ data: `a${JSON.stringify([{ e: 'props', d: items }])}` });
  };
  const position = (accountId: number, netPos: number) => {
    positions.set(accountId, netPos);
    props({ entityType: 'position', entity: { accountId, contractId: 7, netPos } });
  };
  const fill = (orderId: number, qty?: number, price = 29_000) => {
    const raw = orders.get(orderId)!;
    const shape = [...versions.values()].filter(row => row.orderId === orderId).at(-1)!;
    const quantity = qty ?? Number(shape.orderQty);
    const prior = [...fills.values()].filter(row => row.orderId === orderId).reduce((sum, row) => sum + Number(row.qty), 0);
    const updated = { ...raw, ordStatus: prior + quantity >= Number(shape.orderQty) ? 'Filled' : 'Working' };
    orders.set(orderId, updated);
    const entity = { id: nextId++, orderId, contractId: 7, accountId: raw.accountId,
      action: raw.action, qty: quantity, price, timestamp: new Date(clock()).toISOString() };
    fills.set(entity.id, entity);
    props({ entityType: 'fill', entity }, { entityType: 'order', entity: updated });
    position(Number(raw.accountId), (positions.get(Number(raw.accountId)) ?? 0) + (raw.action === 'Buy' ? quantity : -quantity));
  };
  const place = (body: Record<string, unknown>, executeMarket = true) => {
    const id = nextId++;
    const raw = { id, accountId: Number(body.accountId), contractId: 7, action: body.action ?? 'Buy', ordStatus: 'Working' };
    const shape = { id, orderId: id, orderQty: body.orderQty ?? 1, orderType: body.orderType ?? 'Market',
      ...(body.price != null ? { price: body.price } : {}), ...(body.stopPrice != null ? { stopPrice: body.stopPrice } : {}) };
    const command = { id, orderId: id, commandType: 'New', clOrdId: body.clOrdId ?? body.customTag50 ?? '' };
    orders.set(id, raw); versions.set(id, shape); commands.set(id, command);
    props({ entityType: 'command', entity: command }, { entityType: 'orderVersion', entity: shape }, { entityType: 'order', entity: raw });
    if (shape.orderType === 'Market' && executeMarket) fill(id);
    return id;
  };
  const replace = (orderId: number, changes: Record<string, unknown>, order: 'version-first' | 'report-first' = 'version-first') => {
    const commandId = nextId++;
    const shape = { ...[...versions.values()].filter(row => row.orderId === orderId).at(-1)!, ...changes, id: commandId, orderId };
    const command = { id: commandId, orderId, commandType: 'Modify' };
    const report = { ...orders.get(orderId)!, id: nextId++, orderId, commandId, execType: 'Replaced', timestamp: new Date(clock()).toISOString() };
    versions.set(commandId, shape); commands.set(commandId, command); reports.set(report.id, report);
    const versionItem = { entityType: 'orderVersion', entity: shape };
    const reportItem = { entityType: 'executionReport', entity: report };
    props({ entityType: 'command', entity: command }, ...(order === 'version-first' ? [versionItem, reportItem] : [reportItem, versionItem]));
    return commandId;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v1', '');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      if (path === '/order/placeorder') return Response.json({ orderId: place(body) });
      if (path === '/order/modifyorder') {
        if (modifyOutcome === 'confirmed') return Response.json({ commandId: replace(body.orderId, body), failureReason: 'Success' });
        const commandId = nextId++;
        const command = { id: commandId, orderId: body.orderId, commandType: 'Modify' };
        const shape = { ...body, id: commandId };
        commands.set(commandId, command); versions.set(commandId, shape);
        props({ entityType: 'command', entity: command }, { entityType: 'orderVersion', entity: shape });
        if (modifyOutcome === 'rejected') props({ entityType: 'commandReport', entity: {
          id: nextId++, commandId, commandStatus: 'ExecutionRejected', ordStatus: 'Rejected', text: 'InvalidPrice',
        } });
        return Response.json({ commandId, failureReason: 'Success' });
      }
      if (path === '/order/cancelorder') {
        const commandId = nextId++;
        const raw = { ...orders.get(body.orderId)!, ordStatus: 'Canceled' };
        orders.set(body.orderId, raw);
        props({ entityType: 'order', entity: raw });
        return Response.json({ commandId, failureReason: 'Success' });
      }
      if (path === '/order/liquidateposition') {
        const net = positions.get(body.accountId) ?? 0;
        return Response.json(net === 0 ? {} : { orderId: place({ accountId: body.accountId, action: net > 0 ? 'Sell' : 'Buy', orderQty: Math.abs(net), orderType: 'Market' }) });
      }
      throw new Error(`Unexpected offline POST ${path}`);
    }
    if (path === '/account/list') return Response.json(accountIds.map(id => ({ id, name: `DEMO-${id}`, active: true })));
    if (path === '/position/list') return Response.json([...positions].filter(([, net]) => net !== 0).map(([accountId, netPos]) => ({ accountId, contractId: 7, netPos })));
    if (path === '/contract/items') return Response.json([{ id: 7, name: 'MNQU6' }]);
    if (path === '/order/item') return Response.json(orders.get(Number(url.searchParams.get('id'))) ?? null);
    const collection = path.startsWith('/orderVersion/') ? versions : path.startsWith('/executionReport/') ? reports
      : path.startsWith('/command/') ? commands : path.startsWith('/fill/') ? fills : path.startsWith('/order/') ? orders : null;
    if (collection) return Response.json([...collection.values()].filter(row => !url.searchParams.has('masterid')
      || row.orderId === Number(url.searchParams.get('masterid'))));
    if (['/cashBalance/deps', '/accountRiskStatus/deps', '/userAccountAutoLiq/deps', '/commandReport/deps'].includes(path)) return Response.json([]);
    throw new Error(`Unexpected offline GET ${path}`);
  };
  const broker = createTradovateBroker({ environment: 'demo', accessToken: 'offline-fixture',
    accountSpecsByAccountId: Object.fromEntries(accountIds.map(id => [id, `DEMO-${id}`])),
    fetchImpl, clock, webSocketFactory: () => socket, commandConfirmationTimeoutMs: 100 });
  const stop = broker.subscribe(event => events.push(event));
  const sync = () => socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
  const drain = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  return { broker, socket, events, orders, versions, commands, reports, fills, positions, requests, props, place, fill, replace, position, sync, drain, stop, clock, advance, setModifyOutcome };
};
