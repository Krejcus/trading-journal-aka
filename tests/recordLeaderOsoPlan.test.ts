import { describe, expect, it } from 'vitest';
import {
  decideFillCleanup,
  decideRecordCleanup,
  leakedIdentifiers,
  parseRecordLeaderOsoArgs,
  recordLeaderOsoProblems,
  sanitizeRecordedFrame,
  type RecordLeaderOsoPlan,
  type RecordPlacement,
} from '../scripts/copier/recordLeaderOsoPlan';

const LEADER = 4242;
const NOW = 1_800_000_000_000;
const status = (controller: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  controller: {
    armed: false, connected: true, killSwitch: false, groupFlat: true, reconciliationRequired: false,
    lastError: null, manualRecovery: null, transportResume: null, divergentAccounts: [], workingOrderAccounts: [],
    ...controller,
  },
  group: { leaderAccountId: LEADER },
  marketPrices: [{ symbol: 'MNQZ6', price: 30_000, at: NOW - 1_000 }],
  ...extra,
});
const plan = (patch: Partial<RecordLeaderOsoPlan> = {}): RecordLeaderOsoPlan => ({
  accountId: LEADER, symbol: 'MNQZ6', side: 'Buy', entry: 29_500, stopLoss: 29_450, takeProfit: 30_500,
  marketPrice: 30_000, holdMs: 4_000, confirm: false, scenario: 'cancel', allowNonGroupAccount: false, ...patch,
});
const problems = (p = plan(), s: unknown = status()) => recordLeaderOsoProblems(p, s, NOW);

describe('fáze 0: pojistky nahrávání OSO na leaderovi', () => {
  it('bezpečný plán za DISARMED projde (Buy i Sell)', () => {
    expect(problems()).toEqual([]);
    expect(problems(plan({ side: 'Sell', entry: 30_500, stopLoss: 30_550, takeProfit: 29_500 }))).toEqual([]);
  });

  it.each([
    [{ armed: true }, 'DISARMED'], [{ armed: undefined }, 'DISARMED'], [{ connected: false }, 'připojený'],
    [{ killSwitch: true }, 'kill'], [{ groupFlat: false }, 'flat'], [{ reconciliationRequired: true }, 'kontrolu pozic'],
    [{ lastError: 'x' }, 'lastError'], [{ manualRecovery: { id: 'a' } }, 'ruční obnovu'],
    [{ armPreparation: { manualRecoveryRequired: true } }, 'ruční obnovu'],
    [{ transportResume: { phase: 'waiting' } }, 'pokračování'], [{ transportResume: { phase: 'ready' } }, 'pokračování'],
    [{ divergentAccounts: [1] }, 'divergenci'], [{ workingOrderAccounts: [1] }, 'working'],
  ])('stav workeru %o zastaví záznam', (controller, reason) => {
    expect(problems(plan(), status(controller)).join(' ')).toContain(reason);
  });

  it('jen leader skupiny workeru', () => {
    expect(problems(plan(), status({}, { group: { leaderAccountId: 7 } }))).toContain('účet není leader skupiny workeru');
    expect(problems(plan(), {})).not.toEqual([]);
  });

  it('bez čerstvé ceny workeru nebo s nesouhlasnou --market-price neběží', () => {
    expect(problems(plan(), status({}, { marketPrices: [] })).join(' ')).toContain('čerstvou cenu');
    expect(problems(plan(), status({}, { marketPrices: [{ symbol: 'MNQZ6', price: 30_000, at: NOW - 60_000 }] })).join(' ')).toContain('čerstvou cenu');
    expect(problems(plan({ marketPrice: 31_000 })).join(' ')).toContain('nesedí');
  });

  it('vzdálenost a strany se počítají od ceny workeru, ne od zadané', () => {
    // Zadaná cena by vstup „oddálila“, kotva workeru ho drží blízko trhu.
    expect(problems(plan({ marketPrice: 30_080, entry: 29_600, stopLoss: 29_550 }), status()).join(' ')).toContain('pod trhem');
  });

  it('žádná noha nesmí jít hned vyplnit: TP na vzdálené straně trhu', () => {
    expect(problems(plan({ takeProfit: 29_900 })).join(' ')).toContain('TP (Sell limit)');
    expect(problems(plan({ side: 'Sell', entry: 30_500, stopLoss: 30_550, takeProfit: 30_100 })).join(' ')).toContain('TP (Buy limit)');
    expect(problems(plan({ stopLoss: 29_550 }))).toContain('SL musí být pod vstupem');
    expect(problems(plan({ entry: 29_500.1 })).join(' ')).toContain('--entry');
  });

  it('argumenty: jen MNQ, povinné ceny, strop držení, --confirm', () => {
    const argv = ['--account', String(LEADER), '--symbol', 'mnqz6', '--entry', '29500', '--sl', '29450', '--tp', '30500', '--market-price', '30000'];
    expect(parseRecordLeaderOsoArgs(argv)).toMatchObject({ symbol: 'MNQZ6', side: 'Buy', holdMs: 4_000, confirm: false });
    expect(parseRecordLeaderOsoArgs([...argv, '--confirm']).confirm).toBe(true);
    expect(() => parseRecordLeaderOsoArgs(argv.map(item => (item === 'mnqz6' ? 'NQZ6' : item)))).toThrow('MNQ');
    expect(() => parseRecordLeaderOsoArgs(argv.filter(item => item !== '--sl' && item !== '29450'))).toThrow('--sl');
    expect(() => parseRecordLeaderOsoArgs([...argv, '--hold-ms', '60000'])).toThrow('--hold-ms');
  });
});

