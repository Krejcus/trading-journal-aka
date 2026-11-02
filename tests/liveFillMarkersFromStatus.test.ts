import { describe, expect, it } from 'vitest';
import { liveFillMarkersFromStatus, liveFillsNotInJournal } from '../lib/liveFillMarkers';
import { isCopierLiveExposurePayload, mergeCopierLiveExposure } from '../lib/copierLiveExposure';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { cloneDayRuleActions, DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const NOW = 1_000_000;
const ring = (patch: Record<string, unknown> = {}) => ({
  symbol: 'MNQZ6', fromFlat: true, netAfter: 2,
  fills: [{ fillId: '11', orderId: '7', at: NOW - 3_000, price: 28_000, side: 'Buy' as const, quantity: 2, role: 'entry' as const }],
  ...patch,
});
const controller = (patch: Record<string, unknown> = {}) => ({
  connected: true,
  exposure: { positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: 2 }] },
  leaderFills: ring(),
  ...patch,
});
const derive = (patch: Partial<Parameters<typeof liveFillMarkersFromStatus>[0]> = {}) => liveFillMarkersFromStatus({
  controller: controller(), exposureObservedAt: NOW - 1_000, fresh: true, leaderAccountId: 100, root: 'MNQ', now: NOW, ...patch,
});

describe('šipky plnění ze statusu workeru (jen zobrazení)', () => {
  it('čerstvý stav a otevřená pozice: plnění leadera, open=true', () => {
    expect(derive()).toEqual({ open: true, fills: [{ id: '11', orderId: '7', at: NOW - 3_000, price: 28_000, side: 'Buy', role: 'entry', quantity: 2 }] });
  });

  it('obnovený/starý/odpojený stav nebo expozice > 8 s = nic (nikdy jako aktuální)', () => {
    expect(derive({ fresh: false }).open).toBeUndefined();
    expect(derive({ exposureObservedAt: NOW - 8_500 }).open).toBeUndefined();
    expect(derive({ exposureObservedAt: NOW + 6_000 }).open).toBeUndefined();
    expect(derive({ controller: controller({ connected: false }) }).open).toBeUndefined();
    expect(derive({ controller: controller({ exposure: null }) }).open).toBeUndefined();
  });

  it('neúplná epizoda (mezera, start uprostřed) se nekreslí', () => {
    expect(derive({ controller: controller({ leaderFills: ring({ gap: true }) }) }).fills).toEqual([]);
    expect(derive({ controller: controller({ leaderFills: ring({ fromFlat: false }) }) }).fills).toEqual([]);
  });

  it('zavřeno: open=false; znaménko nesedí (Position/Fill závod) = skryto, ne flat', () => {
    const closed = controller({ exposure: { positions: [] }, leaderFills: ring({ netAfter: 0 }) });
    expect(derive({ controller: closed }).open).toBe(false);
    const race = controller({ exposure: { positions: [] }, leaderFills: ring({ netAfter: 2 }) });
    expect(derive({ controller: race }).open).toBeUndefined();
  });

  it('jen pozice leadera (follower expozice se nepočítá) a jen kořen grafu', () => {
    const followerOnly = controller({ exposure: { positions: [{ accountId: 200, symbol: 'MNQZ6', netQuantity: 2 }] } });
    expect(derive({ controller: followerOnly }).open).toBeUndefined();
    expect(derive({ controller: controller({ leaderFills: ring({ symbol: 'NQZ6' }) }) }).open).toBeUndefined();
  });

  it('plnění už v deníku se živě nekreslí', () => {
    expect(liveFillsNotInJournal(derive().fills, new Set(['11']))).toEqual([]);
    expect(liveFillsNotInJournal(derive().fills, new Set(['99']))).toHaveLength(1);
  });
});

describe('exposure push nese plnění leadera', () => {
  const payload = (leaderFills: unknown) => ({ v: 1, startedAt: '2026-11-02T08:00:00.000Z', seq: 5, builtAt: 10, exposure: null, events: [], leaderFills });
  it('rozbité plnění nikdy nezahodí expozici: zpráva projde, merge pole ignoruje (platí poll)', () => {
    expect(isCopierLiveExposurePayload(payload(ring()))).toBe(true);
    expect(isCopierLiveExposurePayload(payload(null))).toBe(true);
    const broken = payload(ring({ fills: [{ fillId: '1', orderId: '2', at: null, price: -5, side: 'Buy', quantity: 1, role: 'entry' }] }));
    expect(isCopierLiveExposurePayload(broken)).toBe(true);
    const status = { startedAt: '2026-11-02T08:00:00.000Z', displaySeq: 4, displayBuiltAt: 5, controller: { leaderFills: ring({ netAfter: 1 }) } } as never;
    const merged = mergeCopierLiveExposure(status, NOW, { payload: broken as never, receivedAt: NOW + 10 } as never);
    expect((merged.status as { controller: { leaderFills: { netAfter: number } } }).controller.leaderFills.netAfter).toBe(1);
    const tooMany = payload(ring({ fills: Array.from({ length: 51 }, () => ring().fills[0]) }));
    const merged2 = mergeCopierLiveExposure(status, NOW, { payload: tooMany as never, receivedAt: NOW + 10 } as never);
    expect((merged2.status as { controller: { leaderFills: { netAfter: number } } }).controller.leaderFills.netAfter).toBe(1);
  });
  it('merge: novější zpráva přepíše plnění; starý worker bez pole nechá hodnotu z pollu', () => {
    const status = { startedAt: '2026-11-02T08:00:00.000Z', displaySeq: 4, displayBuiltAt: 5, controller: { leaderFills: ring({ netAfter: 1 }) } } as never;
    const merged = mergeCopierLiveExposure(status, NOW, { payload: payload(ring()) as never, receivedAt: NOW + 10 } as never);
    expect((merged.status as { controller: { leaderFills: { netAfter: number } } }).controller.leaderFills.netAfter).toBe(2);
    const { leaderFills: _omit, ...legacy } = payload(ring());
    const kept = mergeCopierLiveExposure(status, NOW, { payload: legacy as never, receivedAt: NOW + 10 } as never);
    expect((kept.status as { controller: { leaderFills: { netAfter: number } } }).controller.leaderFills.netAfter).toBe(1);
  });
});

