import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildLiveTradeGroup, copierArmedForRules, copierProvablyOff, liveAccountPositionText, liveChartDisarm, liveTradeGroupKey, shortAccountLabel,
} from '../lib/liveTradeGroupSource';
import { breakEvenStop, liveChartPosition, tightenBlockReason, TIGHTEN_MIN_TICKS } from '../lib/liveChartPosition';
import { EMPTY_JOURNAL_LIVE_VIEW, type JournalLiveView } from '../lib/journalLivePosition';
import { limitAccounts, participatingFollowers, soloTradeBlockReason, targetMultiplier } from '../lib/liveTradeTarget';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { TradeCardModel } from '../lib/liveTradeCard';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const fresh = new Date(NOW - 2_000).toISOString();

const account = (id: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  id, name: `ACC${id}`, positions: [], positionsAvailability: 'available', positionsUpdatedAt: fresh,
  ordersAvailability: 'available', ordersUpdatedAt: fresh,
  ...patch,
} as unknown as LiveAccount);
const order = (accountId: number, working: boolean): LiveOrder => ({ id: accountId * 10, accountId, working } as unknown as LiveOrder);

const controller = (patch: Record<string, unknown> = {}) => ({
  armed: true, transportResume: null, excludedForeignFollowers: [], followerParticipation: [], ...patch,
}) as never;

describe('LIVE → Graf: stav kopírky pro pravidla a vypnutí', () => {
  it('prokazatelně vypnuto jen z čerstvého stavu bez čekajícího automatického pokračování', () => {
    expect(copierProvablyOff(controller({ armed: false }), true)).toBe(true);
    expect(copierProvablyOff(controller({ armed: false }), false)).toBe(false);
    expect(copierProvablyOff(controller({ armed: false, transportResume: { phase: 'waiting' } }), true)).toBe(false);
    expect(copierProvablyOff(controller({ armed: false, transportResume: { phase: 'ready' } }), true)).toBe(false);
    expect(copierProvablyOff(controller({ armed: false, transportResume: { phase: 'declined' } }), true)).toBe(true);
    expect(copierProvablyOff(null, true)).toBe(false);
  });

  it('pravidla výběru účtu: zapnuto jen z čerstvého stavu, jinak neověřeno (null)', () => {
    expect(copierArmedForRules(controller({ armed: true }), true)).toBe(true);
    expect(copierArmedForRules(controller({ armed: true }), false)).toBeNull();
    expect(copierArmedForRules(controller({ armed: false }), true)).toBe(false);
    expect(copierArmedForRules(controller({ armed: false, transportResume: { phase: 'waiting' } }), true)).toBeNull();
    expect(copierArmedForRules(null, false)).toBeNull();
  });

  it('Vypnout je vidět vždy kromě prokazatelně vypnuté kopírky; čekající pokračování se ruší', () => {
    expect(liveChartDisarm(controller({ armed: false }), true)).toBeNull();
    expect(liveChartDisarm(controller({ armed: true }), true)).toEqual({ label: 'Vypnout kopírku', unverified: false });
    expect(liveChartDisarm(controller({ armed: true }), false)).toEqual({ label: 'Vypnout kopírku', unverified: true });
    expect(liveChartDisarm(null, false)).toEqual({ label: 'Vypnout kopírku', unverified: true });
    expect(liveChartDisarm(controller({ armed: false, transportResume: { phase: 'waiting' } }), true))
      .toEqual({ label: 'Zrušit automatické pokračování', unverified: false });
  });
});

