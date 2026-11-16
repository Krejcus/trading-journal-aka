import { describe, expect, it } from 'vitest';
import { decodeRithmicFrames, encodeRithmicFrame } from '../services/rithmic/rithmicCodec';
import { RithmicClient, type RithmicOrderUpdate } from '../services/rithmic/rithmicClient';
import { RithmicRequestError, type RithmicCloseInfo } from '../services/rithmic/rithmicPlant';
import { createFakeRithmicServer, flush } from './_fakeRithmicServer';

const credentials = { user: 'u', password: 'secret', systemName: 'Rithmic Test', appName: 'AlphaTrade', appVersion: '0.1' };

function setup(options: Parameters<typeof createFakeRithmicServer>[0] = {}, requestTimeoutMs = 200) {
  const server = createFakeRithmicServer(options);
  const updates: RithmicOrderUpdate[] = [];
  const closed: Array<{ plant: string; info: RithmicCloseInfo }> = [];
  const unknown: number[] = [];
  const client = new RithmicClient({
    url: 'wss://fake',
    credentials,
    socketFactory: server.socketFactory,
    requestTimeoutMs,
    events: {
      onOrderUpdate: (u) => updates.push(u),
      onPlantClosed: (plant, info) => closed.push({ plant, info }),
      onUnknownTemplate: (_plant, id) => unknown.push(id),
    },
  });
  return { server, client, updates, closed, unknown };
}

const limit = (userTag: string) => ({
  accountId: 'ACC1', userTag, symbol: 'ESZ6', exchange: 'CME', side: 'BUY' as const, quantity: 1, priceType: 'LIMIT' as const, price: 7000,
});

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof RithmicRequestError ? error.outcome : `other:${String(error)}`;
  }
}

describe('rithmicCodec', () => {
  it('zakóduje a dekóduje rámec, i víc rámců v jedné zprávě', () => {
    const a = encodeRithmicFrame(18, { user_msg: ['x'] });
    const b = encodeRithmicFrame(312, { user_tag: 't', quantity: 2, price: 7000.25 });
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    const decoded = decodeRithmicFrames(joined);
    expect(decoded.map((m) => m.name)).toEqual(['RequestHeartbeat', 'RequestNewOrder']);
    expect(decoded[1].fields).toMatchObject({ user_tag: 't', quantity: 2, price: 7000.25 });
  });

  it('neznámou šablonu vrátí bez názvu a nespadne', () => {
    // pole template_id (154467, varint) = 358
    const body = [0x98, 0xb6, 0x4b, 0xe6, 0x02];
    const frame = new Uint8Array([0, 0, 0, body.length, ...body]);
    expect(decodeRithmicFrames(frame)).toEqual([{ templateId: 358, name: null, fields: {} }]);
  });

  it('odmítne poškozený rámec a pole, které zpráva nemá', () => {
    expect(() => decodeRithmicFrames(new Uint8Array([0, 0, 0, 9, 1]))).toThrow(/Poškozený/);
    expect(() => encodeRithmicFrame(312, { neexistuje: 1 })).toThrow(/nemá pole/);
  });
});