describe('fáze 0: úklid', () => {
  const order = (id: string, status: string, filledQuantity = 0, parentOrderId?: string) =>
    ({ id, status, filledQuantity, ...(parentOrderId ? { parentOrderId } : {}) });
  const acked: RecordPlacement = { kind: 'acknowledged', entryId: '10', legIds: ['11', '12'] };

  it('nic nevyplněno: v jednom kole ruší jen vstup, nohy až po potvrzeném zrušení vstupu', () => {
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('11', 'pending'), order('10', 'working'), order('12', 'pending')] }, acked))
      .toEqual({ kind: 'cancel', ids: ['10'] });
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('10', 'canceled'), order('11', 'pending'), order('12', 'pending')] }, acked))
      .toEqual({ kind: 'cancel', ids: ['11', '12'] });
  });

  it('nohy běží, ale vstup není vidět jako zrušený → neověřeno, nohy se neruší', () => {
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('11', 'pending'), order('12', 'pending')] }, acked).kind).toBe('unverified');
  });

  it('vyplněný vstup nebo pozice: nohy (ochrana) se NEruší', () => {
    expect(decideRecordCleanup({ netPosition: 1, orders: [order('10', 'filled', 1), order('11', 'working'), order('12', 'working')] }, acked).kind).toBe('filled');
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('10', 'canceled', 1)] }, acked).kind).toBe('filled');
  });

  it('nečitelný stav je „neověřeno“, nikdy „čisto“', () => {
    expect(decideRecordCleanup({ netPosition: null, orders: [] }, acked).kind).toBe('unverified');
    expect(decideRecordCleanup({ netPosition: 0, orders: null }, acked).kind).toBe('unverified');
  });

  it('nejisté zadání (výjimka, signál během požadavku) nikdy nedá „čisto“, i když leader vypadá prázdný', () => {
    const uncertain: RecordPlacement = { kind: 'uncertain', entrySide: 'Buy' };
    expect(decideRecordCleanup({ netPosition: 0, orders: [] }, uncertain).kind).toBe('unverified');
    // Nohy bez parentId (tvar OSO z UI): v prvním kole jen příkaz na straně vstupu.
    const sided = (id: string, side: string, status = 'working') => ({ id, status, filledQuantity: 0, side });
    expect(decideRecordCleanup({ netPosition: 0, orders: [sided('10', 'Buy'), sided('11', 'Sell', 'pending'), sided('12', 'Sell', 'pending')] }, uncertain))
      .toEqual({ kind: 'cancel', ids: ['10'] });
    expect(decideRecordCleanup({ netPosition: 0, orders: [sided('10', 'Buy', 'canceled'), sided('11', 'Sell', 'pending')] }, uncertain))
      .toEqual({ kind: 'cancel', ids: ['11'] });
  });

  it('„čisto“ jen když jsou všechna id z ACK pozorovaně zrušená', () => {
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('10', 'canceled'), order('11', 'canceled'), order('12', 'canceled')] }, acked)).toEqual({ kind: 'clean' });
    expect(decideRecordCleanup({ netPosition: 0, orders: [order('10', 'canceled')] }, acked).kind).toBe('unverified');
    expect(decideRecordCleanup({ netPosition: 0, orders: [] }, { kind: 'not-sent' })).toEqual({ kind: 'clean' });
  });
});

