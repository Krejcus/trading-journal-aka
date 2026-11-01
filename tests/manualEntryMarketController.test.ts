// 2. 11. 2026: nativní Market ručního vstupu přes skutečný controller v manual-only
// DEMO skupině (mock broker): bez převodu na Limit, nohy OSO, odmítnutá noha = incident,
// brzda během POSTu Market nezruší a neohlásí falešné „zrušeno“.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand, type LeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';

const LEADER = 61038658;
const SYM = 'MNQZ6';
const START = Date.UTC(2026, 10, 2, 2, 0, 0); // 20:00 CT neděle, po otevření session
const group = (): CopyGroupConfig => ({
  id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: manualOnlyDemoSafety(),
});
const risk = (at: number): BrokerAccountRiskSnapshot => ({
  accountId: LEADER, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null,
  dailyLossAutoLiq: null, trailingMaxDrawdown: null,
} as unknown as BrokerAccountRiskSnapshot);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup() {
  const clock = { now: START };
  const quote = { last: 25_000, bid: 24_999.75, ask: 25_000 };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)] });
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300 },
    manualEntryQuote: () => ({ contract: SYM, last: quote.last, lastAt: clock.now - 100, bid: quote.bid, ask: quote.ask, quoteAt: clock.now - 50 }),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  const command = (patch: { quantity?: number; operationId?: string; stopLoss?: number } = {}): LeaderEntryPlaceCommand => {
    const status = controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: patch.quantity ?? 1, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: clock.now - 300,
        stopLoss: patch.stopLoss ?? 24_990, takeProfit: 25_020 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:markettest01' },
    );
    return buildLeaderEntryPlaceCommand(preview, patch.operationId ?? 'entry:markettest01');
  };
  const place = (entry: LeaderEntryPlaceCommand) => controller.placeLeaderEntry(entry, { deadlineAt: clock.now + 15_000 });
  return { broker, controller, audits, clock, quote, command, place };
}

const fillEntry = (broker: MockBroker, entryId: string, quantity: number, price: number) => {
  const entry = broker.orders().find(order => order.brokerOrderId === entryId)!;
  entry.status = 'filled';
  entry.filledQuantity = quantity;
  broker.emitEvent({ type: 'order', order: { ...entry, sourceVersion: '2:Filled' } });
  broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity, price, filledAt: 2 } });
  broker.setPosition(LEADER, SYM, quantity);
  broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: quantity } });
};

