// Fáze 0 obchodování z grafu (29. 10. 2026): skutečný záznam OSO zadaného přes
// API na leaderovi (Lucid, zadání → zrušení vstupu) přehraný do kopírky.
// Tradovate posílá SL nohu s `parentId`, TP nohu BEZ něj (jen `ocoId` na SL);
// vstup dorazí před nohami. Viz docs/CHART_ORDER_ENTRY_PLAN.md §2.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isOpenOrderStatus, type BrokerEvent, type BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';

interface RecordedEvent { t: number; event: { type: 'order'; order: Omit<BrokerOrder, 'tag'>; receivedAt: number } }
const recording = JSON.parse(readFileSync(new URL('./fixtures/tradovate-leader-oso-api-cancel.json', import.meta.url), 'utf8')) as {
  events: RecordedEvent[];
  prices: { entry: number; stopLoss: number; takeProfit: number };
};
const LEADER = 1001;
const FOLLOWER = 200;
/** Zrušení vstupu přišlo ~6 s po zadání; před ním jen zadání. */
const CANCEL_AT = 6_000;

const group = (): CopyGroupConfig => ({
  id: 'api-oso-replay', name: 'Replay', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

async function setup(options: { arm: boolean }) {
  let now = recording.events[0].event.receivedAt - 1_000;
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: group(), clock: () => now,
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  if (options.arm) controller.arm();
  const replay = async (filter: (item: RecordedEvent) => boolean) => {
    for (const item of recording.events.filter(filter)) {
      now = Math.max(now, item.event.receivedAt);
      broker.emitEvent({ ...item.event, order: { tag: '', ...item.event.order } } as BrokerEvent);
    }
    // Okno OSO korelace (1500 ms) musí uplynout i pro případný osamělý vstup.
    now += 2_000;
    await controller.waitForIdle();
  };
  return { broker, controller, audits, replay };
}

const followerOpenOrders = (broker: MockBroker) =>
  broker.orders().filter(order => order.accountId === FOLLOWER && isOpenOrderStatus(order.status));

describe('replay: API OSO na leaderovi (fáze 0 záznam)', () => {
  let controller: CopierRuntimeController | null = null;
  afterEach(() => { controller?.stop(); controller = null; });

  it('za DISARMED nic nezkopíruje, nezaloží incident a zapnutí jde po kontrole pozic', async () => {
    const run = await setup({ arm: false });
    controller = run.controller;
    await run.replay(() => true);

    expect(run.broker.placedRequests()).toEqual([]);
    expect(run.broker.placedOsoRequests()).toEqual([]);
    expect(run.broker.placedOcoRequests()).toEqual([]);
    const status = controller.status();
    expect(status.lastError).toBeNull();
    expect(status.manualRecovery).toBeNull();
    expect(status.armPreparation?.manualRecoveryRequired).not.toBe(true);
    expect(status.lastDisarm?.trigger ?? null).not.toBe('fail-closed');
    expect((await controller.reconcile()).authoritativelyClean).toBe(true);
    controller.arm();
    expect(controller.status().armed).toBe(true);
  });

  it('za ARMED pošle followerovi jedno nativní OSO se stejnými cenami a po zrušení vstupu nic nezůstane', async () => {
    const run = await setup({ arm: true });
    controller = run.controller;
    await run.replay(item => item.t < CANCEL_AT);

    expect(run.broker.placedRequests()).toEqual([]);
    expect(run.broker.placedOsoRequests()).toEqual([expect.objectContaining({
      accountId: FOLLOWER,
      side: 'Buy',
      quantity: 1,
      orderType: 'Limit',
      limitPrice: recording.prices.entry,
      first: expect.objectContaining({ side: 'Sell', orderType: 'Stop', stopPrice: recording.prices.stopLoss }),
      second: expect.objectContaining({ side: 'Sell', orderType: 'Limit', limitPrice: recording.prices.takeProfit }),
    })]);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null, manualRecovery: null });

    const followerEntry = run.broker.orders().find(order => order.accountId === FOLLOWER && order.side === 'Buy');
    expect(followerEntry && isOpenOrderStatus(followerEntry.status)).toBe(true);
    await run.replay(item => item.t >= CANCEL_AT);
    expect(run.broker.cancelRequestCount(followerEntry!.brokerOrderId)).toBe(1);
    expect(followerOpenOrders(run.broker)).toEqual([]);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null, manualRecovery: null });
    // Kopie odešla jako jeden nativní OSO a zrušení vstupu leadera zrušilo všechny tři příkazy followera.
    expect(run.audits.filter(entry => !entry.startsWith('recovered:'))).toEqual(['dispatched:native-oso', 'canceled:', 'canceled:', 'canceled:']);
  });
});
