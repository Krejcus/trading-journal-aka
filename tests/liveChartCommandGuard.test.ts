import { liveUnverifiedActionBlock } from '../lib/liveChartRiskPolicy';
import { describe, expect, it, vi } from 'vitest';
import { createLiveChartCommandGuard } from '../lib/liveChartCommandGuard';
import { createLiveChartIntentStore, LIVE_INTENT_SENDING_MAX_MS } from '../lib/liveChartIntent';
import { isLiveCommandNotSent } from '../lib/liveCommandErrors';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';

let clock = 1_000;
const position = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPosition => ({
  key: JSON.stringify(patch), symbol: 'MNQZ6', lines: [], issue: null,
  summary: { kind: 'position', side: 'long', quantity: 1, entry: 100, entryType: null, openPnl: 0, mark: 101, stop: 90, target: 120,
    protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null, leader: { accountId: 1, quantity: 1, entry: 100 }, rows: [], ...patch },
});
const setup = (current: LiveChartPosition) => {
  const store = createLiveChartIntentStore({ now: () => clock });
  let seq = 0;
  const holder = { current };
  const guard = createLiveChartCommandGuard({ position: () => holder.current, store, newOperationId: () => `manage:op${(seq += 1).toString().padStart(8, '0')}` });
  return { store, guard, holder };
};
/** Relay jako v desku: označí odeslání pod operationId, pak čeká na odpověď. */
const relay = (store: ReturnType<typeof createLiveChartIntentStore>, answer: (operationId: string) => Promise<{ status: string; operationId: string }>) =>
  vi.fn((operationId: string) => { store.markSent(operationId); return answer(operationId); });