describe('nativní Market ručního vstupu (controller, manual-only DEMO)', () => {
  it('pošle Market bez ceny se SL/TP; fill a nohy nevyvolají incident; časy jsou ve statusu', async () => {
    const ctx = await setup();
    const result = await ctx.place(ctx.command({ quantity: 2 }));
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    const [sent] = ctx.broker.placedOsoRequests();
    expect(ctx.broker.placedOsoRequests()).toHaveLength(1);
    expect(sent).toMatchObject({ accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Market',
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 24_990 }, second: { side: 'Sell', orderType: 'Limit', limitPrice: 25_020 } });
    expect(sent).not.toHaveProperty('limitPrice');
    expect(sent).not.toHaveProperty('stopPrice');
    fillEntry(ctx.broker, result.entryBrokerOrderId!, 2, 25_000.25);
    await sleep(30);
    await ctx.controller.waitForIdle();
    const status = ctx.controller.status();
    expect(status).toMatchObject({ armed: true, lastError: null });
    const record = status.manualEntries?.find(entry => entry.operationId === 'entry:markettest01');
    expect(record).toMatchObject({ orderType: 'Market', referencePrice: 25_000, status: 'acknowledged' });
    expect(record).not.toHaveProperty('price');
    expect(record?.timing).toMatchObject({ dispatchAt: expect.any(Number), ackAt: expect.any(Number), fillAvg: 25_000.25, fillQty: 2 });
    expect(ctx.audits.some(line => line.includes('MKT (viděno 25000)'))).toBe(true);
  });

  it('odmítnutá ochranná noha po fillu = incident (DISARM, lastError), nic se neobchoduje', async () => {
    const ctx = await setup();
    const result = await ctx.place(ctx.command());
    fillEntry(ctx.broker, result.entryBrokerOrderId!, 1, 25_000);
    await ctx.controller.waitForIdle();
    const stop = ctx.broker.orders().find(order => order.brokerOrderId === result.stopBrokerOrderId)!;
    stop.status = 'rejected';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop, rejectReason: 'InvalidPrice', sourceVersion: '3:Rejected' } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    const status = ctx.controller.status();
    expect(status.armed).toBe(false);
    expect(status.lastError).toContain('odmítl SL nohu');
    expect(ctx.broker.placedOsoRequests()).toHaveLength(1);
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
  });

  it('brzda během POSTu: vyplněný Market se neruší a nehlásí „zrušen“; incident', async () => {
    const ctx = await setup();
    const original = ctx.broker.placeOso!.bind(ctx.broker);
    ctx.broker.placeOso = async request => {
      ctx.controller.disarm('manual');
      const ack = await original(request);
      // Skutečný Market je u brokera vyplněný dřív, než přijde odpověď.
      const entry = ctx.broker.orders().find(order => order.brokerOrderId === ack.entryBrokerOrderId)!;
      entry.status = 'filled';
      entry.filledQuantity = entry.quantity;
      return ack;
    };
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toContain('vyplněný se SL/TP');
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(result.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().lastError).toContain('vyplněn během brzdy');
  });

  it('odmítnutá noha dorazí streamem dřív než ACK: incident i tak (P1-A)', async () => {
    const ctx = await setup();
    const original = ctx.broker.placeOso!.bind(ctx.broker);
    ctx.broker.placeOso = async request => {
      const ack = await original(request);
      fillEntry(ctx.broker, ack.entryBrokerOrderId, 1, 25_000);
      const stop = ctx.broker.orders().find(order => order.brokerOrderId === ack.firstBrokerOrderId)!;
      stop.status = 'rejected';
      ctx.broker.emitEvent({ type: 'order', order: { ...stop, rejectReason: 'InvalidPrice', sourceVersion: '3:Rejected' } });
      await sleep(5);
      return ack;
    };
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('acknowledged');
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError).toContain('odmítl SL nohu');
  });

  it('replay odmítnuté nohy nevyvolá druhý incident (P2-1)', async () => {
    const ctx = await setup();
    const result = await ctx.place(ctx.command());
    fillEntry(ctx.broker, result.entryBrokerOrderId!, 1, 25_000);
    await ctx.controller.waitForIdle();
    const stop = ctx.broker.orders().find(order => order.brokerOrderId === result.stopBrokerOrderId)!;
    stop.status = 'rejected';
    ctx.broker.emitEvent({ type: 'order', order: { ...stop, rejectReason: 'InvalidPrice', sourceVersion: '3:Rejected' } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    const incidents = () => ctx.audits.filter(line => line.includes('broker odmítl SL nohu')).length;
    expect(incidents()).toBe(1);
    ctx.broker.emitEvent({ type: 'order', order: { ...stop, rejectReason: 'InvalidPrice', sourceVersion: '3:Rejected' } });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(incidents()).toBe(1);
  });

  it('brzda během POSTu se vstupem ve streamu jako working: Market se neruší (P1-B)', async () => {
    const ctx = await setup();
    const original = ctx.broker.placeOso!.bind(ctx.broker);
    ctx.broker.placeOso = async request => { ctx.controller.disarm('manual'); return original(request); };
    const result = await ctx.place(ctx.command());
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(result.entryBrokerOrderId!)).toBe(0);
    expect(ctx.audits.some(line => /vlastní vstup zrušen/.test(line))).toBe(false);
  });

  it('čekající vlastní Limit v manual-only skupině se sám nezruší (P1-C)', async () => {
    const ctx = await setup();
    const status = ctx.controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Limit', price: 24_980, stopLoss: 24_970, takeProfit: 25_010 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:limittest01' },
    );
    const result = await ctx.place(buildLeaderEntryPlaceCommand(preview, 'entry:limittest01'));
    expect(result.status).toBe('acknowledged');
    await sleep(60);
    await ctx.controller.waitForIdle();
    ctx.clock.now += 6_000;
    await sleep(60);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(result.entryBrokerOrderId!)).toBe(0);
    expect(ctx.broker.orders().find(order => order.brokerOrderId === result.entryBrokerOrderId)).toMatchObject({ status: 'working', limitPrice: 24_980 });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
  });

  it('trh utekl mezi vyhodnocením a POSTem: Market se neodešle', async () => {
    const ctx = await setup();
    const original = ctx.broker.placeOso!.bind(ctx.broker);
    let calls = 0;
    ctx.broker.placeOso = async request => { calls += 1; return original(request); };
    // Před POSTem (po durable sending) se ask posune o 12 ticků.
    const command = ctx.command();
    ctx.quote.ask = 25_003; ctx.quote.last = 25_003; ctx.quote.bid = 25_002.75;
    const result = await ctx.place(command);
    expect(result.status).toBe('blocked');
    expect(calls).toBe(0);
  });
});
