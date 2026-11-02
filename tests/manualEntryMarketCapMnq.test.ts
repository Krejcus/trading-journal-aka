import { describe, expect, it } from 'vitest';
import {
  evaluateManualEntryPreview, manualEntryContractCap, MANUAL_ENTRY_GROUP_CAP_MAX,
  type ManualEntryAccountInputs, type ManualEntryPreviewInputs,
} from '../services/manualEntryPreview';
import {
  copyGroupConfigHash, previewSymbolFromChartSource, validateLeaderEntryPreview, type LeaderEntryPreviewCommand,
} from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand, validateLeaderEntryPlace } from '../lib/leaderEntryPlace';
import { createRiskGateContext } from '../services/copierRiskGate';
import { toPlaceOsoPayload } from '../services/tradovateMapping';

/**
 * 2. 11. 2026: nativní Market (bez ceny příkazu), strop ručního vstupu skupiny
 * a tvrdě jen MNQ s původem kontraktu z kotace workeru (IBKR).
 */
const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const group = {
  id: 'manual-demo-61038658', enabled: true, leaderAccountId: 61038658, followers: [] as never[],
  localOnly: true, manualOnly: true, manualEntryMaxContracts: 5,
  safety: { dailyLossLimitUsd: 250, dailyMaxLosingTrades: 0, dailyMaxTrades: 40 },
};
const risk = () => ({
  verifiedAt: NOW - 5_000, sameSession: true, error: null, realizedPnlUsd: 0, openPnlUsd: 0,
  netLiq: 50_000, cashBalanceUsd: 50_000, minNetLiq: null, dailyLossAutoLiq: null, effectiveDailyLossCutUsd: null,
});
const flat = (): ManualEntryAccountInputs => ({ positions: [], liveOrders: [], cut: 'none', syncPaused: false, risk: risk() });
const market = (patch: Partial<LeaderEntryPreviewCommand> = {}): LeaderEntryPreviewCommand => ({
  type: 'preview-leader-entry', groupId: group.id, operationId: 'preview:abcdefgh1234', leaderAccountId: 61038658,
  symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: NOW - 400,
  stopLoss: 24_990, takeProfit: 25_020,
  intent: { armedAt: NOW - 60_000, groupConfigHash: copyGroupConfigHash(group), followerQuantities: [] },
  ...patch,
});
const inputs = (patch: Partial<ManualEntryPreviewInputs> = {}): ManualEntryPreviewInputs => ({
  now: NOW,
  command: market(),
  group,
  riskGate: createRiskGateContext({
    armed: true, armedAt: NOW - 60_000, armTtlMs: 8 * 3_600_000, connected: true, lastHeartbeatAt: NOW,
    shadowMode: false, now: NOW, brokerEnvironment: 'demo', expectedEnvironment: 'demo',
  }),
  stateBlockers: [], reconciliationRequired: false, positionCheckComplete: true, managementOnly: false,
  dayLockPending: false, dayLockUntil: 0, pauseUntil: 0, pauseActive: false, entryCooldownUntil: 0,
  unconfirmedFlatLots: 0, tradingWindowState: 'off', tradingWindowStateAfterReserve: 'off',
  sessionEndAt: NOW + 6 * 3_600_000, armExpiresAt: NOW + 3 * 3_600_000, transportResumePending: false,
  dailyStats: { realizedPnlUsd: 0, losingTrades: 0, tradesToday: 0 }, lastGroupFillAt: null,
  accounts: new Map([[61038658, flat()]]), entryIneligible: new Map(), excludedFollowers: new Set(),
  frontSymbols: ['MNQZ6'],
  workerQuote: { contract: 'MNQZ6', last: 25_000, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null },
  ...patch,
});
const codes = (patch: Partial<ManualEntryPreviewInputs> = {}) => evaluateManualEntryPreview(inputs(patch)).blockers.map(issue => issue.code);

