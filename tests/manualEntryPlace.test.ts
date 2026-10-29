// Fáze 1b obchodování z grafu: skutečné odeslání ručního OSO na leadera
// (docs/CHART_ORDER_ENTRY_PLAN.md §9, §9.1). Skutečný controller kopírky,
// mock broker; ověřeno chováním.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOsoAck, BrokerOsoRequest } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand, type LeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';

const LEADER = 100;
const FOLLOWER = 200;
const START = Date.UTC(2026, 9, 29, 15, 0, 0); // 10:00 CT, uprostřed session
const group = (): CopyGroupConfig => ({
  id: 'manual-group', name: 'Ruční', enabled: true, leaderAccountId: LEADER,
  followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});
const risk = (accountId: number, at: number): BrokerAccountRiskSnapshot => ({
  accountId, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: 48_000,
  dailyLossAutoLiq: 1_000, trailingMaxDrawdown: 2_000,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Setup {
  broker: MockBroker;
  controller: CopierRuntimeController;
  store: CopierStore;
  audits: string[];
  clock: { now: number };
  command: (patch?: Partial<{ price: number; operationId: string }>) => LeaderEntryPlaceCommand;
  place: (command: LeaderEntryPlaceCommand) => ReturnType<CopierRuntimeController['placeLeaderEntry']>;
}

let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: {
  store?: CopierStore;
  arm?: boolean;
  patchBroker?: (broker: MockBroker) => void;
  timings?: { post?: number; start?: number; legWait?: number };
} = {}): Promise<Setup> {
  const clock = { now: START };
  const broker = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    accountRiskSnapshots: [risk(LEADER, START + 500), risk(FOLLOWER, START + 500)],
  });
  options.patchBroker?.(broker);
  const store = options.store ?? createMemoryCopierStore();
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, ...options.timings },
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  if (options.arm !== false) controller.arm();
  await controller.waitForIdle();
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  const command = (patch: Partial<{ price: number; operationId: string }> = {}) => {
    const status = controller.status();
    const preview = buildLeaderEntryPreviewCommand(
      { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: patch.price ?? 29_500, stopLoss: 29_480, takeProfit: 29_560 },
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:manualtest01' },
    );
    return buildLeaderEntryPlaceCommand(preview, patch.operationId ?? 'entry:manualtest01');
  };
  const place = (entry: LeaderEntryPlaceCommand) => controller.placeLeaderEntry(entry, { deadlineAt: clock.now + 15_000 });
  return { broker, controller, store, audits, clock, command, place };
}

const leaderOso = (broker: MockBroker) => broker.placedOsoRequests().filter(request => request.accountId === LEADER);
const followerOso = (broker: MockBroker) => broker.placedOsoRequests().filter(request => request.accountId === FOLLOWER);

