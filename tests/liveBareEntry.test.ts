import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIVE_ATTACH_MIN_TICKS, LIVE_BARE_QUOTE_MAX_AGE_MS, LIVE_CONFIRM_MIN_MS, LIVE_CONFIRM_WINDOW_MS,
  isBareTicketDraft, liveAttachDefaults, liveAttachIntent, liveAttachMarket, liveAttachProblem,
  liveBareConfirmKey, liveBareMarketBlockReason, liveBareMarketButtonLabel, liveBareMarketIntent,
  liveConfirmAsking, liveConfirmClick, liveTicketBareEntry, liveTicketLegsProblem, newestOpenBareEntry,
  type LiveBareEntryRecord, type LiveBareMarketGate,
} from '../lib/liveBareEntry';
import { livePhoneBareMarket } from '../lib/livePhoneOrders';
import { buildLeaderEntryPreviewCommand, validateLeaderEntryPreview } from '../lib/leaderEntryPreview';
import type { TicketDraft } from '../lib/liveOrderTicket';

const NOW = Date.UTC(2026, 10, 3, 15);
const instrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const quote = { symbol: 'MNQZ6', bid: 24_999.75, ask: 25_000, at: NOW - 500 };
const valid = (draft: object) => validateLeaderEntryPreview(buildLeaderEntryPreviewCommand(draft as never, {
  group: { id: 'g', enabled: true, leaderAccountId: 1, followers: [] }, armedAt: 1, excludedFollowers: new Set(), participation: [], operationId: 'preview:abcdefgh1',
}));
const gate = (over: Partial<LiveBareMarketGate> = {}): LiveBareMarketGate => ({
  blockedReason: null, marketSupported: true, bareSupported: true, maxContracts: 3, quote, positionOpen: false, now: NOW, ...over,
});
const entry = (over: Partial<LiveBareEntryRecord> = {}): LiveBareEntryRecord => ({
  operationId: 'entry:a', status: 'acknowledged', createdAt: 100, symbol: 'MNQZ6', side: 'Buy', quantity: 2, bare: true, protected: false, open: true, ...over,
});

describe('newestOpenBareEntry — jen nejnovější a otevřený holý vstup (vytknuto z desku)', () => {
  it('vrátí nejnovější holý vstup na symbolu', () => {
    const latest = entry({ operationId: 'entry:b', createdAt: 200 });
    expect(newestOpenBareEntry([entry(), latest], 'MNQZ6')).toBe(latest);
  });

  it('starší holý vstup NEadoptuje pozici, když je novější vstup se SL/TP (oponentura P1-3)', () => {
    const protectedNewer = entry({ operationId: 'entry:b', createdAt: 200, bare: undefined });
    expect(newestOpenBareEntry([entry(), protectedNewer], 'MNQZ6')).toBeNull();
  });

  it('protected, zavřený, neznámý výsledek, jiný symbol = nic', () => {
    expect(newestOpenBareEntry([entry({ protected: true })], 'MNQZ6')).toBeNull();
    expect(newestOpenBareEntry([entry({ open: false })], 'MNQZ6')).toBeNull();
    expect(newestOpenBareEntry([entry({ status: 'unknown' })], 'MNQZ6')).toBeNull();
    expect(newestOpenBareEntry([entry({ status: 'sending' })], 'MNQZ6')).toBeNull();
    expect(newestOpenBareEntry([entry()], 'MNQH7')).toBeNull();
    expect(newestOpenBareEntry([entry()], null)).toBeNull();
    expect(newestOpenBareEntry(undefined, 'MNQZ6')).toBeNull();
    expect(newestOpenBareEntry([], 'MNQZ6')).toBeNull();
  });

  it('chybějící `open` (starší worker) se bere jako otevřený, stejně jako desk', () => {
    const noOpen = entry();
    delete noOpen.open;
    expect(newestOpenBareEntry([noOpen], 'MNQZ6')).toBe(noOpen);
  });

  it('shoda createdAt: vyhraje první (jako reduce v desku)', () => {
    const first = entry({ operationId: 'entry:first' });
    const second = entry({ operationId: 'entry:second' });
    expect(newestOpenBareEntry([first, second], 'MNQZ6')).toBe(first);
  });
});

