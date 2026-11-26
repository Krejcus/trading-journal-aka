// Další příkazy v LIVE grafu (26. 11. 2026): každý další čekající vstup a každá noha s jinou cenou má vlastní čáru
// a akce míří na id příkazu.
import { describe, expect, it, vi } from 'vitest';
import { liveExtraLineTarget, liveExtraOrderLines, liveExtraOrdersKey, type LiveExtraOrders } from '../lib/liveExtraOrderLines';
import { runLiveExtraManage } from '../lib/liveExtraManage';
import { LIVE_POSITION_OWNER, livePositionChartLines } from '../lib/liveChartOrderLines';

const extra: LiveExtraOrders = {
  entries: [
    { orderId: 'A', side: 'Buy', quantity: 1, price: 25_000, entryType: 'Limit', plannedStop: 24_990, plannedTarget: 25_020, add: false },
    { orderId: 'B', side: 'Buy', quantity: 2, price: 25_000, entryType: 'Stop', add: true },
  ],
  legs: [{ orderId: 'L', role: 'stop', price: 24_980, quantity: 1 }],
};
const options = { pointValue: 2, manageable: true, position: { entry: 25_005, long: true } };
const plain = (text: string) => text.replace(/[  ]/g, ' ');

describe('čáry dalších příkazů', () => {
  it('každý vstup má vlastní skupinu čar s id příkazu; dva vstupy na stejné ceně se nespletou', () => {
    const lines = liveExtraOrderLines(extra, options);
    expect(lines.map(line => line.id)).toEqual([
      'live-position:order:A:entry', 'live-position:order:A:stopLoss', 'live-position:order:A:takeProfit',
      'live-position:order:B:entry', 'live-position:leg:L',
    ]);
    expect(new Set(lines.map(line => line.ownerId))).toEqual(new Set(['live-order:A', 'live-order:B', 'live-leg:L']));
    expect(liveExtraLineTarget(lines[0])).toEqual({ type: 'order', orderId: 'A' });
    expect(liveExtraLineTarget(lines[3])).toEqual({ type: 'order', orderId: 'B' });
    expect(liveExtraLineTarget(lines[4])).toEqual({ type: 'leg', orderId: 'L' });
    expect(liveExtraLineTarget({ ownerId: LIVE_POSITION_OWNER })).toBeNull();
    // Id čar drží předponu živé pozice (podpis čar vrstvy), vstup má × a tah, noha pozice jen tah.
    expect(lines.every(line => line.id.startsWith('live-position:'))).toBe(true);
    expect(lines[0]).toMatchObject({ draggable: true, cancellable: true, cancelAction: 'cancel-order' });
    expect(lines[4]).toMatchObject({ draggable: true, kind: 'stopLoss' });
    expect(lines[4].cancellable).toBeUndefined();
    expect(plain(lines[3].label)).toMatch(/^PŘIKOUPENÍ BUY 2 STOP {2}25000\.00 · čeká na vyplnění$/);
    expect(plain(lines[1].label)).toBe('SL 1  −$20.00 · 10.00 b · čeká na vstup');
    expect(plain(lines[4].label)).toBe('SL 1  −$50.00 · 25.00 b · část pozice');
  });
  it('jen pro čtení nic netáhne ani neruší; běžící změna čáru zamkne', () => {
    for (const line of liveExtraOrderLines(extra, { ...options, manageable: false })) {
      expect(line.draggable).toBe(false);
      expect(line.cancellable ?? false).toBe(false);
    }
    const busy = liveExtraOrderLines(extra, { ...options, pending: new Set(['live-position:order:A:entry']) });
    expect(busy[0].draggable).toBe(false);
    expect(busy[1].draggable).toBe(false); // nohy vstupu, který se právě mění
    expect(busy[3].draggable).toBe(true);
    expect(busy[0].label).toMatch(/mění se/);
  });
  it('klíč překreslení se mění s cenou, množstvím i plánovanou nohou', () => {
    const key = liveExtraOrdersKey(extra);
    expect(liveExtraOrdersKey({ ...extra, entries: [{ ...extra.entries[0], plannedStop: 24_985 }, extra.entries[1]] })).not.toBe(key);
    expect(liveExtraOrdersKey({ ...extra, legs: [{ ...extra.legs[0], price: 24_981 }] })).not.toBe(key);
    expect(liveExtraOrdersKey(null)).toBe('');
  });
  it('hlavní čára SL/TP ukáže, kolik kusů pozice kryje', () => {
    const summary = { kind: 'position', side: 'long', quantity: 3, entry: 25_000, entryType: null, openPnl: null, mark: null, stop: 24_990, target: 25_020, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [] };
    const lines = livePositionChartLines(summary as never, { manageable: true, entryAvg: 25_000, pointValue: 2, legQuantity: { stopLoss: 1, takeProfit: 3 } } as never);
    expect(plain(lines.find(line => line.kind === 'stopLoss')!.label)).toMatch(/^SL 1\/3 {2}−\$20\.00/);
    expect(plain(lines.find(line => line.kind === 'takeProfit')!.label)).toMatch(/^TP 3 {2}\+\$120\.00/);
  });
});

