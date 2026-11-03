// U5 (3. 11. 2026): všechny pracující příkazy leadera jako čáry + rozjeté SL/TP nohy — jen zobrazení.
// Fixture fáze 0 dokupování z DEMO (tests/fixtures/tradovate-leader-scale-in.json): souběžný posun
// 2× SL a 2× TP dává na pár ms rozjeté nohy (t 4011 SL, t 4174 TP), pak čekající přikoupení Limit.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import { buildTradeCard } from '../lib/liveTradeCard';
import { isTradovateWorkingStatus } from '../lib/tradovateOrderReadModel';
import { LIVE_POSITION_OWNER, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import {
  EMPTY_LIVE_WORKING_KEY, LIVE_WORKING_MAX_BADGES, LIVE_WORKING_MAX_LINES, LIVE_WORKING_OWNER,
  isLiveDisplayOnlyLine, liveWorkingAccountIds, liveWorkingOrderClass, liveWorkingOrderLines, liveWorkingOrderView,
  liveWorkingOrdersVerified, type LiveWorkingDrawnPosition, type LiveWorkingOrdersInput,
} from '../lib/liveWorkingOrderLines';

type RecordedOrder = {
  brokerOrderId: string; accountId: number; symbol: string; side: string; orderType: string; quantity: number;
  limitPrice?: number; stopPrice?: number; status: string;
};
type RecordedEvent = { t: number; event: { type: string; order?: RecordedOrder; fill?: { side: string; quantity: number; price: number } } };
const recording = JSON.parse(readFileSync(new URL('./fixtures/tradovate-leader-scale-in.json', import.meta.url), 'utf8')) as { events: RecordedEvent[] };
const LEADER = 1001;
const FOLLOWER = 2002;
const SYM = 'MNQZ6';

const STATUS: Record<string, string> = { working: 'Working', pending: 'Suspended', filled: 'Filled', canceled: 'Canceled', rejected: 'Rejected' };
/** Stav příkazů leadera ze záznamu v čase `t` → REST tvar `LiveOrder` (jako `tradovateCopyTradeOrders`). */
function ordersAt(t: number): LiveOrder[] {
  const latest = new Map<string, RecordedOrder>();
  for (const item of recording.events) {
    if (item.t > t) break;
    if (item.event.type === 'order' && item.event.order) latest.set(item.event.order.brokerOrderId, item.event.order);
  }
  return [...latest.values()].map(order => {
    const status = STATUS[order.status] ?? 'Unknown';
    return {
      id: Number(order.brokerOrderId), accountId: order.accountId, accountName: 'DEMO leader', action: order.side,
      orderType: order.orderType, quantity: order.quantity, price: order.limitPrice ?? null, stopPrice: order.stopPrice ?? null,
      status, symbol: order.symbol, placedAt: null, updatedAt: null, working: isTradovateWorkingStatus(status),
    };
  });
}
/** Pozice leadera v čase `t`: čisté qty a průměr nákupů (fixture jen přikupuje, pak zavře). */
function positionAt(t: number): { net: number; netPrice: number | null } {
  let net = 0; let cost = 0; let bought = 0;
  for (const item of recording.events) {
    if (item.t > t) break;
    const fill = item.event.type === 'fill' ? item.event.fill : undefined;
    if (!fill) continue;
    const signed = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
    net += signed;
    if (signed > 0) { cost += fill.price * fill.quantity; bought += fill.quantity; }
  }
  return { net, netPrice: net !== 0 && bought > 0 ? cost / bought : null };
}
const account = (id: number, patch: Partial<LiveAccount> = {}, position?: { net: number; netPrice: number | null }): LiveAccount => ({
  id, name: id === LEADER ? 'DEMO leader' : 'T2', unrealizedPnl: 0, unrealizedPnlSource: 'broker',
  positions: position && position.net !== 0
    ? [{ accountId: id, symbol: SYM, netPosition: position.net, netPrice: position.netPrice, realizedPnl: 0, unrealizedPnl: 0, updatedAt: null }]
    : [],
  ...patch,
} as unknown as LiveAccount);

/** Co kreslí čáry pozice — ze SKUTEČNÉ karty obchodu nad stejnými příkazy (ladder = jediná cena, jinak null). */
function drawnAt(t: number, orders: LiveOrder[]): LiveWorkingDrawnPosition | null {
  const card = buildTradeCard([{ account: account(LEADER, {}, positionAt(t)), accountId: LEADER, name: 'DEMO leader', isLeader: true }], orders, new Map(), 0);
  if (!card) return null;
  return {
    kind: card.kind, side: card.direction === 1 ? 'long' : 'short', entry: card.entry, entryType: card.entryType,
    stop: card.ladder.stop, target: card.ladder.target, leader: { accountId: LEADER, entry: card.accounts[0]?.entry ?? null },
  };
}
const fixtureInput = (t: number, patch: Partial<LiveWorkingOrdersInput> = {}): LiveWorkingOrdersInput => {
  const orders = ordersAt(t);
  return { orders, accountIds: [LEADER], verified: true, contract: SYM, drawn: { position: drawnAt(t, orders), symbol: SYM }, pointValue: 2, ...patch };
};

let nextId = 1;
const order = (patch: Partial<LiveOrder> = {}): LiveOrder => ({
  id: nextId++, accountId: LEADER, accountName: 'DEMO leader', action: 'Buy', orderType: 'Limit', quantity: 1,
  price: 21000, stopPrice: null, status: 'Working', symbol: SYM, placedAt: null, updatedAt: null, working: true, ...patch,
});
const longPosition = (patch: Partial<LiveWorkingDrawnPosition> = {}): LiveWorkingDrawnPosition => ({
  kind: 'position', side: 'long', entry: 21050, entryType: null, stop: 21000, target: 21100,
  leader: { accountId: LEADER, entry: 21050 }, ...patch,
});
const input = (orders: LiveOrder[], patch: Partial<LiveWorkingOrdersInput> = {}): LiveWorkingOrdersInput => ({
  orders, accountIds: [LEADER], verified: true, contract: SYM, drawn: { position: null }, pointValue: 2, ...patch,
});

describe('U5: pracující příkazy jako čáry — brána ověření (INV-UI-01)', () => {
  it('neověřené čtení příkazů = žádné čáry ani štítky (stejná data ověřená čáry mají)', () => {
    const data = input([order({ price: 20990 }), order({ orderType: 'TrailingStop', stopPrice: 20980, price: null, action: 'Sell' })]);
    const verified = liveWorkingOrderView(data);
    expect(verified.lines).toHaveLength(1);
    expect(verified.badges).toHaveLength(1);
    const unverified = liveWorkingOrderView({ ...data, verified: false });
    expect(unverified).toEqual({ lines: [], badges: [], key: EMPTY_LIVE_WORKING_KEY });
    expect(liveWorkingOrderLines({ ...data, verified: false })).toEqual([]);
    // „Truthy“ hodnota není ověření.
    expect(liveWorkingOrderLines({ ...data, verified: 1 as unknown as boolean })).toEqual([]);
    expect(liveWorkingOrderLines({ ...data, contract: null })).toEqual([]);
    expect(liveWorkingOrderLines({ ...data, contract: '  ' })).toEqual([]);
    expect(liveWorkingOrderLines({ ...data, accountIds: [] })).toEqual([]);
  });

  it('liveWorkingOrdersVerified: issue pozice, staré / odepřené čtení i chybějící účet = false', () => {
    const now = Date.parse('2026-11-03T15:00:00Z');
    const fresh = { ordersAvailability: 'available', ordersUpdatedAt: new Date(now - 5_000).toISOString() } as Partial<LiveAccount>;
    const accounts = [account(LEADER, fresh), account(FOLLOWER, fresh)];
    expect(liveWorkingOrdersVerified({ accounts, accountIds: [LEADER], positionIssue: null, now })).toBe(true);
    expect(liveWorkingOrdersVerified({ accounts, accountIds: [LEADER], positionIssue: 'Kopie dobíhá…', now })).toBe(false);
    expect(liveWorkingOrdersVerified({ accounts, accountIds: [], positionIssue: null, now })).toBe(false);
    expect(liveWorkingOrdersVerified({ accounts, accountIds: [LEADER, 3003], positionIssue: null, now })).toBe(false);
    const stale = [account(LEADER, { ordersAvailability: 'available', ordersUpdatedAt: new Date(now - 60_000).toISOString() })];
    expect(liveWorkingOrdersVerified({ accounts: stale, accountIds: [LEADER], positionIssue: null, now })).toBe(false);
    const denied = [account(LEADER, { ...fresh, ordersAvailability: 'denied' })];
    expect(liveWorkingOrdersVerified({ accounts: denied, accountIds: [LEADER], positionIssue: null, now })).toBe(false);
    const oneStale = [account(LEADER, fresh), account(FOLLOWER, { ordersAvailability: 'unavailable' })];
    expect(liveWorkingOrdersVerified({ accounts: oneStale, accountIds: [LEADER, FOLLOWER], positionIssue: null, now })).toBe(false);
  });

  it('účty pohledu: skupina = jen leader, jeden účet = ten účet', () => {
    expect(liveWorkingAccountIds({ kind: 'group' }, LEADER)).toEqual([LEADER]);
    expect(liveWorkingAccountIds({ kind: 'group' }, null)).toEqual([]);
    expect(liveWorkingAccountIds({ kind: 'account', accountId: String(FOLLOWER) }, LEADER)).toEqual([FOLLOWER]);
    expect(liveWorkingAccountIds({ kind: 'account', accountId: 'abc' }, LEADER)).toEqual([]);
  });
});

describe('U5: rozjeté SL/TP nohy ze záznamu DEMO (fixture scale-in)', () => {
  it('t 4011: SL nohy na dvou cenách → čára pro každou nohu s qty a $; TP na jedné ceně kreslí pozice', () => {
    const data = fixtureInput(4011);
    // Předpoklad z reálné karty obchodu: SL není na jedné ceně, TP ano.
    expect(data.drawn.position).toMatchObject({ kind: 'position', side: 'long', stop: null, target: 28537.5 });
    const lines = liveWorkingOrderLines(data);
    expect(lines.map(line => [line.role, line.price, line.quantity])).toEqual([
      ['stop-leg', 27937.5, 1],
      ['stop-leg', 27936.5, 1],
    ]);
    expect(lines.every(line => line.kind === 'stopLoss' && line.ownerId === LIVE_WORKING_OWNER)).toBe(true);
    // $ proti vstupu leadera (28083.625): (27936.5 − 28083.625) · 1 · 2 = −294.25.
    expect(lines[1].label).toMatch(/^SL 1 ks {2}27936\.50 · −\$294\.25 · 147\.13 b$/);
    expect(lines[0].label).toMatch(/^SL 1 ks {2}27937\.50 · −\$292\.25/);
    expect(lines[0].orderIds).toEqual([611860531153]);
    expect(lines[1].orderIds).toEqual([611860531132]);
  });

  it('t 4174: TP nohy na dvou cenách → dvě TP čáry; SL už zase na jedné ceně → žádná SL čára', () => {
    const data = fixtureInput(4174);
    expect(data.drawn.position).toMatchObject({ stop: 27936.5, target: null });
    const lines = liveWorkingOrderLines(data);
    expect(lines.map(line => [line.role, line.kind, line.price, line.quantity])).toEqual([
      ['target-leg', 'takeProfit', 28538.5, 1],
      ['target-leg', 'takeProfit', 28537.5, 1],
    ]);
  });

  it('t 5364: SL i TP na jedné ceně → nic navíc (čáry pozice, žádná duplicita)', () => {
    const data = fixtureInput(5364);
    expect(data.drawn.position).toMatchObject({ stop: 27936.5, target: 28538.5 });
    expect(liveWorkingOrderView(data)).toEqual({ lines: [], badges: [], key: EMPTY_LIVE_WORKING_KEY });
    // Bez čar pozice (vstup neznámý → livePositionChartLines nekreslí nic) se nohy ukážou samy.
    const undrawn = liveWorkingOrderLines({ ...data, drawn: { position: { ...data.drawn.position!, entry: null } } });
    expect(undrawn.map(line => [line.role, line.price, line.quantity])).toEqual([['target-leg', 28538.5, 2], ['stop-leg', 27936.5, 2]]);
    // (28538.5 − 28083.625) · 2 ks · 2 = +1819.50 (vstup leadera z karty).
    expect(undrawn[0].label).toMatch(/^TP 2 ks {2}28538\.50 · \+\$1819\.50 · 454\.88 b$/);
  });

  it('t 7221: čekající přikoupení kreslí pozice (vlastní čára s ×) → tady nic; Suspended nohy nikdy', () => {
    const pendingAdd = { price: 28027.5, quantity: 1, orderType: 'Limit' };
    expect(liveWorkingOrderLines(fixtureInput(7221, { drawn: { position: drawnAt(7221, ordersAt(7221)), symbol: SYM, pendingAdd } }))).toEqual([]);
    // Worker přikoupení nehlásí → příkaz je vidět jako další vstup, jen pro čtení.
    const lines = liveWorkingOrderLines(fixtureInput(7221));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ role: 'order', kind: 'entry', side: 'buy', orderClass: 'limit', price: 28027.5, quantity: 1 });
    expect(lines[0].label).toBe('LMT BUY 1  28027.50 · Tradovate');
  });
});

