// B1 (3. 11. 2026): data a callbacky desku pro U2/U4/U5/U8/U10 — nová pole s bezpečnými výchozími
// hodnotami, beze změny dnešního chování. Nic z toho neodesílá; příkazy jdou dál jen přes callbacky desku.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import { NO_LIVE_CHART_POSITION, type LiveChartPosition, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import { EMPTY_LIVE_WORKING_KEY, LIVE_WORKING_OWNER, isLiveDisplayOnlyLine } from '../lib/liveWorkingOrderLines';
import { liveBareEntryRecord, liveEntryBlockedReason } from '../lib/livePhoneOrders';
import { liveChartFills, liveChartWorkingOrders, liveChartWorkingSource } from '../hooks/useLiveChartData';
import type { LiveFillMarker } from '../lib/liveFillMarkers';

const root = join(__dirname, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const NOW = Date.parse('2026-11-03T15:00:00Z');
const fresh = new Date(NOW - 2_000).toISOString();
const LEADER = 1001;
const FOLLOWER = 2002;
const SYM = 'MNQZ6';

const account = (id: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  id, name: `ACC${id}`, positions: [], positionsAvailability: 'available', positionsUpdatedAt: fresh,
  ordersAvailability: 'available', ordersUpdatedAt: fresh, ...patch,
} as unknown as LiveAccount);
const order = (patch: Partial<LiveOrder>): LiveOrder => ({
  id: 1, accountId: LEADER, accountName: 'DEMO leader', action: 'Buy', orderType: 'Limit', quantity: 1,
  price: 21000, stopPrice: null, status: 'Working', symbol: SYM, placedAt: null, updatedAt: null, working: true, ...patch,
});
const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 1, entry: 21000, entryType: null, openPnl: null, mark: null,
  stop: 20980, target: 21040, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
  leader: { accountId: LEADER, quantity: 1, entry: 21000 }, rows: [], ...patch,
} as LiveChartPositionSummary);
const position = (patch: Partial<LiveChartPosition> = {}): LiveChartPosition => ({
  key: 'pos', symbol: SYM, lines: [], summary: summary(), issue: null, ...patch,
});
const GROUP = { kind: 'group' } as const;
const sourceOf = (input: Partial<Parameters<typeof liveChartWorkingSource>[0]> = {}) => liveChartWorkingSource({
  enabled: true, accounts: [account(LEADER), account(FOLLOWER)], orders: [], target: GROUP,
  leaderAccountId: LEADER, position: NO_LIVE_CHART_POSITION, now: NOW, ...input,
});

describe('B1: brána odeslání ručního vstupu (telefon i PC)', () => {
  const ok = { entrySupported: true, fresh: true, armed: true, shadowMode: false, entries: [{ status: 'acknowledged' }], relay: true };

  it('pořadí a texty jsou přesně dřívější inline brána telefonu; null jen když vše sedí', () => {
    expect(liveEntryBlockedReason(ok)).toBeNull();
    expect(liveEntryBlockedReason({ ...ok, entrySupported: false, fresh: false, armed: false, relay: false })).toBe('Worker odeslání z appky neumí.');
    expect(liveEntryBlockedReason({ ...ok, fresh: false, armed: false, relay: false })).toBe('Stav kopírky se ověřuje…');
    expect(liveEntryBlockedReason({ ...ok, armed: false, relay: false })).toBe('Kopírka je vypnutá — zapni ji na Live Dashboardu.');
    expect(liveEntryBlockedReason({ ...ok, shadowMode: true })).toBe('Kopírka je vypnutá — zapni ji na Live Dashboardu.');
    for (const status of ['sending', 'unknown']) {
      expect(liveEntryBlockedReason({ ...ok, entries: [{ status: 'acknowledged' }, { status }], relay: false }))
        .toBe('Předchozí vstup nemá výsledek — počkej / vyřeš na Live Dashboardu.');
    }
    expect(liveEntryBlockedReason({ ...ok, relay: false })).toBe('Chybí připojení k workeru přes relay.');
    // Bez záznamů (starší worker, null) nic neblokuje navíc.
    expect(liveEntryBlockedReason({ ...ok, entries: undefined })).toBeNull();
  });

  it('desk: telefon i PC berou tutéž bránu (žádná druhá, volnější cesta)', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/const entryBlockedReason = liveEntryBlockedReason\(\{\s*entrySupported: supportsCopierManualEntry\(agentStatus\),\s*fresh: agentStatusFresh && !agentStatusRestored,/);
    expect(desk).toContain('blockedReason: entryBlockedReason,');
    expect(desk).toContain('entryBlockedReason={entryBlockedReason}');
    // Inline kopie brány v phoneTrade už není.
    const tradeBlock = desk.slice(desk.indexOf('const phoneTrade = useMemo'), desk.indexOf('const phoneFills = useMemo'));
    expect(tradeBlock).not.toMatch(/Stav kopírky se ověřuje|entries\.some/);
  });
});