describe('LIVE → Graf: skupina ze stavu workeru', () => {
  const group = { leaderAccountId: 1, followers: [
    { accountId: 2, mode: 'on-submit' as const, multiplier: 1 },
    { accountId: 3, mode: 'on-submit' as const, multiplier: 2 },
    { accountId: 4, mode: 'on-submit' as const, multiplier: 1, enabled: false },
  ] };
  const build = (statusFresh: boolean, ctl = controller({ excludedForeignFollowers: [3] })) => buildLiveTradeGroup({
    group, controller: ctl, statusFresh,
    displayAccounts: [account(1), account(2), account(3), account(4), account(9)],
    positionAccounts: [account(1, { positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 2, netPrice: 29650.25 } as never] }), account(2)],
    orders: [], nameOf: id => `Účet ${id}`, root: 'MNQ', now: NOW,
  })!;

  it('bez skupiny workeru nic (graf bez čipu), ne ukázka', () => {
    expect(buildLiveTradeGroup({ group: null, controller: null, statusFresh: true, displayAccounts: [], positionAccounts: [], orders: [], nameOf: String, root: 'MNQ', now: NOW })).toBeNull();
  });

  it('leader, followeři s násobkem, účty mimo skupinu; vyřazení jen z čerstvého stavu', () => {
    const fromFresh = build(true);
    expect(fromFresh.leader.accountId).toBe(1);
    expect(fromFresh.followers.map(entry => [entry.accountId, entry.multiplier, entry.excluded ?? false, entry.inactiveReason ?? null]))
      .toEqual([[2, 1, false, null], [3, 2, true, null], [4, 1, false, 'vypnutý ve skupině']]);
    expect(fromFresh.outside.map(entry => entry.accountId)).toEqual([9]);
    expect(fromFresh.armed).toBe(true);
    expect(fromFresh.sample).toBe(false);
    const fromRestored = build(false);
    expect(fromRestored.followers.find(entry => entry.accountId === 3)?.excluded).toBeUndefined();
    expect(fromRestored.armed).toBeNull();
  });

  it('pozice jen z ověřeného čtení; neznámé = null („—“), nikdy „flat“', () => {
    const built = build(true);
    expect(built.leader.position).toMatch(/^\+2 @ 29\s650,25$/);
    expect(built.followers[0].position).toBe('flat');
    expect(built.followers[1].position).toBeNull(); // účet chybí v překryvu pozic
    expect(built.leader.dayPnl.value).toBeNull(); // bez zobrazovacích hodnot neznámo, ne 0
  });

  it('follower, který nekopíruje (cut/DLL/vypnutý), samostatně za zapnuté kopírky nejde; vyřazený ano', () => {
    const built = build(true);
    const [, excluded, inactive] = built.followers;
    expect(soloTradeBlockReason(excluded, true)).toBeNull();
    expect(soloTradeBlockReason(inactive, true)).toMatch(/nekopíruje/);
    expect(soloTradeBlockReason(built.outside[0], true)).toBeNull();
    // Neověřený stav: i účet mimo skupinu je zamčený (členství může být ze starého stavu).
    expect(soloTradeBlockReason(built.outside[0], null)).toMatch(/není ověřený/);
    expect(soloTradeBlockReason(built.leader, false)).toBeNull();
  });

  it('follower, který nekopíruje, se do skupiny nepočítá (násobek, limity)', () => {
    const built = build(true);
    expect(participatingFollowers(built).map(entry => entry.accountId)).toEqual([2]);
    expect(targetMultiplier(built, { kind: 'group' })).toBe(2);
    expect(limitAccounts(built, { kind: 'group' }).map(({ account }) => account.accountId)).toEqual([1, 2]);
  });

  it('obsahový klíč se mění jen se změnou zobrazených dat', () => {
    expect(liveTradeGroupKey(build(true))).toBe(liveTradeGroupKey(build(true)));
    expect(liveTradeGroupKey(build(true))).not.toBe(liveTradeGroupKey(build(false)));
  });
});

describe('LIVE → Graf: text pozice účtu', () => {
  it('flat s čekajícími příkazy, neověřené příkazy, cena po změně velikosti neznámá', () => {
    expect(liveAccountPositionText(account(5), [order(5, true), order(5, true)], 'MNQ', NOW)).toBe('flat · 2 příkazy');
    expect(liveAccountPositionText(account(5, { ordersAvailability: 'unavailable' } as never), [], 'MNQ', NOW)).toBe('flat · příkazy ?');
    expect(liveAccountPositionText(account(5, { positions: [{ symbol: 'MNQZ6', netPosition: -1, netPrice: null } as never] }), [], 'MNQ', NOW)).toBe('-1 @ —');
    expect(liveAccountPositionText(account(5, { positionsUpdatedAt: new Date(NOW - 120_000).toISOString() } as never), [], 'MNQ', NOW)).toBeNull();
  });

  it('krátký štítek na čáru', () => {
    expect(shortAccountLabel('TDFYG1234567')).toBe('T567');
    expect(shortAccountLabel('Lucid')).toBe('Luci');
  });
});

describe('LIVE → Graf: pozice do panelu a grafu', () => {
  const model = {
    kind: 'position', symbol: 'MNQZ6', direction: 1, entryType: null, quantity: 3, entry: 29650, mark: null, openPnl: -42,
    stop: {} as never, target: {} as never, ladder: { stop: 29600, target: 29750 }, stopCovered: 3, targetCovered: 2,
    accounts: [{}, {}, {}] as never, feesIncluded: true, totalFees: null, verified: true,
  } as unknown as TradeCardModel;
  const view = (patch: Partial<JournalLiveView>): JournalLiveView => ({ ...EMPTY_JOURNAL_LIVE_VIEW, target: 'group', verified: true, ...patch });

  it('ověřená pozice: souhrn s P&L z brokera a čáry', () => {
    const shown = liveChartPosition(view({ model }), 'group');
    expect(shown.summary).toMatchObject({ kind: 'position', side: 'long', quantity: 3, openPnl: -42, protection: 'SL 3/3 · TP 2/3' });
    expect(shown.lines.map(line => line.id)).toEqual(['entry', 'stop', 'target']);
  });

  it('ručně vypnutá kopírka s expozicí jen na jednom účtu: souhrn nese „jen …“', () => {
    const shown = liveChartPosition(view({ model, scopeLabel: 'jen T2' }), 'group');
    expect(shown.summary?.scopeLabel).toBe('jen T2');
    expect(shown.key).toContain('jen T2');
  });

  it('neověřený pohled: text místo čísel, žádné čáry', () => {
    const shown = liveChartPosition(view({ model, verified: false, issue: 'settling' }), 'group');
    expect(shown).toMatchObject({ summary: null, lines: [], issue: 'Kopie dobíhá…' });
  });

  it('pohled spadlý na skupinu nesmí ukázat pozici místo vybraného účtu', () => {
    const shown = liveChartPosition(view({ model, target: 'group' }), 7);
    expect(shown.summary).toBeNull();
    expect(shown.lines).toEqual([]);
    expect(shown.issue).toMatch(/není v datech/);
  });
});

