import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { newTicketDraft, ticketMetrics, type TicketDraft } from '../lib/liveOrderTicket';
import { livePhoneSheetEntry, type LivePhoneQuote } from '../lib/livePhoneOrders';
import { LIVE_BUILTIN_BRACKET_TEMPLATE, createLiveBracketTemplate, type LiveBracketTemplate } from '../lib/liveBracketTemplates';
import { LIVE_TICKET_PREFS_KEY } from '../lib/liveTicketPrefs';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import LivePhoneOrderSheet, {
  livePhoneSheetPayload, livePhoneSheetPreviewBlocked, livePhoneSheetPreviewKey, livePhoneSheetProblems, livePhoneSheetSizingLine,
  livePhoneSheetStartDraft, livePhoneSheetSubmitDraft, livePhoneSheetUnits, type LivePhoneSheetTrade,
} from '../components/day/LivePhoneOrderSheet';
import LivePhoneDraftBar, { livePhoneDraftText } from '../components/day/LivePhoneDraftBar';
import { LivePhonePositionBar, createLivePhoneBarGuard, livePhoneAttachDefaults } from '../components/day/LivePhoneLiveActions';
import LivePhoneManageSheet, { livePhoneManagePlans } from '../components/day/LivePhoneManageSheet';

const NOW = Date.UTC(2026, 10, 3, 15);
const instrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const quote = { bid: 24_999.75, ask: 25_000 };
const liveQuote: LivePhoneQuote = { symbol: 'MNQZ6', bid: 24_999.75, ask: 25_000, at: NOW };
const draft = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'limit', price: 24_990, sizing: 'qty', quantity: 1, riskUsd: 200, stopLoss: 24_978, takeProfit: 25_014, ...patch,
});
const trade = (patch: Partial<LivePhoneSheetTrade> = {}): LivePhoneSheetTrade => ({
  blockedReason: null, marketSupported: true, bareSupported: true, maxContracts: 2, frontContract: 'MNQZ6', scaleIn: null, ...patch,
});
const template = (patch: Partial<Parameters<typeof createLiveBracketTemplate>[0]> = {}, id = 'swing'): LiveBracketTemplate => {
  const created = createLiveBracketTemplate({ name: 'Swing', stopLoss: { unit: 'ticks', value: 40 }, takeProfit: { unit: 'r', value: 2 }, sizing: null, ...patch }, { id, now: new Date(NOW) });
  if ('errors' in created) throw new Error(created.errors.join(' '));
  return created.template;
};
const scaleIn = (side: 'buy' | 'sell') => ({ side, quantity: 1, stopLoss: 24_970, targetPrice: 25_030, canAdd: true, reason: null, pendingAdd: null });

