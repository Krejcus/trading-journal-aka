import { describe, expect, it } from 'vitest';
import {
  createLiveChartIntentStore, entryIntentDraft, liveChartIntentLines, liveChartPositionBaseline, manageIntentDraft, trackLiveChartIntent,
} from '../lib/liveChartIntent';
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
});