describe('holý Market — brány stejné jako telefonní lišta', () => {
  it('všechno v pořádku = null', () => {
    expect(liveBareMarketBlockReason(gate(), 1)).toBeNull();
  });

  it('brána desku má přednost (čerstvost, kopírka, rozpracovaný vstup)', () => {
    expect(liveBareMarketBlockReason(gate({ blockedReason: 'Kopírka je vypnutá — zapni ji na Live Dashboardu.', marketSupported: false, quote: null }), 1))
      .toBe('Kopírka je vypnutá — zapni ji na Live Dashboardu.');
  });

  it('bez capability `manual-entry-bare-v1` holý Market nikdy (mutace: povolit bez capability → červená)', () => {
    expect(liveBareMarketBlockReason(gate({ bareSupported: false }), 1)).toBe('Worker zatím neumí Market bez SL/TP.');
    expect(liveBareMarketIntent(gate({ bareSupported: false }), 'buy', 1)).toEqual({ error: 'Worker zatím neumí Market bez SL/TP.' });
  });

  it('bez nativního Marketu nic', () => {
    expect(liveBareMarketBlockReason(gate({ marketSupported: false }), 1)).toBe('Worker zatím neumí Market.');
  });

  it('kotace: 3 000 ms ještě smí, 3 001 ms už ne; chybějící kotace ne', () => {
    expect(LIVE_BARE_QUOTE_MAX_AGE_MS).toBe(3_000);
    expect(liveBareMarketBlockReason(gate({ quote: { ...quote, at: NOW - 3_000 } }), 1)).toBeNull();
    expect(liveBareMarketBlockReason(gate({ quote: { ...quote, at: NOW - 3_001 } }), 1)).toMatch(/není čerstvá/);
    expect(liveBareMarketBlockReason(gate({ quote: null }), 1)).toMatch(/není čerstvá/);
    expect(liveBareMarketBlockReason(gate({ quote: { ...quote, at: Number.NaN } }), 1)).toMatch(/není čerstvá/);
  });

  it('kontrakt jen z IBKR (TV / kontinuální řada = blok)', () => {
    expect(liveBareMarketBlockReason(gate({ quote: { ...quote, symbol: null } }), 1)).toMatch(/Kontrakt není ověřený/);
  });

  it('strop skupiny: rovno stropu smí, o 1 víc ne (mutace na > cap+1 → červená)', () => {
    expect(liveBareMarketBlockReason(gate({ maxContracts: 3 }), 3)).toBeNull();
    expect(liveBareMarketBlockReason(gate({ maxContracts: 3 }), 4)).toBe('Strop ručního vstupu je 3 kontrakty.');
    expect(liveBareMarketBlockReason(gate({ maxContracts: 1 }), 2)).toBe('Strop ručního vstupu je 1 kontrakt.');
    expect(liveBareMarketBlockReason(gate({ maxContracts: 5 }), 6)).toBe('Strop ručního vstupu je 5 kontraktů.');
  });

  it('neplatný počet nic', () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) expect(liveBareMarketBlockReason(gate(), qty)).toBe('Neplatný počet kontraktů.');
  });

  it('v pozici (i čekající vstup) holý Market ne — worker by vrátil account-not-flat', () => {
    expect(liveBareMarketBlockReason(gate({ positionOpen: true }), 1)).toMatch(/V pozici holý Market nejde/);
  });

  it('záměr = přesně tvar telefonní lišty, bez SL/TP, projde validací payloadu', () => {
    const intent = liveBareMarketIntent(gate(), 'buy', 2);
    expect(intent).toEqual(livePhoneBareMarket('buy', 2, quote));
    expect(intent).toEqual({ symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: quote.at });
    expect(intent).not.toHaveProperty('stopLoss');
    expect(intent).not.toHaveProperty('takeProfit');
    expect(() => valid(intent)).not.toThrow();
    expect(liveBareMarketIntent(gate(), 'sell', 1)).toMatchObject({ side: 'Sell', referencePrice: 24_999.75 });
  });
});

