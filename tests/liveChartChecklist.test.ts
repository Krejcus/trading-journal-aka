import { describe, expect, it } from 'vitest';
import {
  createLiveChartIntentStore, entryIntentDraft, liveChartIntentLines, liveChartPositionBaseline, manageIntentDraft, trackLiveChartIntent,
} from '../lib/liveChartIntent';
import { holdLastDrawnPosition, LIVE_CHART_HOLD_LAST_DRAWN_MS, liveChartDrawnMemory, liveChartDrawnMemoryKey, rememberLiveChartDrawn, resetLiveChartDrawnMemoryForTests } from '../lib/liveChartExposureProjection';
import { liveUnverifiedActionBlock } from '../lib/liveChartRiskPolicy';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';

/**
 * Checklist obchodovatelnosti (10. 11. 2026): scénáře na straně grafu. Scénáře workeru
 * (dílčí fill, závod zrušení/fillu, víc ticketů, restart s neznámým výsledkem) hlídají
 * `manualPendingEntryReplay`, `manualScaleIn*`, `manualEntryPlace`, `manualOrderManage`,
 * `liveCancelPending` a `copierStandaloneStopFilledDuringModify`.
 */
const position = (patch: Partial<LiveChartPositionSummary> = {}, key = JSON.stringify(patch)): LiveChartPosition => ({
  key, symbol: 'MNQZ6', lines: [], issue: null,
  summary: { kind: 'position', side: 'long', quantity: 1, entry: 100, entryType: null, openPnl: 0, mark: 101, stop: 90, target: 120,
    protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [], ...patch },
});
const flat: LiveChartPosition = { key: 'none', symbol: null, lines: [], summary: null, issue: null };
const limit = (operationId: string, baseline: LiveChartPosition | null) => entryIntentDraft(
  { symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Limit', price: 99, stopLoss: 90, takeProfit: 120 }, operationId, liveChartPositionBaseline(baseline));

describe('checklist: graf a čekající záměry v okrajových scénářích', () => {
  it('dílčí fill (1/2): záměr zmizí, až ho nahradí nakreslená pozice (změna tvaru), ne dřív', async () => {
    const store = createLiveChartIntentStore();
    await trackLiveChartIntent(store, limit('entry:partial01', null), () => { store.markSent('entry:partial01'); return Promise.resolve({ status: 'acknowledged', operationId: 'entry:partial01' }); });
    store.prune(Date.now(), flat);
    expect(store.snapshot()).toHaveLength(1);
    store.prune(Date.now(), position({ quantity: 1 }));
    expect(store.snapshot()).toEqual([]);
  });

  it('závod zrušení a fillu: worker zrušení odmítne (vstup se vyplnil) → čára „ruším vstup“ zmizí, pozice se kreslí podle brokera', async () => {
    const store = createLiveChartIntentStore();
    const draft = manageIntentDraft('cancel-entry', { symbol: 'MNQZ6', side: 'long', expectPrice: 99, operationId: 'manage:race00001' })!;
    await trackLiveChartIntent(store, draft, () => { store.markSent('manage:race00001'); return Promise.resolve({ status: 'rejected', operationId: 'manage:race00001' }); });
    expect(store.snapshot()).toEqual([]);
  });

  it('restart desku během neznámého výsledku: nová instance nemá starý záměr, pozdní odpověď na starý operationId nic neoživí ani nezdvojí', async () => {
    const before = createLiveChartIntentStore();
    await trackLiveChartIntent(before, limit('entry:restart01', null), () => { before.markSent('entry:restart01'); return Promise.reject(new Error('timeout')); }).catch(() => undefined);
    expect(before.snapshot().map(intent => intent.state)).toEqual(['unknown']);
    const after = createLiveChartIntentStore();
    after.settle('entry:restart01', { status: 'acknowledged' });
    expect(after.snapshot()).toEqual([]);
    // Opakovaný klik s TÝMŽ operationId (relay dedup) nezaloží druhý záměr ani neztratí „odesláno“.
    after.begin(limit('entry:restart02', null));
    after.markSent('entry:restart02');
    after.begin(limit('entry:restart02', null));
    expect(after.snapshot()).toMatchObject([{ operationId: 'entry:restart02', sent: true }]);
    expect(liveChartIntentLines(after.snapshot(), 'MNQZ6').filter(line => line.kind === 'entry')).toHaveLength(1);
  });

  it('pozice z víc ticketů: přikoupení (změna množství 2 → 3) záměr nahradí; stejný tvar ne', async () => {
    const store = createLiveChartIntentStore();
    const before = position({ quantity: 2 });
    await trackLiveChartIntent(store, limit('entry:multi0001', before), () => { store.markSent('entry:multi0001'); return Promise.resolve({ status: 'acknowledged', operationId: 'entry:multi0001' }); });
    store.prune(Date.now(), position({ quantity: 2, openPnl: 50 }));
    expect(store.snapshot()).toHaveLength(1);
    store.prune(Date.now(), position({ quantity: 3 }));
    expect(store.snapshot()).toEqual([]);
  });

  it('review 6bb8ef7 P2: záměr nezmizí bez kreslitelné náhrady (summary.entry = null, žádné čáry)', async () => {
    const store = createLiveChartIntentStore();
    await trackLiveChartIntent(store, limit('entry:noentry01', null), () => { store.markSent('entry:noentry01'); return Promise.resolve({ status: 'acknowledged', operationId: 'entry:noentry01' }); });
    const evidence = { workerEntryOperationIds: new Set(['entry:noentry01']) };
    store.prune(Date.now(), position({ entry: null as never, quantity: 2 }), evidence);
    expect(store.snapshot()).toHaveLength(1);
    store.prune(Date.now(), position({ quantity: 2 }), evidence);
    expect(store.snapshot()).toEqual([]);
    // Ani správa (posun SL) nepřistane na pozici bez ceny vstupu.
    const move = manageIntentDraft('move-stop', { symbol: 'MNQZ6', side: 'long', expectPrice: 90, newPrice: 95, entry: 100, quantity: 1, operationId: 'manage:noentry2' })!;
    store.begin(move);
    store.markSent('manage:noentry2');
    store.settle('manage:noentry2', { status: 'acknowledged' });
    store.prune(Date.now(), position({ entry: null as never, stop: 95 }));
    expect(store.snapshot().map(intent => intent.operationId)).toEqual(['manage:noentry2']);
    store.prune(Date.now(), position({ stop: 95 }));
    expect(store.snapshot()).toEqual([]);
  });

  it('review 6bb8ef7 poznámka: během odesílání záměr nezdvojí už nakreslenou pozici — změna tvaru ho nahradí hned', async () => {
    const store = createLiveChartIntentStore();
    store.begin(limit('entry:sending01', flat));
    store.markSent('entry:sending01');
    store.prune(Date.now(), position({ quantity: 1 }));
    expect(store.snapshot()).toEqual([]);
    // Stejný tvar jako při kliku (už nakreslená pozice) během odesílání nic nesmaže.
    const before = position({ quantity: 2 });
    store.begin(limit('entry:sending02', before));
    store.prune(Date.now(), position({ quantity: 2, openPnl: 9 }));
    expect(store.snapshot()).toHaveLength(1);
  });

  it('neznámý stop-out: držená stará pozice zmizí nejpozději po LIVE_CHART_HOLD_LAST_DRAWN_MS (5 s)', () => {
    expect(LIVE_CHART_HOLD_LAST_DRAWN_MS).toBe(5_000);
    const drawn = position({ quantity: 1 });
    const stale: LiveChartPosition = { ...flat, issue: 'Data brokera jsou zastaralá.', issueKind: 'stale' } as LiveChartPosition;
    const first = holdLastDrawnPosition(null, drawn, 1_000);
    const held = holdLastDrawnPosition(first.memory, stale, 3_000);
    expect(held.shown.summary?.unverified).toBe(true);
    const expired = holdLastDrawnPosition(held.memory, stale, 1_000 + LIVE_CHART_HOLD_LAST_DRAWN_MS + 1);
    expect(expired.shown.summary).toBeNull();
  });

  it('checklist: z neověřené pozice jde snížit riziko, zvýšit ne', () => {
    const summary = { unverified: true, side: 'long' as const, stop: 90 };
    expect(liveUnverifiedActionBlock(summary, { kind: 'close' })).toBeNull();
    expect(liveUnverifiedActionBlock(summary, { kind: 'cancel-entry' })).toBeNull();
    expect(liveUnverifiedActionBlock(summary, { kind: 'add-protection' })).toBeNull();
    expect(liveUnverifiedActionBlock(summary, { kind: 'move-stop', newPrice: 95 })).toBeNull();
    expect(liveUnverifiedActionBlock(summary, { kind: 'move-stop', newPrice: 85 })).toMatch(/rozšířit SL/);
    expect(liveUnverifiedActionBlock(summary, { kind: 'remove-stop' })).toMatch(/odebrat SL/);
    expect(liveUnverifiedActionBlock(summary, { kind: 'scale-in' })).toMatch(/přikoupit/);
    expect(liveUnverifiedActionBlock(summary, { kind: 'entry' })).toMatch(/nový vstup/);
  });

  it('review 6bb8ef7 P2: přepnutí skupiny / leadera / followerů se stale čtením nepodrží pozici jiného leadera', () => {
    resetLiveChartDrawnMemoryForTests();
    const groupA = { id: 'g1', leaderAccountId: 1, followers: [{ accountId: 3 }, { accountId: 2 }] };
    const keyA = liveChartDrawnMemoryKey(groupA, 'group');
    expect(liveChartDrawnMemoryKey({ ...groupA, followers: [{ accountId: 2 }, { accountId: 3 }] }, 'group')).toBe(keyA);
    rememberLiveChartDrawn(keyA, holdLastDrawnPosition(null, position({ quantity: 1 }), 1_000).memory);
    const stale = { ...flat, issue: 'Data brokera jsou zastaralá.', issueKind: 'stale' } as LiveChartPosition;
    expect(holdLastDrawnPosition(liveChartDrawnMemory(keyA, 2_000), stale, 2_000).shown.summary?.unverified).toBe(true);
    for (const other of [
      { ...groupA, id: 'g2' },
      { ...groupA, leaderAccountId: 9 },
      { ...groupA, followers: [{ accountId: 2 }] },
    ]) {
      const key = liveChartDrawnMemoryKey(other, 'group');
      expect(key).not.toBe(keyA);
      expect(holdLastDrawnPosition(liveChartDrawnMemory(key, 2_000), stale, 2_000).shown.summary).toBeNull();
    }
    // Staré záznamy se při čtení zahodí (mapa neroste).
    expect(liveChartDrawnMemory(keyA, 1_000 + LIVE_CHART_HOLD_LAST_DRAWN_MS + 1)).toBeNull();
    rememberLiveChartDrawn(keyA, holdLastDrawnPosition(null, position({ quantity: 1 }), 1_000).memory);
    liveChartDrawnMemory('jiný', 1_000 + LIVE_CHART_HOLD_LAST_DRAWN_MS + 1);
    expect(liveChartDrawnMemory(keyA, 1_000)).toBeNull();
  });

  it('během odesílání: správa nezmizí, ani když pozice už ukazuje cílovou cenu; vstup s důkazem workeru bez změny tvaru také ne', () => {
    const store = createLiveChartIntentStore();
    store.begin(manageIntentDraft('move-stop', { symbol: 'MNQZ6', side: 'long', expectPrice: 90, newPrice: 95, entry: 100, quantity: 1, operationId: 'manage:sending03' })!);
    store.markSent('manage:sending03');
    store.prune(Date.now(), position({ stop: 95 }));
    expect(store.snapshot().map(intent => intent.state)).toEqual(['sending']);
    const before = position({ quantity: 2 });
    store.begin(limit('entry:sending04', before));
    store.markSent('entry:sending04');
    store.prune(Date.now(), position({ quantity: 2, stop: 95 }), { workerEntryOperationIds: new Set(['entry:sending04']) });
    expect(store.snapshot().map(intent => intent.operationId)).toEqual(['manage:sending03', 'entry:sending04']);
  });

  it('změna tvaru nahradí záměr dřív, než přijde výsledek: pozdní rejected / unknown ho neoživí', async () => {
    const store = createLiveChartIntentStore();
    let answer!: (value: { status: string; operationId: string }) => void;
    const tracked = trackLiveChartIntent(store, limit('entry:latefill1', flat), () => { store.markSent('entry:latefill1'); return new Promise<{ status: string; operationId: string }>(resolve => { answer = resolve; }); });
    store.prune(Date.now(), position({ quantity: 1 }));
    expect(store.snapshot()).toEqual([]);
    answer({ status: 'rejected', operationId: 'entry:latefill1' });
    await tracked;
    store.settle('entry:latefill1', { status: 'unknown' });
    expect(store.snapshot()).toEqual([]);
  });
});