describe('nativní Market ručního vstupu', () => {
  it('čerstvý Market projde a leader nese typ Market', () => {
    const result = evaluateManualEntryPreview(inputs());
    expect(result.blockers).toEqual([]);
    expect(result.wouldPlace?.leader).toMatchObject({ orderType: 'Market', price: 25_000, quantity: 1 });
  });

  it('validátor: Market bez ceny příkazu, s referenční cenou a časem kotace', () => {
    expect(() => validateLeaderEntryPreview(market())).not.toThrow();
    expect(() => validateLeaderEntryPreview(market({ price: 25_000 }))).toThrow('invalid-relay-command-payload');
    expect(() => validateLeaderEntryPreview(market({ referencePrice: undefined }))).toThrow();
    expect(() => validateLeaderEntryPreview(market({ quoteReceivedAt: undefined }))).toThrow();
    expect(() => validateLeaderEntryPreview(market({ referencePrice: 25_000.1 }))).toThrow();
    expect(() => validateLeaderEntryPreview(market({ quoteReceivedAt: 12 }))).toThrow();
    expect(() => validateLeaderEntryPreview(market({ orderType: 'MarketIfTouched' as never }))).toThrow();
    // Limit dál vyžaduje cenu.
    expect(() => validateLeaderEntryPreview(market({ orderType: 'Limit', referencePrice: undefined, quoteReceivedAt: undefined }))).toThrow();
    expect(() => validateLeaderEntryPreview(market({ orderType: 'Limit', price: 24_990, stopLoss: 24_980 }))).not.toThrow();
  });

  it('broker dostane Market bez price — nikdy Limit ±2 body', () => {
    const payload = toPlaceOsoPayload({
      tag: 'me123', accountId: 61038658, symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market',
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 24_990 }, second: { side: 'Sell', orderType: 'Limit', limitPrice: 25_020 },
    }, 'DEMO8661118');
    expect(payload.orderType).toBe('Market');
    expect(payload).not.toHaveProperty('price');
    expect(payload).not.toHaveProperty('stopPrice');
    expect(payload.bracket1).toMatchObject({ orderType: 'Stop', stopPrice: 24_990 });
    expect(payload.bracket2).toMatchObject({ orderType: 'Limit', price: 25_020 });
  });

  it('stará kotace klienta, kotace z budoucnosti a posun trhu Market zablokují', () => {
    expect(codes({ command: market({ quoteReceivedAt: NOW - 5_001 }) })).toContain('market-quote-stale');
    expect(codes({ command: market({ quoteReceivedAt: NOW + 2_001 }) })).toContain('market-quote-stale');
    expect(codes({ workerQuote: { contract: 'MNQZ6', last: 25_002.25, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null } })).toContain('market-quote-drift');
    expect(codes({ workerQuote: { contract: 'MNQZ6', last: 25_002, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null } })).not.toContain('market-quote-drift');
  });

  it('SL/TP blíž než 16 ticků od ceny i od trhu Market odmítne', () => {
    expect(codes({ command: market({ stopLoss: 24_996.25 }) })).toContain('market-bracket-too-close');
    expect(codes({ command: market({ takeProfit: 25_003.75 }) })).toContain('market-bracket-too-close');
    expect(codes({ command: market({ stopLoss: 24_996, takeProfit: 25_004 }) })).not.toContain('market-bracket-too-close');
    // Uživatel viděl 25 000, trh (ask workeru) je už 24 998: SL 24 995 je od trhu jen 12 ticků.
    const moved = { contract: 'MNQZ6', last: 24_998, lastAt: NOW - 300, bid: 24_997.75, ask: 24_998, quoteAt: NOW - 200 };
    expect(codes({ command: market({ stopLoss: 24_995, takeProfit: 25_020 }), workerQuote: moved })).toContain('market-bracket-too-close');
  });

  it('Market jen v manual-only DEMO skupině bez followerů', () => {
    const copy = { ...group, manualOnly: false, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }] as never[] };
    expect(codes({ group: copy, command: market({ intent: { ...market().intent, groupConfigHash: copyGroupConfigHash(copy) } }) })).toContain('market-manual-only');
    const live = inputs();
    expect(evaluateManualEntryPreview({ ...live, riskGate: { ...live.riskGate, brokerEnvironment: 'live' } }).blockers.map(issue => issue.code)).toContain('market-manual-only');
  });

  it('cena workeru: Buy bere ask, Sell bid, jinak last; starší než 3 s Market zablokuje', () => {
    const quote = { contract: 'MNQZ6', last: 25_000, lastAt: NOW - 5_000, bid: 24_999.75, ask: 25_000, quoteAt: NOW - 100 };
    expect(codes({ workerQuote: quote })).toEqual([]);
    expect(codes({ command: market({ side: 'Sell', referencePrice: 24_999.75, stopLoss: 25_010, takeProfit: 24_980 }), workerQuote: quote })).toEqual([]);
    expect(codes({ workerQuote: { ...quote, quoteAt: NOW - 3_001 } })).toContain('market-worker-quote-stale');
    // Limit potřebuje jen původ kontraktu (≤ 15 s), ne čerstvou cenu.
    const limit = market({ orderType: 'Limit', price: 24_990, referencePrice: undefined, quoteReceivedAt: undefined, stopLoss: 24_980, takeProfit: 25_010 });
    expect(codes({ command: limit, workerQuote: { ...quote, quoteAt: NOW - 10_000, lastAt: NOW - 12_000 } })).toEqual([]);
    expect(codes({ command: limit, workerQuote: { ...quote, quoteAt: NOW - 15_001, lastAt: NOW - 15_001 } })).toContain('contract-unverified');
  });

  it('riziko Marketu z horší ceny: viděná vs. trh workeru', () => {
    // Buy: uživatel viděl 25 000, ask workeru 25 001 (4 ticky) → riziko od 25 001.
    const quote = { contract: 'MNQZ6', last: 25_001, lastAt: NOW - 100, bid: 25_000.75, ask: 25_001, quoteAt: NOW - 100 };
    const result = evaluateManualEntryPreview(inputs({ workerQuote: quote }));
    expect(result.wouldPlace?.leader.price).toBe(25_001);
  });

  it('riziko Marketu počítá s cenou, kterou uživatel viděl, a skluzem navíc', () => {
    // 1 MNQ: (10 b + 6 ticků) × 2 $ + 1,5 $ = 24,5 $; 11 MNQ by bylo nad stropem 5.
    const result = evaluateManualEntryPreview(inputs({ command: market({ quantity: 5 }) }));
    expect(result.blockers).toEqual([]);
    const tight = evaluateManualEntryPreview(inputs({ command: market({ quantity: 5, stopLoss: 24_970 }), dailyStats: { realizedPnlUsd: -100, losingTrades: 0, tradesToday: 0 } }));
    // 5 × ((30 + 1,5) × 2 + 1,5) = 322,5 $ > zbývající denní strop.
    expect(tight.blockers.map(issue => issue.code)).toContain('risk-daily');
  });
});