describe('PC panel: holý Market z návrhu', () => {
  const market: TicketDraft = { side: 'buy', type: 'market', price: 25_000, sizing: 'qty', quantity: 2, riskUsd: 200, stopLoss: null, takeProfit: null };

  it('holý = jen Market bez obou nohou', () => {
    expect(isBareTicketDraft(market)).toBe(true);
    expect(isBareTicketDraft({ ...market, type: 'limit' })).toBe(false);
    expect(isBareTicketDraft({ ...market, stopLoss: 24_990 })).toBe(false);
  });

  it('nohy: jedna noha nikdy, Limit/Stop vždy obě, Market bez obou jen s capability', () => {
    expect(liveTicketLegsProblem({ ...market, stopLoss: 24_990 }, true)).toBe('Vyplň SL i TP, nebo u Marketu ani jedno.');
    expect(liveTicketLegsProblem({ ...market, takeProfit: 25_020 }, true)).toBe('Vyplň SL i TP, nebo u Marketu ani jedno.');
    expect(liveTicketLegsProblem({ ...market, type: 'limit' }, true)).toBe('Limit a Stop potřebují SL i TP.');
    expect(liveTicketLegsProblem({ ...market, type: 'stop' }, true)).toBe('Limit a Stop potřebují SL i TP.');
    expect(liveTicketLegsProblem(market, true)).toBeNull();
    expect(liveTicketLegsProblem(market, false)).toMatch(/neumí Market bez SL\/TP/);
    expect(liveTicketLegsProblem({ ...market, stopLoss: 24_990, takeProfit: 25_020 }, false)).toBeNull();
  });

  it('návrh panelu = stejný payload jako lišta i list telefonu', () => {
    const draft = liveTicketBareEntry(market, instrument, quote);
    expect(draft).toEqual(livePhoneBareMarket('buy', 2, quote));
    expect(() => valid(draft)).not.toThrow();
  });

  it('jen v kontraktech, jen Market bez nohou, jen s IBKR kontraktem', () => {
    expect(liveTicketBareEntry({ ...market, sizing: 'risk' }, instrument, quote)).toHaveProperty('error');
    expect(liveTicketBareEntry({ ...market, stopLoss: 24_990 }, instrument, quote)).toHaveProperty('error');
    expect(liveTicketBareEntry({ ...market, type: 'limit' }, instrument, quote)).toHaveProperty('error');
    expect(liveTicketBareEntry(market, instrument, { ...quote, symbol: null })).toHaveProperty('error');
  });
});