describe('U5: seskupení, filtry a pořadí', () => {
  it('jedna cena → jedna čára: stejný účet, typ, strana a cena se sečtou; id jsou unikátní', () => {
    const a = order({ price: 20990 });
    const b = order({ price: 20990, quantity: 2 });
    const c = order({ price: 20990, action: 'Sell' });
    const d = order({ price: null, stopPrice: 20990, orderType: 'Stop' });
    const lines = liveWorkingOrderLines(input([a, b, c, d]));
    expect(lines).toHaveLength(3);
    const buyLimit = lines.find(line => line.side === 'buy' && line.orderClass === 'limit')!;
    expect(buyLimit).toMatchObject({ quantity: 3, orderIds: [a.id, b.id], label: 'LMT BUY 3  20990.00 · Tradovate' });
    expect(new Set(lines.map(line => line.id)).size).toBe(lines.length);
  });

  it('jen pracující příkazy účtů pohledu na kontraktu grafu, s cenou; Market nikdy', () => {
    const lines = liveWorkingOrderLines(input([
      order({ symbol: 'MNQH7' }),
      order({ accountId: FOLLOWER }),
      order({ accountId: null }),
      order({ working: false, status: 'Suspended' }),
      order({ orderType: 'Market', price: 21010 }),
      order({ price: null }),
      order({ orderType: 'Stop', price: 20995, stopPrice: null }),
      order({ quantity: 0 }),
      order({ symbol: ' mnqz6 ', price: 20975 }),
    ]));
    expect(lines.map(line => line.price)).toEqual([20975]);
  });

  it('StopLimit leží na spouštěcí ceně, limit je v tooltipu', () => {
    const [line] = liveWorkingOrderLines(input([order({ orderType: 'StopLimit', action: 'Sell', stopPrice: 20980, price: 20978.25 })]));
    expect(line).toMatchObject({ price: 20980, orderClass: 'stopLimit', label: 'STP LMT SELL 1  20980.00 · Tradovate' });
    expect(line.title).toMatch(/limit 20978\.25/);
  });

  it('pozice s jednou cenou SL/TP: nohy na ní se vynechají, cizí příkazy zůstanou', () => {
    const lines = liveWorkingOrderLines(input([
      order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 21000 }),
      order({ action: 'Sell', orderType: 'Limit', price: 21100 }),
      order({ action: 'Buy', orderType: 'Limit', price: 21020 }),
      order({ action: 'Sell', orderType: 'Limit', price: 21120 }),
    ], { drawn: { position: longPosition() } }));
    expect(lines.map(line => [line.role, line.price])).toEqual([['target-leg', 21120], ['order', 21020]]);
  });

  it('čekající vstup: vynechá se jen ten, který kreslí karta (první na ceně), ne další', () => {
    const pending = longPosition({ kind: 'pending', entry: 21000, entryType: 'Limit', stop: null, target: null });
    const first = order({ price: 21000 });
    const second = order({ price: 21000 });
    const other = order({ price: 20980 });
    const lines = liveWorkingOrderLines(input([first, second, other], { drawn: { position: pending } }));
    expect(lines.map(line => [line.price, line.orderIds])).toEqual([[21000, [second.id]], [20980, [other.id]]]);
    // U čekajícího vstupu nejsou nohy SL/TP pozice — výstupní příkaz je obyčejný příkaz.
    const exit = liveWorkingOrderLines(input([order({ action: 'Sell', price: 21100 })], { drawn: { position: pending } }));
    expect(exit[0].role).toBe('order');
  });

  it('pozice na jiném kontraktu nic nevynechává (čáry pozice tu neleží)', () => {
    const lines = liveWorkingOrderLines(input([order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 21000 })], {
      drawn: { position: longPosition(), symbol: 'MNQH7' },
    }));
    expect(lines).toHaveLength(1);
    expect(lines[0].role).toBe('order');
  });

  it('víc účtů: poznámka = účet; $ jen u nohy účtu, jehož vstup známe', () => {
    const lines = liveWorkingOrderLines(input([
      order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20990 }),
      order({ accountId: FOLLOWER, accountName: 'T2', action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20980 }),
    ], { accountIds: [LEADER, FOLLOWER], drawn: { position: longPosition({ stop: null }) } }));
    expect(lines.map(line => line.label)).toEqual([
      'SL 1 ks  20990.00 · −$120.00 · 60.00 b · DEMO leader',
      'SL 1 ks  20980.00 · T2',
    ]);
  });

  it('víc než 12 čar → 12 (nohy SL/TP přednostně) + štítek „+N dalších“ bez čáry', () => {
    const many = Array.from({ length: 15 }, (_, index) => order({ price: 20700 + index * 10 }));
    const legs = [
      order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20500 }),
      order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20510 }),
    ];
    const view = liveWorkingOrderView(input([...many, ...legs], { drawn: { position: longPosition({ stop: null, target: null }) } }));
    expect(view.lines).toHaveLength(LIVE_WORKING_MAX_LINES);
    expect(view.lines.filter(line => line.role === 'stop-leg').map(line => line.price)).toEqual([20510, 20500]);
    const overflow = view.badges.find(badge => badge.kind === 'overflow')!;
    expect(overflow).toMatchObject({ text: '+5 dalších', price: null, count: 5 });
    expect(overflow.title).toMatch(/LMT BUY 1 \d+\.00/);
  });
});