describe('U2 list: velikost podle rizika odchází jako zobrazené N, nikdy riskUsd', () => {
  const risky = draft({ sizing: 'risk', quantity: 7, riskUsd: 50, stopLoss: 24_980, takeProfit: 25_010 });

  it('50 $ při SL 10 b = 2 kontrakty (dolů, ne 3 ani zastaralých 7)', () => {
    const submit = livePhoneSheetSubmitDraft(risky, instrument, quote);
    expect(submit).toMatchObject({ sizing: 'qty', quantity: 2 });
    expect(ticketMetrics(risky, instrument, quote).quantity).toBe(2);
    const payload = livePhoneSheetPayload(submit, instrument, liveQuote, 'MNQZ6');
    expect(payload).toEqual({ symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Limit', price: 24_990, stopLoss: 24_980, takeProfit: 25_010 });
    expect(JSON.stringify(payload)).not.toMatch(/risk/i);
  });

  it('řádek „→ N kontraktů · skutečné riziko“; Market jen odhad; bez SL text', () => {
    expect(livePhoneSheetSizingLine(risky, ticketMetrics(risky, instrument, quote))).toBe('→ 2 kontrakty · skutečné riziko $40');
    const market = { ...risky, type: 'market' as const, stopLoss: 24_990, takeProfit: 25_040 };
    expect(livePhoneSheetSizingLine(market, ticketMetrics(market, instrument, quote))).toMatch(/^→ 2 kontrakty · skutečné riziko ≈ \$40 \(odhad z ceny grafu\)$/);
    const noStop = { ...risky, stopLoss: null };
    expect(livePhoneSheetSizingLine(noStop, ticketMetrics(noStop, instrument, quote))).toMatch(/bez stop lossu/);
    expect(livePhoneSheetSizingLine(draft(), ticketMetrics(draft(), instrument, quote))).toBeNull();
  });

  it('příkaz náhledu = přesně odeslání LivePhoneChart (kontrakt z IBKR, u Limitu bez IBKR front)', () => {
    const noIbkr = { ...liveQuote, symbol: null };
    const b5 = (d: TicketDraft, q: LivePhoneQuote) => livePhoneSheetEntry(d, instrument, { ...q, symbol: q.symbol ?? (d.type === 'limit' ? 'MNQZ6' : null) });
    for (const d of [draft(), draft({ type: 'stop', price: 25_010, stopLoss: 25_000, takeProfit: 25_030 }), draft({ type: 'market', stopLoss: 24_980, takeProfit: 25_020 })]) {
      for (const q of [liveQuote, noIbkr]) expect(livePhoneSheetPayload(d, instrument, q, 'MNQZ6')).toEqual(b5(d, q));
    }
    expect(livePhoneSheetPayload(draft(), instrument, noIbkr, 'MNQZ6')).toMatchObject({ symbol: 'MNQZ6', orderType: 'Limit' });
    expect(livePhoneSheetPayload(draft({ type: 'market' }), instrument, noIbkr, 'MNQZ6')).toHaveProperty('error');
    expect(livePhoneSheetPayload(draft(), instrument, null, 'MNQZ6')).toHaveProperty('error');
  });
});

describe('U2 list: náhled u workeru', () => {
  const market = draft({ type: 'market', stopLoss: 24_980, takeProfit: 25_040 });

  it('klíč Marketu nejede s tickem, ale změna návrhu nebo stavu kopírky ho změní', () => {
    const at = (q: LivePhoneQuote, d = market, reset = 'ok') => livePhoneSheetPreviewKey(reset, livePhoneSheetPayload(d, instrument, q, null));
    const base = at(liveQuote);
    expect(base).not.toBe('');
    expect(at({ ...liveQuote, bid: 25_000, ask: 25_000.25, at: NOW + 700 })).toBe(base);
    expect(at(liveQuote, { ...market, stopLoss: 24_979 })).not.toBe(base);
    expect(at(liveQuote, { ...market, quantity: 2 })).not.toBe(base);
    expect(at(liveQuote, { ...market, side: 'sell', stopLoss: 25_020, takeProfit: 24_960 })).not.toBe(base);
    expect(at(liveQuote, market, 'Kopírka je vypnutá — zapni ji na Live Dashboardu.')).not.toBe(base);
    // Limit: cena je součást klíče.
    const limit = (price: number) => livePhoneSheetPreviewKey('ok', livePhoneSheetPayload(draft({ price }), instrument, liveQuote, null));
    expect(limit(24_990)).not.toBe(limit(24_989.75));
    expect(livePhoneSheetPreviewKey('ok', { error: 'x' })).toBe('');
  });

  it('brána náhledu: desk → čerstvá kotace (≤ 3 s) → chyby návrhu → příkaz', () => {
    const payload = livePhoneSheetPayload(draft(), instrument, liveQuote, null);
    const ok = { blockedReason: null, problems: [], payload, liveQuote, now: NOW + 3_000 };
    expect(livePhoneSheetPreviewBlocked(ok)).toBeNull();
    expect(livePhoneSheetPreviewBlocked({ ...ok, blockedReason: 'Stav kopírky se ověřuje…', liveQuote: null })).toBe('Stav kopírky se ověřuje…');
    expect(livePhoneSheetPreviewBlocked({ ...ok, now: NOW + 3_001 })).toMatch(/Cena není čerstvá/);
    expect(livePhoneSheetPreviewBlocked({ ...ok, liveQuote: null })).toMatch(/Cena není čerstvá/);
    expect(livePhoneSheetPreviewBlocked({ ...ok, problems: [{ level: 'warning', text: 'Bez stop lossu.' }] })).toBeNull();
    expect(livePhoneSheetPreviewBlocked({ ...ok, problems: [{ level: 'error', text: 'Stop loss je na špatné straně vstupu.' }] })).toMatch(/^Nejdřív oprav: Stop loss/);
    expect(livePhoneSheetPreviewBlocked({ ...ok, payload: { error: 'Limit a Stop potřebují SL i TP.' } })).toBe('Limit a Stop potřebují SL i TP.');
  });

  it('render: tlačítko jen s deskovým náhledem, nic se při vykreslení neodešle; brána desku vypne odeslání', () => {
    const preview = vi.fn();
    const props = { initial: draft(), instrument, quote, onSubmit: vi.fn(), onClose: vi.fn() };
    expect(renderToStaticMarkup(React.createElement(LivePhoneOrderSheet, props))).not.toMatch(/Zkontrolovat u workeru/);
    const html = renderToStaticMarkup(React.createElement(LivePhoneOrderSheet, { ...props, trade: trade({ preview }), liveQuote }));
    expect(html).toMatch(/Zkontrolovat u workeru \(nic se neodešle\)/);
    expect(html).not.toMatch(/připraveno/i);
    expect(preview).not.toHaveBeenCalled();
    const blocked = renderToStaticMarkup(React.createElement(LivePhoneOrderSheet, { ...props, trade: trade({ preview, blockedReason: 'Kopírka je vypnutá — zapni ji na Live Dashboardu.' }), liveQuote }));
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Koupit 1 limit<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Koupit 1 limit<\/button>/);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('render: „Riziko $“ ukáže N a skutečné riziko; „Upravit v grafu“ jen s rodičem', () => {
    const html = renderToStaticMarkup(React.createElement(LivePhoneOrderSheet, {
      initial: draft({ sizing: 'risk', riskUsd: 50, stopLoss: 24_980, takeProfit: 25_010 }), instrument, quote, onSubmit: vi.fn(), onClose: vi.fn(), onEditInChart: vi.fn(),
    }));
    expect(html).toMatch(/→ 2 kontrakty · skutečné riziko \$40/);
    expect(html).toMatch(/Upravit v grafu/);
    expect(html).toMatch(/Kontrakty/);
  });
});

describe('U2 list: problémy návrhu = brány, které by odeslání stejně zastavilo', () => {
  const texts = (d: TicketDraft, t?: LivePhoneSheetTrade | null) => livePhoneSheetProblems(d, instrument, quote, t).map(p => `${p.level}:${p.text}`);

  it('bez desku jen výpočet panelu (+ varování Marketu pod 16 ticků)', () => {
    expect(texts(draft({ quantity: 5 }))).toEqual([]);
    expect(texts(draft({ type: 'market', stopLoss: 24_998, takeProfit: 25_040 }))).toEqual([expect.stringMatching(/^warning:U Marketu musí být SL i TP aspoň 16 ticků/)]);
  });

  it('s deskem: strop, jedna noha, Market bez capability, holý Market bez capability, přikoupení jinam', () => {
    expect(texts(draft({ quantity: 3 }), trade())).toContain('error:Strop ručního vstupu je 2 kontrakty.');
    expect(texts(draft({ quantity: 2 }), trade())).toEqual([]);
    expect(texts(draft({ takeProfit: null }), trade())).toContain('error:Vyplň SL i TP, nebo u Marketu ani jedno.');
    expect(texts(draft({ type: 'market', stopLoss: 24_980, takeProfit: 25_040 }), trade({ marketSupported: false }))).toContain('error:Worker zatím neumí Market — použij Limit.');
    expect(texts(draft({ type: 'market', stopLoss: null, takeProfit: null }), trade({ bareSupported: false }))).toContain('error:Worker zatím neumí Market bez SL/TP — doplň SL i TP.');
    expect(texts(draft(), trade({ scaleIn: scaleIn('sell') }))).toContain('error:V pozici jde jen přikoupit na její stranu — zavři ji ×.');
    // Riziko $ nad strop: N z rizika, ne zadané kontrakty.
    expect(texts(draft({ sizing: 'risk', riskUsd: 200, stopLoss: 24_980, takeProfit: 25_010 }), trade())).toContain('error:Strop ručního vstupu je 2 kontrakty.');
  });
});

describe('U8 šablony v listu a „Přidat SL/TP“', () => {
  const plus = newTicketDraft('buy', 'limit', 24_990, instrument, quote, { sizing: 'qty', quantity: 1, riskUsd: 200 });

  it('nový návrh („+“) dostane výchozí šablonu místo 12 b / 2R; velikost šablony automaticky ne', () => {
    const result = livePhoneSheetStartDraft(plus, template({ sizing: { mode: 'qty', quantity: 3 } }), instrument, quote, null);
    expect(result.draft).toMatchObject({ stopLoss: 24_980, takeProfit: 25_010, quantity: 1, sizing: 'qty' });
    // Vestavěná = dosavadní chování (nic se nemění).
    expect(livePhoneSheetStartDraft(plus, LIVE_BUILTIN_BRACKET_TEMPLATE, instrument, quote, null).draft).toEqual(plus);
    expect(livePhoneSheetStartDraft(plus, null, instrument, quote, null).draft).toBe(plus);
  });

  it('přikoupení šablonu ignoruje (SL/TP pozice), jiná strana pozice šablonu dostane', () => {
    const add = { ...plus, stopLoss: 24_970, takeProfit: 25_030 };
    const same = livePhoneSheetStartDraft(add, template(), instrument, quote, scaleIn('buy'));
    expect(same.skipped).toBe('scale-in');
    expect(same.draft).toBe(add);
    expect(livePhoneSheetStartDraft(plus, template(), instrument, quote, scaleIn('sell')).draft.stopLoss).toBe(24_980);
  });

  it('Přidat SL/TP: vestavěná = dosavadních 10 / 20 b; vlastní výchozí šablona od trhu; bez TP = 20 b', () => {
    expect(livePhoneAttachDefaults('long', 25_000, 0.25, LIVE_BUILTIN_BRACKET_TEMPLATE)).toEqual({ stopLoss: 24_990, takeProfit: 25_020 });
    expect(livePhoneAttachDefaults('long', 25_000, 0.25, null)).toEqual({ stopLoss: 24_990, takeProfit: 25_020 });
    expect(livePhoneAttachDefaults('long', 25_000, 0.25, template({ stopLoss: { unit: 'ticks', value: 24 }, takeProfit: { unit: 'r', value: 2 } }))).toEqual({ stopLoss: 24_994, takeProfit: 25_012 });
    expect(livePhoneAttachDefaults('short', 25_000, 0.25, template({ stopLoss: { unit: 'ticks', value: 24 }, takeProfit: { unit: 'r', value: 2 } }))).toEqual({ stopLoss: 25_006, takeProfit: 24_988 });
    expect(livePhoneAttachDefaults('long', 25_000, 0.25, template({ name: 'Runner', takeProfit: null }))).toEqual({ stopLoss: 24_990, takeProfit: 25_020 });
  });

  it('jednotky listu: bez uložené volby ceny (dosavadní telefon), jinak sdílená předvolba', () => {
    const storage = (value: string | null) => ({ getItem: () => value, setItem: () => undefined });
    expect(livePhoneSheetUnits(null)).toBe('price');
    expect(livePhoneSheetUnits(storage(null))).toBe('price');
    expect(livePhoneSheetUnits(storage(JSON.stringify({ units: 'ticks' })))).toBe('ticks');
    expect(livePhoneSheetUnits({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined })).toBe('price');
    expect(LIVE_TICKET_PREFS_KEY).toBe('alphatrade:live-ticket-prefs');
  });
});

describe('U2 lišta návrhu', () => {
  it('text „BUY 2 LMT @ … · SL … · TP … · −$48“, holý Market „bez SL/TP“', () => {
    expect(livePhoneDraftText(draft({ quantity: 2 }), instrument, quote)).toBe('BUY 2 LMT @ 24990.00 · SL 24978.00 · TP 25014.00 · −$48');
    expect(livePhoneDraftText(draft({ side: 'sell', type: 'market', stopLoss: null, takeProfit: null }), instrument, quote)).toBe('SELL 1 MKT ~24999.75 · bez SL/TP');
    expect(livePhoneDraftText(draft({ type: 'market', stopLoss: 24_980, takeProfit: 25_040 }), instrument, quote)).toMatch(/· ≈ −\$40$/);
  });

  it('Odeslat vypne brána desku, chyba návrhu i běžící odeslání; při vykreslení nic neodejde', () => {
    const onSubmit = vi.fn();
    const render = (patch: Record<string, unknown>) => renderToStaticMarkup(React.createElement(LivePhoneDraftBar, {
      draft: draft(), instrument, quote, onSubmit, onEdit: vi.fn(), onDiscard: vi.fn(), ...patch,
    }));
    const disabled = /<button[^>]*disabled=""[^>]*>(Odeslat|Odesílám…)<\/button>/;
    expect(render({ trade: trade() })).not.toMatch(disabled);
    expect(render({ trade: trade() })).toMatch(/>Odeslat<\/button>/);
    expect(render({ trade: trade({ blockedReason: 'Stav kopírky se ověřuje…' }) })).toMatch(disabled);
    expect(render({ trade: trade(), draft: draft({ quantity: 3 }) })).toMatch(disabled);
    expect(render({ trade: trade(), busy: true })).toMatch(/disabled=""[^>]*>Odesílám…<\/button>/);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('lišta pozice: Zrušit / Zavřít dvoukrokově s klíčem akce, mimo sdílený zámek', () => {
  it('busy vypne jen „Přidat SL/TP“, Flatten / Zavřít nikdy; SL/TP správa jen u chráněné pozice', () => {
    const base = { side: 'long' as const, quantity: 1, symbol: 'MNQZ6', busy: true, onAttach: vi.fn(), onClose: vi.fn(), onManage: vi.fn(), guard: createLivePhoneBarGuard(), onSwallowed: vi.fn() };
    const bare = renderToStaticMarkup(React.createElement(LivePhonePositionBar, { ...base, unprotected: true }));
    expect(bare).toMatch(/<button[^>]*disabled=""[^>]*>Přidat SL\/TP<\/button>/);
    // Holá pozice: záložní tlačítko se vždy jmenuje „Flatten“ (C8 kolo 1 — „Zavřít“ jen pro cílené zavření).
    const close = bare.match(/<button[^>]*aria-label="Flatten — zavřít vše"[^>]*>/)?.[0] ?? '';
    expect(close).not.toBe('');
    expect(close).not.toMatch(/disabled/);
    const managedClose = renderToStaticMarkup(React.createElement(LivePhonePositionBar, { ...base, unprotected: false }))
      .match(/<button[^>]*aria-label="Zavřít pozici \(Flatten\)"[^>]*>/)?.[0] ?? '';
    expect(managedClose).not.toBe('');
    expect(managedClose).not.toMatch(/disabled/);
    expect(bare).not.toMatch(/Správa SL a TP/);
    expect(renderToStaticMarkup(React.createElement(LivePhonePositionBar, { ...base, unprotected: false }))).toMatch(/aria-label="Správa SL a TP"/);
    const pending = renderToStaticMarkup(React.createElement(LivePhonePositionBar, { ...base, unprotected: false, pending: { type: 'Limit', price: 24_990 } }));
    expect(pending).not.toMatch(/Správa SL a TP/);
    expect(pending.match(/<button[^>]*aria-label="Zrušit čekající příkaz"[^>]*>/)?.[0]).not.toMatch(/disabled/);
    expect(base.onClose).not.toHaveBeenCalled();
  });
});

describe('U10 list správy: záměry (číslo, BE, BE + n, BE s poplatky)', () => {
  const row = (patch: Partial<LiveChartPositionSummary['rows'][number]> = {}): LiveChartPositionSummary['rows'][number] => ({
    accountId: 1, name: 'L', isLeader: true, quantity: 2, entry: 25_000, openPnl: 20, stop: 24_990, target: 25_030, protectedFully: true,
    stopUsd: -40, targetUsd: 120, fees: 3, openPnlAsOf: null, ordersVerified: true, stopCoverage: 2, targetCoverage: 2, ...patch,
  });
  const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
    kind: 'position', side: 'long', quantity: 2, entry: 25_000, entryType: null, openPnl: 20, mark: 25_010, stop: 24_990, target: 25_030,
    protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null, leader: { accountId: 1, quantity: 2, entry: 25_000 }, rows: [row()], ...patch,
  });
  const plans = (patch: Partial<Parameters<typeof livePhoneManagePlans>[0]> = {}) => livePhoneManagePlans({
    summary: summary(), leaderAccountId: 1, entryAvg: 25_000, leg: 'stopLoss', units: 'ticks', value: 30, plusTicks: 2, ...patch,
  });

  it('SL 30 ticků od průměru: „co jsem viděl“ = SL z read modelu', () => {
    expect(plans().move).toEqual({ ok: true, intent: expect.objectContaining({ action: 'move-stop', expectPrice: 24_990, newPrice: 24_992.5, direction: 'tighten' }) });
    expect(plans({ value: 70 }).move).toMatchObject({ ok: true, intent: { newPrice: 24_982.5, direction: 'loosen' } });
    expect(plans({ units: 'price', value: 25_009 }).move).toMatchObject({ ok: false, reason: expect.stringMatching(/8 ticků/) });
    expect(plans({ value: null }).move).toMatchObject({ ok: false, reason: 'Zadej číslo.' });
    expect(plans({ summary: null }).move).toMatchObject({ ok: false, reason: 'Pozice leadera není známá.' });
  });

  it('TP číslem jen dál od trhu', () => {
    expect(plans({ leg: 'takeProfit', units: 'pts', value: 40 }).move).toMatchObject({ ok: true, intent: { action: 'move-target', expectPrice: 25_030, newPrice: 25_040 } });
    expect(plans({ leg: 'takeProfit', units: 'pts', value: 20 }).move).toMatchObject({ ok: false, reason: expect.stringMatching(/dál od trhu/) });
  });

  it('BE, BE + 2 t a BE s poplatky leadera; poplatky neznámé = nenabízet', () => {
    const p = plans();
    expect(p.be).toMatchObject({ ok: true, intent: { action: 'move-stop', expectPrice: 24_990, newPrice: 25_000 } });
    expect(p.plus).toMatchObject({ ok: true, intent: { newPrice: 25_000.5, label: 'SL na BE +2 t 25000.50' } });
    expect(p.fees).toMatchObject({ ok: true, intent: { newPrice: 25_000.75 } });
    expect(plans({ summary: summary({ rows: [row({ fees: null })] }) }).fees).toBeNull();
    // Jiný leader skupiny (zobrazovací isLeader nestačí): qty i poplatky neznámé.
    expect(plans({ leaderAccountId: 9 }).fees).toBeNull();
    expect(plans({ leaderAccountId: 9, units: 'usd', value: 20 }).move).toMatchObject({ ok: false, reason: expect.stringMatching(/Počet kontraktů leadera/) });
    expect(plans({ entryAvg: null }).be).toMatchObject({ ok: false });
  });

  it('render: tlačítka s cenou záměru, bez manage vše vypnuté; vykreslení nic neodešle', () => {
    const manage = vi.fn();
    const state = { pendingMove: null, setPendingMove: vi.fn(), busyRef: { current: false } };
    const render = (patch: Record<string, unknown>) => renderToStaticMarkup(React.createElement(LivePhoneManageSheet, {
      summary: summary(), manage, state, entryAvg: 25_000, leaderAccountId: 1, onClose: vi.fn(), ...patch,
    }));
    const html = render({});
    expect(html).toMatch(/SL na BE 25000\.00/);
    expect(html).toMatch(/BE \+ 2 t/);
    expect(html).toMatch(/BE \+ odhad poplatků/);
    expect(render({ summary: summary({ rows: [row({ fees: null })] }) })).not.toMatch(/BE \+ odhad poplatků/);
    const off = render({ manage: null });
    expect(off).toMatch(/Správa z telefonu teď nejde/);
    expect(off).not.toMatch(/<button(?![^>]*disabled)[^>]*>(<span>)?(BE|Posunout)/);
    expect(manage).not.toHaveBeenCalled();
    expect(state.setPendingMove).not.toHaveBeenCalled();
  });
});

describe('statika: listy a lišty nemají vlastní cestu k brokerovi (INV-UI-01)', () => {
  const source = (file: string) => readFileSync(`components/day/${file}`, 'utf8');
  const broker = /from ['"][^'"]*(tradovate|copier|relay|broker|LiveDesk|liveChartOrder|chartOrderEntry)[^'"]*['"]|fetch\(|supabase|invoke\(/i;

  it('lišta návrhu odesílá jen přes onSubmit rodiče (submitSheetDraft) se zobrazeným N', () => {
    const bar = source('LivePhoneDraftBar.tsx');
    expect(bar).not.toMatch(broker);
    expect(bar).not.toMatch(/\.(place|preview|attach|flatten|manage)\(|onManageEntry|placeLeaderEntry/);
    expect(bar.match(/onSubmit\(/g)).toHaveLength(1);
    expect(bar).toMatch(/onSubmit\(livePhoneSheetSubmitDraft\(draft, instrument, quote\)\)/);
  });

  it('list objednávky: odeslání jen onSubmit, z desku jen náhled (nic nezapíše)', () => {
    const sheet = source('LivePhoneOrderSheet.tsx');
    expect(sheet).not.toMatch(broker);
    expect(sheet).not.toMatch(/\.(place|attach|flatten|manage)\(|onManageEntry|placeLeaderEntry/);
    expect(sheet.match(/onSubmit\(/g)).toHaveLength(1);
    expect(sheet).toMatch(/onSubmit\(submitDraft\)/);
    expect(sheet.match(/\.preview\(/g)).toHaveLength(1);
    expect(sheet).toMatch(/'blockedReason' \| 'marketSupported' \| 'bareSupported' \| 'maxContracts' \| 'frontContract' \| 'scaleIn' \| 'preview'/);
  });

  it('list správy: jen sdílený runner (request = dvoukrok), nikdy přímé manage() ani run()', () => {
    const sheet = source('LivePhoneManageSheet.tsx');
    expect(sheet).not.toMatch(broker);
    expect(sheet).not.toMatch(/[^.\w]manage\(|runner\.run\(|onManageEntry/);
    expect(sheet.match(/runner\.request\(/g)).toHaveLength(1);
    expect(sheet).toMatch(/useLiveManageRunner\(\{\s*manage,\s*state,/);
  });

  it('lišta pozice: první klepnutí přes pojistku rodiče, Zavřít bez busy', () => {
    const actions = source('LivePhoneLiveActions.tsx');
    expect(actions).not.toMatch(broker);
    expect(actions).toContain('guard: LivePhoneBarGuard;');
    expect(actions).toMatch(/const step = guard\.flatten\(pending \? 'cancel' : 'flatten'\);/);
    expect(actions).not.toMatch(/Opravdu/);
    expect(actions).not.toMatch(/armedAt/);
    expect(actions).toMatch(/liveAttachProblem\(side, market, sl, tp, tickSize\)/);
  });
});