describe('dvoukrok smazání šablony a klíč holého Marketu', () => {
  const KEY = 'bare-market:MNQZ6:Buy:1';

  it('první klik jen zeptá, nic neodešle', () => {
    expect(liveConfirmClick(null, KEY, NOW)).toEqual({ send: false, next: { key: KEY, at: NOW } });
  });

  it('dvojklik pod 350 ms neodešle a okno neprodlouží (mutace hranice → červená)', () => {
    expect(LIVE_CONFIRM_MIN_MS).toBe(350);
    const asked = { key: KEY, at: NOW };
    expect(liveConfirmClick(asked, KEY, NOW + 349)).toEqual({ send: false, next: { key: KEY, at: NOW + 349 } });
    expect(liveConfirmClick(asked, KEY, NOW + 350)).toEqual({ send: true, next: null });
  });

  it('po 4 s se potvrzení nepočítá — znovu „Opravdu?“', () => {
    expect(LIVE_CONFIRM_WINDOW_MS).toBe(4_000);
    const asked = { key: KEY, at: NOW };
    expect(liveConfirmClick(asked, KEY, NOW + 3_999)).toEqual({ send: true, next: null });
    expect(liveConfirmClick(asked, KEY, NOW + 4_000)).toEqual({ send: false, next: { key: KEY, at: NOW + 4_000 } });
    expect(liveConfirmAsking(asked, KEY, NOW + 3_999)).toBe(true);
    expect(liveConfirmAsking(asked, KEY, NOW + 4_000)).toBe(false);
  });

  it('jiný klíč (jiná strana / počet) nikdy nepotvrdí — jen nové „Opravdu?“', () => {
    const asked = { key: KEY, at: NOW };
    const other = 'bare-market:MNQZ6:Sell:1';
    expect(liveConfirmClick(asked, other, NOW + 1_000)).toEqual({ send: false, next: { key: other, at: NOW + 1_000 } });
    expect(liveConfirmAsking(asked, other, NOW + 1_000)).toBe(false);
  });

  it('klíč holého Marketu: bez ceny (jede s tickem), ale se stranou, počtem a kontraktem', () => {
    const a = livePhoneBareMarket('buy', 1, quote) as Parameters<typeof liveBareConfirmKey>[0];
    const ticked = livePhoneBareMarket('buy', 1, { ...quote, ask: 25_001, at: quote.at + 200 }) as Parameters<typeof liveBareConfirmKey>[0];
    expect(liveBareConfirmKey(a)).toBe('bare-market:MNQZ6:Buy:1');
    expect(liveBareConfirmKey(ticked)).toBe(liveBareConfirmKey(a));
    expect(liveBareConfirmKey({ ...a, side: 'Sell' })).not.toBe(liveBareConfirmKey(a));
    expect(liveBareConfirmKey({ ...a, quantity: 2 })).not.toBe(liveBareConfirmKey(a));
    expect(liveBareConfirmKey({ ...a, symbol: 'MNQH7' })).not.toBe(liveBareConfirmKey(a));
    // Vstup se SL/TP má jiný jmenný prostor — potvrzení holého ho nepotvrdí.
    expect(liveBareConfirmKey({ ...a, stopLoss: 24_990, takeProfit: 25_020 })).not.toBe(liveBareConfirmKey(a));
  });

  it('popisek tlačítka je výstražný a nic se neptá', () => {
    expect(liveBareMarketButtonLabel('buy', 1)).toBe('Koupit 1 MARKET · BEZ SL/TP');
    expect(liveBareMarketButtonLabel('sell', 2)).toBe('Prodat 2 MARKET · BEZ SL/TP');
  });
});

