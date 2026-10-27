import { describe, expect, it } from 'vitest';
import {
  buildJournalLiveView, confirmWorkerMismatches, journalLivePriceLines, livePositionMatchesRoot, LIVE_STOP_COLOR, LIVE_TARGET_COLOR,
  JOURNAL_DIVERGENCE_CONFIRM_MS, JOURNAL_PNL_MAX_AGE_MS, WORKER_MISMATCH_CONFIRM_MS,
} from '../lib/journalLivePosition';
import { tradovatePositionPollDelay, tradovatePositionPollFirstDelay } from '../components/useTradovateLiveData';
import { createLivePriceLinesFeed } from '../lib/livePriceLinesFeed';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const now = Date.UTC(2026, 9, 27, 14, 0, 0);
const at = new Date(now - 2_000).toISOString();

const account = (id: number, quantity: number, entry: number, openPnl: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  ...devLiveCopyFixtureSnapshot.accounts[0], id, name: `ACC${id}`,
  unrealizedPnl: openPnl, unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: at,
  positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: at, ordersUpdatedAt: at,
  positions: quantity === 0 ? [] : [{ accountId: id, symbol: 'MNQZ6', netPosition: quantity, netPrice: entry, unrealizedPnl: openPnl, realizedPnl: 0, updatedAt: at }],
  ...patch,
});
let nextId = 1;
const order = (accountId: number, patch: Partial<LiveOrder>): LiveOrder => ({
  id: nextId++, accountId, accountName: '', symbol: 'MNQZ6', action: 'Sell', orderType: 'Stop', quantity: 2,
  price: null, stopPrice: null, status: 'Working', working: true, placedAt: at, updatedAt: at, ...patch,
});
const bracket = (accountId: number, stop: number, target: number, quantity = 2) => [
  order(accountId, { orderType: 'Stop', stopPrice: stop, quantity }),
  order(accountId, { orderType: 'Limit', price: target, quantity }),
];
const group: CopyGroupConfig = {
  id: 'g', name: 'Skupina', enabled: true, leaderAccountId: 1,
  followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1, enabled: true } as CopyGroupConfig['followers'][number]],
};