describe('strop ručního vstupu skupiny', () => {
  it('výchozí 1; vyšší jen u manual-only local-only skupiny, nejvýš 5', () => {
    expect(manualEntryContractCap(null)).toBe(1);
    expect(manualEntryContractCap({ manualEntryMaxContracts: 5 })).toBe(1);
    expect(manualEntryContractCap({ manualOnly: true, manualEntryMaxContracts: 5 })).toBe(1);
    expect(manualEntryContractCap({ manualOnly: true, localOnly: true, manualEntryMaxContracts: 5 })).toBe(5);
    expect(manualEntryContractCap({ manualOnly: true, localOnly: true, manualEntryMaxContracts: 6 })).toBe(1);
    expect(manualEntryContractCap({ manualOnly: true, localOnly: true, manualEntryMaxContracts: 2.5 })).toBe(1);
    expect(manualEntryContractCap({ manualOnly: true, localOnly: true, manualEntryMaxContracts: 0 })).toBe(1);
    expect(MANUAL_ENTRY_GROUP_CAP_MAX).toBe(5);
  });

  it('quantity nad stropem skupiny = blocker; 1–5 projde', () => {
    for (const quantity of [1, 2, 3, 5]) expect(codes({ command: market({ quantity }) })).not.toContain('manual-cap');
    expect(codes({ command: market({ quantity: 6 }) })).toContain('manual-cap');
    const legacy = { ...group, manualEntryMaxContracts: undefined };
    expect(codes({ group: legacy, command: market({ quantity: 2, intent: { ...market().intent, groupConfigHash: copyGroupConfigHash(legacy) } }) })).toContain('manual-cap');
  });

  it('záporné, nulové, desetinné a extrémní quantity neprojdou validací tvaru', () => {
    for (const quantity of [-1, 0, 1.5, 51, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateLeaderEntryPreview(market({ quantity }))).toThrow('invalid-relay-command-payload');
    }
    expect(() => validateLeaderEntryPreview({ ...market(), quantity: '2' })).toThrow();
  });

  it('změněné quantity po vytvoření příkazu neprojde otiskem payloadu', () => {
    const place = buildLeaderEntryPlaceCommand(market({ quantity: 2 }), 'entry:abcdefgh1234');
    expect(() => validateLeaderEntryPlace(place)).not.toThrow();
    expect(() => validateLeaderEntryPlace({ ...place, quantity: 5 })).toThrow('invalid-relay-command-payload');
    expect(() => validateLeaderEntryPlace({ ...place, orderType: 'Limit', price: 25_000 })).toThrow();
  });
});