describe('Přidat SL/TP k holému vstupu', () => {
  it('trh pro attach: long = bid, short = ask (jako worker exitSide)', () => {
    expect(liveAttachMarket('long', quote)).toBe(24_999.75);
    expect(liveAttachMarket('short', quote)).toBe(25_000);
  });

  it(`hranice ${LIVE_ATTACH_MIN_TICKS} ticků na správné straně (mutace na 7 → červená)`, () => {
    expect(LIVE_ATTACH_MIN_TICKS).toBe(8);
    // long, trh 25 000: 8 ticků = 2 body
    expect(liveAttachProblem('long', 25_000, 24_998, 25_002, 0.25)).toBeNull();
    expect(liveAttachProblem('long', 25_000, 24_998.25, 25_002, 0.25)).toMatch(/aspoň 8 ticků/);
    expect(liveAttachProblem('long', 25_000, 24_998, 25_001.75, 0.25)).toMatch(/aspoň 8 ticků/);
    // short zrcadlově
    expect(liveAttachProblem('short', 25_000, 25_002, 24_998, 0.25)).toBeNull();
    expect(liveAttachProblem('short', 25_000, 25_001.75, 24_998, 0.25)).toMatch(/aspoň 8 ticků/);
    expect(liveAttachProblem('short', 25_000, 25_002, 24_998.25, 0.25)).toMatch(/aspoň 8 ticků/);
    // špatná strana
    expect(liveAttachProblem('long', 25_000, 25_010, 24_990, 0.25)).toMatch(/správné straně/);
    expect(liveAttachProblem('long', 25_000, Number.NaN, 25_010, 0.25)).toBe('Vyplň SL i TP.');
  });

  it('výchozí nohy 10/20 b od trhu, jinak šablona', () => {
    expect(liveAttachDefaults('long', 25_000, 0.25)).toEqual({ stopLoss: 24_990, takeProfit: 25_020 });
    expect(liveAttachDefaults('short', 25_000, 0.25)).toEqual({ stopLoss: 25_010, takeProfit: 24_980 });
    expect(liveAttachDefaults('long', 25_000, 0.25, { stopPoints: 6, targetPoints: 12.1 })).toEqual({ stopLoss: 24_994, takeProfit: 25_012 });
    expect(liveAttachDefaults('long', 25_000, 0.25, { stopPoints: 0, targetPoints: -1 })).toEqual({ stopLoss: 24_990, takeProfit: 25_020 });
  });

  const position = { side: 'long' as const, quantity: 2, symbol: 'MNQZ6', pending: null };
  const base = { bareEntry: entry(), position, quote, stopLoss: 24_990, takeProfit: 25_020, tickSize: 0.25, now: NOW };

  it('vstup attach: vlastní holý vstup, množství vstupu, trh z kotace IBKR téhož kontraktu', () => {
    expect(liveAttachIntent(base)).toEqual({ attach: {
      entryOperationId: 'entry:a', symbol: 'MNQZ6', quantity: 2, expectPrice: 24_999.75, stopLoss: 24_990, takeProfit: 25_020,
    } });
    const short = liveAttachIntent({ ...base, bareEntry: entry({ side: 'Sell' }), position: { ...position, side: 'short' }, stopLoss: 25_010, takeProfit: 24_980 });
    expect(short).toMatchObject({ attach: { expectPrice: 25_000 } });
  });

  it('nohy se zarovnají na tick', () => {
    expect(liveAttachIntent({ ...base, stopLoss: 24_990.1, takeProfit: 25_019.9 })).toMatchObject({ attach: { stopLoss: 24_990, takeProfit: 25_020 } });
  });

  it('bez vlastního holého vstupu, s čekajícím vstupem nebo nesedící pozicí nic', () => {
    expect(liveAttachIntent({ ...base, bareEntry: null })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, position: null })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, position: { ...position, pending: { type: 'Limit', price: 1 } } })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, position: { ...position, quantity: 3 } })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, position: { ...position, side: 'short' } })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, position: { ...position, symbol: 'MNQH7' } })).toHaveProperty('error');
  });

  it('stará kotace nebo kotace jiného / neověřeného kontraktu nic', () => {
    expect(liveAttachIntent({ ...base, quote: { ...quote, at: NOW - 3_001 } })).toEqual({ error: 'Cena není čerstvá (starší než 3 s) — nic se neodeslalo.' });
    expect(liveAttachIntent({ ...base, quote: { ...quote, symbol: null } })).toHaveProperty('error');
    expect(liveAttachIntent({ ...base, quote: { ...quote, symbol: 'MNQH7' } })).toHaveProperty('error');
  });

  it('chybějící noha nebo noha blíž než 8 ticků nic', () => {
    expect(liveAttachIntent({ ...base, takeProfit: null })).toEqual({ error: 'Vyplň SL i TP.' });
    expect(liveAttachIntent({ ...base, stopLoss: 24_998 })).toHaveProperty('error');
  });
});

describe('statická pojistka: modul nic neodesílá (INV-UI-01/02)', () => {
  const source = readFileSync(new URL('../lib/liveBareEntry.ts', import.meta.url), 'utf8');
  it('importuje jen čisté moduly a nevolá relay, broker ani síť', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort();
    expect(imports).toEqual(['./leaderEntryPreview', './liveClickGate', './liveOrderTicket', './livePhoneOrders']);
    expect(source).not.toMatch(/fetch\(|executeTradovateCopierRelayCommand|\.place\(|\.attach\(|\.manage\(|localStorage/);
  });
});
