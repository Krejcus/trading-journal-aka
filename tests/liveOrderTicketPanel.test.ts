import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LiveOrderTicket, { liveAttachDefaultLegs, liveTicketNewDraft } from '../components/LiveOrderTicket';
import { LIVE_ATTACH_OWNER, liveAttachChartLines, newTicketDraft, type TicketDraft } from '../lib/liveOrderTicket';
import { createLiveBracketTemplate, type LiveBracketTemplate } from '../lib/liveBracketTemplates';
import { NO_LIVE_CHART_POSITION, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { LiveManageRunner } from '../hooks/useLiveManageRunner';

/**
 * PC panel objednávky (U4 holý Market + Přidat SL/TP + předvolby qty, U8 šablony,
 * U10 správa pozice; 3. 11. 2026). Vše jen předvyplnění / záměr: odeslání jen
 * tlačítkem panelu přes callbacky desku (INV-UI-01..04).
 */

const MNQ = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const quote = { bid: 100, ask: 100.25 };
const ticket = readFileSync('components/LiveOrderTicket.tsx', 'utf8');

const template = (input: Parameters<typeof createLiveBracketTemplate>[0]): LiveBracketTemplate => {
  const created = createLiveBracketTemplate(input, { id: 'tpl-1', now: new Date(0) });
  if (!('template' in created)) throw new Error(created.errors.join(' '));
  return created.template;
};

describe('čáry „· přidat“ (U4): jen návrh nohou v panelu', () => {
  const legs = { entryOperationId: 'entry:a', stopLoss: 95, takeProfit: 110 };

  it('táhnutelné, × jen vyhodí nohu z návrhu, bez akcí — nic odsud neodchází k brokerovi', () => {
    const lines = liveAttachChartLines(legs, { side: 'long', quantity: 2 }, 100, MNQ);
    expect(lines.map(line => [line.id, line.kind, line.price])).toEqual([
      [`${LIVE_ATTACH_OWNER}:stopLoss`, 'stopLoss', 95], [`${LIVE_ATTACH_OWNER}:takeProfit`, 'takeProfit', 110],
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ ownerId: LIVE_ATTACH_OWNER, draggable: true, cancellable: true });
      expect(line.cancelAction).toBe('remove-bracket');
      expect(line.actions).toBeUndefined();
      expect(line.addableBrackets).toBeUndefined();
    }
    // P&L od průměru vstupu × kusy × $ za bod.
    expect(lines[0].label).toBe('SL  −$20.00 · 5.00 b · přidat');
    expect(lines[1].labelAt!(112)).toBe('TP  +$48.00 · 12.00 b · přidat');
  });

  it('short zrcadlově; neznámý průměr = jen cena; chybějící noha se nekreslí', () => {
    expect(liveAttachChartLines({ ...legs, stopLoss: 105, takeProfit: null }, { side: 'short', quantity: 1 }, 100, MNQ).map(line => line.label))
      .toEqual(['SL  −$10.00 · 5.00 b · přidat']);
    expect(liveAttachChartLines(legs, { side: 'long', quantity: 1 }, null, MNQ)[0].label).toBe('SL  95.00 · přidat');
  });
});