describe('RithmicClient', () => {
  it('přihlásí order plant a načte identitu, účty a trade route', async () => {
    const { server, client } = setup({ accounts: ['ACC1', 'ACC2'] });
    await client.connect(['order']);
    expect(client.isConnected('order')).toBe(true);
    expect(client.accounts.map((a) => a.accountId)).toEqual(['ACC1', 'ACC2']);
    expect(client.userType).toBe(3);
    // odběr změn příkazů i bracketů pro každý účet
    expect(server.received.filter((r) => r.templateId === 308).length).toBe(2);
    expect(server.received.filter((r) => r.templateId === 336).length).toBe(2);
  });

  it('špatné heslo = odmítnuto a spojení zavřené', async () => {
    const server = createFakeRithmicServer({ password: 'jine' });
    const client = new RithmicClient({ url: 'wss://fake', credentials, socketFactory: server.socketFactory });
    expect(await outcomeOf(client.connect(['order']))).toBe('rejected');
    expect(client.isConnected('order')).toBe(false);
    expect(server.sockets.every((s) => s.readyState === 3)).toBe(true);
  });

  it('vloží Limit, vrátí basket_id a doručí stavy z Rithmicu i z burzy', async () => {
    const { server, client, updates } = setup();
    await client.connect(['order']);
    const ack = await client.placeOrder(limit('tag-1'));
    await flush();
    expect(server.orders.get(ack.basketId)?.price).toBe(7000);
    expect(updates.map((u) => `${u.source}:${u.notifyType}`)).toEqual(['rithmic:OPEN', 'exchange:STATUS']);
    expect(updates[1]).toMatchObject({ userTag: 'tag-1', basketId: ack.basketId, side: 'BUY', priceType: 'LIMIT', price: 7000 });
    expect(updates[1].gatewayAt).toBe(1_800_000_000_000);
  });

  it('odmítnutí serverem je "rejected" a příkaz nevznikne', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    server.controls.rejectNextOrder = 'price out of range';
    const error = await client.placeOrder(limit('tag-r')).catch((e) => e as RithmicRequestError);
    expect(error).toBeInstanceOf(RithmicRequestError);
    expect((error as RithmicRequestError).outcome).toBe('rejected');
    expect((error as RithmicRequestError).rpCode).toEqual(['6', 'price out of range']);
    expect(server.orders.size).toBe(0);
  });

  it('pád spojení po odeslání = "unknown", žádné opakování, příkaz jde dohledat podle značky', async () => {
    const { server, client, closed } = setup();
    await client.connect(['order']);
    server.controls.dropNextOrderBeforeAck = true;
    expect(await outcomeOf(client.placeOrder(limit('tag-lost')))).toBe('unknown');
    await flush();
    expect(server.newOrderFrames()).toBe(1);
    expect(closed).toEqual([{ plant: 'order', info: { code: 1006, reason: 'dropped', intentional: false, forcedLogout: false } }]);
    expect(client.isConnected('order')).toBe(false);
    // server příkaz přijal; po novém připojení ho najdeme podle user_tag
    await client.connect(['order']);
    const found = (await client.showOrders('ACC1')).filter((o) => o.userTag === 'tag-lost');
    expect(found).toHaveLength(1);
    expect(found[0].isSnapshot).toBe(true);
    expect(server.newOrderFrames()).toBe(1);
  });

  it('timeout bez odpovědi = "unknown" a žádné opakování', async () => {
    const { server, client } = setup({}, 30);
    await client.connect(['order']);
    server.controls.ignoreNextOrder = true;
    expect(await outcomeOf(client.placeOrder(limit('tag-t')))).toBe('unknown');
    expect(server.newOrderFrames()).toBe(1);
  });

  it('bez spojení nebo s neplatným příkazem = "not-sent" a nic neodejde', async () => {
    const { server, client } = setup();
    expect(await outcomeOf(client.placeOrder(limit('x')))).toBe('not-sent');
    await client.connect(['order']);
    expect(await outcomeOf(client.placeOrder({ ...limit('x'), quantity: 0 }))).toBe('not-sent');
    expect(await outcomeOf(client.placeOrder({ ...limit('x'), price: undefined }))).toBe('not-sent');
    expect(await outcomeOf(client.placeOrder({ ...limit(''), }))).toBe('not-sent');
    expect(await outcomeOf(client.placeOrder({ ...limit('x'), exchange: 'EUREX' }))).toBe('not-sent');
    expect(await outcomeOf(client.placeBracketOrder({ ...limit('x') }))).toBe('not-sent');
    expect(await outcomeOf(client.placeBracketOrder({ ...limit('x'), stopTicks: 0 }))).toBe('not-sent');
    expect(server.newOrderFrames()).toBe(0);
  });

  it('bracket: nohy vzniknou až po vyplnění vstupu a odkazují na něj', async () => {
    const { server, client, updates } = setup();
    await client.connect(['order']);
    const ack = await client.placeBracketOrder({ ...limit('tag-b'), stopTicks: 40, targetTicks: 80 });
    await flush();
    const sent = server.received.find((r) => r.templateId === 330)!.fields;
    expect(sent).toMatchObject({ bracket_type: 6, stop_ticks: 40, stop_quantity: 1, target_ticks: 80, target_quantity: 1, user_type: 3 });
    expect(server.orders.size).toBe(1);
    server.fill(ack.basketId, 7000);
    await flush();
    const legs = updates.filter((u) => u.source === 'exchange' && u.originalBasketId === ack.basketId);
    expect(legs.map((l) => `${l.side}:${l.priceType}`).sort()).toEqual(['SELL:LIMIT', 'SELL:STOP_MARKET']);
    expect(legs.find((l) => l.priceType === 'STOP_MARKET')?.triggerPrice).toBe(6990);
    expect(legs.find((l) => l.priceType === 'LIMIT')?.price).toBe(7020);
    expect(updates.some((u) => u.notifyType === 'FILL' && u.fillPrice === 7000 && u.basketId === ack.basketId)).toBe(true);
  });

  it('posun a zrušení projdou; druhé zrušení server odmítne', async () => {
    const { server, client, updates } = setup();
    await client.connect(['order']);
    const ack = await client.placeOrder(limit('tag-m'));
    await client.modifyOrder({ accountId: 'ACC1', basketId: ack.basketId, symbol: 'ESZ6', exchange: 'CME', quantity: 1, priceType: 'LIMIT', price: 6999.75 });
    await client.cancelOrder('ACC1', ack.basketId);
    await flush();
    expect(server.orders.get(ack.basketId)).toMatchObject({ price: 6999.75, status: 'cancelled' });
    expect(updates.filter((u) => u.source === 'exchange').map((u) => u.notifyType)).toEqual(['STATUS', 'MODIFY', 'CANCEL']);
    expect(await outcomeOf(client.cancelOrder('ACC1', ack.basketId))).toBe('rejected');
  });

  it('snímek příkazů se nepošle jako živá událost', async () => {
    const { client, updates } = setup();
    await client.connect(['order']);
    await client.placeOrder(limit('tag-s'));
    await flush();
    const before = updates.length;
    const snapshot = await client.showOrders('ACC1');
    await flush();
    expect(snapshot.map((o) => o.userTag)).toEqual(['tag-s']);
    expect(updates.length).toBe(before);
    expect(await client.showOrders('JINY')).toEqual([]);
  });

  it('historie obsahuje i dokončené příkazy, které snímek pracujících už nevrací', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    const ack = await client.placeOrder({ ...limit('tag-f'), priceType: 'MARKET', price: undefined });
    server.fill(ack.basketId, 7001);
    await flush();
    expect(await client.showOrders('ACC1')).toEqual([]);
    const history = await client.showOrderHistorySummary('ACC1', '20261116');
    expect(history.map((o) => o.userTag)).toEqual(['tag-f']);
  });

  it('vynucené odhlášení zavře plant s příznakem forcedLogout', async () => {
    const { server, client, closed } = setup();
    await client.connect(['order']);
    server.forceLogout();
    await flush();
    expect(closed.map((c) => c.info.forcedLogout)).toEqual([true]);
    expect(client.isConnected('order')).toBe(false);
  });

  it('"žádná data" (rp_code 7) je prázdná odpověď, ne chyba', async () => {
    const { server, client } = setup();
    await client.connect(['ticker']);
    expect(await client.frontMonthContract('ES', 'CME')).toBe('ESZ6');
    server.controls.frontMonth = null;
    expect(await client.frontMonthContract('ES', 'CME')).toBeNull();
  });

  it('close() ukončí čekající požadavky jako "unknown" a ohlásí úmyslné zavření', async () => {
    const { server, client, closed } = setup({}, 5_000);
    await client.connect(['order']);
    server.controls.ignoreNextOrder = true;
    const pending = outcomeOf(client.placeOrder(limit('tag-c')));
    await flush();
    client.close();
    expect(await pending).toBe('unknown');
    expect(closed.map((c) => c.info.intentional)).toEqual([true]);
  });
});
