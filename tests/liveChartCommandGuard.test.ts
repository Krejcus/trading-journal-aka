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
  it('z neověřené pozice neodejde správa, doplnění SL/TP, holé nohy, × holé pozice ani přikoupení — typ chyby `not-sent`', async () => {
    const { store, guard } = setup(position({ unverified: true }));
    const send = vi.fn(() => Promise.resolve({ status: 'acknowledged', operationId: 'x' }));
    const seen = { symbol: 'MNQZ6', side: 'Buy' as const, quantity: 1, referencePrice: 100 };
    const calls = [
      guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 95 }, send),
      guard.attach({ symbol: 'MNQZ6', quantity: 1, stopLoss: 90, takeProfit: 120 }, send),
      guard.bareLeg(seen, { kind: 'add', leg: 'stopLoss', price: 90 }, send),
      guard.closeBare(seen, send),
      guard.entry({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'entry:abcdefgh1', true, send),
    ];
    for (const call of calls) {
      const reason = await call.catch(error => error);
      expect(isLiveCommandNotSent(reason)).toBe(true);
      expect(String(reason.message)).toMatch(/nic se neodeslalo/);
    }
    expect(send).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual([]);
  });

  it('obyčejný vstup (bez přikoupení) bránu neověřené pozice nepotřebuje a odejde', async () => {
    const { store, guard } = setup(position({ unverified: true }));
    const send = relay(store, () => Promise.resolve({ status: 'acknowledged', operationId: 'entry:abcdefgh1' }));
    await guard.entry({ symbol: 'MNQZ6', side: 'Sell', quantity: 1, orderType: 'Market', referencePrice: 100 }, 'entry:abcdefgh1', false, () => send('entry:abcdefgh1'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.snapshot()).toMatchObject([{ operationId: 'entry:abcdefgh1', state: 'acknowledged' }]);
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

  it('po fillu: neověřeno → doklad bez překreslení cesty; stejné callbacky pak projdou', async () => {
    const { store, guard, holder } = setup(position({ unverified: true }));
    const send = relay(store, operationId => Promise.resolve({ status: 'acknowledged', operationId }));
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 95 }, send).catch(() => undefined);
    expect(send).not.toHaveBeenCalled();
    holder.current = position();
    await guard.manage({ action: 'move-stop', symbol: 'MNQZ6', expectPrice: 90, newPrice: 95 }, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