describe('živá pozice v grafu deníku', () => {
  it('skupina: vážený vstup a SL/TP leadera, výběr celé skupiny i účtů', () => {
    const view = buildJournalLiveView({
      accounts: [account(1, 2, 21480, 40), account(2, 1, 21481, 18)],
      orders: [...bracket(1, 21470, 21500), ...bracket(2, 21472, 21495, 1)],
      feeRates: new Map(), group, target: 'group', now,
    });
    expect(view.verified).toBe(true);
    expect(view.options.map(option => option.id)).toEqual(['group', 1, 2]);
    expect(view.model?.quantity).toBe(3);
    expect(view.model?.entry).toBeCloseTo((21480 * 2 + 21481) / 3, 6);
    const lines = journalLivePriceLines(view.model);
    expect(lines.map(line => line.id)).toEqual(['entry', 'stop', 'target']);
    expect(lines.find(line => line.id === 'stop')).toMatchObject({ price: 21470, color: LIVE_STOP_COLOR });
    expect(lines.find(line => line.id === 'target')).toMatchObject({ price: 21500, color: LIVE_TARGET_COLOR });
    expect(lines[0].title).toBe('LONG 3');
  });

  it('jeden účet: jeho vstup, jeho SL/TP', () => {
    const view = buildJournalLiveView({
      accounts: [account(1, 2, 21480, 40), account(2, 1, 21481, 18)],
      orders: [...bracket(1, 21470, 21500), ...bracket(2, 21472, 21495, 1)],
      feeRates: new Map(), group, target: 2, now,
    });
    expect(view.target).toBe(2);
    expect(view.model?.quantity).toBe(1);
    expect(view.model?.entry).toBe(21481);
    expect(view.model?.ladder).toEqual({ stop: 21472, target: 21495 });
    // Účet, který z dat zmizel → celá skupina, a ta bez něj není celá.
    const missing = buildJournalLiveView({ accounts: [account(1, 2, 21480, 40)], orders: [], feeRates: new Map(), group, target: 2, now });
    expect(missing).toMatchObject({ target: 'group', issue: 'missing-account', verified: false, model: null });
    expect(missing.options.map(option => option.id)).toEqual(['group', 1]);
    // Jednotlivý účet, který v datech je, se dál ukáže.
    expect(buildJournalLiveView({ accounts: [account(1, 2, 21480, 40)], orders: [], feeRates: new Map(), group, target: 1, now })).toMatchObject({ target: 1, issue: null });
  });

  it('účty skupiny se liší (jiný směr, osiřelý příkaz) → žádný souhrn; nejdřív okno dobíhání kopie, pak odkaz na LIVE', () => {
    const oppositeInput = {
      accounts: [account(1, 2, 21480, 40), account(2, -1, 21481, -18)],
      orders: [], feeRates: new Map(), group, target: 'group' as const, now,
    };
    expect(buildJournalLiveView(oppositeInput)).toMatchObject({ issue: 'settling', verified: false, model: null, divergenceCandidate: true });
    // Okno je delší než cyklus čtení z brokera v deníku (6 s).
    expect(JOURNAL_DIVERGENCE_CONFIRM_MS).toBeGreaterThan(6_000);
    expect(buildJournalLiveView({ ...oppositeInput, divergenceSince: now - JOURNAL_DIVERGENCE_CONFIRM_MS + 1 }).issue).toBe('settling');
    // Začátek z reálného času může být o kus po hodinách pohledu → pořád dobíhá.
    expect(buildJournalLiveView({ ...oppositeInput, divergenceSince: now + 4_000 }).issue).toBe('settling');
    expect(buildJournalLiveView({ ...oppositeInput, divergenceSince: now - JOURNAL_DIVERGENCE_CONFIRM_MS }))
      .toMatchObject({ issue: 'divergent', verified: false, model: null });
    const orphan = buildJournalLiveView({
      accounts: [account(1, 0, 0, 0), account(2, 0, 0, 0)],
      orders: [order(2, { orderType: 'Stop', stopPrice: 21450 })], feeRates: new Map(), group, target: 'group', now,
      divergenceSince: now - 10_000,
    });
    expect(orphan.issue).toBe('divergent');
    // Osiřelý příkaz z neověřeného čtení příkazů není jistý rozjezd.
    const staleOrders = new Date(now - 90_000).toISOString();
    const unsure = buildJournalLiveView({
      accounts: [account(1, 0, 0, 0), account(2, 0, 0, 0, { ordersUpdatedAt: staleOrders })],
      orders: [order(2, { orderType: 'Stop', stopPrice: 21450 })], feeRates: new Map(), group, target: 'group', now,
    });
    expect(unsure.issue).toBe('orders-stale');
  });

  it('neověřené čtení pozic (> 45 s) nic nekreslí — ani poslední známou polohu', () => {
    const stale = new Date(now - 90_000).toISOString();
    const view = buildJournalLiveView({
      accounts: [account(1, 2, 21480, 40, { positionsUpdatedAt: stale }), account(2, 1, 21481, 18)],
      orders: bracket(1, 21470, 21500), feeRates: new Map(), group, target: 'group', now,
    });
    expect(view.verified).toBe(false);
    expect(view.issue).toBe('stale');
    expect(view.model).toBeNull();
    expect(view.readAgeMs).toBe(90_000);
    expect(journalLivePriceLines(view.model)).toEqual([]);
  });

  it('nesouměrná skupina: leader flat a follower drží, nebo worker potvrdí jiné kusy → žádný souhrn', () => {
    const orphanInput = { accounts: [account(1, 0, 0, 0), account(2, 1, 21481, 18)], orders: [], feeRates: new Map(), group, target: 'group' as const, now };
    // Bez workeru: výstup / vstup on-submit chvíli dobíhá → nejdřív neutrální stav, po okně rozjetí.
    expect(buildJournalLiveView(orphanInput)).toMatchObject({ issue: 'settling', model: null });
    expect(buildJournalLiveView({ ...orphanInput, divergenceSince: now - JOURNAL_DIVERGENCE_CONFIRM_MS })).toMatchObject({ issue: 'divergent', model: null });
    // S čerstvým workerem: potvrzený rozdíl → hned; hlášený rozdíl i každý
    // ne-OK verdikt (neověřená pozice, denní limit, zlikvidovaný účet,
    // příkazy mimo kopii, vypnutý ne-flat) → stejné okno, nikdy souhrn.
    const none = new Set<number>();
    expect(buildJournalLiveView({ ...orphanInput, workerMismatches: { pending: none, confirmed: new Set([2]), ok: none } }).issue).toBe('divergent');
    for (const verdicts of [
      { pending: new Set([2]), confirmed: none, ok: none },
      { pending: none, confirmed: none, ok: none },
      { pending: none, confirmed: none, ok: new Set([3]) },
    ]) {
      const settling = buildJournalLiveView({ ...orphanInput, workerMismatches: verdicts });
      expect(settling).toMatchObject({ issue: 'settling', model: null, divergenceCandidate: true });
      expect(buildJournalLiveView({ ...orphanInput, workerMismatches: verdicts, divergenceSince: now - JOURNAL_DIVERGENCE_CONFIRM_MS }).issue).toBe('divergent');
    }
    // Potvrzené rozjetí drží okno (kandidát), takže výpadek heartbeatu (bez
    // verdiktů) se stejným začátkem zůstane „liší se“, ne „dobíhá“.
    const confirmedView = buildJournalLiveView({ ...orphanInput, workerMismatches: { pending: none, confirmed: new Set([2]), ok: none } });
    expect(confirmedView.divergenceCandidate).toBe(true);
    expect(buildJournalLiveView({ ...orphanInput, workerMismatches: null, divergenceSince: now - JOURNAL_DIVERGENCE_CONFIRM_MS }).issue).toBe('divergent');
    // Follower s OK verdiktem (kopírka ho vědomě neřídí): jeho pozice, bez poplachu.
    expect(buildJournalLiveView({ ...orphanInput, divergenceSince: now - 60_000, workerMismatches: { pending: none, confirmed: none, ok: new Set([2]) } }))
      .toMatchObject({ issue: null, model: { quantity: 1 }, divergenceCandidate: false });
    // Samotný účet followera ale svou pozici ukáže.
    expect(buildJournalLiveView({
      accounts: [account(1, 0, 0, 0), account(2, 1, 21481, 18)],
      orders: [], feeRates: new Map(), group, target: 2, now,
    }).model?.quantity).toBe(1);
    // Leader drží a follower ještě ne (běžný vstup): souhrn leadera, ne poplach.
    const input = { accounts: [account(1, 2, 21480, 40), account(2, 0, 0, 0)], orders: [], feeRates: new Map(), group, target: 'group' as const, now };
    expect(buildJournalLiveView(input).model?.quantity).toBe(2);
    expect(buildJournalLiveView({ ...input, workerMismatches: { pending: new Set([2]), confirmed: new Set(), ok: new Set() } }).model?.quantity).toBe(2);
    expect(buildJournalLiveView({ ...input, workerMismatches: { pending: new Set(), confirmed: new Set([2]), ok: new Set() } })).toMatchObject({ issue: 'divergent', model: null });
  });

  it('rozdíl kusů followera se potvrdí až po chvíli, „liší se od leadera“ hned; OK ho smaže', () => {
    const verdicts = [
      { accountId: 2, ok: false, detail: 'MNQZ6: drží 0, očekáváno 2' },
      { accountId: 3, ok: false, detail: 'pozice se liší od leadera' },
      { accountId: 4, ok: false, detail: 'účet zlikvidován propkou' },
    ];
    const first = confirmWorkerMismatches(verdicts, new Map(), now);
    expect([...first.confirmed]).toEqual([3]);
    expect([...first.pending]).toEqual([2]);
    expect(first.ok.size).toBe(0);
    const later = confirmWorkerMismatches(verdicts, first.since, now + WORKER_MISMATCH_CONFIRM_MS);
    expect([...later.confirmed].sort()).toEqual([2, 3]);
    expect(later.pending.size).toBe(0);
    const healed = confirmWorkerMismatches([{ accountId: 2, ok: true, detail: null }], later.since, now + WORKER_MISMATCH_CONFIRM_MS + 1_000);
    expect(healed.confirmed.size).toBe(0);
    expect([...healed.ok]).toEqual([2]);
    expect(healed.since.size).toBe(0);
  });

  it('staré otevřené P&L (REST v penalizaci) se neukáže, pozice a čáry ano', () => {
    const old = new Date(now - JOURNAL_PNL_MAX_AGE_MS - 1_000).toISOString();
    const view = buildJournalLiveView({
      accounts: [account(1, 2, 21480, 40, { unrealizedPnlUpdatedAt: old }), account(2, 1, 21481, 18)],
      orders: bracket(1, 21470, 21500), feeRates: new Map(), group, target: 'group', now,
    });
    expect(view.issue).toBeNull();
    expect(view.model?.quantity).toBe(3);
    expect(view.model?.openPnl).toBeNull();
    expect(journalLivePriceLines(view.model).map(line => line.id)).toEqual(['entry', 'stop', 'target']);
    // Čerstvé P&L zůstane.
    expect(buildJournalLiveView({
      accounts: [account(1, 2, 21480, 40), account(2, 1, 21481, 18)],
      orders: [], feeRates: new Map(), group, target: 'group', now,
    }).model?.openPnl).toBe(58);
  });

  it('tempo čtení z brokera: LIVE beze změny, deník s pozicí 6 s, jinak pozadí 30 s', () => {
    expect(tradovatePositionPollDelay(true, 'off', true)).toBe(3_000);
    expect(tradovatePositionPollDelay(true, 'off', false)).toBe(15_000);
    expect(tradovatePositionPollDelay(false, 'off', true)).toBe(30_000);
    expect(tradovatePositionPollDelay(false, 'watch', true)).toBe(30_000);
    expect(tradovatePositionPollDelay(false, 'position', false)).toBe(6_000);
    expect(tradovatePositionPollFirstDelay(true, 'off', true)).toBe(0);
    expect(tradovatePositionPollFirstDelay(true, 'off', false)).toBe(1_000);
    expect(tradovatePositionPollFirstDelay(false, 'off', true)).toBe(30_000);
    expect(tradovatePositionPollFirstDelay(false, 'watch', true)).toBe(0);
    // Deník: ne dřív než 6 s od posledního čtení (bootstrap, kolísání zájmu).
    expect(tradovatePositionPollFirstDelay(false, 'position', true, 2_000)).toBe(4_000);
    expect(tradovatePositionPollFirstDelay(false, 'watch', true, 60_000)).toBe(0);
    expect(tradovatePositionPollFirstDelay(true, 'off', true, 1_000)).toBe(0);
  });

  it('čekající limit: přerušovaná čára vstupu a SL/TP z bracketu (Suspended)', () => {
    const view = buildJournalLiveView({
      accounts: [account(1, 0, 0, 0), account(2, 0, 0, 0)],
      orders: [
        order(1, { action: 'Buy', orderType: 'Limit', price: 21460, quantity: 2 }),
        order(1, { orderType: 'Stop', stopPrice: 21450, status: 'Suspended', working: false }),
        order(1, { orderType: 'Limit', price: 21490, status: 'Suspended', working: false }),
      ],
      feeRates: new Map(), group, target: 'group', now,
    });
    expect(view.model?.kind).toBe('pending');
    const lines = journalLivePriceLines(view.model);
    expect(lines[0]).toMatchObject({ id: 'pending', price: 21460, style: 'dashed', title: 'BUY LMT 2' });
    expect(lines.slice(1).map(line => [line.id, line.price])).toEqual([['stop', 21450], ['target', 21490]]);
    // Čekající vstup z neověřeného čtení příkazů se nekreslí.
    const stale = new Date(now - 90_000).toISOString();
    const unverified = buildJournalLiveView({
      accounts: [account(1, 0, 0, 0, { ordersUpdatedAt: stale }), account(2, 0, 0, 0)],
      orders: [order(1, { action: 'Buy', orderType: 'Limit', price: 21460, quantity: 2 })],
      feeRates: new Map(), group, target: 'group', now,
    });
    expect(unverified).toMatchObject({ issue: 'orders-stale', model: null, verified: false });
  });

  it('bez pozice a příkazů žádný model ani čáry; bez skupiny nic', () => {
    expect(buildJournalLiveView({ accounts: [account(1, 0, 0, 0), account(2, 0, 0, 0)], orders: [], feeRates: new Map(), group, target: 'group', now }))
      .toMatchObject({ model: null, issue: null, verified: true });
    expect(buildJournalLiveView({ accounts: [account(1, 2, 21480, 40)], orders: [], feeRates: new Map(), group: null, target: 'group', now }).options).toEqual([]);
  });

  it('čáry patří do panelů MNQ i NQ (stejná cena indexu), ne jinam; feed bez změny neruší grafy', () => {
    expect(livePositionMatchesRoot('MNQZ6', 'NQ')).toBe(true);
    expect(livePositionMatchesRoot('MNQZ6', 'MNQ')).toBe(true);
    expect(livePositionMatchesRoot('MNQZ6', 'ES')).toBe(false);
    const feed = createLivePriceLinesFeed();
    let calls = 0;
    feed.subscribe(() => { calls += 1; });
    const lines = [{ id: 'entry' as const, price: 21480, color: '#3b82f6', style: 'solid' as const, title: 'LONG 2' }];
    feed.publish('MNQZ6', lines);
    feed.publish('MNQZ6', [...lines]);
    expect(calls).toBe(1);
    expect(feed.current('NQ')).toEqual(lines);
    expect(feed.current('ES')).toEqual([]);
    feed.publish(null, []);
    expect(feed.current('MNQ')).toEqual([]);
  });
});
