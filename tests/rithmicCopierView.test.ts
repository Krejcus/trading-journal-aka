import { describe, expect, it } from 'vitest';
import {
  copierGates, copierGroupSummary, copierOpenPnl, copierRedact, copierRisk, copierSltpUsd, copierTileKind, copierUnprotected,
  parseCopierTableSettings, COPIER_TABLE_DEFAULTS, type CopierAccount, type CopierView,
} from '../lib/rithmicCopierView';

const acc = (id: string, o: Partial<CopierAccount> = {}): CopierAccount => ({
  id, name: `Účet ${id}`, firm: 'X', balance: 50000, realizedToday: 0, dailyLossLimit: 1000, drawdownLeft: 2000, drawdownMax: 2000,
  position: { side: 'long', quantity: 2, averagePrice: 25000, stop: 24990, target: 25020 }, status: 'active', copyOn: true, ratio: 1, maxContracts: 3, latencyMs: 80, ...o,
});
const view = (accounts: CopierAccount[], price = 25005): CopierView => ({
  accounts: Object.fromEntries(accounts.map(a => [a.id, a])), pointValue: 2, price,
  groups: [{ id: 'g', name: 'G', leaderId: accounts[0].id, followerIds: accounts.slice(1).map(a => a.id), state: 'disarmed' }],
});

describe('kopírka Rithmic: výpočty zobrazení', () => {
  it('otevřený P&L long i short, bez ceny nula', () => {
    expect(copierOpenPnl(acc('a'), 25005, 2)).toBe(20);
    expect(copierOpenPnl(acc('a', { position: { side: 'short', quantity: 1, averagePrice: 25000, stop: 25010, target: null } }), 25005, 2)).toBe(-10);
    expect(copierOpenPnl(acc('a'), null, 2)).toBe(0);
  });

  it('SL/TP v USD z ceny SL a TP a kusů; bez SL null', () => {
    expect(copierSltpUsd(acc('a'), 2)).toEqual({ sl: -40, tp: 80 });
    expect(copierSltpUsd(acc('a', { position: { side: 'long', quantity: 2, averagePrice: 25000, stop: null, target: 25020 } }), 2)).toBeNull();
    expect(copierSltpUsd(acc('a', { position: null }), 2)).toBeNull();
  });

  it('skupina: součet nebo průměr na účet; účet bez SL do čísla nepatří, ale hlásí se', () => {
    const v = view([acc('L'), acc('F1'), acc('F2', { position: { side: 'long', quantity: 2, averagePrice: 25000, stop: null, target: null } })]);
    const sum = copierGroupSummary(v, v.groups[0], 'sum');
    expect(sum.sl).toBe(-80); expect(sum.tp).toBe(160); expect(sum.protectedCount).toBe(2);
    expect(sum.unprotectedIds).toEqual(['F2']);
    const avg = copierGroupSummary(v, v.groups[0], 'avg');
    expect(avg.sl).toBe(-40); expect(avg.tp).toBe(80);
    expect(sum.open).toBe(60); expect(sum.inPosition).toBe(3); expect(sum.contracts).toBe(6);
  });

  it('bez pozic SL/TP skupiny nic', () => {
    const v = view([acc('L', { position: null }), acc('F', { position: null })]);
    expect(copierGroupSummary(v, v.groups[0], 'sum').sl).toBeNull();
  });

  it('DLL zbývá nikdy víc než rezerva DD; breached 0', () => {
    const a = acc('a', { realizedToday: -300, position: null, drawdownLeft: 500 });
    expect(copierRisk(a, 25000, 2)).toEqual({ ddLeft: 500, dllLeft: 500 });
    expect(copierRisk(acc('b', { realizedToday: -300, position: null }), 25000, 2).dllLeft).toBe(700);
    expect(copierRisk(acc('c', { status: 'breached' }), 25000, 2)).toEqual({ ddLeft: 0, dllLeft: 0 });
  });

  it('dlaždice: neshoda > bez SL > vypnutý > limit > problém', () => {
    expect(copierTileKind(acc('a', { brokerQuantity: 3 }))).toBe('bad');
    expect(copierTileKind(acc('a', { position: { side: 'long', quantity: 1, averagePrice: 1, stop: null, target: null } }))).toBe('prob');
    expect(copierUnprotected(acc('a'))).toBe(false);
    expect(copierTileKind(acc('a', { copyOn: false }))).toBe('off');
    expect(copierTileKind(acc('a', { status: 'dll-locked' }))).toBe('lock');
    expect(copierTileKind(acc('a', { status: 'unverifiable' }))).toBe('prob');
  });

  it('brány: neověřitelný účet nabídne opravu, pozice bez SL zablokuje', () => {
    const v = view([acc('L'), acc('F1', { status: 'unverifiable' }), acc('F2', { position: { side: 'long', quantity: 1, averagePrice: 1, stop: null, target: null } })]);
    const g = copierGates(v, v.groups[0]);
    expect(g.find(x => x.label === 'Účty způsobilé')).toMatchObject({ ok: false, fixAccountId: 'F1' });
    expect(g.find(x => x.label === 'Každá pozice má SL a TP')?.ok).toBe(false);
  });

  it('neznámý realizovaný výsledek nebo zůstatek: „—“, ne nula', () => {
    const v = view([acc('L', { realizedToday: null, balance: null }), acc('F')]);
    const s = copierGroupSummary(v, v.groups[0], 'sum');
    expect(s.day).toBeNull(); expect(s.balance).toBeNull(); expect(s.open).toBe(40);
  });

  it('skrývání názvů', () => {
    expect(copierRedact('Flex 50K •002', 3, 3)).toBe('Fle••••••002');
    expect(copierRedact('ABC', 3, 3)).toBe('ABC');
  });

  it('nastavení: nesmysly zahodí, chybějící sloupce doplní', () => {
    expect(parseCopierTableSettings(null)).toEqual(COPIER_TABLE_DEFAULTS);
    const s = parseCopierTableSettings({ order: ['tp', 'sl', 'nic'], hidden: ['x', 'dd'], sltp: 'avg', redactStart: 99 });
    expect(s.order.slice(0, 2)).toEqual(['tp', 'sl']);
    expect(s.order).toHaveLength(COPIER_TABLE_DEFAULTS.order.length);
    expect(s.hidden).toEqual(['dd']); expect(s.sltp).toBe('avg'); expect(s.redactStart).toBe(12);
  });
});

