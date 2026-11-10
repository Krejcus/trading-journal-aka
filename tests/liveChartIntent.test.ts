import { describe, expect, it } from 'vitest';
import {
  LIVE_INTENT_SETTLED_HOLD_MS, bareLegIntentDraft, createLiveChartIntentStore, entryIntentDraft, liveChartIntentLines,
  manageIntentDraft, sameTick, trackLiveChartIntent, withLiveChartIntentLines,
} from '../lib/liveChartIntent';
import { liveChartNotSent } from '../lib/liveChartNotSent';
import { isLiveDisplayOnlyLine } from '../lib/liveWorkingOrderLines';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';

let clock = 1_000;
const store = () => createLiveChartIntentStore({ now: () => clock });
const position = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPosition => ({
  key: JSON.stringify(patch), symbol: 'MNQZ6', lines: [], issue: null,
  summary: { kind: 'position', side: 'long', quantity: 1, entry: 100, entryType: null, openPnl: 0, mark: 101, stop: 90, target: 120,
    protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [], ...patch },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const moveStop = (price: number) => manageIntentDraft('move-stop', { symbol: 'MNQZ6', side: 'long', expectPrice: 90, newPrice: price, operationId: 'manage:abcdefgh1' });

describe('čekající záměr v LIVE grafu', () => {
  it('čára vznikne synchronně při kliku, ještě před odpovědí workeru, a je jen pro zobrazení', () => {
    const intents = store();
    const pending = deferred<{ status: string; operationId: string }>();
    void trackLiveChartIntent(intents, moveStop(95), () => pending.promise);
    const [line] = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(line).toMatchObject({ price: 95, kind: 'stopLoss', draggable: false, cancellable: false, displayOnly: true, lineStyle: 'dotted' });
    expect(line.label).toMatch(/odesílám/);
    expect(intents.snapshot()[0].operationId).toBe('manage:abcdefgh1');
    // Handlery PC i telefonu takovou čáru ignorují — z čekající čáry nic neodejde.
    expect(isLiveDisplayOnlyLine(line)).toBe(true);
  });

  it('odmítnutí, blokace i „nic se neodeslalo“ čáru hned vrátí (zmizí)', async () => {
    for (const run of [
      () => Promise.resolve({ status: 'rejected', operationId: 'manage:x1234567' }),
      () => Promise.resolve({ status: 'blocked', operationId: 'manage:x1234567' }),
      () => Promise.reject(liveChartNotSent('Stav kopírky není čerstvě ověřený — nic se neodeslalo.')),
    ]) {
      const intents = store();
      await trackLiveChartIntent(intents, moveStop(95), run).catch(() => undefined);
      expect(intents.snapshot()).toEqual([]);
    }
  });

  it('ACK čáru nepotvrdí jako ochranu: zůstává tlumená „přijato“, dokud cenu neukáže broker', async () => {
    const intents = store();
    await trackLiveChartIntent(intents, moveStop(95), () => Promise.resolve({ status: 'acknowledged', operationId: 'manage:real1234' }));
    const [line] = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(line).toMatchObject({ displayOnly: true, draggable: false, cancellable: false, color: '#94a3b8' });
    expect(line.color).not.toBe('#ef4444');
    expect(line.label).toMatch(/přijato · čekám na stav brokera/);
    expect(intents.snapshot()[0]).toMatchObject({ state: 'acknowledged', operationId: 'manage:real1234' });
    intents.prune(clock, position({ stop: 90 }));
    expect(intents.snapshot()).toHaveLength(1);
    // Neověřená projekce cíl nepotvrzuje.
    intents.prune(clock, position({ stop: 95, unverified: true }));
    expect(intents.snapshot()).toHaveLength(1);
    intents.prune(clock, position({ stop: 95 }));
    expect(intents.snapshot()).toEqual([]);
    // Zaokrouhlení na tick (0.25) čáru složí; jiný tick ne.
    const rounded = store();
    rounded.begin(moveStop(95.02)!);
    rounded.settle(rounded.snapshot()[0].id, { status: 'acknowledged' });
    expect(sameTick(95.02, 95)).toBe(true);
    rounded.prune(clock, position({ stop: 95 }));
    expect(rounded.snapshot()).toEqual([]);
    const otherTick = store();
    otherTick.begin(moveStop(95.2)!);
    otherTick.settle(otherTick.snapshot()[0].id, { status: 'acknowledged' });
    otherTick.prune(clock, position({ stop: 95 }));
    expect(otherTick.snapshot()).toHaveLength(1);
  });

  it('věta „nic se neodeslalo“ bez kódu není důkaz, že příkaz neodešel', async () => {
    const intents = store();
    await trackLiveChartIntent(intents, moveStop(95), () => Promise.reject(new Error('nic se neodeslalo'))).catch(() => undefined);
    expect(intents.snapshot()[0]?.state).toBe('unknown');
    const relay = Object.assign(new Error('copier-relay-entry-busy'), { name: 'TradovateRequestError', status: 409 });
    const second = store();
    await trackLiveChartIntent(second, moveStop(95), () => Promise.reject(relay)).catch(() => undefined);
    expect(second.snapshot()).toEqual([]);
  });

  it('neznámý výsledek = „výsledek neznámý“, po čase zmizí; nic se neopakuje', async () => {
    const intents = store();
    let calls = 0;
    await trackLiveChartIntent(intents, moveStop(95), () => { calls += 1; return Promise.reject(new Error('timeout')); }).catch(() => undefined);
    expect(calls).toBe(1);
    expect(liveChartIntentLines(intents.snapshot(), 'MNQZ6')[0].label).toMatch(/výsledek neznámý/);
    clock += LIVE_INTENT_SETTLED_HOLD_MS + 1;
    intents.prune(clock, position());
    expect(intents.snapshot()).toEqual([]);
  });

  it('odebrání SL: tlumené „ruším SL“ na dosavadní ceně; skutečná SL čára (read model) zůstává, dokud broker nepotvrdí odstranění', async () => {
    const intents = store();
    const draft = bareLegIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1 }, { kind: 'remove', leg: 'stopLoss', stop: 90, target: null });
    await trackLiveChartIntent(intents, draft, () => Promise.resolve({ status: 'acknowledged', operationId: 'manage:rm123456' }));
    expect(liveChartIntentLines(intents.snapshot(), 'MNQZ6')[0]).toMatchObject({ price: 90, label: expect.stringMatching(/ruším SL/) });
    intents.prune(clock, position({ stop: 90 }));
    expect(intents.snapshot()).toHaveLength(1);
    intents.prune(clock, position({ stop: null }));
    expect(intents.snapshot()).toEqual([]);
  });

  it('vstup Market/Limit: čára vstupu i SL/TP na ceně, kterou uživatel viděl; jiný kontrakt grafu nic nekreslí', () => {
    const intents = store();
    intents.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Sell', quantity: 2, orderType: 'Market', referencePrice: 100, stopLoss: 110, takeProfit: 80 }, 'entry:abcdefgh1'));
    const lines = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(lines.map(line => [line.kind, line.price])).toEqual([['entry', 100], ['stopLoss', 110], ['takeProfit', 80]]);
    expect(lines[0].label).toMatch(/SELL 2 MARKET/);
    expect(liveChartIntentLines(intents.snapshot(), 'MNQH7')).toEqual([]);
  });

  it('přikoupení neskončí jen proto, že strana už sedí; vstup z flatu ano, až když dorazí qty a SL', () => {
    const scale = store();
    scale.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 100, baselineQuantity: 2 }, 'entry:scalein01'));
    scale.settle(scale.snapshot()[0].id, { status: 'acknowledged' });
    scale.prune(clock, position({ side: 'long', quantity: 2 }));
    expect(scale.snapshot()).toHaveLength(1);
    scale.prune(clock, position({ side: 'long', quantity: 3 }));
    expect(scale.snapshot()).toEqual([]);
    const freshEntry = store();
    freshEntry.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: 100, stopLoss: 90, baselineQuantity: 0 }, 'entry:fresh0001'));
    freshEntry.settle(freshEntry.snapshot()[0].id, { status: 'acknowledged' });
    freshEntry.prune(clock, position({ side: 'long', quantity: 2, stop: 90.1 }));
    expect(freshEntry.snapshot()).toEqual([]);
    const waitingStop = store();
    waitingStop.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: 100, stopLoss: 90, baselineQuantity: 0 }, 'entry:waitstop1'));
    waitingStop.settle(waitingStop.snapshot()[0].id, { status: 'acknowledged' });
    waitingStop.prune(clock, position({ side: 'long', quantity: 2, stop: 80 }));
    expect(waitingStop.snapshot()).toHaveLength(1);
  });

  it('záměry jdou do kanálu pracujících příkazů (PC i telefon) a mění jen jeho obsahový klíč', () => {
    const intents = store();
    const empty = { lines: [], badges: [], key: 'none', contract: null };
    expect(withLiveChartIntentLines(empty, intents.snapshot(), 'MNQZ6')).toBe(empty);
    intents.begin(moveStop(95)!);
    const merged = withLiveChartIntentLines(empty, intents.snapshot(), 'MNQZ6');
    expect(merged.contract).toBe('MNQZ6');
    expect(merged.lines).toHaveLength(1);
    expect(merged.key).not.toBe('none');
  });
});