describe('fáze 1b: odeslání ručního vstupu na leadera', () => {
  it('ARMED: náhled bez blockerů → jedno OSO na leadera a kopírka ho rozkopíruje followerovi se stejnými cenami', async () => {
    const ctx = await setup();
    const preview = ctx.controller.previewLeaderEntry({ ...ctx.command(), type: 'preview-leader-entry', operationId: 'preview:manualcheck1' } as never);
    expect(preview.blockers).toEqual([]);
    const result = await ctx.place(ctx.command());
    expect(result).toMatchObject({ status: 'acknowledged', blockers: [] });
    expect(result.entryBrokerOrderId && result.stopBrokerOrderId && result.targetBrokerOrderId).toBeTruthy();
    await sleep(50);
    await ctx.controller.waitForIdle();
    const [sent] = leaderOso(ctx.broker);
    expect(leaderOso(ctx.broker)).toHaveLength(1);
    expect(sent).toMatchObject({
      accountId: LEADER, symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 29_500,
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 29_480 },
      second: { side: 'Sell', orderType: 'Limit', limitPrice: 29_560 },
    });
    expect(sent.tag).toMatch(/^me[0-9a-f]{14}$/);
    // Soulad náhledu s kopírováním: follower dostal nativní OSO se stejnými cenami a qty z náhledu.
    const copies = followerOso(ctx.broker);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ quantity: preview.wouldPlace!.followers[0].quantity, limitPrice: 29_500,
      first: { stopPrice: 29_480 }, second: { limitPrice: 29_560 } });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    const stored = (await ctx.store.load()).safety?.manualEntries ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ operationId: 'entry:manualtest01', status: 'acknowledged', entryBrokerOrderId: result.entryBrokerOrderId });
  });

  it('stejné operationId se nikdy nepošle znovu; jiný obsah se stejným id = blocked', async () => {
    const ctx = await setup();
    const first = await ctx.place(ctx.command());
    const again = await ctx.place(ctx.command());
    expect(again).toMatchObject({ status: 'acknowledged', entryBrokerOrderId: first.entryBrokerOrderId });
    const conflict = await ctx.place(ctx.command({ price: 29_499 }));
    expect(conflict.status).toBe('blocked');
    expect(conflict.blockers.map(issue => issue.code)).toContain('operation-conflict');
    expect(leaderOso(ctx.broker)).toHaveLength(1);
  });

  it('další vstup hned po přijatém: brána klidu skupiny ho zastaví (id z ACK jsou pracovní příkazy)', async () => {
    const ctx = await setup();
    expect((await ctx.place(ctx.command())).status).toBe('acknowledged');
    const second = await ctx.place(ctx.command({ operationId: 'entry:manualtest02' }));
    expect(second.status).toBe('blocked');
    expect(second.blockers.map(issue => issue.code)).toContain('account-not-flat');
    expect(leaderOso(ctx.broker)).toHaveLength(1);
  });

  it('DISARMED: blocked, nic se nezapíše k brokerovi ani do úložiště', async () => {
    const ctx = await setup({ arm: false });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('blocked');
    expect(leaderOso(ctx.broker)).toEqual([]);
    expect((await ctx.store.load()).safety?.manualEntries ?? []).toEqual([]);
  });

  it('vypršelá platnost = blocked bez zápisu', async () => {
    const ctx = await setup();
    const result = await ctx.controller.placeLeaderEntry(ctx.command(), { deadlineAt: ctx.clock.now + 500 });
    expect(result.blockers.map(issue => issue.code)).toContain('expired');
    expect(leaderOso(ctx.broker)).toEqual([]);
  });

  it('timeout POSTu = unknown bez retry; blokuje další vstup i ARM, vyřeší ho jen ruční waiver', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => (request.accountId === LEADER
          ? new Promise<BrokerOsoAck>(() => undefined)
          : real(request));
      },
    });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('unknown');
    expect(ctx.controller.status().manualEntries?.[0]).toMatchObject({ status: 'unknown' });
    const next = await ctx.place(ctx.command({ operationId: 'entry:manualtest03' }));
    expect(next.blockers.map(issue => issue.code)).toContain('manual-entry-unresolved');
    ctx.controller.disarm('manual');
    expect(() => ctx.controller.arm()).toThrow(/ruční vstup/);
    await ctx.controller.waiveManualEntry({ operationId: 'entry:manualtest01', reason: 'ověřeno v Tradovate, nic nevzniklo' });
    expect(ctx.controller.status().manualEntries?.[0]).toMatchObject({ status: 'waived' });
    expect(ctx.controller.status().reconciliationRequired).toBe(true);
  });

  it('ACK se vstupem bez nohou = abandoned + incident (bez auto-close) + jediné cílené zrušení vstupu', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => (request.accountId === LEADER
          ? { entryBrokerOrderId: 'lead-entry-1', firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: true, definitive: false }
          : real(request));
      },
    });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('abandoned');
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError).toBeTruthy();
    expect(ctx.broker.cancelRequestCount('lead-entry-1')).toBe(1);
    expect(ctx.broker.liquidateRequests()).toEqual([]);
    const stored = (await ctx.store.load()).safety?.manualEntries?.[0];
    expect(stored).toMatchObject({ status: 'abandoned', cancel: { status: 'sent' } });
  });

  it('definitivní odmítnutí bez id = rejected, kopírka zůstává zapnutá', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => (request.accountId === LEADER
          ? { entryBrokerOrderId: '', firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: false, definitive: true, rejectReason: 'Price outside limits' }
          : real(request));
      },
    });
    const result = await ctx.place(ctx.command());
    expect(result).toMatchObject({ status: 'rejected' });
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
  });

  it('vlastní vstup, ke kterému nedorazí nohy: nikdy se nekopíruje samostatně, incident + zrušení vstupu', async () => {
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => {
          if (request.accountId !== LEADER) return real(request);
          // Broker vrátí id všech tří, ale stream ukáže jen vstup.
          broker.emitEvent({ type: 'order', order: {
            tag: request.tag, brokerOrderId: 'lone-entry', accountId: LEADER, symbol: request.symbol, side: request.side,
            orderType: 'Limit', quantity: 1, filledQuantity: 0, limitPrice: request.limitPrice, status: 'working',
            sourceVersion: '1', updatedAt: Date.now(),
          } });
          return { entryBrokerOrderId: 'lone-entry', firstBrokerOrderId: 'lone-s', secondBrokerOrderId: 'lone-t', accepted: true, definitive: true };
        };
      },
    });
    expect((await ctx.place(ctx.command())).status).toBe('acknowledged');
    // Hodiny controlleru běží dál: okno OSO i čekání na nohy uplynou.
    for (let step = 0; step < 8; step += 1) {
      ctx.clock.now += 300;
      await sleep(120);
    }
    await ctx.controller.waitForIdle();
    expect(ctx.audits.some(entry => entry.includes('ochranné nohy nedorazily'))).toBe(true);
    expect(followerOso(ctx.broker)).toEqual([]);
    expect(ctx.broker.placedRequests().filter(request => request.accountId === FOLLOWER)).toEqual([]);
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.broker.cancelRequestCount('lone-entry')).toBe(1);
  });

  it('brzda během POSTu: ACK přijde za DISARMED → vlastní vstup se hned zruší, follower nic', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>(resolve => { release = resolve; });
    let ctxRef: Setup | null = null;
    const ctx = await setup({
      timings: { post: 2_000 },
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => {
          if (request.accountId !== LEADER) return real(request);
          await gateOpen;
          return real(request);
        };
      },
    });
    ctxRef = ctx;
    const pending = ctx.place(ctx.command());
    await sleep(30);
    ctxRef.controller.disarm('manual');
    release();
    const result = await pending;
    expect(result.status).toBe('acknowledged');
    await sleep(50);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount(result.entryBrokerOrderId!)).toBe(1);
    expect(followerOso(ctx.broker)).toEqual([]);
  });

  it('event od brokera během ukládání `sending` = not-sent, žádný POST (fence z příchodu eventů)', async () => {
    const memory = createMemoryCopierStore();
    let broker!: MockBroker;
    let fired = false;
    const store: CopierStore = {
      ...memory,
      commit: async (snapshot, revision) => {
        if (!fired && snapshot.safety?.manualEntries?.some(entry => entry.status === 'sending')) {
          fired = true;
          broker.emitEvent({ type: 'position', position: { accountId: FOLLOWER, symbol: 'MNQZ6', netQuantity: 0 } });
        }
        return memory.commit(snapshot, revision);
      },
    };
    const ctx = await setup({ store, patchBroker: created => { broker = created; } });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('blocked');
    expect(result.blockers.map(issue => issue.code)).toContain('state-changed');
    expect(leaderOso(ctx.broker)).toEqual([]);
    expect((await memory.load()).safety?.manualEntries?.[0]).toMatchObject({ status: 'not-sent' });
  });

  it('restart se záznamem `sending` → unknown, nikdy znovu neodesláno', async () => {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    first.controller.stop();
    active = null;
    const snapshot = await store.load();
    await store.commit({
      ...snapshot,
      safety: { ...snapshot.safety!, manualEntries: [{
        operationId: 'entry:restarted01', payloadHash: 'abcdefgh12', tag: 'me0123456789abcd', status: 'sending',
        createdAt: START, updatedAt: START,
        request: { accountId: LEADER, symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560 },
      }] },
    }, snapshot.revision);
    const second = await setup({ store, arm: false });
    expect(second.controller.status().manualEntries?.[0]).toMatchObject({ operationId: 'entry:restarted01', status: 'unknown' });
    expect((await store.load()).safety?.manualEntries?.[0].status).toBe('unknown');
    expect(leaderOso(second.broker)).toEqual([]);
  });
});