describe('skutečný účet Rithmicu v kopírce', () => {
  it('leader bez followerů, jen data ze služby', async () => {
    const { rithmicCopierViewFromService } = await import('../lib/rithmicCopierView');
    const v = rithmicCopierViewFromService({ accountName: 'LT-1', system: 'LucidTrading', closedPnl: -120, positionKnown: true,
      position: { side: 'long', quantity: 2, entry: 25000, stop: 24990, target: null }, price: 25004, pointValue: 2, maxContracts: 3 })!;
    expect(v.groups).toEqual([{ id: 'rithmic', name: 'Hlavní', leaderId: 'LT-1', followerIds: [], state: 'disarmed' }]);
    expect(v.accounts['LT-1']).toMatchObject({ balance: null, realizedToday: -120, dailyLossLimit: null, firm: 'LucidTrading', position: { averagePrice: 25000, stop: 24990, target: null } });
    const s = copierGroupSummary(v, v.groups[0], 'sum');
    expect(s.day).toBe(-104); expect(s.sl).toBe(-40); expect(s.tp).toBeNull();
  });

  it('neznámý stav nebo účet = žádný pohled; neznámý výsledek dne „—“', async () => {
    const { rithmicCopierViewFromService } = await import('../lib/rithmicCopierView');
    const base = { accountName: 'A', system: null, closedPnl: undefined, positionKnown: true, position: null, price: 1, pointValue: 2, maxContracts: 1 };
    expect(rithmicCopierViewFromService({ ...base, positionKnown: false })).toBeNull();
    expect(rithmicCopierViewFromService({ ...base, accountName: '' })).toBeNull();
    expect(rithmicCopierViewFromService(base)!.accounts.A.realizedToday).toBeNull();
  });
});