describe('controller: plnění leadera ve statusu (jen zobrazení)', () => {
  const group = (): CopyGroupConfig => ({
    id: 'fills-group', name: 'Fills', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyLossLimitUsd: 0, dailyMaxLosingTrades: 0, dailyMaxTrades: 0, entryCooldownMinutes: 0,
      tradingWindow: { enabled: false, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
      dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions) },
  });
  it('fill leadera se objeví v leaderFills; fill followera ne', async () => {
    let now = Date.parse('2026-09-08T16:00:00.000Z');
    const clock = () => now;
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock });
    broker.setConnected(true);
    await runtime.waitForIdle();
    await runtime.reconcile();
    runtime.arm();
    await runtime.waitForIdle();
    try {
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lf1', tag: '', brokerOrderId: 'lo1', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 20_000, filledAt: now } });
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await runtime.waitForIdle();
      now += 1_000;
      broker.emitEvent({ type: 'fill', fill: { fillId: 'ff1', tag: '', brokerOrderId: 'fo1', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 20_000, filledAt: now } });
      await runtime.waitForIdle();
      const fills = runtime.status().leaderFills;
      expect(fills).toMatchObject({ symbol: 'MNQU6', fromFlat: true, netAfter: 1, fills: [{ fillId: 'lf1', role: 'entry', side: 'Buy', price: 20_000 }] });
      expect(fills!.fills).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });
});

describe('controller: mezery a reset šipek (jen zobrazení)', () => {
  const group = (): CopyGroupConfig => ({
    id: 'fills-gap-group', name: 'Fills gap', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyLossLimitUsd: 0, dailyMaxLosingTrades: 0, dailyMaxTrades: 0, entryCooldownMinutes: 0,
      tradingWindow: { enabled: false, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
      dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions) },
  });
  const boot = async () => {
    let now = Date.parse('2026-09-08T16:00:00.000Z');
    const clock = () => now;
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
    const runtime = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock, wait: async () => undefined, leaderFlatGraceMs: 5 });
    broker.setConnected(true);
    await runtime.waitForIdle();
    await runtime.reconcile();
    runtime.arm();
    await runtime.waitForIdle();
    const leaderFill = (fillId: string, side: 'Buy' | 'Sell') => {
      now += 1_000;
      broker.emitEvent({ type: 'fill', fill: { fillId, tag: '', brokerOrderId: `o-${fillId}`, accountId: 100, symbol: 'MNQU6', side, quantity: 1, price: 20_000, filledAt: now } });
    };
    return { broker, runtime, leaderFill, advance: (ms: number) => { now += ms; } };
  };

  it('odpojení uprostřed epizody = mezera (šipky se nekreslí)', async () => {
    const { broker, runtime, leaderFill } = await boot();
    try {
      leaderFill('g1', 'Buy');
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      await runtime.waitForIdle();
      expect(runtime.status().leaderFills).toMatchObject({ fromFlat: true });
      expect(runtime.status().leaderFills?.gap).toBeUndefined();
      broker.setConnected(false);
      await runtime.waitForIdle();
      expect(runtime.status().leaderFills).toMatchObject({ gap: true });
    } finally {
      runtime.stop();
    }
  });

  it('změna skupiny smaže šipky starého nastavení', async () => {
    const { broker, runtime, leaderFill, advance } = await boot();
    try {
      leaderFill('r1', 'Buy');
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 1 } });
      leaderFill('r2', 'Sell');
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 } });
      broker.setPosition(100, 'MNQU6', 0);
      await runtime.waitForIdle();
      expect(runtime.status().leaderFills?.fills).toHaveLength(2);
      // Pojistka po flat leadera musí doběhnout (lhůta podle hodin kopírky), jinak změnu skupiny správně blokuje.
      advance(1_000);
      await new Promise(resolve => setTimeout(resolve, 50));
      await runtime.waitForIdle();
      await runtime.reconfigureGroup(group());
      expect(runtime.status().leaderFills).toBeNull();
    } finally {
      runtime.stop();
    }
  });
});

describe('šipky plnění nikdy neautorizují příkaz (INV-UI-*)', async () => {
  const { readFileSync } = await import('node:fs');
  it('phoneFills jde jen do slotu grafu, nikdy do phoneTrade ani relay', () => {
    const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
    const uses = desk.split('\n').filter(line => /\bphoneFills\b/.test(line)).map(line => line.trim());
    expect(uses.filter(line => !/^const phoneFills = useMemo|^fills: phoneFills\.fills,|^fillsOpen: phoneFills\.open,/.test(line))).toEqual([]);
    const tradeBlock = desk.slice(desk.indexOf('const phoneTrade = useMemo'), desk.indexOf('const phoneFills = useMemo'));
    expect(tradeBlock).not.toMatch(/leaderFills|phoneFills|liveFillMarkers/);
  });
});