describe('odeslání akce na dalším příkazu', () => {
  const line = { id: 'live-position:order:A:entry', ownerId: 'live-order:A', kind: 'entry' as const };
  const ok = { type: 'leader-order-managed' as const, operationId: 'manage:x', action: 'cancel-entry' as const, status: 'acknowledged' as const, checkedAt: 1, blockers: [] };
  it('jedno volání s id příkazu a cenou, kterou uživatel viděl; zámek se uvolní', async () => {
    const manage = vi.fn(async () => ok);
    const busyRef = { current: false };
    const reports: string[] = [];
    const pending: Array<string | null> = [];
    const status = await runLiveExtraManage({ manage, busyRef, report: notice => reports.push(notice.text), setPending: id => pending.push(id) }, { line, action: 'move', expect: 25_000, next: 24_995 });
    expect(status).toBe('acknowledged');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith({ type: 'order', orderId: 'A' }, 'move', 'entry', 25_000, 24_995);
    expect(busyRef.current).toBe(false);
    expect(pending).toEqual([line.id, null]);
    expect(reports).toEqual(['Vstup posunut.']);
  });
  it('běžící jiný příkaz, chybějící cena nebo cizí čára: nic se neodešle', async () => {
    const manage = vi.fn(async () => ok);
    const reports: string[] = [];
    const deps = { manage, busyRef: { current: true }, report: (notice: { text: string }) => reports.push(notice.text) };
    expect(await runLiveExtraManage(deps, { line, action: 'cancel', expect: 25_000 })).toBe('not-sent');
    deps.busyRef.current = false;
    expect(await runLiveExtraManage(deps, { line, action: 'move', expect: 25_000 })).toBe('not-sent');
    expect(await runLiveExtraManage(deps, { line: { ...line, ownerId: LIVE_POSITION_OWNER }, action: 'cancel', expect: 25_000 })).toBe('not-sent');
    expect(manage).not.toHaveBeenCalled();
  });
  it('výjimka po zavolání = neznámý výsledek, nic se neopakuje', async () => {
    const manage = vi.fn(async () => { throw new Error('spojení spadlo'); });
    const reports: string[] = [];
    const busyRef = { current: false };
    expect(await runLiveExtraManage({ manage, busyRef, report: notice => reports.push(notice.text) }, { line, action: 'cancel', expect: 25_000 })).toBe('unknown');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(busyRef.current).toBe(false);
    expect(reports[0]).toMatch(/není znám/);
  });
});

describe('čip „+ SL" pro nekrytý zbytek pozice', () => {
  const summary = { kind: 'position', side: 'long', quantity: 3, entry: 25_000, entryType: null, openPnl: null, mark: null, stop: 24_990, target: 25_020, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [] };
  it('zůstává na čáře pozice i vedle existující čáry SL; TP zbytku se nenabízí', () => {
    const controls = { manageable: true, entryAvg: 25_000, pointValue: 2, bareLegs: true, legQuantity: { stopLoss: 1, takeProfit: 1 } };
    const entryLine = (extra: object) => livePositionChartLines(summary as never, { ...controls, ...extra } as never).find(line => line.kind === 'entry')!;
    expect(entryLine({ restStop: true }).addableBrackets).toEqual(['stopLoss']);
    expect(entryLine({ restStop: false }).addableBrackets).toBeUndefined();
  });
});
