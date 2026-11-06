import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';
import type { TicketDraft } from '../lib/liveOrderTicket';
import type { LiveTicketScaleIn } from '../lib/liveScaleIn';
import type { BacktestChartOrderLine } from '../services/backtestOrderLines';

// B5 (telefonní graf, 3. 11. 2026): U2 čáry návrhu, U3 dvě okna a přehrávání, U5 pracující
// příkazy jen jako zobrazení, U7 zvuk při fillu (opt-in), U10 ✎ → list správy.

// Overlay (DOM, souřadnice grafu) nahradí zachytávač: test volá jeho callbacky jako tah/klepnutí.
const captured: { props: Record<string, any> | null; all: Record<string, any>[] } = { props: null, all: [] };
vi.mock('../components/BacktestOrderLinesOverlay', () => ({
  default: (props: Record<string, any>) => { captured.props = props; captured.all.push(props); return null; },
}));
const lines = await import('../components/day/LivePhoneOrderLines');
const { LivePhoneOrderLines, livePhoneDraftLines, livePhoneDraftAfterDrag, livePhoneDraftAfterRemove, livePhoneDraftAfterAddBracket, livePhoneMarketDraftFollow, livePhoneWorkingView, LIVE_PHONE_MANAGE_ACTION } = lines;
const { default: LivePhoneReplayLiveChip, livePhoneReplayLiveText, livePhoneReplayPnlText } = await import('../components/day/LivePhoneReplayLiveChip');
const { LiveFillAnnounceSetting } = await import('../components/day/LivePhoneTrade');

const instrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const quote = { bid: 28960, ask: 28960.25 };
const draft = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'limit', price: 28950, sizing: 'qty', quantity: 1, riskUsd: 200, stopLoss: 28940, takeProfit: 28970, ...patch,
});
const scaleIn = (patch: Partial<LiveTicketScaleIn> = {}): LiveTicketScaleIn => ({
  side: 'buy', quantity: 1, stopLoss: 28930, targetPrice: 28990, canAdd: true, reason: null, pendingAdd: null, ...patch,
});
const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'short', quantity: 1, entry: 28975.5, entryType: null, openPnl: 12, mark: 28960,
  stop: 28984.25, target: 28958, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
  leader: { accountId: 1, quantity: 1, entry: 28975.5 }, rows: [], ...patch,
});
const ack = (): LeaderOrderManageResult => ({ type: 'leader-order-managed', operationId: 'manage:x', action: 'move-stop', status: 'acknowledged', checkedAt: 1, blockers: [] });
const workingLine = (patch: Partial<BacktestChartOrderLine> & Record<string, unknown> = {}) => ({
  id: 'live-working:1|limit|buy|28900', ownerId: 'live-working' as const, ownerType: 'order' as const, kind: 'entry' as const, price: 28900, color: '#94a3b8',
  label: 'LMT BUY 1  28900.00 · Tradovate', draggable: false as const, cancellable: false as const, displayOnly: true as const, lineStyle: 'dotted' as const,
  title: 'Spravuj v Tradovate', role: 'order' as const, side: 'buy' as const, orderClass: 'limit' as const, quantity: 1, accountId: 1, orderIds: [1], ...patch,
});

type RenderOpts = {
  summary?: LiveChartPositionSummary | null;
  manage?: ReturnType<typeof vi.fn> | null;
  state?: { pendingMove: null; setPendingMove: ReturnType<typeof vi.fn>; busyRef: { current: boolean } };
  api?: unknown;
  extra?: Record<string, unknown>;
};
const render = (opts: RenderOpts = {}) => {
  captured.props = null;
  const notices: string[] = [];
  const state = opts.state ?? { pendingMove: null, setPendingMove: vi.fn(), busyRef: { current: false } };
  renderToStaticMarkup(React.createElement(LivePhoneOrderLines, {
    api: (opts.api ?? {}) as never, state: state as never, summary: opts.summary === undefined ? summary() : opts.summary, manage: (opts.manage ?? null) as never,
    canClose: true, entryAvg: 28975.5, isDark: true, onNotice: (text: string) => notices.push(text),
    ...(opts.extra ?? {}),
  }));
  return { props: captured.props, notices, state };
};
const byId = (props: Record<string, any>, id: string) => props.lines.find((line: { id: string }) => line.id === id);