describe('callbacky grafu: autorizace jen na platném dokladu', () => {
  it('checklist ★: z neověřené pozice JDE zavřít, zrušit vstup, utáhnout SL, BE a přidat SL/TP (long i short)', async () => {
    for (const side of ['long', 'short'] as const) {
      const { store, guard } = setup(position({ unverified: true, side, stop: side === 'long' ? 90 : 110 }));
      const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
      const seen = { symbol: 'MNQZ6', side: side === 'long' ? 'Buy' as const : 'Sell' as const, quantity: 1, referencePrice: 100 };
      const tighter = side === 'long' ? 95 : 105;
      await guard.manage({ action: 'close-position', symbol: 'MNQZ6', expectPrice: 100 }, send);
      await guard.manage({ action: 'cancel-entry', symbol: 'MNQZ6', expectPrice: 99 }, send);
      await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: side === 'long' ? 90 : 110, newPrice: tighter }, send);
      await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: side === 'long' ? 90 : 110, newPrice: 100 }, send); // BE
      await guard.attach({ symbol: 'MNQZ6', quantity: 1, stopLoss: 90, takeProfit: 120 }, send);
      await guard.bareLeg(seen, { kind: 'add', leg: 'takeProfit', price: 120 } as never, send);
      await guard.bareLeg(seen, { kind: 'move', leg: 'stopLoss', price: tighter, current: side === 'long' ? 90 : 110 } as never, send);
      await guard.closeBare(seen, send);
      expect(send).toHaveBeenCalledTimes(8);
    }
  });

  it('checklist ★: z neověřené pozice se odmítne rozšíření i odebrání SL, posun TP/limitu, odebrání TP, přikoupení a nový vstup — srozumitelně, kód `not-sent`', async () => {
    const { store, guard } = setup(position({ unverified: true, side: 'long', stop: 90 }));
    const send = vi.fn(() => Promise.resolve({ status: 'acknowledged', operationId: 'x' }));
    const seen = { symbol: 'MNQZ6', side: 'Buy' as const, quantity: 1, referencePrice: 100 };
    const calls = [
      guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 85 }, send),
      guard.manage({ action: 'move-target', symbol: 'MNQZ6', expectPrice: 120, newPrice: 125 }, send),
      guard.manage({ action: 'move-limit', symbol: 'MNQZ6', expectPrice: 99, newPrice: 98 }, send),
      guard.bareLeg(seen, { kind: 'remove', leg: 'stopLoss', stop: 90, target: null } as never, send),
      guard.bareLeg(seen, { kind: 'remove', leg: 'takeProfit', stop: null, target: 120 } as never, send),
      guard.bareLeg(seen, { kind: 'move', leg: 'stopLoss', price: 80, current: 90 } as never, send),
      guard.entry({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'entry:abcdefgh1', true, send),
      guard.entry({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 100 }, 'entry:abcdefgh2', false, send),
    ];
    for (const call of calls) {
      const reason = await call.catch(error => error);
      expect(isLiveCommandNotSent(reason)).toBe(true);
      expect(String(reason.message)).toMatch(/Pozice je zatím neověřená — .* teď nejde; teď jde jen snížit riziko/);
    }
    expect(send).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual([]);
  });

  it('checklist: pozice z víc ticketů (scope position) jde zavřít a utáhnout SL i neověřeně; SL na víc cenách se neposoudí', async () => {
    const multi = position({ unverified: true, side: 'long', quantity: 3, stop: 90, rows: [{ accountId: 1, quantity: 3 } as never] });
    const { store, guard } = setup(multi);
    const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
    await guard.manage({ action: 'close-position', symbol: 'MNQZ6', expectPrice: 100 }, send);
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 95 }, send);
    expect(send).toHaveBeenCalledTimes(2);
    // Nohy na různých cenách (SL bez jedné ceny): utažení bez známé ceny SL nejde posoudit → odmítnuto,
    // zavřít jde dál.
    const split = position({ unverified: true, side: 'long', quantity: 3, stop: null }).summary!;
    expect(liveUnverifiedActionBlock(split, { kind: 'move-stop', newPrice: 95 })).toMatch(/bez jedné známé ceny SL/);
    expect(liveUnverifiedActionBlock(split, { kind: 'close' })).toBeNull();
  });

  it('utažení se posuzuje proti ceně, kterou ověří worker (expectPrice), ne proti zastaralému souhrnu', async () => {
    // Souhrn grafu (neověřený) má SL 90, broker už 95: posun na 92 by SL rozšířil → odmítnuto.
    const { store, guard } = setup(position({ unverified: true, side: 'long', stop: 90 }));
    const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
    const reason = await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 95, newPrice: 92 }, send).catch(error => error);
    expect(isLiveCommandNotSent(reason)).toBe(true);
    expect(String(reason.message)).toMatch(/rozšířit SL/);
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 95, newPrice: 97 }, send);
    expect(send).toHaveBeenCalledTimes(1);
    const removeLeg = await guard.manage({ action: 'remove-leg', symbol: 'MNQZ6', expectPrice: 95 }, send).catch(error => error);
    expect(String(removeLeg.message)).toMatch(/odebrat SL/);
  });

  it('nový vstup na JINÉM kontraktu než neověřená pozice odejde', async () => {
    const { store, guard } = setup(position({ unverified: true }));
    const send = relay(store, () => Promise.resolve({ status: 'acknowledged', operationId: 'entry:abcdefgh1' }));
    await guard.entry({ symbol: 'MNQH7', side: 'Sell', quantity: 1, orderType: 'Market', referencePrice: 100 }, 'entry:abcdefgh1', false, () => send('entry:abcdefgh1'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ověřená pozice: operationId vznikne před odesláním a týž jde do příkazu i do čekající čáry (synchronně)', () => {
    const { store, guard } = setup(position());
    const send = relay(store, () => new Promise(() => undefined));
    void guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 95 }, send);
    expect(send).toHaveBeenCalledWith('manage:op00000001');
    expect(store.snapshot()).toMatchObject([{ operationId: 'manage:op00000001', kind: 'move-stop', state: 'sending', sent: true }]);
  });

  it('timeout relaye po odeslání = výsledek neznámý pod týmž operationId; pozdní odpověď po vypršení nic neoživí', async () => {
    const { store, guard } = setup(position());
    await guard.closeBare({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, referencePrice: 100 },
      relay(store, () => Promise.reject(new Error('Výsledek zavření chybí')))).catch(() => undefined);
    expect(store.snapshot()).toMatchObject([{ operationId: 'manage:op00000001', kind: 'close', state: 'unknown' }]);
    let answer!: (value: { status: string; operationId: string }) => void;
    const pending = guard.bareLeg({ symbol: 'MNQZ6', side: 'Buy', quantity: 1 }, { kind: 'move', leg: 'stopLoss', price: 95, current: 90 } as never,
      relay(store, () => new Promise(resolve => { answer = resolve; })));
    clock += LIVE_INTENT_SENDING_MAX_MS + 1;
    store.prune(clock, position());
    expect(store.snapshot().some(intent => intent.operationId === 'manage:op00000002')).toBe(false);
    answer({ status: 'acknowledged', operationId: 'manage:op00000002' });
    await pending;
    expect(store.snapshot().some(intent => intent.operationId === 'manage:op00000002')).toBe(false);
  });

  it('kontrola před relayem (nic neodešlo) čáru vrátí bez ohledu na text chyby', async () => {
    const { store, guard } = setup(position());
    await guard.attach({ symbol: 'MNQZ6', quantity: 1, stopLoss: 90, takeProfit: 120 }, () => Promise.reject(new Error('cokoli'))).catch(() => undefined);
    expect(store.snapshot()).toEqual([]);
  });

  it('po fillu: rozšíření SL neověřeně neodejde, po ověření (doklad / kontinuita) ano', async () => {
    const { store, guard, holder } = setup(position({ unverified: true }));
    const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 85 }, send).catch(() => undefined);
    expect(send).not.toHaveBeenCalled();
    holder.current = position();
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 85 }, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('neznámé ≠ flat (review Codexu a09c4176)', () => {
  it('pohled bez pozice s neověřeným čtením: nový vstup na žádném kontraktu neodejde', async () => {
    for (const issueKind of ['stale', 'orders-stale', 'missing-account', 'mismatch', 'unknown'] as const) {
      const { store, guard } = setup({ key: 'u', symbol: null, lines: [], summary: null, issue: 'Pozice neověřeno', issueKind });
      const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
      const result = guard.entry({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 100 }, 'entry:abcdefgh9', false, () => send('entry:abcdefgh9'));
      await expect(result).rejects.toSatisfy(isLiveCommandNotSent);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('ověřený flat vstup pustí', async () => {
    const { store, guard } = setup({ key: 'f', symbol: null, lines: [], summary: null, issue: null });
    const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
    await guard.entry({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 100 }, 'entry:abcdefgh8', false, () => send('entry:abcdefgh8'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