describe('fáze 1b: oprava po oponentuře diffu (M1–M3)', () => {
  it('M1: řídicí event mezi zařazením a startem → blocked, žádný POST', async () => {
    const ctx = await setup();
    const pending = ctx.place(ctx.command());
    // Synchronně hned po zařazení: úloha ještě nezačala, `gate` o eventu neví.
    ctx.broker.emitEvent({ type: 'error', error: new Error('ws transport error'), at: ctx.clock.now });
    const result = await pending;
    expect(result.status).toBe('blocked');
    expect(result.blockers.map(issue => issue.code)).toContain('state-changed');
    expect(leaderOso(ctx.broker)).toEqual([]);
  });

  it('M2: selhání uložení výsledku po ACK vrátí pravdu od brokera (ne chybu) a vypne kopírku', async () => {
    const memory = createMemoryCopierStore();
    const store: CopierStore = {
      ...memory,
      commit: async (snapshot, revision) => {
        if (snapshot.safety?.manualEntries?.some(entry => entry.status === 'acknowledged')) throw new Error('disk full');
        return memory.commit(snapshot, revision);
      },
    };
    const ctx = await setup({ store });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('acknowledged');
    expect(result.reason).toMatch(/nepodařilo uložit/);
    expect(ctx.controller.status().armed).toBe(false);
  });

  it('M2: abandoned se zrušením i když uložení výsledku selže', async () => {
    const memory = createMemoryCopierStore();
    const store: CopierStore = {
      ...memory,
      commit: async (snapshot, revision) => {
        if (snapshot.safety?.manualEntries?.some(entry => entry.status !== 'sending')) throw new Error('disk full');
        return memory.commit(snapshot, revision);
      },
    };
    const ctx = await setup({
      store,
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => (request.accountId === LEADER
          ? { entryBrokerOrderId: 'm2-entry', firstBrokerOrderId: '', secondBrokerOrderId: '', accepted: true, definitive: false }
          : real(request));
      },
    });
    const result = await ctx.place(ctx.command());
    expect(result.status).toBe('abandoned');
    await sleep(30);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount('m2-entry')).toBe(1);
    expect(ctx.controller.status().armed).toBe(false);
  });

  it('M3a: brzda po ACK, ale před zpracováním eventů OSO → vlastní vstup se zruší, follower nic', async () => {
    let brokerRef!: MockBroker;
    const ctx = await setup({
      patchBroker: broker => {
        brokerRef = broker;
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => {
          if (request.accountId !== LEADER) return real(request);
          // Eventy OSO dorazí až ~30 ms po ACK (jako WS za REST).
          setTimeout(() => {
            const base = { tag: request.tag, accountId: LEADER, symbol: request.symbol, quantity: 1, filledQuantity: 0, status: 'working' as const, sourceVersion: '1', updatedAt: Date.now() };
            brokerRef.emitEvent({ type: 'order', order: { ...base, brokerOrderId: 'm3-e', side: request.side, orderType: 'Limit', limitPrice: request.limitPrice } });
            brokerRef.emitEvent({ type: 'order', order: { ...base, brokerOrderId: 'm3-s', side: 'Sell', orderType: 'Stop', stopPrice: request.first.stopPrice, parentOrderId: 'm3-e', ocoId: 'm3-t' } });
            brokerRef.emitEvent({ type: 'order', order: { ...base, brokerOrderId: 'm3-t', side: 'Sell', orderType: 'Limit', limitPrice: request.second.limitPrice, parentOrderId: 'm3-e', ocoId: 'm3-s' } });
          }, 30);
          return { entryBrokerOrderId: 'm3-e', firstBrokerOrderId: 'm3-s', secondBrokerOrderId: 'm3-t', accepted: true, definitive: true };
        };
      },
    });
    expect((await ctx.place(ctx.command())).status).toBe('acknowledged');
    ctx.controller.disarm('manual');
    await sleep(120);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount('m3-e')).toBe(1);
    expect(followerOso(ctx.broker)).toEqual([]);
  });

  it('M3b: timeout, brzda a pozdní ACK → vlastní vstup se zruší', async () => {
    let resolveLate!: (ack: BrokerOsoAck) => void;
    const ctx = await setup({
      patchBroker: broker => {
        const real = broker.placeOso!.bind(broker);
        broker.placeOso = async (request: BrokerOsoRequest) => (request.accountId === LEADER
          ? new Promise<BrokerOsoAck>(resolve => { resolveLate = resolve; })
          : real(request));
      },
    });
    expect((await ctx.place(ctx.command())).status).toBe('unknown');
    ctx.controller.disarm('manual');
    resolveLate({ entryBrokerOrderId: 'late-e', firstBrokerOrderId: 'late-s', secondBrokerOrderId: 'late-t', accepted: true, definitive: true });
    await sleep(50);
    await ctx.controller.waitForIdle();
    expect(ctx.broker.cancelRequestCount('late-e')).toBe(1);
    expect((await ctx.store.load()).safety?.manualEntries?.[0]).toMatchObject({ status: 'unknown', lateResult: { entryBrokerOrderId: 'late-e' } });
  });

  it('nevyřešený ruční vstup se v LIVE ukáže jako položka k ručnímu vyřešení', async () => {
    const { manualEntryDisplayStuckOperations } = await import('../lib/manualEntryDisplay');
    expect(manualEntryDisplayStuckOperations({ manualEntries: [
      { operationId: 'entry:a', status: 'unknown', createdAt: 1, updatedAt: 2, symbol: 'MNQZ6', side: 'Buy', quantity: 1 },
      { operationId: 'entry:b', status: 'acknowledged', createdAt: 1, updatedAt: 2, symbol: 'MNQZ6', side: 'Buy', quantity: 1 },
    ] })).toEqual([expect.objectContaining({ kind: 'manual-entry', key: 'entry:a', status: 'unknown' })]);
  });
});

