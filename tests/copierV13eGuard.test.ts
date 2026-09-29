import { describe, expect, it } from 'vitest';
import type { BrokerEvent, BrokerOrder, BrokerOrderStatusLookup } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import type { CopierAuditEntry } from '../services/copierRunner';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

// Čočka ROZPOČET/FRONTA (v13d). Jen sondy: vypisují, nic netvrdí.
// Heartbeat jako Tradovate: každá stream zpráva nese heartbeat (at = příjem), plus každých 2,5 s.
// Latence: L = /order/list (globální graf), RTT pro ostatní REST (pozice, cancel, findOrderById).

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SYM = 'MNQU6';

const leaderOrder = (partial: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, status: 'working',
  sourceVersion: '1:Working', updatedAt: Date.now(), ...partial,
});

interface Lat { list: number; rtt: number }
interface Cnt { listOrders: number; listPositions: number; cancels: number; findById: number; restStatus: number; streamOnly: number }

interface H {
  broker: MockBroker; controller: CopierRuntimeController; store: CopierStore;
  audits: CopierAuditEntry[]; errors: Error[]; lat: Lat; cnt: Cnt;
  legs: Map<number, string[]>; stopHb: () => void; emit: (e: BrokerEvent) => void;
}

async function harness(followers: number[]): Promise<H> {
  const group: CopyGroupConfig = {
    id: 'rozpocet-d', name: 'rozpocet-d', enabled: true, leaderAccountId: 100,
    followers: followers.map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
    safety: { ...DEFAULT_COPY_GROUP_SAFETY },
  };
  const broker = createMockBroker({ behavior: request => (request.orderType === 'Market' ? { kind: 'fill', price: 30_000 } : { kind: 'working' }) });
  const lat: Lat = { list: 0, rtt: 0 };
  const cnt: Cnt = { listOrders: 0, listPositions: 0, cancels: 0, findById: 0, restStatus: 0, streamOnly: 0 };
  broker.findOrderStatusById = async (accountId: number, orderId: string, options?: { streamOnly?: boolean }): Promise<BrokerOrderStatusLookup> => {
    const o = broker.orders().find(item => item.accountId === accountId && item.brokerOrderId === orderId);
    if (options?.streamOnly) {
      cnt.streamOnly += 1;
      if (o && ['canceled', 'filled', 'rejected'].includes(o.status)) return { status: o.status, completeness: 'authoritative', observedAt: Date.now() };
      return { status: null, completeness: 'eventual', observedAt: Date.now() };
    }
    if (o && ['canceled', 'filled', 'rejected'].includes(o.status)) return { status: o.status, completeness: 'authoritative', observedAt: Date.now() };
    cnt.restStatus += 1; await sleep(lat.rtt);
    return { status: o?.status ?? null, completeness: 'authoritative', observedAt: Date.now() };
  };
  const realList = broker.listOrders.bind(broker);
  broker.listOrders = async a => { cnt.listOrders += 1; await sleep(lat.list); return realList(a); };
  const realPos = broker.listPositions.bind(broker);
  broker.listPositions = async a => { cnt.listPositions += 1; await sleep(lat.rtt); return realPos(a); };
  const realCancel = broker.cancelOrder.bind(broker);
  broker.cancelOrder = async (a, id) => { cnt.cancels += 1; await sleep(lat.rtt); return realCancel(a, id); };
  const realFind = broker.findOrderById.bind(broker);
  broker.findOrderById = async (a, id) => { cnt.findById += 1; await sleep(lat.rtt); return realFind(a, id); };
  const realEmit = broker.emitEvent.bind(broker);
  const emit = (e: BrokerEvent) => { realEmit({ type: 'heartbeat', at: Date.now() }); realEmit(e); };
  const store = createMemoryCopierStore();
  const audits: CopierAuditEntry[] = [];
  const errors: Error[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group, osoCorrelationWindowMs: 1500,
    onAudit: e => audits.push(...e), onError: e => errors.push(e),
  } as never);
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  const hb = setInterval(() => realEmit({ type: 'heartbeat', at: Date.now() }), 2_500);
  emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e1', limitPrice: 30_000, sourceVersion: 'e1:w' }) });
  emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e1-s', parentOrderId: 'e1', side: 'Sell', orderType: 'Stop', stopPrice: 29_950, sourceVersion: 'e1-s:w' }) });
  emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e1-t', parentOrderId: 'e1', side: 'Sell', orderType: 'Limit', limitPrice: 30_100, sourceVersion: 'e1-t:w' }) });
  await controller.waitForIdle();
  const snap = await store.load();
  const legs = new Map<number, string[]>();
  for (const entry of snap.osoOutbox ?? []) {
    if (!entry.entryBrokerOrderId) continue;
    const parent = broker.orders().find(o => o.brokerOrderId === entry.entryBrokerOrderId);
    if (parent) { parent.status = 'filled'; parent.filledQuantity = parent.quantity; }
    legs.set(entry.request.accountId, [entry.firstBrokerOrderId!, entry.secondBrokerOrderId!]);
  }
  emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e1', limitPrice: 30_000, status: 'filled', filledQuantity: 1, sourceVersion: 'e1:f' }) });
  emit({ type: 'fill', fill: { fillId: 'e1-lf', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_000, filledAt: Date.now() } });
  broker.setPosition(100, SYM, 1);
  emit({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
  for (const f of followers) {
    broker.setPosition(f, SYM, 1);
    emit({ type: 'position', position: { accountId: f, symbol: SYM, netQuantity: 1 } });
  }
  await controller.waitForIdle();
  return { broker, controller, store, audits, errors, lat, cnt, legs, stopHb: () => clearInterval(hb), emit };
}

const reset = (c: Cnt) => { c.listOrders = 0; c.listPositions = 0; c.cancels = 0; c.findById = 0; c.restStatus = 0; c.streamOnly = 0; };
const st = (h: H) => ({ armed: h.controller.status().armed, lastError: h.controller.status().lastError });
const legState = (h: H, f: number) => h.legs.get(f)!.map(id => h.broker.orders().find(o => o.brokerOrderId === id)?.status);


describe('S1/zzV_Guard + D-B L=300', () => {
  for (const [L, legsDone, delayEntry] of [[300, false, 20]] as const) {
    it(`nový parent zůstane OSO při L=${L}`, async () => {
      const followers = [200, 300, 400];
      const h = await harness(followers);
      try {
        h.lat.list = L; h.lat.rtt = 150;
        if (legsDone) for (const f of followers) for (const id of h.legs.get(f)!) h.broker.orders().find(o => o.brokerOrderId === id)!.status = 'canceled';
        reset(h.cnt);
        const auditsBefore = h.audits.length;
        h.broker.setPosition(100, SYM, 0);
        h.emit({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 0 } });
        for (const f of followers) {
          h.broker.setPosition(f, SYM, 0);
          h.emit({ type: 'position', position: { accountId: f, symbol: SYM, netQuantity: 0 } });
        }
        await sleep(delayEntry);
        const osoBefore = h.broker.placedOsoRequests().length;
        const placedBefore = h.broker.placedRequests().length;
        const tEntry = Date.now();
        h.emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e9', limitPrice: 30_020, sourceVersion: 'e9:w' }) });
        h.emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e9-s', parentOrderId: 'e9', side: 'Sell', orderType: 'Stop', stopPrice: 29_970, sourceVersion: 'e9-s:w' }) });
        h.emit({ type: 'order', order: leaderOrder({ brokerOrderId: 'e9-t', parentOrderId: 'e9', side: 'Sell', orderType: 'Limit', limitPrice: 30_120, sourceVersion: 'e9-t:w' }) });
        await sleep(2_000);
        await h.controller.waitForIdle();
        const s = h.controller.status();
        const snap = await h.store.load();
        console.log(`DBG L=${L} legsDone=${legsDone} delay=${delayEntry}`, JSON.stringify({
          ms: Date.now() - tEntry, oso: h.broker.placedOsoRequests().slice(osoBefore).map(r => r.accountId),
          oco: h.broker.placedOcoRequests().map(r => r.accountId), placed: h.broker.placedRequests().slice(placedBefore).map(p => `${p.accountId}:${p.side}${p.orderType}${p.quantity}`),
          armed: s.armed, lastError: s.lastError, stuck: s.stuckOperations.map(o => [o.kind, o.status]),
          audits: h.audits.slice(auditsBefore).map(a => `${a.kind}:${a.accountId ?? ''}:${String(a.leaderEventId).slice(0, 40)}:${String(a.reason).slice(0, 140)}`),
          errors: h.errors.map(e => e.message.slice(0, 160)),
          osoOutbox: (snap.osoOutbox ?? []).map(e => [e.leaderEntryOrderId, e.request.accountId, e.status]),
        }));
        expect(h.broker.placedOsoRequests().slice(osoBefore).map(request => request.accountId).sort())
          .toEqual(followers);
        expect(h.broker.placedOcoRequests()).toHaveLength(0);
        expect(h.broker.placedRequests().slice(placedBefore).filter(request => request.orderType === 'Limit'))
          .toHaveLength(0);
      } finally { h.stopHb(); h.controller.stop(); }
    }, 60_000);
  }
});