beforeEach(() => { captured.props = null; captured.all = []; });

describe('U2: čáry návrhu v grafu telefonu (návrh, ne odeslání)', () => {
  it('Limit: vstup i SL/TP jdou táhnout; Market: vstup ne (jede s cenou), SL/TP ano', () => {
    const limit = livePhoneDraftLines(draft(), instrument, quote, null);
    expect(limit.map(line => [line.kind, line.draggable])).toEqual([['entry', true], ['stopLoss', true], ['takeProfit', true]]);
    const market = livePhoneDraftLines(draft({ type: 'market' }), instrument, quote, null);
    expect(market.find(line => line.kind === 'entry')!.draggable).toBe(false);
    expect(market.filter(line => line.kind !== 'entry').every(line => line.draggable)).toBe(true);
  });

  it('přikoupení drží SL/TP pozice: v grafu jen vstup návrhu (žádná táhnutelná noha ani + SL)', () => {
    const locked = livePhoneDraftLines(draft({ stopLoss: 28930, takeProfit: 28990 }), instrument, quote, scaleIn());
    expect(locked.map(line => line.kind)).toEqual(['entry']);
    expect(locked[0].addableBrackets).toBeUndefined();
    // Opačná strana = žádné přikoupení → nohy návrhu normálně.
    expect(livePhoneDraftLines(draft({ side: 'sell', price: 28970, stopLoss: 28980, takeProfit: 28950 }), instrument, quote, scaleIn()).length).toBe(3);
  });

  it('tah / × / + SL čáry návrhu volá jen onDraft* — nikdy manage ani nic dalšího', async () => {
    const manage = vi.fn(async () => ack());
    const onDraftChange = vi.fn();
    const onDraftRemove = vi.fn();
    const onDraftAddBracket = vi.fn();
    const draftLines = livePhoneDraftLines(draft({ takeProfit: null }), instrument, quote, null);
    const { props } = render({ manage, extra: { draftLines, onDraftChange, onDraftRemove, onDraftAddBracket } });
    props!.onChange(byId(props!, 'live-draft:stopLoss'), 'stopLoss', 28938.1, byId(props!, 'live-draft:stopLoss'));
    props!.onChange(byId(props!, 'live-draft:entry'), 'entry', 28951.6, byId(props!, 'live-draft:entry'));
    props!.onCancel(byId(props!, 'live-draft:stopLoss'));
    props!.onCancel(byId(props!, 'live-draft:entry'));
    props!.onAddBracket(byId(props!, 'live-draft:entry'), 'takeProfit', 28975);
    await Promise.resolve();
    expect(onDraftChange.mock.calls).toEqual([['stopLoss', 28938], ['entry', 28951.5]]);
    expect(onDraftRemove.mock.calls).toEqual([['stopLoss'], ['entry']]);
    expect(onDraftAddBracket).toHaveBeenCalledWith('takeProfit', 28975);
    expect(manage).not.toHaveBeenCalled();
    // × návrhu jedním klepnutím (jen zahodí návrh; klíč s cenou by u Marketu nešel potvrdit),
    // × pozice dál dvoukrokově.
    expect(draftLines.every(line => byId(props!, line.id).confirmCancel === false)).toBe(true);
    expect(byId(props!, 'live-position:entry').confirmCancel).toBeUndefined();
  });

  it('+ SL / + TP z čáry pozice nic nepřidá (jen vstup návrhu)', () => {
    const onDraftAddBracket = vi.fn();
    const { props } = render({ manage: vi.fn(), extra: { onDraftAddBracket } });
    props!.onAddBracket(byId(props!, 'live-position:entry'), 'stopLoss', 28990);
    expect(onDraftAddBracket).not.toHaveBeenCalled();
  });

  it('úpravy návrhu: Market vstup se tahem nemění, ceny na tick, × vstupu zahodí návrh', () => {
    expect(livePhoneDraftAfterDrag(draft({ type: 'market', price: 28960.25 }), 'entry', 28900, instrument).price).toBe(28960.25);
    expect(livePhoneDraftAfterDrag(draft(), 'entry', 28945.6, instrument).price).toBe(28945.5);
    expect(livePhoneDraftAfterDrag(draft(), 'takeProfit', 28977.4, instrument).takeProfit).toBe(28977.5);
    expect(livePhoneDraftAfterDrag(draft(), 'stopLoss', Number.NaN, instrument)).toEqual(draft());
    expect(livePhoneDraftAfterRemove(draft(), 'entry')).toBeNull();
    expect(livePhoneDraftAfterRemove(draft(), 'takeProfit')).toMatchObject({ takeProfit: null, stopLoss: 28940 });
    expect(livePhoneDraftAfterAddBracket(draft({ stopLoss: null }), 'stopLoss', instrument, quote, 28941.1).stopLoss).toBe(28941);
  });

  it('Market návrh: SL/TP jedou s cenou o stejný kus; přikoupení a Limit ne', () => {
    const market = draft({ type: 'market', price: 28960.25, stopLoss: 28950.25, takeProfit: 28980.25 });
    expect(livePhoneMarketDraftFollow(market, 28960.25, 28961.25, null, 0.25)).toMatchObject({ stopLoss: 28951.25, takeProfit: 28981.25 });
    expect(livePhoneMarketDraftFollow(market, null, 28961.25, null, 0.25)).toBe(market);
    expect(livePhoneMarketDraftFollow(market, 28960.25, 28961.25, scaleIn({ stopLoss: 28950.25, targetPrice: 28980.25 }), 0.25)).toBe(market);
    expect(livePhoneMarketDraftFollow(draft(), 28960.25, 28961.25, null, 0.25)).toEqual(draft());
  });
});