describe('ruční vstup jen MNQ s ověřeným kontraktem', () => {
  it('NQ, kontinuální řada a jiný root neprojdou validací', () => {
    for (const symbol of ['NQZ6', 'MNQ1!', 'NQ1!', 'MNQZ2026', 'ESZ6', 'mnqz6', 'MNQZ66']) {
      expect(() => validateLeaderEntryPreview(market({ symbol }))).toThrow('invalid-relay-command-payload');
    }
  });

  it('kontrakt z grafu: jen IBKR MNQ, nikdy NQ ani TradingView', () => {
    expect(previewSymbolFromChartSource('IBKR:MNQZ2026')).toBe('MNQZ6');
    expect(previewSymbolFromChartSource('IBKR:NQZ2026')).toBeNull();
    expect(previewSymbolFromChartSource('CME_MINI:MNQ1!')).toBeNull();
    expect(previewSymbolFromChartSource('CME_MINI:MNQZ2026')).toBeNull();
    expect(previewSymbolFromChartSource(null)).toBeNull();
  });

  it('starý kontrakt, chybějící / stará / jiná kotace workeru = fail-closed (i pro Limit)', () => {
    const limit = market({ orderType: 'Limit', price: 24_990, referencePrice: undefined, quoteReceivedAt: undefined, stopLoss: 24_980, takeProfit: 25_010 });
    expect(codes({ command: market({ symbol: 'MNQU5' }) })).toContain('symbol-not-front');
    expect(codes({ workerQuote: null })).toContain('contract-unverified');
    expect(codes({ command: limit, workerQuote: null })).toContain('contract-unverified');
    expect(codes({ workerQuote: { contract: 'MNQZ6', last: 25_000, lastAt: NOW - 15_001, bid: null, ask: null, quoteAt: null } })).toContain('contract-unverified');
    expect(codes({ workerQuote: { contract: 'MNQH7', last: 25_000, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null } })).toContain('contract-mismatch');
    expect(codes({ command: limit, workerQuote: { contract: 'MNQU5', last: 25_000, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null } })).toContain('contract-mismatch');
  });
});

describe('původ kontraktu bez IBKR: front podle brokera (jen Limit/Stop)', () => {
  const limit = market({ orderType: 'Limit', price: 24_990, referencePrice: undefined, quoteReceivedAt: undefined, stopLoss: 24_980, takeProfit: 25_010 });
  it('Limit projde s čerstvým frontem od brokera, Market ani Stop ne', () => {
    const stop = market({ orderType: 'Stop', price: 25_010, referencePrice: undefined, quoteReceivedAt: undefined, stopLoss: 25_000, takeProfit: 25_030 });
    expect(codes({ command: stop, workerQuote: null, brokerFront: { contract: 'MNQZ6', at: NOW - 60_000 } })).toContain('contract-unverified');
    expect(codes({ command: limit, workerQuote: null, brokerFront: { contract: 'MNQZ6', at: NOW - 60_000 } })).toEqual([]);
    expect(codes({ workerQuote: null, brokerFront: { contract: 'MNQZ6', at: NOW - 60_000 } })).toContain('contract-unverified');
  });
  it('jiný front, starý front nebo rozpor s IBKR = blokováno', () => {
    expect(codes({ command: limit, workerQuote: null, brokerFront: { contract: 'MNQH7', at: NOW - 60_000 } })).toContain('contract-mismatch');
    expect(codes({ command: limit, workerQuote: null, brokerFront: { contract: 'MNQZ6', at: NOW - 30 * 60_000 - 1 } })).toContain('contract-unverified');
    expect(codes({ command: limit, workerQuote: { contract: 'MNQH7', last: 25_000, lastAt: NOW - 300, bid: null, ask: null, quoteAt: null }, brokerFront: { contract: 'MNQZ6', at: NOW - 60_000 } })).toContain('contract-mismatch');
  });
});