describe('nový návrh panelu: předvolby + výchozí šablona (U4/U8)', () => {
  it('nový návrh se otevře bez SL/TP, jinak jako newTicketDraft (Filip 5. 11.)', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const type of ['limit', 'stop', 'market'] as const) {
        const price = side === 'buy' ? 95 : 105;
        expect(liveTicketNewDraft({ side, type, price, instrument: MNQ, quote, maxContracts: 1 }).draft)
          .toEqual({ ...newTicketDraft(side, type, price, MNQ, quote), stopLoss: null, takeProfit: null });
      }
    }
  });

  it('počet z předvoleb nikdy nad strop skupiny; výslovný počet (menu grafu) má přednost', () => {
    const prefs = { quantity: 3, sizing: 'qty' as const, riskUsd: 200, units: 'ticks' as const };
    expect(liveTicketNewDraft({ side: 'buy', type: 'limit', price: 95, instrument: MNQ, quote, prefs, maxContracts: 2 }).draft.quantity).toBe(2);
    expect(liveTicketNewDraft({ side: 'buy', type: 'limit', price: 95, instrument: MNQ, quote, prefs, maxContracts: 5 }).draft.quantity).toBe(3);
    expect(liveTicketNewDraft({ side: 'buy', type: 'limit', price: 95, instrument: MNQ, quote, prefs, maxContracts: 5, base: { quantity: 1 } }).draft.quantity).toBe(1);
  });

  it('výchozí šablona: SL/TP návrhu nedosadí; velikost šablony jen do stropu a ne přes výslovný počet', () => {
    const scalp = template({ name: 'Scalp', stopLoss: { unit: 'ticks', value: 20 }, takeProfit: { unit: 'ticks', value: 40 }, sizing: { mode: 'qty', quantity: 5 } });
    const result = liveTicketNewDraft({ side: 'buy', type: 'limit', price: 95, instrument: MNQ, quote, maxContracts: 2, template: scalp });
    expect(result.draft).toMatchObject({ price: 95, stopLoss: null, takeProfit: null, quantity: 2 });
    expect(result.notes.join(' ')).toMatch(/účet dovolí 2/);
    const short = liveTicketNewDraft({ side: 'sell', type: 'limit', price: 105, instrument: MNQ, quote, maxContracts: 5, template: scalp, base: { quantity: 1 } });
    expect(short.draft).toMatchObject({ stopLoss: null, takeProfit: null, quantity: 1 });
  });

  it('přikoupení šablonu ignoruje (SL/TP pozice dosadí panel)', () => {
    const scalp = template({ name: 'Scalp', stopLoss: { unit: 'ticks', value: 20 }, takeProfit: { unit: 'ticks', value: 40 }, sizing: null });
    const scaleIn = { side: 'buy' as const, quantity: 1, stopLoss: 80, targetPrice: 120, canAdd: true, reason: null, pendingAdd: null };
    const draft = liveTicketNewDraft({ side: 'buy', type: 'limit', price: 95, instrument: MNQ, quote, maxContracts: 2, template: scalp, scaleIn }).draft;
    expect(draft).toEqual(newTicketDraft('buy', 'limit', 95, MNQ, quote));
  });
});

describe('výchozí nohy „Přidat SL/TP“ (U4/U8)', () => {
  it('bez šablony 10 / 20 b od trhu (jako list telefonu), na obou stranách', () => {
    expect(liveAttachDefaultLegs('long', 100, 101, 0.25, null)).toEqual({ stopLoss: 90, takeProfit: 120 });
    expect(liveAttachDefaultLegs('short', 100, 99, 0.25, null)).toEqual({ stopLoss: 110, takeProfit: 80 });
  });

  it('vlastní šablona od průměru vstupu; bez průměru od trhu; bez TP = TP 20 b od trhu', () => {
    const t = template({ name: 'T', stopLoss: { unit: 'ticks', value: 16 }, takeProfit: { unit: 'ticks', value: 32 }, sizing: null });
    expect(liveAttachDefaultLegs('long', 100, 101, 0.25, t)).toEqual({ stopLoss: 97, takeProfit: 109 });
    expect(liveAttachDefaultLegs('long', 100, null, 0.25, t)).toEqual({ stopLoss: 96, takeProfit: 108 });
    const runner = template({ name: 'R', stopLoss: { unit: 'pts', value: 5 }, takeProfit: null, sizing: null });
    expect(liveAttachDefaultLegs('short', 100, 100, 0.25, runner)).toEqual({ stopLoss: 105, takeProfit: 80 });
  });
});

// ---------------------------------------------------------------------------
// Vykreslený panel (bez DOM: jen markup, efekty neběží)

const bare = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'market', price: 100.25, sizing: 'qty', quantity: 1, riskUsd: 200, stopLoss: null, takeProfit: null, ...patch,
});
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(LiveOrderTicket, {
  isDark: true, instrument: MNQ, quote, draft: null, onDraft: () => {}, fromBox: false,
  units: 'pts', onUnits: () => {}, scope: 'account', onScope: () => {},
  group: null, target: { kind: 'group' }, onTarget: () => {},
  quoteInfo: { source: 'IBKR:MNQZ2026', capturedAt: Date.now(), stale: false },
  // Ověřeně flat (bez pozice i bez problému čtení); chybějící data = neověřeno (unknown ≠ flat).
  position: NO_LIVE_CHART_POSITION,
  onPlaceEntry: async () => { throw new Error('test nic neodesílá'); },
  entryMarketSupported: true, entryMaxContracts: 1,
  onNewDraft: () => {}, onClose: () => {},
  ...props,
} as never));
/** Velké tlačítko odeslání (první <button> za problémy panelu). */
const sendButton = (markup: string) => {
  const at = markup.indexOf('live-ticket-send');
  return markup.slice(markup.lastIndexOf('<button', at), markup.indexOf('</button>', at));
};

