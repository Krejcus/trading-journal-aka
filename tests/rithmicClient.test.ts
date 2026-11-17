import { describe, expect, it, vi } from 'vitest';
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

  it('posun a zrušení projdou; odpověď na druhé zrušení nic nedokazuje', async () => {
    const { server, client, updates } = setup();
    await client.connect(['order']);
    const ack = await client.placeOrder(limit('tag-m'));
    await client.modifyOrder({ accountId: 'ACC1', basketId: ack.basketId, symbol: 'ESZ6', exchange: 'CME', quantity: 1, priceType: 'LIMIT', price: 6999.75 });
    await client.cancelOrder('ACC1', ack.basketId);
    await flush();
    expect(server.orders.get(ack.basketId)).toMatchObject({ price: 6999.75, status: 'cancelled' });
    expect(updates.filter((u) => u.source === 'exchange').map((u) => u.notifyType)).toEqual(['STATUS', 'MODIFY', 'CANCEL']);
    // změřené chování: zrušení už zrušeného nebo neexistujícího příkazu vrátí „ok" — nic nedokazuje
    expect(await outcomeOf(client.cancelOrder('ACC1', ack.basketId))).toBe('resolved');
    server.controls.cancelUnknownOk = false;
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
    expect(await outcomeOf(client.showOrders('JINY'))).toBe('not-sent');
  });

  it('snímek vrací pracující i dnešní dokončené příkazy; odmítnutý na RMS jen jako záznam Rithmicu', async () => {
    const { server, client, updates } = setup();
    await client.connect(['order']);
    const filled = await client.placeOrder({ ...limit('tag-f'), priceType: 'MARKET', price: undefined });
    server.fill(filled.basketId, 7001);
    const cancelled = await client.placeOrder(limit('tag-c'));
    await client.cancelOrder('ACC1', cancelled.basketId);
    server.controls.rmsRejectNextOrder = 'Rejected at RMS - limit';
    const rejected = await client.placeOrder({ ...limit('tag-rms'), quantity: 500 });
    await client.placeOrder(limit('tag-open'));
    await flush();
    // odmítnutí RMS: odpověď je „přijato" a živě přijde jen záznam Rithmicu s důvodem FA
    const rms = updates.filter((u) => u.basketId === rejected.basketId);
    expect(rms.map((u) => `${u.source}:${u.notifyType}:${u.completionReason}`)).toEqual(['rithmic:ORDER_RCVD_FROM_CLNT:', 'rithmic:COMPLETE:FA']);
    const snapshot = await client.showOrders('ACC1');
    const byTag = Object.fromEntries(snapshot.map((o) => [o.userTag, `${o.source}:${o.status}:${o.notifyType}:${o.completionReason}`]));
    expect(byTag).toEqual({
      'tag-f': 'exchange:complete:FILL:',
      'tag-c': 'exchange:complete:CANCEL:',
      'tag-rms': 'rithmic:complete:COMPLETE:FA',
      'tag-open': 'exchange:open:STATUS:',
    });
    expect(await client.showOrderHistorySummary('ACC1', '20261116')).toEqual([]);
  });

  it('vynucené odhlášení zavře plant s příznakem forcedLogout', async () => {
    const { server, client, closed } = setup();
    await client.connect(['order']);
    server.forceLogout();
    await flush();
    expect(closed.map((c) => c.info.forcedLogout)).toEqual([true]);
    expect(client.isConnected('order')).toBe(false);
  });

  it('výjimka ze send() je "unknown", ne "not-sent"', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    const socket = server.sockets.find((x) => x.readyState === 1)!;
    const original = socket.send.bind(socket);
    socket.send = () => {
      throw new Error('EPIPE');
    };
    const error = await client.placeOrder(limit('tag-e')).catch((e) => e as RithmicRequestError);
    socket.send = original;
    expect((error as RithmicRequestError).outcome).toBe('unknown');
    expect((error as Error).message).not.toMatch(/rejected|odm[ií]t/i);
  });

  it('konečná odpověď bez shodného user_msg se nepřiřadí cizímu požadavku', async () => {
    const { server, client } = setup({}, 40);
    await client.connect(['order']);
    server.controls.ignoreNextOrder = true;
    const pending = outcomeOf(client.placeOrder(limit('tag-late')));
    await flush();
    // pozdní potvrzení jiného (starého) požadavku: bez user_msg i s cizím user_msg
    const socket = server.sockets.find((x) => x.readyState === 1)!;
    socket.push(313, { rp_code: ['0'], basket_id: '999' });
    socket.push(313, { user_msg: ['stary-pozadavek'], rp_code: ['0'], basket_id: '998' });
    expect(await pending).toBe('unknown');
  });

  it('snímky téhož účtu běží po jednom a nepomíchají se', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    const open = await client.placeOrder(limit('tag-open'));
    const done = await client.placeOrder({ ...limit('tag-done'), priceType: 'MARKET', price: undefined });
    server.fill(done.basketId, 7001);
    await flush();
    const [first, second] = await Promise.all([client.showOrders('ACC1'), client.showOrders('ACC1')]);
    expect(first.map((o) => o.basketId).sort()).toEqual([open.basketId, done.basketId].sort());
    expect(second.map((o) => o.basketId).sort()).toEqual([open.basketId, done.basketId].sort());
  });

  it('událost s cizí identitou účtu se zahodí a ohlásí', async () => {
    const server = createFakeRithmicServer();
    const attention: string[] = [];
    const seen: RithmicOrderUpdate[] = [];
    const client = new RithmicClient({
      url: 'wss://fake', credentials, socketFactory: server.socketFactory,
      events: { onOrderUpdate: (u) => seen.push(u), onAttention: (m) => attention.push(m) },
    });
    await client.connect(['order']);
    const socket = server.sockets.find((x) => x.readyState === 1)!;
    socket.push(352, { account_id: 'ACC1', fcm_id: 'JINE_FCM', ib_id: 'IB', basket_id: '5', notify_type: 1 });
    socket.push(352, { account_id: 'CIZI', basket_id: '6', notify_type: 1 });
    socket.push(352, { account_id: 'ACC1', fcm_id: 'FCM', ib_id: 'IB', basket_id: '7', notify_type: 1 });
    await flush();
    expect(seen.map((u) => u.basketId)).toEqual(['7']);
    expect(attention).toHaveLength(2);
  });

  it('tiché spojení se po 2,5 intervalu zavře; zdravé přežije a hlásí živost', async () => {
    vi.useFakeTimers();
    try {
      const { server, client, closed } = setup();
      const alive: string[] = [];
      const second = new RithmicClient({
        url: 'wss://fake', credentials, socketFactory: server.socketFactory,
        events: { onAlive: (plant) => alive.push(plant), onPlantClosed: (plant, info) => closed.push({ plant, info }) },
      });
      await second.connect(['order']);
      await client.connect(['order']);
      const before = alive.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(second.isConnected('order')).toBe(true);
      expect(alive.length).toBeGreaterThan(before);
      server.controls.silent = true;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(second.isConnected('order')).toBe(false);
      expect(client.isConnected('order')).toBe(false);
      expect(closed.every((c) => c.info.intentional === false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dva účty se stejným číslem přihlášení odmítne a seznam účtů nenechá v paměti', async () => {
    const { server, client } = setup();
    server.controls.duplicateAccount = true;
    await expect(client.connect(['order'])).rejects.toThrow(/dva účty se stejným číslem/);
    expect(client.accounts).toEqual([]);
    expect(client.isConnected('order')).toBe(false);
  });

  it('pnl plant bez order plantu se nepřipojí; neznámá pozice je null, ne nula', async () => {
    const server = createFakeRithmicServer();
    const positions: Array<number | null> = [];
    const client = new RithmicClient({
      url: 'wss://fake', credentials, socketFactory: server.socketFactory,
      events: { onInstrumentPosition: (p) => positions.push(p.netQuantity) },
    });
    expect(await outcomeOf(client.connect(['pnl']))).toBe('not-sent');
    await client.connect(['order', 'pnl']);
    const socket = server.sockets.filter((x) => x.readyState === 1 && x.infra === 4)[0];
    socket.push(450, { account_id: 'ACC1', symbol: 'ESZ6' });
    socket.push(450, { account_id: 'ACC1', symbol: 'ESZ6', net_quantity: 0 });
    await flush();
    expect(positions).toEqual([null, 0]);
  });

  it('datový řádek bez user_msg se nepřiřadí cizímu čtení', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    const socket = server.sockets.find((x) => x.readyState === 1)!;
    // pozdní řádek starého čtení (účet A) dorazí těsně před dalším čtením
    socket.push(339, { rq_handler_rp_code: ['0'], basket_id: 'CIZI', target_ticks: '10' });
    socket.push(339, { user_msg: ['stare-cteni'], rq_handler_rp_code: ['0'], basket_id: 'CIZI2', target_ticks: '10' });
    const result = await client.showBrackets('ACC1').catch((e) => e as RithmicRequestError);
    expect(result instanceof RithmicRequestError ? result.outcome : result).not.toEqual(expect.arrayContaining([expect.objectContaining({ basketId: 'CIZI' })]));
  });

  it('zápis nese úplnou identitu účtu, ne jen jeho číslo', async () => {
    const { server, client } = setup();
    await client.connect(['order']);
    await client.placeOrder(limit('tag-id'));
    expect(server.received.find((r) => r.templateId === 312)!.fields).toMatchObject({ account_id: 'ACC1', fcm_id: 'FCM', ib_id: 'IB' });
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

describe('výpadek klienta mezi kroky vícekontraktového obchodu', () => {
  it('samostatné čekající přikoupení přežije původní SL a může znovu otevřít pozici', async () => {
    const { server, client } = setup();
    try {
      await client.connect(['order']);
      const initial = await client.placeBracketOrder({ ...limit('initial'), stopTicks: 40, targetTicks: 80 });
      server.fill(initial.basketId, 7000);
      const additional = await client.placeBracketOrder({ ...limit('additional'), price: 6995, stopTicks: 20, targetTicks: 100 });
      const stop = [...server.orders.values()].find(o => o.parent === initial.basketId && o.priceType === 4)!;
      client.close();
      // Orders can be matched during an outage. Test a stop execution delivered before the add.
      server.fill(stop.basketId, 6990);
      expect(server.positions.get('ACC1|ESZ6')).toBe(0);
      expect(server.orders.get(additional.basketId)?.status).toBe('open');
      server.fill(additional.basketId, 6990);
      expect(server.positions.get('ACC1|ESZ6')).toBe(1);
    } finally { client.close(); }
  });

  it('pokles množství ochrany z 3 na 2 před výstupem ponechá při výpadku jeden kus otevřený', async () => {
    const { server, client } = setup();
    try {
      await client.connect(['order']);
      const initial = await client.placeBracketOrder({ ...limit('three'), quantity: 3, stopTicks: 40, targetTicks: 80 });
      server.fill(initial.basketId, 7000);
      const legs = [...server.orders.values()].filter(o => o.parent === initial.basketId);
      const target = legs.find(o => o.priceType === 1)!;
      await client.modifyOrder({ accountId: 'ACC1', basketId: target.basketId, symbol: 'ESZ6', exchange: 'CME', quantity: 2, priceType: 'LIMIT', price: target.price });
      client.close(); // The second, independent exit did not reach the venue.
      expect(legs.map(o => o.quantity)).toEqual([2, 2]);
      const stop = legs.find(o => o.priceType === 4)!;
      server.fill(stop.basketId, 6990);
      expect(server.positions.get('ACC1|ESZ6')).toBe(1);
      expect([...server.orders.values()].filter(o => o.status === 'open')).toHaveLength(0);
    } finally { client.close(); }
  });
});
