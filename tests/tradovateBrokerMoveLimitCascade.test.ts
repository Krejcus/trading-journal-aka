import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(messages: unknown[]) { this.onmessage?.({ data: `a${JSON.stringify(messages)}` }); }
}

const flush = async () => {
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
};

const completeHandshake = async (socket: FakeSocket) => {
  socket.open();
  socket.onmessage?.({ data: 'o' });
  await flush();
  socket.deliver([{ i: 0, s: 200, d: {} }]);
  await flush();
  socket.deliver([{ i: 1, s: 200, d: [] }]);
  await flush();
};

type Prop = { entityType: string; entity: Record<string, unknown> };

const accountId = 61038658;
const contractId = 4470324;
const entryId = 611860533628;
const stopId = 611860533629;
const targetId = 611860533630;
const entryModifyId = 611860533635;
const stopModifyId = 611860533636;
const targetModifyId = 611860533638;

const entry = (ordStatus = 'Working') => ({
  id: entryId, accountId, contractId, action: 'Buy', ordStatus, linkedId: stopId,
});
const stop = (ordStatus = 'Suspended') => ({
  id: stopId, accountId, contractId, action: 'Sell', ordStatus, parentId: entryId, ocoId: targetId,
});
const target = (ordStatus = 'Suspended') => ({
  id: targetId, accountId, contractId, action: 'Sell', ordStatus, ocoId: stopId,
});
const entryVersion = (id = entryId, price = 27000) => ({ id, orderId: entryId, orderQty: 1, orderType: 'Limit', price });
const stopVersion = (id = stopId, stopPrice = 26988) => ({ id, orderId: stopId, orderQty: 1, orderType: 'Stop', stopPrice });
const targetVersion = (id = targetId, price = 27024) => ({ id, orderId: targetId, orderQty: 1, orderType: 'Limit', price });
const modify = (id: number, orderId: number, commandStatus?: string) => ({
  id, orderId, commandType: 'Modify', ...(commandStatus ? { commandStatus } : {}),
});

const orderEvents = (events: BrokerEvent[]) => events.filter((event): event is Extract<BrokerEvent, { type: 'order' }> => event.type === 'order');
const latest = (events: BrokerEvent[], id: number) => orderEvents(events).filter(event => event.order.brokerOrderId === String(id)).at(-1)?.order;

const createWire = async (promoteHeldModify = true) => {
  const socket = new FakeSocket();
  const events: BrokerEvent[] = [];
  const broker = createTradovateBroker({
    environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO8661118',
    promoteHeldModify: () => promoteHeldModify,
    webSocketFactory: () => socket,
    fetchImpl: (async input => {
      if (String(input).includes('/contract/items')) return Response.json([{ id: contractId, name: 'MNQZ6' }]);
      return Response.json([]);
    }) as typeof fetch,
  });
  const unsubscribe = broker.subscribe(event => events.push(event));
  await completeHandshake(socket);
  return { socket, events, unsubscribe };
};

const deliver = async (socket: FakeSocket, ...items: Prop[]) => {
  socket.deliver([{ e: 'props', d: items }]);
  await flush();
};

const seedOso = async (socket: FakeSocket) => {
  await deliver(socket,
    { entityType: 'order', entity: entry() }, { entityType: 'orderversion', entity: entryVersion() },
    { entityType: 'order', entity: stop() }, { entityType: 'orderversion', entity: stopVersion() },
    { entityType: 'order', entity: target() }, { entityType: 'orderversion', entity: targetVersion() },
  );
};

type LegDelivery = 'onhold-before-version' | 'version-before-onhold';

const deliverMoveCascade = async (socket: FakeSocket, order: LegDelivery = 'onhold-before-version', replaced = true) => {
  await deliver(socket,
    { entityType: 'command', entity: modify(entryModifyId, entryId, 'Pending') },
    { entityType: 'orderversion', entity: entryVersion(entryModifyId, 27002.25) },
  );
  const heldLeg = (id: number, orderId: number, version: Record<string, unknown>): Prop[] => order === 'onhold-before-version'
    ? [
      { entityType: 'command', entity: modify(id, orderId, 'OnHold') },
      { entityType: 'orderversion', entity: version },
      { entityType: 'commandreport', entity: { id: id + 1, commandId: id, commandStatus: 'OnHold' } },
    ]
    : [
      { entityType: 'orderversion', entity: version },
      { entityType: 'command', entity: modify(id, orderId, 'OnHold') },
    ];
  await deliver(socket, ...heldLeg(stopModifyId, stopId, stopVersion(stopModifyId, 26990.25)));
  await deliver(socket, ...heldLeg(targetModifyId, targetId, targetVersion(targetModifyId, 27026.25)));
  if (!replaced) return;
  await deliver(socket, {
    entityType: 'executionreport', entity: {
      id: entryModifyId + 6, commandId: entryModifyId, orderId: entryId, accountId, contractId,
      action: 'Buy', ordStatus: 'Working', execType: 'Replaced',
    },
  });
};