describe('fáze 0: anonymizace', () => {
  const frame = (items: unknown[]) => `a${JSON.stringify(items)}`;
  const props = (entityType: string, entity: Record<string, unknown>, eventType = 'Created') => ({ e: 'props', d: { entityType, eventType, entity } });

  it('ponechá jen vlastní příkazy a navázané entity, vyhodí soukromé klíče, přemapuje účty', () => {
    const context = { orderIds: new Set([500]), commandIds: new Set<number>(), accountMap: new Map([[4242, 1001], [6000, 2002]]) };
    const out = sanitizeRecordedFrame(frame([
      props('order', { id: 500, accountId: 4242, ordStatus: 'Working', clOrdId: 'recabc' }),
      props('order', { id: 501, accountId: 4242, parentId: 500, ordStatus: 'Suspended' }),
      props('command', { id: 900, orderId: 501, userSessionId: 77, senderId: 88 }),
      props('commandReport', { id: 901, commandId: 900, commandStatus: 'OnHold' }),
      props('order', { id: 777, accountId: 5555, ordStatus: 'Working' }),
      props('cashBalance', { id: 1, accountId: 4242, amount: 50_000 }),
      props('position', { id: 2, accountId: 4242, netPos: 0 }),
      props('position', { id: 3, accountId: 6000, netPos: 2 }),
      props('user', { id: 3, name: 'Filip', email: 'x@y.cz' }),
      { e: 'shutdown', d: {} },
    ]), context);
    expect(out.map(item => item.entityType)).toEqual(['order', 'order', 'command', 'commandReport', 'position']);
    expect(out[4].entity).toEqual({ id: 2, accountId: 1001, netPos: 0 });
    expect(out[0].entity).toEqual({ id: 500, accountId: 1001, ordStatus: 'Working' });
    expect(out[2].entity).toEqual({ id: 900, orderId: 501 });
    expect(context.orderIds.has(501)).toBe(true);
  });

  it('rámce mimo `a[...]` nebo poškozené se zahodí', () => {
    const context = { orderIds: new Set([1]), commandIds: new Set<number>(), accountMap: new Map() };
    expect(sanitizeRecordedFrame('o', context)).toEqual([]);
    expect(sanitizeRecordedFrame('a[{bad', context)).toEqual([]);
  });

  it('poslední síto najde id i jméno účtu, ale ne cizí čísla, která je obsahují', () => {
    const text = '{"accountId":1001,"price":29500.25,"note":"LFE0506123","id":42420001}';
    expect(leakedIdentifiers(text, [4242, 'LFE0506123', 'x@y.cz'])).toEqual(['LFE0506123']);
    expect(leakedIdentifiers('{"accountId":4242}', [4242])).toEqual(['4242']);
  });
});