describe('holý Market z PC panelu (U4)', () => {
  it('jen s capability: výstražné tlačítko „MARKET · BEZ SL/TP“, odeslat jde (dvoukrok je v kliku)', () => {
    const button = sendButton(render({ draft: bare(), entryBareSupported: true }));
    expect(button).toContain('Koupit 1 MARKET · BEZ SL/TP');
    expect(button).not.toMatch(/disabled=""/);
  });

  it('Limit a Stop bez SL/TP jen s vlastní capability, i víc kontraktů', () => {
    const limit = bare({ type: 'limit', price: 95 });
    const on = sendButton(render({ draft: limit, entryBareSupported: true, entryBarePendingSupported: true }));
    expect(on).toContain('Koupit 1 LIMIT · BEZ SL/TP');
    expect(on).not.toMatch(/disabled=""/);
    expect(sendButton(render({ draft: bare({ type: 'stop', price: 105 }), entryBarePendingSupported: true }))).toContain('Koupit 1 STOP · BEZ SL/TP');
    const off = sendButton(render({ draft: limit, entryBareSupported: true }));
    expect(off).toMatch(/disabled=""/);
    expect(off).toContain('Limit a Stop potřebují SL i TP.');
    expect(sendButton(render({ draft: { ...limit, quantity: 2 }, entryBarePendingSupported: true, entryMaxContracts: 5 }))).toContain('Koupit 2 LIMIT · BEZ SL/TP');
  });

  it('bez capability Market bez SL/TP nenabídne a nepustí', () => {
    const markup = render({ draft: bare() });
    expect(markup).not.toContain('MARKET · BEZ SL/TP');
    expect(sendButton(markup)).toMatch(/disabled=""/);
    expect(sendButton(markup)).toContain('Worker zatím neumí Market bez SL/TP — doplň SL i TP.');
  });

  it('jedna noha nikdy; brána desku, otevřená pozice a velikost podle rizika blokují', () => {
    expect(sendButton(render({ draft: bare({ stopLoss: 90 }), entryBareSupported: true }))).toContain('Vyplň SL i TP, nebo u Marketu ani jedno.');
    const disarmed = sendButton(render({ draft: bare(), entryBareSupported: true, entryBlockedReason: 'Kopírka je vypnutá — zapni ji na Live Dashboardu.' }));
    expect(disarmed).toMatch(/disabled=""/);
    expect(disarmed).toContain('Kopírka je vypnutá');
    const open = sendButton(render({ draft: bare(), entryBareSupported: true, entryLeaderPosition: { side: 'long', quantity: 1, symbol: 'MNQZ6', bareEntryOperationId: null, pending: null } }));
    expect(open).toMatch(/disabled=""/);
    expect(open).toContain('V pozici holý Market nejde');
    expect(sendButton(render({ draft: bare({ sizing: 'risk' }), entryBareSupported: true }))).toContain('Bez SL/TP jen v kontraktech');
    // Strop skupiny i pro holý Market.
    expect(sendButton(render({ draft: bare({ quantity: 2 }), entryBareSupported: true }))).toMatch(/disabled=""/);
  });

  it('kotace z TradingView (bez kontraktu z IBKR) holý Market nepustí', () => {
    const markup = render({ draft: bare(), entryBareSupported: true, quoteInfo: { source: 'TV:MNQ1!', capturedAt: Date.now(), stale: false } });
    expect(sendButton(markup)).toMatch(/disabled=""/);
    expect(sendButton(markup)).not.toContain('MARKET · BEZ SL/TP');
  });

  it('zdroj: brána v okamžiku kliku (liveBareSendClick), pak jediné onPlaceEntry (přes sdílený zámek)', () => {
    const send = ticket.slice(ticket.indexOf('const sendDirect = async'), ticket.indexOf('const multiplier ='));
    const step = send.indexOf('liveBareSendClick({ gate: bareGateAt(Date.now()), last: directClickRef.current, draft: previewDraft })');
    const place = send.indexOf('placeEntryLocked(previewDraft');
    expect(step).toBeGreaterThan(0);
    expect(send.slice(step, place)).toMatch(/if \(step\.blocked\) \{ setDirect\(.*\); return; \}/);
    expect(send.slice(step, place)).toMatch(/if \(!step\.send\) return;/);
    expect(place).toBeGreaterThan(step);
    expect(ticket.match(/onPlaceEntry\(/g)).toHaveLength(1);
  });
});

describe('předvolby qty (U4)', () => {
  const draft = bare({ type: 'limit', price: 95, stopLoss: 90, takeProfit: 105 });
  it('čipy 1 · 2 · 3 · 5 jen do stropu skupiny; při stropu 1 žádné', () => {
    expect(render({ draft, entryMaxContracts: 3 }).match(/aria-pressed=/g)).toHaveLength(3);
    expect(render({ draft, entryMaxContracts: 5 }).match(/aria-pressed=/g)).toHaveLength(4);
    expect(render({ draft, entryMaxContracts: 1 })).not.toContain('Rychlá volba počtu kontraktů');
  });

  it('do předvoleb jde jen velikost a jednotky — nikdy cena, SL ani TP (INV-UI-04)', () => {
    const calls = ticket.match(/remember\([^;]*;/g) ?? [];
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call).toMatch(/^remember\(\{ (?:(?:sizing|quantity|riskUsd|units): [\w.]+(?:, )?)+ \}\);$/);
  });
});

describe('ATM šablony v panelu (U8)', () => {
  const draft = bare({ type: 'limit', price: 95, stopLoss: 90, takeProfit: 105 });
  it('čip vestavěné šablony vždy; ukládat jen přihlášenému uživateli', () => {
    const markup = render({ draft });
    expect(markup).toContain('Výchozí 12 b / 2R');
    expect(markup).toContain('Šablony se ukládají jen přihlášenému uživateli.');
  });

  it('přikoupení: čipy šablon vypnuté (platí SL/TP pozice)', () => {
    const scaleIn = { side: 'buy' as const, quantity: 1, stopLoss: 90, targetPrice: 105, canAdd: true, reason: null, pendingAdd: null };
    expect(render({ draft, entryScaleIn: scaleIn, entryMaxContracts: 2 })).toContain('Přikoupení drží SL/TP pozice — šablona se nepoužije.');
  });

  it('šablony jen předvyplní: čipy ani ukládání nikdy neodesílají', () => {
    const bar = ticket.slice(ticket.indexOf('const TemplateBar'), ticket.indexOf('const AttachSection'));
    const handlers = ticket.slice(ticket.indexOf('// ── ATM šablony (U8): jen předvyplnění'), ticket.indexOf('// ── „Přidat SL/TP“ k vlastnímu holému Marketu'));
    for (const part of [bar, handlers]) {
      expect(part.length).toBeGreaterThan(200);
      expect(part).not.toMatch(/onPlaceEntry|onAttachBrackets|manageRunner|onManageEntry|sendDirect/);
    }
  });
});

describe('„Přidat SL/TP“ k holé pozici (U4)', () => {
  const entry = { operationId: 'entry:abc', status: 'acknowledged', createdAt: 1, symbol: 'MNQZ6', side: 'Buy' as const, quantity: 1, bare: true };
  it('jen s capability, callbackem a vlastním holým vstupem', () => {
    const shown = render({ entryBareSupported: true, onAttachBrackets: async () => { throw new Error('nic'); }, entryBareEntry: entry });
    expect(shown).toContain('Long 1 · BEZ SL/TP');
    expect(shown).toContain('Odeslat SL a TP');
    expect(render({ entryBareSupported: true, entryBareEntry: entry })).not.toContain('Odeslat SL a TP');
    expect(render({ onAttachBrackets: async () => { throw new Error('nic'); }, entryBareEntry: entry })).not.toContain('Odeslat SL a TP');
  });

  it('zdroj: záměr se skládá při kliku (liveAttachIntent), jediné volání onAttachBrackets, neznámé se neopakuje', () => {
    const send = ticket.slice(ticket.indexOf('const sendAttach = async'), ticket.indexOf('// ── Správa pozice leadera z panelu'));
    expect(send.indexOf('liveAttachIntent(')).toBeGreaterThan(0);
    // Pozice leadera a čerstvá kotace IBKR (kontrakt, ≤ 3 s) jdou do záměru až v okamžiku kliku.
    expect(send).toMatch(/const intent = liveAttachIntent\(\{\s+bareEntry: attachEntry, position: entryLeaderPosition, quote: bareQuote,\s+stopLoss: shownLegs\.stopLoss, takeProfit: shownLegs\.takeProfit, tickSize: tick, now: Date\.now\(\),\s+\}\);/);
    expect(send.indexOf('onAttachBrackets(intent.attach)')).toBeGreaterThan(send.indexOf('liveAttachIntent('));
    expect(send).toMatch(/if \(shownAttachNotice\?\.final\) return;/);
    expect(send).toMatch(/result\.status === 'acknowledged' \|\| result\.status === 'unknown'/);
    expect(ticket.match(/onAttachBrackets\(/g)).toHaveLength(1);
  });
});

describe('správa pozice z panelu (U10)', () => {
  const row = { accountId: 11, name: 'Leader', isLeader: true, quantity: 1, entry: 25_000, openPnl: 20, stop: 24_990, target: 25_020,
    protectedFully: true, stopUsd: -20, targetUsd: 40, fees: 1.04, openPnlAsOf: null, ordersVerified: true, stopCoverage: 1, targetCoverage: 1 };
  const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
    kind: 'position', side: 'long', quantity: 1, entry: 25_000, entryType: 'Market', openPnl: 20, mark: 25_010,
    stop: 24_990, target: 25_020, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
    leader: { accountId: 11, quantity: 1, entry: 25_000 }, rows: [row], ...patch,
  });
  const runner: LiveManageRunner = {
    busy: false, result: null, clearResult: () => {}, pendingMove: null,
    run: async () => { throw new Error('test nic neodesílá'); },
    request: () => ({ step: 'repeat' }),
  };
  const manage = (props: Record<string, unknown> = {}, position = summary()) => render({
    quote: { bid: 25_010, ask: 25_010.25 },
    position: { key: 'p', symbol: 'MNQZ6', lines: [], summary: position, issue: null },
    onManageEntry: async () => { throw new Error('test nic neodesílá'); },
    manageEntryAvgPrice: 25_000, manageLeaderAccountId: 11, manageRunner: runner, ...props,
  });

  it('SL/TP číslem, BE, BE + n a BE + poplatky jen se sdíleným runnerem a leaderem skupiny workeru', () => {
    const markup = manage();
    expect(markup).toContain('Správa pozice · leader');
    expect(markup).toContain('BE · 25 000.00');
    expect(markup).toContain('BE + odhad poplatků · 25 000.75');
    expect(markup).toContain('Nový stop loss');
    // Bez sdíleného runneru (zámek s čarami grafu), bez správy nebo s cizím leaderem nic.
    expect(manage({ manageRunner: null })).not.toContain('Správa pozice');
    expect(manage({ onManageEntry: undefined })).not.toContain('Správa pozice');
    expect(manage({ manageLeaderAccountId: 12 })).not.toContain('Správa pozice');
    expect(manage({}, summary({ kind: 'pending' }))).not.toContain('Správa pozice');
  });

  it('BE + poplatky se bez známých poplatků nenabízí', () => {
    expect(manage({}, summary({ rows: [{ ...row, fees: null }] }))).not.toContain('BE + odhad poplatků');
  });

  it('zdroj: jediná cesta je manageRunner.request se záměrem spočteným při kliku', () => {
    expect(ticket.match(/manageRunner\.request\(/g)).toHaveLength(1);
    expect(ticket.match(/onManageEntry\(/g)).toBeNull();
    const handlers = ticket.slice(ticket.indexOf('const moveLeg = '), ticket.indexOf('const manageButton = '));
    expect(handlers).toMatch(/manageMovePlan\(guardNow\(\), leg\)/);
    expect(handlers).toMatch(/planBreakEven\(guardNow\(\), manageBasis, variant\)/);
    expect(ticket).not.toMatch(/Opravdu \$\{|intent\.confirm|moveShownRef/);
  });
});