describe('U5: pracující příkazy jen jako zobrazení', () => {
  it('čára live-working: tah, ×, tlačítka ani + SL nic nepošlou a nic nezmění', async () => {
    const manage = vi.fn(async () => ack());
    const onDraftChange = vi.fn();
    const onDraftRemove = vi.fn();
    const onManage = vi.fn();
    // I kdyby čára přišla „táhnutelná“ s tlačítky, vrstva ji pustí jen jako zobrazení.
    const line = workingLine({ draggable: true as never, cancellable: true as never, actions: [{ id: 'break-even', label: 'BE' }] });
    const { props } = render({ manage, extra: { extraLines: [line], onDraftChange, onDraftRemove, onManage } });
    const shown = byId(props!, line.id);
    expect(shown).toMatchObject({ draggable: false, cancellable: false, actions: undefined, addableBrackets: undefined });
    props!.onChange(shown, 'entry', 28910, shown);
    props!.onChange({ ...shown, kind: 'stopLoss' }, 'stopLoss', 28910, shown);
    props!.onCancel(shown);
    props!.onAction(shown, 'break-even');
    props!.onAction(shown, LIVE_PHONE_MANAGE_ACTION.id);
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onDraftRemove).not.toHaveBeenCalled();
    expect(onManage).not.toHaveBeenCalled();
  });

  it('kontrakt čar musí sedět s kontraktem grafu (IBKR měsíc); souvislá řada kreslí kontrakt pozice', () => {
    const working = { lines: [workingLine()] as never[], badges: [{ id: 'b', kind: 'unsupported' as const, text: 'TRAILINGSTOP SELL 1 · nepodporovaný typ', price: null, color: '#f59e0b', title: 't', count: 1 }], key: 'k', contract: 'MNQZ6' };
    expect(livePhoneWorkingView(working, 'MNQZ6').lines).toHaveLength(1);
    expect(livePhoneWorkingView(working, null).badges).toHaveLength(1);
    expect(livePhoneWorkingView(working, 'MNQH7')).toEqual({ lines: [], badges: [] });
    expect(livePhoneWorkingView({ ...working, contract: null }, null)).toEqual({ lines: [], badges: [] });
    expect(livePhoneWorkingView(null, 'MNQZ6')).toEqual({ lines: [], badges: [] });
    // Čára bez značky zobrazení (cizí vlastník) do vrstvy příkazů neprojde.
    expect(livePhoneWorkingView({ ...working, lines: [{ ...workingLine(), ownerId: 'live-position', displayOnly: undefined } as never] }, null).lines).toHaveLength(0);
  });
});