describe('B1: holý vstup a pozice leadera (U4)', () => {
  it('záznam se zúží na pole LiveBareEntryRecord (nic navíc z durable záznamu)', () => {
    const raw = {
      operationId: 'entry:abc', status: 'acknowledged', createdAt: 5, updatedAt: 9, symbol: SYM, side: 'Buy' as const, quantity: 2,
      bare: true, open: true, reason: 'x', timing: { ackAt: 7 }, entryBrokerOrderId: '77',
    };
    expect(liveBareEntryRecord(raw)).toEqual({ operationId: 'entry:abc', status: 'acknowledged', createdAt: 5, symbol: SYM, side: 'Buy', quantity: 2, bare: true, open: true });
    expect(liveBareEntryRecord(null)).toBeNull();
    expect(liveBareEntryRecord(undefined)).toBeNull();
  });

  it('desk: holý vstup jen přes newestOpenBareEntry a jen v pohledu leadera skupiny workeru; attach jen s capability', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/const chartBareEntry = useMemo\(\(\) => \(chartLeaderBasis\s*\? liveBareEntryRecord\(newestOpenBareEntry\(agentStatus\?\.controller\.manualEntries, chartPositionSymbol\)\)\s*: null\)/);
    // Ovládání po fillu se neschová (review Codexu): nabídky i z neověřené pozice, odeslání zastaví brána.
    expect(desk).toMatch(/const chartManageSummary = chartData\.position\?\.summary \?\? null;/);
    expect(desk).toMatch(/const chartGuard = useMemo\(\(\) => createLiveChartCommandGuard\(\{/);
    expect(desk).toMatch(/livePhonePosition\(chartManageSummary, chartLeaderBasis, chartPositionSymbol, chartBareEntry\?\.operationId \?\? null\)/);
    // PC: Přidat SL/TP = deskový attachBrackets, jen když worker inzeruje manual-entry-bare-v1.
    expect(desk.match(/onAttachBrackets/g)).toHaveLength(1);
    expect(desk).toContain('{...(supportsCopierManualEntryBare(agentStatus) && !supportsCopierManualOrderSingleLeg(agentStatus) ? { onAttachBrackets: attachBrackets } : {})}');
    // Telefon: náhled = deskový previewLeaderEntry jen s capability ručního vstupu.
    expect(desk.match(/preview: previewLeaderEntry/g)).toHaveLength(1);
    expect(desk).toContain('...(supportsCopierManualEntry(agentStatus) ? { preview: previewLeaderEntry } : {}),');
    // Inline kopie výběru holého vstupu zmizela (jediná logika je v lib/liveBareEntry).
    expect(desk).not.toMatch(/newest\.bare === true/);
  });
});

describe('B1: pracující příkazy pro graf (U5) — jen zobrazení', () => {
  it('neověřené čtení příkazů, pozice s issue nebo vypnutý pohled = nic (žádná poslední známá poloha)', () => {
    const foreign = [order({})];
    expect(sourceOf({ enabled: false, orders: foreign })).toMatchObject({ orders: [], accountIds: [], verified: false });
    expect(sourceOf({ orders: foreign, accounts: [account(LEADER, { ordersAvailability: 'unavailable' } as Partial<LiveAccount>)] }))
      .toMatchObject({ orders: [], verified: false });
    expect(sourceOf({ orders: foreign, accounts: [account(LEADER, { ordersUpdatedAt: new Date(NOW - 60_000).toISOString() } as Partial<LiveAccount>)] }))
      .toMatchObject({ orders: [], verified: false });
    expect(sourceOf({ orders: foreign, position: position({ issue: 'Kopie dobíhá…', summary: null, symbol: null }) }))
      .toMatchObject({ orders: [], verified: false });
    expect(sourceOf({ orders: foreign, accounts: [] })).toMatchObject({ verified: false });
    for (const unverified of [sourceOf({ enabled: false, orders: foreign }), null, undefined]) {
      expect(liveChartWorkingOrders(unverified, { frontContract: SYM })).toEqual({ lines: [], badges: [], key: EMPTY_LIVE_WORKING_KEY, contract: null });
    }
  });

  it('skupina = příkazy leadera, jeden účet = příkazy toho účtu', () => {
    expect(sourceOf({}).accountIds).toEqual([LEADER]);
    expect(sourceOf({ target: { kind: 'account', accountId: String(FOLLOWER) } }).accountIds).toEqual([FOLLOWER]);
    expect(sourceOf({ leaderAccountId: null }).accountIds).toEqual([]);
    expect(sourceOf({ leaderAccountId: null }).verified).toBe(false);
  });

  it('cizí Limit bez pozice: kontrakt z frontu brokera; čára nejde táhnout ani zrušit', () => {
    const working = sourceOf({ orders: [order({}), order({ id: 2, accountId: FOLLOWER })] });
    expect(working.verified).toBe(true);
    // Bez pozice a bez frontu kontrakt neznáme → nic.
    expect(liveChartWorkingOrders(working, {}).lines).toEqual([]);
    const view = liveChartWorkingOrders(working, { frontContract: SYM, pointValue: 2 });
    expect(view.contract).toBe(SYM);
    expect(view.lines).toHaveLength(1);
    const [line] = view.lines;
    expect(line).toMatchObject({ ownerId: LIVE_WORKING_OWNER, draggable: false, cancellable: false, displayOnly: true, price: 21000, accountId: LEADER });
    expect(line.label).toMatch(/^LMT BUY 1/);
    expect(isLiveDisplayOnlyLine(line)).toBe(true);
    expect('cancelAction' in line || 'actions' in line || 'labelAt' in line).toBe(false);
    // Jiný kontrakt grafu (front jiný měsíc) = nic.
    expect(liveChartWorkingOrders(working, { frontContract: 'MNQH7' }).lines).toEqual([]);
  });

  it('s pozicí: kontrakt pozice, nekreslí dvakrát SL/TP pozice ani čekající přikoupení s ×', () => {
    const orders = [
      order({ id: 10, action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20980 }), // SL pozice (už má čáru)
      order({ id: 11, action: 'Sell', orderType: 'Limit', price: 21040 }), // TP pozice (už má čáru)
      order({ id: 12, action: 'Sell', orderType: 'Stop', price: null, stopPrice: 20970 }), // rozjetá SL noha
      order({ id: 13, action: 'Buy', orderType: 'Limit', price: 20990 }), // čekající přikoupení
    ];
    const working = sourceOf({ orders, position: position() });
    const withAdd = liveChartWorkingOrders(working, { frontContract: 'MNQH7', pendingAdd: { price: 20990, orderType: 'Limit' }, pointValue: 2 });
    expect(withAdd.contract).toBe(SYM);
    expect(withAdd.lines.map(line => [line.role, line.price])).toEqual([['stop-leg', 20970]]);
    // Bez čáry přikoupení (worker bez capability) se čekající Limit ukáže jako pracující příkaz.
    const withoutAdd = liveChartWorkingOrders(working, { pointValue: 2 });
    expect(withoutAdd.lines.map(line => [line.role, line.price])).toEqual([['order', 20990], ['stop-leg', 20970]]);
    expect(withAdd.key).not.toBe(withoutAdd.key);
    // Stejný obsah = stejný klíč (graf se nepřekreslí).
    expect(liveChartWorkingOrders(working, { pendingAdd: { price: 20990, orderType: 'Limit' }, pointValue: 2 }).key).toBe(withAdd.key);
  });

  it('vadná data nevyhodí výjimku', () => {
    const junk = { orders: [null, { id: 'x' }] as unknown as LiveOrder[], accountIds: [LEADER], verified: true, position: { symbol: SYM } as unknown as LiveChartPosition };
    expect(() => liveChartWorkingOrders(junk, { frontContract: SYM })).not.toThrow();
    expect(liveChartWorkingOrders({ verified: true } as never, {}).lines).toEqual([]);
  });

  it('desk: čáry jdou jen do obálky grafu (PC prop, telefonní slot), nikdy do phoneTrade ani callbacků', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    const uses = desk.split('\n').filter(line => /\bchartWorkingOrders\b/.test(line)).map(line => line.trim());
    expect(uses).toEqual([
      'const chartWorkingOrders = useKeyedValue(chartWorkingWithIntents);',
      'workingOrders={chartWorkingOrders}',
      'workingOrders: chartWorkingOrders,',
    ]);
    expect(desk).toMatch(/pendingAdd: scaleInPendingAdd \? \{ price: scaleInPendingAdd\.price, orderType: scaleInPendingAdd\.orderType \} : null,/);
    const tradeBlock = desk.slice(desk.indexOf('const phoneTrade = useMemo'), desk.indexOf('const phoneFills = useMemo'));
    expect(tradeBlock).not.toMatch(/working|userId/i);
    for (const name of ['previewLeaderEntry', 'placeLeaderEntry', 'manageLeaderEntry', 'attachBrackets', 'runStaticSafetyAction']) {
      const start = desk.indexOf(`const ${name} = useCallback`);
      expect(start, name).toBeGreaterThan(0);
      expect(desk.slice(start, desk.indexOf('\n  }, [', start)), name).not.toMatch(/working|Working|userId/);
    }
    // Hook skládá podklad ze stejného čtení příkazů jako karta a z ověřené pozice.
    const hook = source('hooks/useLiveChartData.ts');
    expect(hook).toMatch(/const working = useMemo\(\(\) => liveChartWorkingSource\(\{\s*enabled: enabled && viewGroup != null,\s*accounts,\s*orders,/);
    expect(hook).toMatch(/return \{ group: tradeGroup, groupKey, position, disarm, working \};/);
  });
});

describe('B1: šipky plnění pro PC (U4)', () => {
  const fill = (id: string, patch: Partial<LiveFillMarker> = {}): LiveFillMarker => ({
    id, orderId: `o${id}`, at: NOW - 1_000, price: 21000, side: 'Buy', role: 'entry', quantity: 1, ...patch,
  });

  it('bez šipek prázdný pohled; klíč podle obsahu', () => {
    expect(liveChartFills({ fills: [], open: true, symbol: SYM })).toEqual({ key: 'none', fills: [], open: undefined });
    expect(liveChartFills(null)).toEqual({ key: 'none', fills: [], open: undefined });
    const a = liveChartFills({ fills: [fill('1')], open: true, symbol: SYM });
    expect(a).toMatchObject({ fills: [fill('1')], open: true, symbol: SYM });
    expect(liveChartFills({ fills: [fill('1')], open: true, symbol: SYM }).key).toBe(a.key);
    expect(liveChartFills({ fills: [fill('1')], open: false, symbol: SYM }).key).not.toBe(a.key);
    expect(liveChartFills({ fills: [fill('1'), fill('2', { role: 'exit', side: 'Sell' })], open: false, symbol: SYM }).key).not.toBe(a.key);
    expect(liveChartFills({ fills: [fill('1')], open: true, symbol: 'MNQH7' }).key).not.toBe(a.key);
  });
});

describe('B1: obálka PC grafu propouští nové podklady a porovnává je', () => {
  it('každá prop obálky je v porovnání memo (jinak by graf držel staré čáry/šipky)', () => {
    const slot = source('components/LiveTradingScreenSlot.tsx');
    const props = slot.slice(slot.indexOf('interface Props {'), slot.indexOf('\n}\n', slot.indexOf('interface Props {')));
    const names = [...props.matchAll(/^ {2}([A-Za-z]+)\??:/gm)].map(match => match[1]);
    expect(names).toEqual(expect.arrayContaining([
      'entryBareSupported', 'entryBareEntry', 'entryLeaderPosition', 'onAttachBrackets', 'entryBlockedReason',
      'manageLeaderAccountId', 'workingOrders', 'liveFills', 'userId',
    ]));
    const comparator = slot.slice(slot.indexOf('export default React.memo(LiveTradingScreenSlot'));
    // `group` se porovná obsahovým klíčem `groupKey`.
    for (const name of names.filter(name => name !== 'group')) {
      expect(comparator, name).toMatch(new RegExp(`left\\.${name}\\b`));
    }
    expect(comparator).toMatch(/\(left\.workingOrders\?\.key \?\? 'none'\) === \(right\.workingOrders\?\.key \?\? 'none'\)/);
    expect(comparator).toMatch(/\(left\.liveFills\?\.key \?\? 'none'\) === \(right\.liveFills\?\.key \?\? 'none'\)/);
  });

  it('desk předá PC grafu nové podklady s bezpečnými výchozími hodnotami', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    const pc = desk.slice(desk.indexOf('<LiveTradingScreenSlot'), desk.indexOf('/>', desk.indexOf('entryScaleIn={')));
    for (const prop of [
      'entryBareSupported={supportsCopierManualEntryBare(agentStatus)}',
      'entryBareEntry={chartBareEntry}',
      'entryLeaderPosition={chartLeaderPosition}',
      'manageLeaderAccountId={workerGroup?.leaderAccountId ?? null}',
      'workingOrders={chartWorkingOrders}',
      'liveFills={pcFills}',
      'userId={userId}',
    ]) expect(pc, prop).toContain(prop);
  });
});
