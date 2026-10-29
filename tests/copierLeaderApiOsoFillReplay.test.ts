// Fáze 0/1b obchodování z grafu (29. 10. 2026 19:00 UTC): skutečný záznam
// marketable OSO zadaného přes API na leaderovi (Lucid) — vstup se vyplnil,
// nohy přešly na Working, pak liquidate. Pořadí: vstup → SL (parentId) →
// TP (jen ocoId) → fill vstupu → nohy Working. Nohy tedy dorazí před fillem.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder, BrokerOsoRequest } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';

type RecordedEvent = { t: number; event: ({ type: 'order'; order: Omit<BrokerOrder, 'tag'> } | { type: 'fill'; fill: Record<string, unknown> }) & { receivedAt: number } };
const recording = JSON.parse(readFileSync(new URL('./fixtures/tradovate-leader-oso-api-fill.json', import.meta.url), 'utf8')) as {
  events: RecordedEvent[];
  prices: { entry: number; stopLoss: number; takeProfit: number };
};
const LEADER = 1001;
const FOLLOWER = 200;
/** Liquidate přišel ~7,2 s po startu; před ním zadání, fill a nohy Working. */
const BEFORE_LIQUIDATE = 7_000;
const ENTRY_ID = '707501072797';
const STOP_ID = '707501072798';
const TARGET_ID = '707501072799';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const group = (): CopyGroupConfig => ({
  id: 'api-oso-fill', name: 'Replay fill', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const risk = (accountId: number, at: number): BrokerAccountRiskSnapshot => ({
  accountId, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 48_000, dailyLossAutoLiq: 1_000, trailingMaxDrawdown: 2_000,
});
const before = recording.events.filter(item => item.t < BEFORE_LIQUIDATE);
const emitRecorded = (broker: MockBroker, items: RecordedEvent[]) => {
  for (const item of items) {
    const event = item.event.type === 'order'
      ? { ...item.event, order: { tag: '', ...item.event.order } }
      : { ...item.event, fill: { tag: '', ...item.event.fill } };
    broker.emitEvent(event as never);
  }
};

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function boot(options: { slowStore?: boolean; patchBroker?: (broker: MockBroker) => void } = {}) {
  const clock = { now: recording.events[0].event.receivedAt - 1_000 };
  const broker = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    accountRiskSnapshots: [risk(LEADER, clock.now), risk(FOLLOWER, clock.now)],
  });
  options.patchBroker?.(broker);
  const memory = createMemoryCopierStore();
  let slow = false;
  const store: CopierStore = options.slowStore
    ? { ...memory, commit: async (snapshot, revision) => { if (slow) await sleep(5); return memory.commit(snapshot, revision); } }
    : memory;
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group: group(), clock: () => clock.now, manualEntryTimingsMs: { legWait: 300 },
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  slow = true;
  return { broker, controller, audits, clock };
}

const followerOso = (broker: MockBroker) => broker.placedOsoRequests().filter(request => request.accountId === FOLLOWER);
const expectCopiedWithRecordedPrices = (broker: MockBroker) => {
  const copies = followerOso(broker);
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({
    side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: recording.prices.entry,
    first: { side: 'Sell', orderType: 'Stop', stopPrice: recording.prices.stopLoss },
    second: { side: 'Sell', orderType: 'Limit', limitPrice: recording.prices.takeProfit },
  });
};

describe('fáze 1b: replay záznamu vyplněného OSO na leaderovi', { timeout: 30_000 }, () => {
  it('OSO s fillem (nohy dorazí před fillem) → follower dostane nativní OSO stejných cen, bez lone-leg', async () => {
    const ctx = await boot({ slowStore: true });
    for (const item of before) ctx.clock.now = Math.max(ctx.clock.now, item.event.receivedAt);
    emitRecorded(ctx.broker, before);
    await sleep(100);
    ctx.clock.now += 2_000;
    await sleep(200);
    await ctx.controller.waitForIdle();
    expect(ctx.audits.some(entry => entry.includes('oso-lone-leg'))).toBe(false);
    expectCopiedWithRecordedPrices(ctx.broker);
    expect(ctx.broker.placedRequests().filter(request => request.accountId === FOLLOWER)).toEqual([]);
  });

  it('jako vlastní ruční vstup z grafu: ACK, kopie followerovi, vlastní vstup se neruší', async () => {
    let brokerRef!: MockBroker;
    const ctx = await boot({
      slowStore: true,
      patchBroker: broker => {
        brokerRef = broker;
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => {
          if (request.accountId !== LEADER) return real(request);
          // WS eventy přijdou za REST ACK (v záznamu ~130 ms).
          setTimeout(() => emitRecorded(brokerRef, before), 30);
          return { entryBrokerOrderId: ENTRY_ID, firstBrokerOrderId: STOP_ID, secondBrokerOrderId: TARGET_ID, accepted: true, definitive: true };
        };
      },
    });
    ctx.clock.now = recording.events[0].event.receivedAt;
    const status = ctx.controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: recording.prices.entry, stopLoss: recording.prices.stopLoss, takeProfit: recording.prices.takeProfit },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:fillreplay001' },
    );
    const result = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, 'entry:fillreplay001'), { deadlineAt: ctx.clock.now + 15_000 });
    expect(result.blockers).toEqual([]);
    expect(result).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: ENTRY_ID });
    await sleep(150);
    ctx.clock.now += 2_000;
    await sleep(200);
    await ctx.controller.waitForIdle();
    expect(ctx.audits.some(entry => entry.includes('oso-lone-leg') || entry.includes('nohy nedorazily'))).toBe(false);
    expectCopiedWithRecordedPrices(ctx.broker);
    expect(ctx.broker.cancelRequestCount(ENTRY_ID)).toBe(0);
    expect(ctx.controller.status().manualEntries?.[0]).toMatchObject({ status: 'acknowledged' });
  });
});