describe('U10: ✎ na čáře jen otevře list správy', () => {
  it('✎ u táhnutelné SL/TP: klepnutí volá jen onManage s nohou, nic se neodešle', async () => {
    const manage = vi.fn(async () => ack());
    const onManage = vi.fn();
    const { props } = render({ manage, extra: { onManage } });
    const stop = byId(props!, 'live-position:stopLoss');
    const target = byId(props!, 'live-position:takeProfit');
    expect(stop.actions.map((action: { id: string }) => action.id)).toEqual(['manage']);
    expect(target.actions.map((action: { id: string }) => action.id)).toEqual(['manage']);
    // Vstup má dál jen BE (dvoukrokově), ✎ ne.
    expect(byId(props!, 'live-position:entry').actions.map((action: { id: string }) => action.id)).toEqual(['break-even']);
    props!.onAction(stop, 'manage');
    props!.onAction(target, 'manage');
    await Promise.resolve();
    expect(onManage.mock.calls).toEqual([['stopLoss'], ['takeProfit']]);
    expect(manage).not.toHaveBeenCalled();
  });

  it('bez správy (manage null), bez onManage nebo u čekajícího vstupu ✎ není', () => {
    const none = render({ manage: null, extra: { onManage: vi.fn() } });
    expect(none.props!.lines.some((line: { actions?: { id: string }[] }) => line.actions?.some(action => action.id === 'manage'))).toBe(false);
    const noHandler = render({ manage: vi.fn() });
    expect(noHandler.props!.lines.some((line: { actions?: { id: string }[] }) => line.actions?.some(action => action.id === 'manage'))).toBe(false);
    const pending = render({ manage: vi.fn(), summary: summary({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null }), extra: { onManage: vi.fn() } });
    expect(pending.props!.lines.some((line: { actions?: { id: string }[] }) => line.actions?.some(action => action.id === 'manage'))).toBe(false);
  });
});

describe('U3: dvě okna — každé okno svým API, zámek jednoho příkazu společný', () => {
  it('dvě instance (okna) dostanou své API; druhý tah během letu prvního neodejde', async () => {
    let release: (value: LeaderOrderManageResult) => void = () => {};
    const manage = vi.fn(() => new Promise<LeaderOrderManageResult>(resolve => { release = resolve; }));
    const state = { pendingMove: null, setPendingMove: vi.fn(), busyRef: { current: false } };
    const apiOne = { pane: 1 };
    const apiTwo = { pane: 2 };
    const one = render({ manage, state, api: apiOne });
    expect(one.props!.api).toBe(apiOne);
    one.props!.onChange(byId(one.props!, 'live-position:stopLoss'), 'stopLoss', 28990, byId(one.props!, 'live-position:stopLoss'));
    expect(state.busyRef.current).toBe(true);
    const two = render({ manage, state, api: apiTwo });
    expect(two.props!.api).toBe(apiTwo);
    two.props!.onChange(byId(two.props!, 'live-position:takeProfit'), 'takeProfit', 28950, byId(two.props!, 'live-position:takeProfit'));
    await Promise.resolve();
    expect(manage).toHaveBeenCalledTimes(1);
    expect(two.notices.join(' ')).toMatch(/Čeká se na výsledek/);
    release(ack());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.busyRef.current).toBe(false);
  });

  it('štítek přehrávání: živý stav z read modelu, P&L jen známý, jediné tlačítko = zpět na živo', () => {
    expect(livePhoneReplayLiveText(null)).toBe('živě bez pozice');
    expect(livePhoneReplayLiveText({ side: 'long', quantity: 2, pending: false })).toBe('živě LONG 2');
    expect(livePhoneReplayLiveText({ side: 'short', quantity: 1, pending: true })).toBe('živě ČEKÁ SELL 1');
    expect(livePhoneReplayPnlText(12.5)).toBe('+$12.50');
    expect(livePhoneReplayPnlText(-4)).toBe('−$4.00');
    expect(livePhoneReplayPnlText(null)).toBeNull();
    const html = renderToStaticMarkup(React.createElement(LivePhoneReplayLiveChip, { position: { side: 'long', quantity: 2, pending: false }, pnl: 12.5, onExit: () => {} }));
    expect(html).toMatch(/PŘEHRÁVÁNÍ/);
    expect(html).toMatch(/Zpět na živo/);
    expect(html).toMatch(/Obchoduj v živém grafu/);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toMatch(/Koupit|Prodat|Odeslat/);
    // Čekající vstup nemá P&L.
    expect(renderToStaticMarkup(React.createElement(LivePhoneReplayLiveChip, { position: { side: 'long', quantity: 1, pending: true }, pnl: 99, onExit: () => {} }))).not.toMatch(/\$99/);
  });
});

