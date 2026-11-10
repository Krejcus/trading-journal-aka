import { describe, expect, it } from 'vitest';
import {
  LIVE_INTENT_SENDING_MAX_MS, LIVE_INTENT_SETTLED_HOLD_MS, bareLegIntentDraft, createLiveChartIntentStore, entryIntentDraft, liveChartIntentLines,
  manageIntentDraft, trackLiveChartIntent, withLiveChartIntentLines, type LiveChartIntentStore,
} from '../lib/liveChartIntent';
import { LiveCommandNotSentError } from '../lib/liveCommandErrors';
import { isLiveDisplayOnlyLine } from '../lib/liveWorkingOrderLines';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';

let clock = 1_000;
const store = () => createLiveChartIntentStore({ now: () => clock });
const position = (patch: Partial<LiveChartPositionSummary> = {}, key = JSON.stringify(patch)): LiveChartPosition => ({
  key, symbol: 'MNQZ6', lines: [], issue: null,
  summary: { kind: 'position', side: 'long', quantity: 1, entry: 100, entryType: null, openPnl: 0, mark: 101, stop: 90, target: 120,
    protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [], ...patch },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const OP = 'manage:abcdefgh1';
const moveStop = (price: number, operationId = OP) => manageIntentDraft('move-stop', { symbol: 'MNQZ6', side: 'long', expectPrice: 90, newPrice: price, operationId })!;
/** Jako desk: relay obal označí záměr odeslaný, pak teprve požadavek. */
const sent = <T,>(intents: LiveChartIntentStore, operationId: string, result: () => Promise<T>) => () => { intents.markSent(operationId); return result(); };
const ack = (operationId = OP) => ({ status: 'acknowledged', operationId });
const states = (intents: LiveChartIntentStore) => intents.snapshot().map(intent => [intent.operationId, intent.state]);

describe('čekající záměr v LIVE grafu', () => {
  it('čára vznikne synchronně při kliku, pod operationId příkazu, a je jen pro zobrazení', () => {
    const intents = store();
    const pending = deferred<{ status: string; operationId: string }>();
    void trackLiveChartIntent(intents, moveStop(95), () => pending.promise);
    const [line] = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(line).toMatchObject({ id: `live-working:intent:${OP}:stopLoss`, price: 95, kind: 'stopLoss', draggable: false, cancellable: false, displayOnly: true, lineStyle: 'dotted' });
    expect(line.label).toMatch(/odesílám/);
    expect(states(intents)).toEqual([[OP, 'sending']]);
    // Handlery PC i telefonu takovou čáru ignorují — z čekající čáry nic neodejde.
    expect(isLiveDisplayOnlyLine(line)).toBe(true);
  });

  it('odmítnutí a blokace se stejným operationId čáru hned vrátí (zmizí)', async () => {
    for (const status of ['rejected', 'blocked', 'abandoned']) {
      const intents = store();
      await trackLiveChartIntent(intents, moveStop(95), sent(intents, OP, () => Promise.resolve({ status, operationId: OP })));
      expect(intents.snapshot()).toEqual([]);
    }
  });

  it('„neodesláno“ se pozná strukturálně, ne textem chyby', async () => {
    // Výjimka dřív, než relay požadavek odešel (markSent nebyl) = návrat, ať je text jakýkoli.
    const before = store();
    await trackLiveChartIntent(before, moveStop(95), () => Promise.reject(new Error('timeout'))).catch(() => undefined);
    expect(before.snapshot()).toEqual([]);
    // Po odeslání = výsledek neznámý, i když text zní jako „nic se neodeslalo“.
    const after = store();
    await trackLiveChartIntent(after, moveStop(95), sent(after, OP, () => Promise.reject(new Error('Stav není čerstvě ověřený — nic se neodeslalo.')))).catch(() => undefined);
    expect(states(after)).toEqual([[OP, 'unknown']]);
    // Typ chyby `not-sent` čáru vrátí vždy.
    const typed = store();
    await trackLiveChartIntent(typed, moveStop(95), sent(typed, OP, () => Promise.reject(new LiveCommandNotSentError('cokoli')))).catch(() => undefined);
    expect(typed.snapshot()).toEqual([]);
  });

  it('výsledek s jiným operationId se nepáruje naslepo: neznámý výsledek, ne potvrzení ani návrat', async () => {
    const intents = store();
    await trackLiveChartIntent(intents, moveStop(95), sent(intents, OP, () => Promise.resolve({ status: 'rejected', operationId: 'manage:other12345' })));
    expect(states(intents)).toEqual([[OP, 'unknown']]);
  });

  it('timeout: „odesílám“ po 45 s zmizí a pozdní odpověď na tentýž operationId ho neoživí ani nezmění jiný záměr', async () => {
    const intents = store();
    const late = deferred<{ status: string; operationId: string }>();
    const tracked = trackLiveChartIntent(intents, moveStop(95), sent(intents, OP, () => late.promise));
    clock += LIVE_INTENT_SENDING_MAX_MS + 1;
    intents.prune(clock, position());
    expect(intents.snapshot()).toEqual([]);
    intents.begin(moveStop(97, 'manage:second1234'));
    late.resolve(ack());
    await tracked;
    expect(states(intents)).toEqual([['manage:second1234', 'sending']]);
  });

  it('ACK čáru nepotvrdí jako ochranu: zůstává tlumená „přijato“, dokud cenu neukáže broker, nejdéle 20 s', async () => {
    const intents = store();
    await trackLiveChartIntent(intents, moveStop(95), sent(intents, OP, () => Promise.resolve(ack())));
    const [line] = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(line).toMatchObject({ displayOnly: true, draggable: false, cancellable: false, color: '#94a3b8' });
    expect(line.color).not.toBe('#ef4444');
    expect(line.label).toMatch(/přijato · čekám na stav brokera/);
    intents.prune(clock, position({ stop: 90 }));
    expect(intents.snapshot()).toHaveLength(1);
    // Neověřená projekce cíl nepotvrzuje.
    intents.prune(clock, position({ stop: 95, unverified: true }));
    expect(intents.snapshot()).toHaveLength(1);
    intents.prune(clock, position({ stop: 95 }));
    expect(intents.snapshot()).toEqual([]);
    const held = store();
    await trackLiveChartIntent(held, moveStop(95), sent(held, OP, () => Promise.resolve(ack())));
    clock += LIVE_INTENT_SETTLED_HOLD_MS + 1;
    held.prune(clock, position({ stop: 90 }));
    expect(held.snapshot()).toEqual([]);
  });

  it('neznámý výsledek = „výsledek neznámý“, po čase zmizí; nic se neopakuje', async () => {
    const intents = store();
    let calls = 0;
    await trackLiveChartIntent(intents, moveStop(95), sent(intents, OP, () => { calls += 1; return Promise.reject(new Error('timeout')); })).catch(() => undefined);
    expect(calls).toBe(1);
    expect(liveChartIntentLines(intents.snapshot(), 'MNQZ6')[0].label).toMatch(/výsledek neznámý/);
    clock += LIVE_INTENT_SETTLED_HOLD_MS + 1;
    intents.prune(clock, position());
    expect(intents.snapshot()).toEqual([]);
  });

  it('odebrání SL: tlumené „ruším SL“ na dosavadní ceně; skutečná SL čára (read model) zůstává, dokud broker nepotvrdí odstranění', async () => {
    const intents = store();
    const draft = bareLegIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1 }, { kind: 'remove', leg: 'stopLoss', stop: 90, target: null }, 'manage:rm123456');
    await trackLiveChartIntent(intents, draft, sent(intents, 'manage:rm123456', () => Promise.resolve(ack('manage:rm123456'))));
    expect(liveChartIntentLines(intents.snapshot(), 'MNQZ6')[0]).toMatchObject({ price: 90, label: expect.stringMatching(/ruším SL/) });
    intents.prune(clock, position({ stop: 90 }));
    expect(intents.snapshot()).toHaveLength(1);
    intents.prune(clock, position({ stop: null }));
    expect(intents.snapshot()).toEqual([]);
  });

  it('stará pozice vs. nový vstup: stará pozice téže strany vstup nepotvrdí, až změna pozice', async () => {
    const intents = store();
    const old = position({}, 'old-long-1');
    const draft = entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'entry:abcdefgh1', old.key);
    await trackLiveChartIntent(intents, draft, sent(intents, 'entry:abcdefgh1', () => Promise.resolve(ack('entry:abcdefgh1'))));
    intents.prune(clock, old);
    expect(intents.snapshot()).toHaveLength(1);
    intents.prune(clock, position({ quantity: 2 }, 'long-2'));
    expect(intents.snapshot()).toEqual([]);
  });

  it('změna jen ověřenosti (přípona „neověřeno“) vstup nepotvrdí; opakovaný begin téhož operationId neztratí „odesláno“', async () => {
    const intents = store();
    const old = position({}, 'pos-a|neověřeno');
    intents.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'entry:abcdefgh2', old.key));
    intents.markSent('entry:abcdefgh2');
    intents.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'entry:abcdefgh2', old.key));
    expect(intents.snapshot()).toMatchObject([{ operationId: 'entry:abcdefgh2', sent: true }]);
    intents.settle('entry:abcdefgh2', { status: 'acknowledged' });
    intents.prune(clock, position({}, 'pos-a'));
    expect(intents.snapshot()).toHaveLength(1);
  });

  it('vstup Market/Limit: čára vstupu i SL/TP na ceně, kterou uživatel viděl; jiný kontrakt grafu nic nekreslí', () => {
    const intents = store();
    intents.begin(entryIntentDraft({ symbol: 'MNQZ6', side: 'Sell', quantity: 2, orderType: 'Market', referencePrice: 100, stopLoss: 110, takeProfit: 80 }, 'entry:abcdefgh1', null));
    const lines = liveChartIntentLines(intents.snapshot(), 'MNQZ6');
    expect(lines.map(line => [line.kind, line.price])).toEqual([['entry', 100], ['stopLoss', 110], ['takeProfit', 80]]);
    expect(lines[0].label).toMatch(/SELL 2 MARKET/);
    expect(liveChartIntentLines(intents.snapshot(), 'MNQH7')).toEqual([]);
  });

  it('záměry jdou do kanálu pracujících příkazů (PC i telefon) a mění jen jeho obsahový klíč', () => {
    const intents = store();
    const empty = { lines: [], badges: [], key: 'none', contract: null };
    expect(withLiveChartIntentLines(empty, intents.snapshot(), 'MNQZ6')).toBe(empty);
    intents.begin(moveStop(95));
    const merged = withLiveChartIntentLines(empty, intents.snapshot(), 'MNQZ6');
    expect(merged.contract).toBe('MNQZ6');
    expect(merged.lines).toHaveLength(1);
    expect(merged.key).not.toBe('none');
  });
});