describe('U5: nepodporovaný typ a vadná data', () => {
  it('nepodporovaný typ = jen štítek (s cenou, když je konečná), nikdy čára', () => {
    const view = liveWorkingOrderView(input([
      order({ orderType: 'TrailingStop', action: 'Sell', price: null, stopPrice: 20980 }),
      order({ orderType: 'Unsupported', brokerOrderType: 'MIT', action: 'Buy', price: null, stopPrice: null } as Partial<LiveOrder>),
      order({ orderType: '—', action: 'Buy', price: 20970 }),
    ]));
    expect(view.lines).toEqual([]);
    expect(view.badges.map(badge => [badge.kind, badge.text, badge.price])).toEqual(expect.arrayContaining([
      ['unsupported', 'TRAILINGSTOP SELL 1 · nepodporovaný typ · 20980.00', 20980],
      ['unsupported', 'MIT BUY 1 · nepodporovaný typ', null],
      ['unsupported', '? BUY 1 · nepodporovaný typ · 20970.00', 20970],
    ]));
    expect(view.badges).toHaveLength(3);
  });

  it('neznámá strana = štítek, ne čára; víc nepodporovaných než strop → „+N dalších“', () => {
    const view = liveWorkingOrderView(input([
      order({ action: '—' }),
      ...Array.from({ length: LIVE_WORKING_MAX_BADGES + 1 }, (_, index) => order({ orderType: 'MIT', price: 20900 + index })),
    ]));
    expect(view.lines).toEqual([]);
    expect(view.badges.filter(badge => badge.kind === 'unsupported')).toHaveLength(LIVE_WORKING_MAX_BADGES);
    expect(view.badges.find(badge => badge.kind === 'overflow')).toMatchObject({ text: '+2 dalších' });
    expect(liveWorkingOrderView(input([order({ action: '?!' })])).badges[0].text).toBe('LIMIT ? 1 · neznámá strana · 21000.00');
  });

  it('typ příkazu: stejné rozlišení jako karta obchodu', () => {
    expect(['Limit', 'stop', 'Stop Limit', 'STOPLIMIT', 'Market', 'TrailingStop', 'MarketIfTouched', 'Unsupported', '', null]
      .map(value => liveWorkingOrderClass(value))).toEqual(['limit', 'stop', 'stopLimit', 'stopLimit', 'market', 'unsupported', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
  });

  it('vadná data nikdy nevyhodí výjimku (getter, který hází → prázdný pohled)', () => {
    const exploding = order();
    Object.defineProperty(exploding, 'symbol', { get: () => { throw new Error('boom'); } });
    expect(() => liveWorkingOrderView(input([exploding]))).not.toThrow();
    expect(liveWorkingOrderView(input([exploding])).key).toBe(EMPTY_LIVE_WORKING_KEY);
    const junk = [null, undefined, {}, { working: true }, order({ price: Number.NaN }), order({ quantity: Number.POSITIVE_INFINITY }),
      order({ action: 42 as unknown as string, orderType: {} as unknown as string })] as unknown as LiveOrder[];
    expect(() => liveWorkingOrderView(input(junk))).not.toThrow();
    expect(() => liveWorkingOrderView(null as unknown as LiveWorkingOrdersInput)).not.toThrow();
    expect(() => liveWorkingOrderView({ ...input([order()]), orders: undefined as unknown as LiveOrder[], drawn: undefined as unknown as LiveWorkingOrdersInput['drawn'] })).not.toThrow();
  });
});

describe('U5: čáry jsou jen zobrazení (INV-UI-03, INV-MANUAL-01)', () => {
  const mixed = () => liveWorkingOrderView(input([
    order({ price: 20990 }), order({ action: 'Sell', price: 21130 }),
    order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20990 }),
    order({ action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20980 }),
    order({ action: 'Sell', orderType: 'Limit', price: 21150 }),
    order({ orderType: 'StopLimit', price: 21070, stopPrice: 21072 }),
  ], { drawn: { position: longPosition({ stop: null, target: null }) } }));

  it('žádná čára nejde táhnout, zrušit ×, nemá tlačítka ani přidání SL/TP', () => {
    const { lines } = mixed();
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(line.ownerId).toBe(LIVE_WORKING_OWNER);
      expect(line.draggable).toBe(false);
      expect(line.cancellable).toBe(false);
      expect(line.displayOnly).toBe(true);
      expect(line.lineStyle).toBe('dotted');
      expect(line.title).toMatch(/Spravuj v Tradovate, nebo zavři pozici ×\/Flatten/);
      for (const field of ['cancelAction', 'confirmCancel', 'actions', 'addableBrackets', 'labelAt', 'bracketLabelAt', 'dragDeadZonePx'] as const) {
        expect(line[field], `${line.id}.${field}`).toBeUndefined();
      }
      // Barva = #rrggbb (overlay k ní připojuje alfu).
      expect(line.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('handlery poznají čáru jen pro zobrazení; čáry pozice ne', () => {
    for (const line of mixed().lines) expect(isLiveDisplayOnlyLine(line)).toBe(true);
    const summary: LiveChartPositionSummary = {
      kind: 'position', side: 'long', quantity: 1, entry: 21050, entryType: null, openPnl: null, mark: null, stop: 21000, target: 21100,
      protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null, leader: { accountId: LEADER, quantity: 1, entry: 21050 }, rows: [],
    };
    const positionLines = livePositionChartLines(summary, { manageable: true, entryAvg: 21050, pointValue: 2 });
    expect(positionLines.every(line => line.ownerId === LIVE_POSITION_OWNER && !isLiveDisplayOnlyLine(line))).toBe(true);
    expect(LIVE_WORKING_OWNER).not.toBe(LIVE_POSITION_OWNER);
  });

  it('statická kontrola: modul nic neposílá a vlastník live-working nemá větev se správou', () => {
    const source = readFileSync('lib/liveWorkingOrderLines.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports.sort()).toEqual(['../services/backtestOrderLines', '../services/tradecopiaLiveService', './liveReadFreshness']);
    expect(source).toMatch(/import type \{ BacktestChartOrderLine, BacktestChartOrderLineKind \} from '\.\.\/services\/backtestOrderLines'/);
    expect(source).toMatch(/import type \{ LiveAccount \} from '\.\.\/services\/tradecopiaLiveService'/);
    expect(source).not.toMatch(/fetch\(|leaderOrderManage|leaderEntryPlace|manage-leader-order|place-leader-entry|cancelAction|relay/i);
    // Komponenty, které čáry live-working použijí, je nesmí na stejném řádku posílat do správy / zadání.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk('components');
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
        if (!/LIVE_WORKING_OWNER|'live-working'/.test(text)) return;
        expect(text, `${file}:${index + 1}`).not.toMatch(/runLiveManage|manage\(|onManage|placeLeaderEntry|manageLeaderEntry|attachBrackets|run\(/);
      });
    }
  });
});