describe('LIVE → Graf: vypnutí a strážní pravidla', () => {
  const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
  const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
  const overview = readFileSync('components/LiveCopyTradeOverview.tsx', 'utf8');

  it('neověřené vypnutí má stejný text jako přehled LIVE', () => {
    const text = /const UNVERIFIED_DISARM_TEXT = '([^']+)'/.exec(screen)?.[1];
    expect(text).toBeTruthy();
    expect(overview).toContain(text!);
  });

  it('graf vypíná jen přes safety cestu desku, stabilní funkcí přes ref, bez opakování', () => {
    expect(desk).toMatch(/safetyCommandRef\.current = executeSafetyCommand;/);
    expect(desk).toMatch(/await safetyCommandRef\.current\(\{ type: 'disarm' \}\);/);
    expect(desk).toMatch(/const disarmFromChart = useCallback\(async \(\)[^]*?\}, \[\]\);/);
      });

  it('hláška z grafu na přehledu má čas a zmizí po zapnutí kopírky nebo po 10 minutách', () => {
    expect(desk).toMatch(/armedNow \|\| freshnessNow - chartSafetyNotice\.at > 10 \* 60_000/);
    expect(desk).toMatch(/agentStatusFresh && !agentStatusRestored && agentStatus\?\.controller\.armed === true/);
    expect(desk).toMatch(/toLocaleTimeString\('cs-CZ'/);
  });

  it('dvojklik na Vypnout: zámek přes ref nezávislý na překreslení', () => {
    expect(screen).toMatch(/if \(!onDisarm \|\| disarmBusy \|\| disarmInFlightRef\.current\) return;\n    disarmInFlightRef\.current = true;/);
  });

  it('BE a Zavřít pozici v panelu nic neodesílají', () => {
    const ticket = readFileSync('components/LiveOrderTicket.tsx', 'utf8');
    const card = ticket.slice(ticket.indexOf('const PositionCard'), ticket.indexOf('/** Jak dlouho výsledek náhledu platí'));
    expect(card).toMatch(/disabled\n/);
    expect(card).not.toMatch(/onClick/);
  });
});

describe('LIVE → Graf: SL na BE a pojistka utažení (fáze 2c, jen UI)', () => {
  it('BE na tick ve směru ochrany, s epsilonem proti součtům fillů', () => {
    expect(breakEvenStop('long', 29029.3)).toBe(29029.25);
    expect(breakEvenStop('short', 29029.3)).toBe(29029.5);
    // 3 filly 29029.25/.25/.5 → průměr těsně pod tickem nesmí ubrat celý tick.
    expect(breakEvenStop('long', (29029.25 + 29029.25 + 29029.75) / 3 - 1e-12)).toBe(29029.25);
    expect(breakEvenStop('long', 29029.25 - 1e-11)).toBe(29029.25);
    expect(breakEvenStop('short', 29029.25 + 1e-11)).toBe(29029.25);
    expect(breakEvenStop('long', null)).toBeNull();
  });

  it('utažení jen s cenou od brokera a aspoň N ticků od trhu; posun dál od trhu bez pojistky', () => {
    const gap = TIGHTEN_MIN_TICKS * 0.25;
    expect(tightenBlockReason('long', 29000, 28990, null)).toBeNull();
    expect(tightenBlockReason('long', 29000, 29010, null)).toMatch(/není známá/);
    expect(tightenBlockReason('long', 29000, 29010, 29010 + gap)).toBeNull();
    expect(tightenBlockReason('long', 29000, 29010, 29010 + gap - 0.25)).toMatch(/ticků/);
    expect(tightenBlockReason('long', 29000, 29020, 29010)).toMatch(/ticků/);
    expect(tightenBlockReason('short', 29100, 29090, 29090 - gap)).toBeNull();
    expect(tightenBlockReason('short', 29100, 29090, 29090 - gap + 0.25)).toMatch(/ticků/);
    expect(tightenBlockReason('short', 29100, 29110, null)).toBeNull();
  });
});