afterEach(() => undefined);

describe('Tradovate move-limit OSO cascade from DEMO journal', () => {
  it('promotes held SL and TP prices after the entry moves 27000 -> 27002.25, while legs stay pending', async () => {
    const wire = await createWire();
    try {
      await seedOso(wire.socket);
      await deliverMoveCascade(wire.socket);

      expect(latest(wire.events, entryId)).toMatchObject({ status: 'working', limitPrice: 27002.25 });
      expect(latest(wire.events, stopId)).toMatchObject({ status: 'pending', stopPrice: 26990.25 });
      expect(latest(wire.events, targetId)).toMatchObject({ status: 'pending', limitPrice: 27026.25 });
    } finally {
      wire.unsubscribe();
    }
  });

  it.each(['onhold-before-version', 'version-before-onhold'] as const)(
    'promotes both held legs when OrderVersion delivery is %s',
    async order => {
      const wire = await createWire();
      try {
        await seedOso(wire.socket);
        await deliverMoveCascade(wire.socket, order);
        expect(latest(wire.events, stopId)).toMatchObject({ status: 'pending', stopPrice: 26990.25 });
        expect(latest(wire.events, targetId)).toMatchObject({ status: 'pending', limitPrice: 27026.25 });
      } finally {
        wire.unsubscribe();
      }
    },
  );

  it('does not promote held leg prices when promoteHeldModify is disabled', async () => {
    const wire = await createWire(false);
    try {
      await seedOso(wire.socket);
      await deliverMoveCascade(wire.socket);
      expect(latest(wire.events, entryId)).toMatchObject({ status: 'working', limitPrice: 27002.25 });
      expect(latest(wire.events, stopId)).toMatchObject({ status: 'pending', stopPrice: 26988 });
      expect(latest(wire.events, targetId)).toMatchObject({ status: 'pending', limitPrice: 27024 });
    } finally {
      wire.unsubscribe();
    }
  });

  it('reverts held legs to their last confirmed prices when the entry Modify is rejected and their Modifies stop', async () => {
    const wire = await createWire();
    try {
      await seedOso(wire.socket);
      await deliverMoveCascade(wire.socket, 'onhold-before-version', false);
      // Chování brokera pro odmítnutí vstupu se staženými Modify nohou zatím není ověřené.
      await deliver(wire.socket,
        { entityType: 'commandreport', entity: { id: 700, commandId: entryModifyId, commandStatus: 'ExecutionRejected', ordStatus: 'Rejected' } },
        { entityType: 'commandreport', entity: { id: 701, commandId: stopModifyId, commandStatus: 'ExecutionStopped' } },
        { entityType: 'commandreport', entity: { id: 702, commandId: targetModifyId, commandStatus: 'ExecutionStopped' } },
      );

      // Adaptér drží vstup na poslední potvrzené ceně; stažené Modify nohou vrací na jejich dřívější verze.
      expect(latest(wire.events, entryId)).toMatchObject({ status: 'working', limitPrice: 27000 });
      expect(latest(wire.events, stopId)).toMatchObject({ status: 'pending', stopPrice: 26988 });
      expect(latest(wire.events, targetId)).toMatchObject({ status: 'pending', limitPrice: 27024 });
    } finally {
      wire.unsubscribe();
    }
  });

  it('marks an activated held leg unconfirmed until its held Modify receives an ExecutionReport', async () => {
    const wire = await createWire();
    try {
      await seedOso(wire.socket);
      await deliverMoveCascade(wire.socket);
      await deliver(wire.socket, { entityType: 'order', entity: stop('Working') });
      expect(latest(wire.events, stopId)).toMatchObject({ status: 'working', stopPrice: 26990.25, heldPriceUnconfirmed: true });

      await deliver(wire.socket, {
        entityType: 'executionreport', entity: {
          id: 703, commandId: stopModifyId, orderId: stopId, accountId, contractId,
          action: 'Sell', ordStatus: 'Working', execType: 'New', parentId: entryId, ocoId: targetId,
        },
      });
      expect(latest(wire.events, stopId)).toMatchObject({ status: 'working', stopPrice: 26990.25 });
      expect(latest(wire.events, stopId)?.heldPriceUnconfirmed).toBeUndefined();
    } finally {
      wire.unsubscribe();
    }
  });
});