describe('fáze 1b: fill scénář nahrávání', () => {
  const fill = (patch: Partial<RecordLeaderOsoPlan> = {}) => plan({
    scenario: 'fill', entry: 30_010, stopLoss: 29_900, takeProfit: 30_500, ...patch,
  });

  it('marketable Buy i Sell s rozumným SL projde', () => {
    expect(problems(fill())).toEqual([]);
    expect(problems(fill({ side: 'Sell', entry: 29_990, stopLoss: 30_100, takeProfit: 29_500 }))).toEqual([]);
  });

  it('limit, který se nevyplní, nebo příliš drahý vstup odmítne', () => {
    expect(problems(fill({ entry: 29_990 })).join(' ')).toContain('na trhu nebo nad ním');
    expect(problems(fill({ entry: 30_100 })).join(' ')).toContain('na trhu nebo nad ním');
    expect(problems(fill({ side: 'Sell', entry: 30_010, stopLoss: 30_120, takeProfit: 29_500 })).join(' ')).toContain('na trhu nebo pod ním');
  });

  it('SL příliš blízko (trefí se při držení) nebo daleko (velké riziko) odmítne', () => {
    expect(problems(fill({ stopLoss: 29_990 })).join(' ')).toContain('SL musí být');
    expect(problems(fill({ stopLoss: 29_500 })).join(' ')).toContain('SL musí být');
  });

  it('TP blízko trhu odmítne a DISARMED pojistky platí i tady', () => {
    expect(problems(fill({ takeProfit: 30_100 })).join(' ')).toContain('TP');
    expect(problems(fill(), status({ armed: true })).join(' ')).toContain('DISARMED');
  });

  it('účet mimo skupinu jen s --non-group-account a nikdy follower skupiny', () => {
    const outsider = status({}, { group: { leaderAccountId: LEADER, followers: [{ accountId: 7 }] } });
    expect(problems(fill({ accountId: 99 }), outsider).join(' ')).toContain('není leader');
    expect(problems(fill({ accountId: 99, allowNonGroupAccount: true }), outsider)).toEqual([]);
    expect(problems(fill({ accountId: 7, allowNonGroupAccount: true }), outsider).join(' ')).toContain('ve skupině');
    expect(parseRecordLeaderOsoArgs(['--account', '9', '--symbol', 'MNQZ6', '--entry', '1', '--sl', '1', '--tp', '1',
      '--market-price', '1', '--scenario', 'fill', '--non-group-account'])).toMatchObject({ scenario: 'fill', allowNonGroupAccount: true });
    expect(() => parseRecordLeaderOsoArgs(['--account', '9', '--symbol', 'MNQZ6', '--entry', '1', '--sl', '1', '--tp', '1',
      '--market-price', '1', '--scenario', 'market'])).toThrow('--scenario');
  });

  const ack: RecordPlacement = { kind: 'acknowledged', entryId: 'e', legIds: ['s', 't'] };
  it('úklid: otevřená pozice = zavřít, nohy nad pozicí se nikdy neruší samostatně', () => {
    expect(decideFillCleanup({ netPosition: 1, orders: [
      { id: 'e', status: 'filled', filledQuantity: 1 }, { id: 's', status: 'working', filledQuantity: 0 },
    ] }, ack)).toEqual({ kind: 'liquidate' });
  });

  it('úklid: flat → nevyplněný vstup zrušit, zbylé nohy zrušit, pak čisto', () => {
    expect(decideFillCleanup({ netPosition: 0, orders: [
      { id: 'e', status: 'working', filledQuantity: 0 }, { id: 's', status: 'pending', filledQuantity: 0, parentOrderId: 'e' },
    ] }, ack)).toEqual({ kind: 'cancel', ids: ['e'] });
    expect(decideFillCleanup({ netPosition: 0, orders: [
      { id: 'e', status: 'filled', filledQuantity: 1 }, { id: 't', status: 'working', filledQuantity: 0 },
    ] }, ack)).toEqual({ kind: 'cancel', ids: ['t'] });
    expect(decideFillCleanup({ netPosition: 0, orders: [
      { id: 'e', status: 'filled', filledQuantity: 1 }, { id: 's', status: 'canceled', filledQuantity: 0 },
    ] }, ack)).toEqual({ kind: 'clean' });
  });

  it('úklid: nečitelný stav nebo nejisté zadání nikdy „čisto“', () => {
    expect(decideFillCleanup({ netPosition: null, orders: [] }, ack).kind).toBe('unverified');
    expect(decideFillCleanup({ netPosition: 0, orders: [] }, { kind: 'uncertain', entrySide: 'Buy' }).kind).toBe('unverified');
  });
});