describe('U7: zvuk při fillu — volba v menu grafu', () => {
  it('Vypnuto / Tón / Hlas, vybraná volba je zaškrtnutá', () => {
    const html = renderToStaticMarkup(React.createElement(LiveFillAnnounceSetting, { mode: 'off', onMode: () => {} }));
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>Vypnuto</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Tón</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Hlas</);
  });
});

describe('statika B5: odeslání jen tlačítkem, přehrávání nic, zobrazení nic neautorizuje (INV-UI-01..04)', () => {
  const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
  const chart = readFileSync('components/day/DayFullscreenChart.tsx', 'utf8');
  const orderLines = readFileSync('components/day/LivePhoneOrderLines.tsx', 'utf8');
  const chip = readFileSync('components/day/LivePhoneReplayLiveChip.tsx', 'utf8');
  const broker = /from ['"][^'"]*(tradovate|copier|relay|broker|LiveDesk|chartOrderEntry)[^'"]*['"]|fetch\(|supabase|invoke\(/i;

  it('list i lišta návrhu odesílají stejnou cestou (submitSheetDraft) a jen ona volá send pro návrh', () => {
    expect(phone).toMatch(/<LivePhoneDraftBar[\s\S]*?onSubmit=\{draft => submitSheetDraft\(draft, replay\)\}/);
    expect(phone).toMatch(/<LivePhoneOrderSheet[\s\S]*?onSubmit=\{draft => submitSheetDraft\(draft, replay\)\}/);
    // Dvě odesílací místa vstupu: lišta Koupit/Prodat a submitSheetDraft (stejný příkaz jako náhled).
    expect(phone.match(/void send\(/g)).toHaveLength(2);
    expect(phone).toMatch(/void send\(livePhoneSheetPayload\(draft, LIVE_PHONE_INSTRUMENT, quote, trade\?\.frontContract \?\? null\)\);/);
    expect(phone).toMatch(/void send\(scaleIn \? livePhonePillScaleIn\(side, pill\.qty, quote!, scaleIn, trade!\.maxContracts\) : livePhoneBareMarket\(side, pill\.qty, quote!\)\);/);
  });

  it('přehrávání: odeslání listu/lišty i lišta Koupit/Prodat nejdřív kontrolují replay; lišta, návrh a vrstva čar schované', () => {
    expect(phone).toMatch(/const submitSheetDraft = \(draft: TicketDraft, replay: boolean\) => \{\s*if \(replay\) \{ say\(/);
    expect(phone).toMatch(/const onSide = \(side: 'buy' \| 'sell', replay: boolean\) => \{\s*if \(replay\) \{ say\(REPLAY_NO_TRADE\); return; \}/);
    expect(phone).toMatch(/\{!replay && <LiveTradePill [^\n]*onSide=\{side => onSide\(side, replay\)\} \/>\}/);
    expect(phone).toMatch(/\{chartDraft && !replay && lastPrice != null && \(\s*<LivePhoneDraftBar/);
    expect(phone).toMatch(/paneLayer: \(\{ api, replay, active, lastPrice \}\) => \(api && !replay \? <>/);
    expect(phone).toMatch(/\{manageLeg && !replay && \(/);
    expect(phone).toMatch(/\{plus != null && !replay && \(/);
    expect(phone).toMatch(/onPositionOrder: \(drawing, \{ lastPrice, replay \}\) => \{\s*if \(replay\) \{ say\(REPLAY_NO_TRADE\); return; \}/);
    expect(phone).toMatch(/\{replay && <LivePhoneReplayLiveChip [^\n]*onExit=\{exitReplay\} \/>\}/);
    // Lišta pozice (Zavřít, Přidat SL/TP) zůstává i v přehrávání; správa (U10) jen mimo něj.
    expect(phone).toMatch(/onManage=\{openManage && !replay \? \(\) => openManage\('stopLoss'\) : undefined\}/);
    expect(chart).toMatch(/exitReplay: \(\) => \{ if \(replayPhase !== 'off'\) stopReplay\(\); \}/);
  });

  it('pracující příkazy jdou jen do extraLines a štítků — nikdy do trade, manage ani odeslání', () => {
    expect(phone.match(/working\.\w+/g)).toEqual(['working.lines', 'working.badges']);
    expect(phone).toMatch(/extraLines=\{working\.lines\}/);
    expect(phone).toMatch(/const working = useMemo\(\(\) => livePhoneWorkingView\(slots\.workingOrders, contract\), \[slots\.workingOrders, contract\]\);/);
    expect(phone.match(/slots\.workingOrders/g)).toHaveLength(2);
    // Pojistka nad overlayem v každém handleru (čára jen pro zobrazení nikdy nic nepošle ani nezmění návrh).
    expect(orderLines).toMatch(/onChange=\{\(line, kind, price, startLine\) => \{\s*\/\/[^\n]*\n\s*if \(isLiveDisplayOnlyLine\(line\)\) return;/);
    expect(orderLines).toMatch(/onCancel=\{line => \{\s*if \(isLiveDisplayOnlyLine\(line\)\) return;/);
    expect(orderLines).toMatch(/onAction=\{\(line, actionId\) => \{\s*if \(isLiveDisplayOnlyLine\(line\) \|\| line\.ownerId !== LIVE_POSITION_OWNER/);
  });

  it('list správy sdílí zámek čar (lineState) a dostane jen deskový manage; ✎ jen otevře list', () => {
    expect(phone).toMatch(/<LivePhoneManageSheet[\s\S]*?manage=\{trade\?\.manage \?\? null\}\s*state=\{lineState\}/);
    expect(phone).toMatch(/const openManage = trade\?\.manage \? \(leg: 'stopLoss' \| 'takeProfit'\) => setManageLeg\(\{ key: Date\.now\(\), leg \}\) : undefined;/);
    expect(orderLines).toMatch(/if \(actionId === LIVE_PHONE_MANAGE_ACTION\.id\) \{ if \(line\.kind !== 'entry'\) onManage\?\.\(line\.kind\); return; \}/);
  });

  it('zvuk při fillu: stejné události jako karty, brána dostupnosti, žádná cesta k brokerovi', () => {
    expect(phone).toMatch(/useLiveFillAnnouncer\(\{ events: slots\.copyEvents, fills: slots\.fills, fillsSymbol: slots\.fillsSymbol, available: slots\.copyEvents != null, requireFocus: false \}\);/);
    expect(phone).toMatch(/hubExtra: <LiveFillAnnounceSetting mode=\{fillMode\} onMode=\{setFillMode\} \/>/);
    expect(chart).toMatch(/extra=\{live\?\.hubExtra\}/);
  });

  it('nové a změněné soubory telefonu nemají vlastní cestu k brokerovi', () => {
    for (const [file, source] of [['LivePhoneChart.tsx', phone], ['LivePhoneOrderLines.tsx', orderLines], ['LivePhoneReplayLiveChip.tsx', chip]] as const) {
      expect(source, file).not.toMatch(broker);
    }
    expect(chip).not.toMatch(/\.(place|preview|attach|flatten|manage)\(|onManageEntry|placeLeaderEntry/);
    expect(orderLines).not.toMatch(/\.(place|preview|attach|flatten)\(/);
  });
});