describe('OSO okno: zdržená fronta controlleru nesmí nohy předběhnout časovačem (oponentura 1b, P1)', () => {
  it('API OSO z fixture se zpožděním zpracování 2 s a pomalým úložištěm → nativní OSO followera, ne lone-leg', async () => {
    const recording = JSON.parse(readFileSync('tests/fixtures/tradovate-leader-oso-api-cancel.json', 'utf8'));
    const leader = 1001;
    let now = recording.events[0].event.receivedAt - 1000;
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const memory = createMemoryCopierStore();
    let slow = false;
    const store: CopierStore = {
      ...memory,
      commit: async (snapshot, revision) => {
        if (slow) await sleep(5);
        return memory.commit(snapshot, revision);
      },
    };
    const audits: string[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store, clock: () => now,
      group: { id: 'g', name: 'g', enabled: true, leaderAccountId: leader, followers: [{ accountId: FOLLOWER, mode: 'on-submit', multiplier: 1 }], localOnly: true },
      onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
    });
    active = controller;
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    slow = true;
    for (const item of recording.events.filter((entry: { t: number }) => entry.t < 6_000)) {
      now = Math.max(now, item.event.receivedAt);
      broker.emitEvent({ ...item.event, order: { tag: '', ...item.event.order } });
    }
    now += 2_000; // fronta stála (např. za POSTem ručního vstupu)
    await sleep(50);
    now += 2_000;
    await sleep(300);
    await controller.waitForIdle();
    expect(audits.some(entry => entry.includes('oso-lone-leg'))).toBe(false);
    expect(broker.placedOsoRequests().filter(request => request.accountId === FOLLOWER)).toHaveLength(1);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
  });
});
