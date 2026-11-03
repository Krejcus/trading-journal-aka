import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import LiveOrderTicket, { attachErrorNotice } from '../components/LiveOrderTicket';
import ConfirmActionDialog from '../components/ConfirmActionDialog';
import { liveSafetyDialogInitialFocus, liveSafetyShortcutListener } from '../components/LiveSafetyControls';
import { LIVE_TICKET_SELECTOR, dispatchLiveHotkeyOutcome, liveHotkeyOverlayOpen, liveReleaseTicketFocus } from '../components/LiveHotkeysHelp';
import { createLivePhoneBarClose } from '../components/day/LivePhoneLiveActions';
import {
  LIVE_BARE_POSITION_UNVERIFIED,
  LIVE_PREVIEW_PLACE_BARE,
  liveBareMarketBlockReason,
  liveBareSendClick,
  livePreviewPlaceClick,
  liveTicketBarePosition,
  type LiveBareMarketGate,
  type LiveConfirmState,
} from '../lib/liveBareEntry';
import { LIVE_PREVIEW_FRESH_MS } from '../lib/livePreviewView';
import {
  LIVE_MANAGE_SEEN_MIN_MS,
  liveManageSeenPriceProblem,
  liveManageShownPrice,
  managePriceFromInput,
  planManageMove,
  type LiveManageShownPrice,
} from '../lib/liveManagePrices';
import { NO_LIVE_CHART_POSITION, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import { livePositionChartLines } from '../lib/liveChartOrderLines';
import { createTwoStepGuard, liveHotkeyAction, resolveLiveHotkey } from '../lib/liveHotkeys';
import { createLiveSafetyShortcutBus } from '../lib/liveSafetyShortcut';
import { createLiveManageRun } from '../hooks/useLiveManageRunner';
import type { LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';
import type { TicketDraft } from '../lib/liveOrderTicket';

/**
 * Opravy po oponentuře copier-design-critic k UI vlně B (3. 11. 2026): behaviorální
 * scénáře chyby, zastaralého stavu a opačného pořadí přes čisté funkce a vykreslení
 * (jsdom v repu není a síť je zakázaná — klik/klávesa se simulují voláním téže funkce,
 * kterou volá obsluha, a zapojení hlídá statická kontrola zdrojáku).
 */

const source = (path: string) => readFileSync(path, 'utf8');
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};
const ticket = source('components/LiveOrderTicket.tsx');

const limitDraft: LiveEntryPreviewDraft = { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 25_000, stopLoss: 24_990, takeProfit: 25_020 };
const bareDraft: LiveEntryPreviewDraft = { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 25_000.25, quoteReceivedAt: 1_000 };

// ---------------------------------------------------------------------------
// P2: Náhled → Odeslat — dvoukrok 350 ms – 4 s, holý Market nikdy

describe('P2: Odeslat v Náhledu = dvoukrok 350 ms – 4 s; holý Market jen velkým tlačítkem', () => {
  /** Klikání tak, jak ho dělá `PreviewSection.send` (ref stavu potvrzení mezi kliky). */
  const clicker = (draft: LiveEntryPreviewDraft, patch: Partial<Parameters<typeof livePreviewPlaceClick>[0]> = {}) => {
    let confirm: LiveConfirmState | null = null;
    const place = vi.fn();
    const click = (now: number, over: Partial<Parameters<typeof livePreviewPlaceClick>[0]> = {}) => {
      const step = livePreviewPlaceClick({
        confirm, draft, operationId: 'entry:abc', previewKey: `true|${JSON.stringify(draft)}`, receivedAt: 900,
        blockedReason: null, freshMs: LIVE_PREVIEW_FRESH_MS, now, ...patch, ...over,
      });
      confirm = step.next;
      if (step.send) place(draft);
      return step;
    };
    return { click, place };
  };

  it('dvojklik (< 350 ms) nic neodešle; 349 ms ne, 350 ms ano — právě jednou', () => {
    const fast = clicker(limitDraft);
    fast.click(1_000);
    fast.click(1_080);
    expect(fast.place).not.toHaveBeenCalled();
    const early = clicker(limitDraft);
    early.click(1_000);
    expect(early.click(1_349).send).toBe(false);
    // Kotva se posunula na 1 349: 1 350 je 1 ms po předchozím kliku → nic (trojklik).
    expect(early.click(1_350).send).toBe(false);
    expect(early.place).not.toHaveBeenCalled();
    const edge = clicker(limitDraft);
    edge.click(1_000);
    expect(edge.click(1_350).send).toBe(true);
    expect(edge.place).toHaveBeenCalledTimes(1);
    // Po odeslání se stav potvrzení zahodí: další klik jen znovu ptá.
    expect(edge.click(1_800).send).toBe(false);
    expect(edge.place).toHaveBeenCalledTimes(1);
  });

  it('po 4 s výzva vyprší; změna návrhu (jiná cena = jiný klíč) mezi kliky nic nepotvrdí', () => {
    const late = clicker(limitDraft);
    late.click(1_000);
    expect(late.click(5_000).send).toBe(false);
    expect(late.place).not.toHaveBeenCalled();
    const changed = clicker(limitDraft);
    changed.click(1_000);
    expect(changed.click(1_500, { previewKey: `true|${JSON.stringify({ ...limitDraft, price: 25_000.25 })}` }).send).toBe(false);
    expect(changed.place).not.toHaveBeenCalled();
  });

  it('holý Market z Náhledu nikdy — ani dvěma kliky v okně', () => {
    const bare = clicker(bareDraft);
    expect(bare.click(1_000).reason).toBe(LIVE_PREVIEW_PLACE_BARE);
    expect(bare.click(1_500).send).toBe(false);
    expect(bare.place).not.toHaveBeenCalled();
  });

  it('zastaralý náhled nebo brána panelu při DRUHÉM kliku = nic a výzva se zahodí', () => {
    const stale = clicker(limitDraft);
    stale.click(1_000);
    const step = stale.click(900 + LIVE_PREVIEW_FRESH_MS + 1);
    expect(step).toMatchObject({ send: false, next: null });
    expect(step.reason).toMatch(/není čerstvý/);
    const blocked = clicker(limitDraft);
    blocked.click(1_000);
    expect(blocked.click(1_500, { blockedReason: 'Cena grafu je zastaralá — náhled ani odeslání teď nejde.' })).toMatchObject({ send: false, next: null });
    // Po odblokování znovu od prvního kliku (ne potvrzení starého).
    expect(blocked.click(1_600).send).toBe(false);
    expect(blocked.place).not.toHaveBeenCalled();
    // Bez id odeslání (náhled chybí) nikdy.
    expect(clicker(limitDraft).click(1_000, { operationId: null }).reason).toMatch(/Náhled chybí/);
  });

  it('zdroj: Náhled dostane onPlace jen pro návrh, který není holý; send jen přes livePreviewPlaceClick', () => {
    expect(ticket).toMatch(/\{\.\.\.\(onPlaceEntry && !bareDraft \? \{ onPlace: onPlaceEntry \} : \{\}\)\}/);
    const section = between(ticket, 'const PreviewSection: React.FC', '// ── Předvolby, šablony a výchozí návrh');
    expect(section).not.toMatch(/confirmUntil|5_000/);
    expect(section).toMatch(/const placeFn = barePreview \? undefined : onPlace;/);
    const send = between(section, 'const send = async () => {', 'const placedText');
    const step = send.indexOf('livePreviewPlaceClick({');
    const gate = send.indexOf('if (!step.send) return;');
    const call = send.indexOf('await placeFn(previewDraft');
    expect(step).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(step);
    expect(call).toBeGreaterThan(gate);
    // Jediné volání odeslání v sekci a tlačítko Odeslat jen s placeFn (ne s onPlace).
    expect(section.match(/onPlace\(|placeFn\(/g)).toHaveLength(1);
    expect(section).toMatch(/\{placeFn && result\?\.wouldPlace && <button/);
    expect(section).not.toMatch(/\{onPlace && result\?\.wouldPlace && <button/);
  });
});

// ---------------------------------------------------------------------------
// P3: unknown ≠ flat v UI bráně holého Marketu

const MNQ = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const bareTicket = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'market', price: 100.25, sizing: 'qty', quantity: 1, riskUsd: 200, stopLoss: null, takeProfit: null, ...patch,
});
const renderTicket = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(LiveOrderTicket, {
  isDark: true, instrument: MNQ, quote: { bid: 100, ask: 100.25 }, draft: bareTicket(), onDraft: () => {}, fromBox: false,
  units: 'pts', onUnits: () => {}, scope: 'account', onScope: () => {},
  group: null, target: { kind: 'group' }, onTarget: () => {},
  quoteInfo: { source: 'IBKR:MNQZ2026', capturedAt: Date.now(), stale: false },
  position: NO_LIVE_CHART_POSITION, entryBareSupported: true,
  onPlaceEntry: async () => { throw new Error('test nic neodesílá'); },
  entryMarketSupported: true, entryMaxContracts: 1, onNewDraft: () => {}, onClose: () => {},
  ...props,
} as never));
const sendButton = (markup: string) => {
  const at = markup.indexOf('live-ticket-send');
  return markup.slice(markup.lastIndexOf('<button', at), markup.indexOf('</button>', at));
};

describe('P3: neověřená pozice není flat (holý Market z PC)', () => {
  const gate = (positionOpen: boolean, blockedReason: string | null = null): LiveBareMarketGate => ({
    blockedReason, marketSupported: true, bareSupported: true, maxContracts: 1,
    quote: { symbol: 'MNQZ6', bid: 25_000, ask: 25_000.25, at: 1_000 }, positionOpen, now: 1_500,
  });

  it('issue čtení i chybějící data = neověřeno (blokuje s vlastním textem); souhrn nebo čekající vstup = ne flat', () => {
    expect(liveTicketBarePosition({ summary: null, issue: 'Pozice neověřené' }, null)).toEqual({ open: true, reason: LIVE_BARE_POSITION_UNVERIFIED });
    expect(liveTicketBarePosition(null, null)).toEqual({ open: true, reason: LIVE_BARE_POSITION_UNVERIFIED });
    expect(liveTicketBarePosition(undefined, null)).toEqual({ open: true, reason: LIVE_BARE_POSITION_UNVERIFIED });
    expect(liveTicketBarePosition({ summary: { kind: 'position' }, issue: null }, null)).toEqual({ open: true, reason: null });
    expect(liveTicketBarePosition({ summary: null, issue: null }, { side: 'long' })).toEqual({ open: true, reason: null });
    expect(liveTicketBarePosition({ summary: null, issue: null }, null)).toEqual({ open: false, reason: null });
    // Do brány: neověřená pozice holý Market zablokuje, ověřeně flat pustí.
    const unverified = liveTicketBarePosition({ summary: null, issue: 'Pozice neověřené' }, null);
    expect(liveBareMarketBlockReason(gate(unverified.open, unverified.reason), 1)).toBe(LIVE_BARE_POSITION_UNVERIFIED);
    expect(liveBareMarketBlockReason(gate(false), 1)).toBeNull();
  });

  it('vykreslený panel: neověřená nebo chybějící pozice tlačítko zamkne s textem; ověřeně flat ne', () => {
    for (const position of [{ key: 'issue', symbol: null, lines: [], summary: null, issue: 'Pozice neověřené' }, null]) {
      const button = sendButton(renderTicket({ position }));
      expect(button).toMatch(/disabled=""/);
      expect(button).toContain(LIVE_BARE_POSITION_UNVERIFIED);
    }
    const flat = sendButton(renderTicket({}));
    expect(flat).not.toMatch(/disabled=""/);
    expect(flat).toContain('Koupit 1 MARKET · BEZ SL/TP');
    // Dvojí pojistka v bráně panelu: text neověřené pozice I „ne flat“ (stejná funkce pro obojí).
    const gateSource = between(ticket, 'const barePosition = liveTicketBarePosition(position, entryLeaderPosition);', 'const bareEntryDraft = ');
    expect(gateSource).toMatch(/: entryBlockedReason \?\? barePosition\.reason,/);
    expect(gateSource).toMatch(/positionOpen: barePosition\.open,/);
  });
});

describe('P3 (kontrolní seznam 25): druhý klik holého Marketu po změně stavu', () => {
  const okGate = (now: number, patch: Partial<LiveBareMarketGate> = {}): LiveBareMarketGate => ({
    blockedReason: null, marketSupported: true, bareSupported: true, maxContracts: 1,
    quote: { symbol: 'MNQZ6', bid: 25_000, ask: 25_000.25, at: now - 100 }, positionOpen: false, now, ...patch,
  });
  const run = (clicks: Array<{ at: number; gate?: Partial<LiveBareMarketGate> }>) => {
    let confirm: LiveConfirmState | null = null;
    let sent = 0;
    const blocked: string[] = [];
    for (const click of clicks) {
      const step = liveBareSendClick({ gate: okGate(click.at, click.gate), confirm, draft: bareDraft });
      confirm = step.next;
      if (step.blocked) blocked.push(step.blocked);
      if (step.send) sent += 1;
    }
    return { sent, blocked };
  };

  it('pozice se objeví mezi kliky = druhý klik nic; po zmizení blokace zase od prvního kliku', () => {
    expect(run([{ at: 1_000 }, { at: 1_500, gate: { positionOpen: true } }, { at: 1_900 }])).toEqual({ sent: 0, blocked: [expect.stringMatching(/V pozici holý Market nejde/)] });
  });

  it('obnovený / nečerstvý stav desku nebo stará kotace při druhém kliku = nic', () => {
    expect(run([{ at: 1_000 }, { at: 1_500, gate: { blockedReason: 'Stav kopírky není čerstvě ověřený.' } }]).sent).toBe(0);
    expect(run([{ at: 1_000 }, { at: 1_500, gate: { quote: { symbol: 'MNQZ6', bid: 1, ask: 1.25, at: 1_500 - 3_001 } } }]).sent).toBe(0);
    // Trojklik nic: pauza 350 ms se počítá od PŘEDCHOZÍHO kliku.
    expect(run([{ at: 1_000 }, { at: 1_200 }, { at: 1_350 }])).toEqual({ sent: 0, blocked: [] });
    expect(run([{ at: 1_000 }, { at: 1_200 }, { at: 1_400 }, { at: 1_600 }])).toEqual({ sent: 0, blocked: [] });
    expect(run([{ at: 1_000 }, { at: 1_200 }, { at: 1_600 }])).toEqual({ sent: 1, blocked: [] });
  });
});

// ---------------------------------------------------------------------------
// P3: fokus odesílacího tlačítka po kliku, který nic neodeslal

describe('P3: po zkratce Shift+B/S nezůstane fokus v panelu (žádná klávesová cesta k odeslání)', () => {
  /** Minimální model fokusu: tlačítko v panelu, Enter „klikne“ na fokusovaný prvek. */
  const page = () => {
    const doc = { activeElement: null as unknown };
    const body = { closest: () => null, blur: () => {} };
    const sendButtonEl = {
      closest: (selector: string) => (selector === LIVE_TICKET_SELECTOR ? {} : null),
      blur: vi.fn(() => { doc.activeElement = body; }),
      click: vi.fn(),
    };
    doc.activeElement = sendButtonEl;
    const enter = () => { if (doc.activeElement === sendButtonEl) sendButtonEl.click(); };
    return { doc, body, sendButtonEl, enter };
  };

  it('fokus na tlačítku panelu (armovací klik) → zkratka ho zruší → Enter nic nepošle', () => {
    const { doc, sendButtonEl, enter } = page();
    expect(liveReleaseTicketFocus(doc)).toBe(true);
    enter();
    expect(sendButtonEl.blur).toHaveBeenCalledTimes(1);
    expect(sendButtonEl.click).not.toHaveBeenCalled();
  });

  it('mutace kontroly: bez zrušení fokusu by Enter tlačítko zmáčkl (model je citlivý)', () => {
    const { sendButtonEl, enter } = page();
    enter();
    expect(sendButtonEl.click).toHaveBeenCalledTimes(1);
  });

  it('fokus mimo panel zůstává; neznámý stav (výjimka) fokus zruší; bez dokumentu nic', () => {
    const outside = { closest: () => null, blur: vi.fn() };
    expect(liveReleaseTicketFocus({ activeElement: outside })).toBe(false);
    expect(outside.blur).not.toHaveBeenCalled();
    const broken = { closest: () => { throw new Error('bad'); }, blur: vi.fn() };
    expect(liveReleaseTicketFocus({ activeElement: broken })).toBe(true);
    expect(broken.blur).toHaveBeenCalledTimes(1);
    expect(liveReleaseTicketFocus(null)).toBe(false);
    expect(liveReleaseTicketFocus({ activeElement: null })).toBe(false);
  });

  it('zdroj: prefillFromHotkey ruší fokus PŘED výměnou návrhu; obě odesílací tlačítka fokus po kliku pouští', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    const prefill = between(screen, 'const prefillFromHotkey = ', 'hotkeyHandlerRef.current = ');
    const release = prefill.indexOf("liveReleaseTicketFocus(typeof document === 'undefined' ? null : document);");
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(prefill.indexOf('setDraft(result.draft);'));
    expect(screen).toMatch(/<aside className="live-chart-ticket h-full w-\[304px\]">\s*<LiveOrderTicket/);
    expect(ticket).toMatch(/onClick=\{event => \{ event\.currentTarget\.blur\(\); void sendDirect\(\); \}\}/);
    expect(ticket).toMatch(/onClick=\{event => \{ event\.currentTarget\.blur\(\); void send\(\); \}\}/);
  });
});

// ---------------------------------------------------------------------------
// P3: telefonní „Zrušit“ čekajícího vstupu přes sdílený zámek čar

describe('P3: telefon — Zrušit z lišty pozice jde sdíleným zámkem (jeden příkaz naráz)', () => {
  const ack: LeaderOrderManageResult = { type: 'leader-order-managed', status: 'acknowledged', blockers: [] } as unknown as LeaderOrderManageResult;
  const setup = (busy = false) => {
    const busyRef = { current: busy };
    const manage = vi.fn(async () => ack);
    const flatten = vi.fn(async () => 'Flatten odeslán.');
    const say = vi.fn();
    const close = createLivePhoneBarClose({ trade: () => ({ manage, flatten }), busyRef, setPendingMove: () => {}, say });
    return { busyRef, manage, flatten, say, close };
  };
  const pending = { pending: { price: 24_990 } };

  it('běží příkaz z čáry (zámek obsazený) → Zrušit nic neodešle, jen text', async () => {
    const { manage, say, close, busyRef } = setup(true);
    const result = await close(pending);
    expect(manage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'cancel', outcome: { called: false, status: 'not-sent' } });
    expect(say).toHaveBeenCalledWith('Čeká se na výsledek předchozí změny — nic se neodeslalo.');
    expect(busyRef.current).toBe(true);
  });

  it('volný zámek → jediné cancel-entry s cenou, kterou uživatel viděl; zámek drží po dobu letu', async () => {
    const { manage, close, busyRef } = setup(false);
    let lockedDuring = false;
    manage.mockImplementation(async () => { lockedDuring = busyRef.current; return ack; });
    await close(pending);
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith('cancel-entry', 24_990, undefined);
    expect(lockedDuring).toBe(true);
    expect(busyRef.current).toBe(false);
  });

  it('opačné pořadí: Zrušit letí → × / BE z čáry se stejným zámkem neodejde', async () => {
    const { manage, close, busyRef } = setup(false);
    let release!: () => void;
    manage.mockImplementation(() => new Promise(resolve => { release = () => resolve(ack); }));
    const lineManage = vi.fn(async () => ack);
    const lineRun = createLiveManageRun({ manage: () => lineManage, busyRef, setPendingMove: () => {}, report: () => {} });
    const inFlight = close(pending);
    const line = await lineRun('move-stop', 24_980, 25_000, 'stopLoss');
    expect(line).toMatchObject({ called: false, status: 'not-sent' });
    expect(lineManage).not.toHaveBeenCalled();
    release();
    await inFlight;
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it('Flatten (pozice) zámek ani busy neblokuje; výjimka zrušení = neznámé, nic se neopakuje', async () => {
    const busy = setup(true);
    expect(await busy.close({ pending: null })).toEqual({ kind: 'flatten' });
    expect(busy.flatten).toHaveBeenCalledTimes(1);
    expect(busy.manage).not.toHaveBeenCalled();
    const thrown = setup(false);
    thrown.manage.mockImplementation(async () => { throw new Error('relay timeout'); });
    const result = await thrown.close(pending);
    expect(result).toMatchObject({ kind: 'cancel', outcome: { called: true, status: 'unknown' } });
    expect(thrown.manage).toHaveBeenCalledTimes(1);
    expect(thrown.say.mock.calls.at(-1)?.[0]).toMatch(/Výsledek neznámý/);
    // Čekající vstup bez ceny = záložní Flatten (jako dřív).
    const noPrice = setup(false);
    expect(await noPrice.close({ pending: { price: null } })).toEqual({ kind: 'flatten' });
    expect(noPrice.manage).not.toHaveBeenCalled();
  });

  it('zdroj: lišta volá jen barClose se sdíleným lineState.busyRef; žádné přímé trade.manage v grafu', () => {
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/onClose=\{\(\) => \{ void barClose\(position\); \}\}/);
    const factory = between(phone, 'const barClose = useMemo(() => createLivePhoneBarClose({', '}), [lineState.busyRef, lineState.setPendingMove]);');
    expect(factory).toMatch(/busyRef: lineState\.busyRef,/);
    expect(phone).not.toMatch(/trade\??\.manage\(/);
  });
});

// ---------------------------------------------------------------------------
// P3: „Posunout“ ukazuje cenu, která odejde; změna průměru těsně před klikem = nic

describe('P3: Správa na PC — cena záměru na tlačítku a jen viděná cena odejde', () => {
  const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
    kind: 'position', side: 'long', quantity: 1, entry: 25_000, entryType: 'Market', openPnl: 20, mark: 25_010,
    stop: 24_990, target: 25_012, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
    leader: { accountId: 11, quantity: 1, entry: 25_000 }, rows: [], ...patch,
  });
  /** TP zadaný „+15 b od průměru“ → absolutní cena záměru při daném průměru. */
  const tpIntent = (entryAvg: number) => {
    const converted = managePriceFromInput({ side: 'long', leg: 'takeProfit', units: 'pts', value: 15, entryAvg, quantity: 1, pointValue: 2, tick: 0.25 });
    if ('blocked' in converted) throw new Error(converted.blocked);
    const plan = planManageMove(summary(), 'takeProfit', converted.price);
    if (!('intent' in plan)) throw new Error(plan.reason);
    return plan.intent.newPrice;
  };

  it('cena musí na tlačítku viset aspoň 350 ms: 349 ms ne, 350 ms ano', () => {
    const shown = liveManageShownPrice(null, 25_015, 1_000);
    expect(liveManageSeenPriceProblem(shown, 25_015, 1_000 + LIVE_MANAGE_SEEN_MIN_MS - 1)).toMatch(/Nic se neodeslalo/);
    expect(liveManageSeenPriceProblem(shown, 25_015, 1_000 + LIVE_MANAGE_SEEN_MIN_MS)).toBeNull();
    // Stejná cena při dalším vykreslení `since` neposune.
    expect(liveManageShownPrice(shown, 25_015, 5_000)).toBe(shown);
    expect(liveManageShownPrice(shown, null, 5_000)).toBeNull();
    expect(liveManageSeenPriceProblem(null, 25_015, 9_000)).toMatch(/Nic se neodeslalo/);
  });

  it('průměr se změní pollem (přikoupení) mezi zadáním a klikem → nová cena, klik těsně po změně nic, pak ano', () => {
    const before = tpIntent(25_000);
    expect(before).toBe(25_015);
    let shown: LiveManageShownPrice | null = liveManageShownPrice(null, before, 1_000);
    // Poll přinese nový průměr: tlačítko se překreslí na novou cenu.
    const after = tpIntent(25_002.5);
    expect(after).toBe(25_017.5);
    shown = liveManageShownPrice(shown, after, 3_000);
    expect(shown).toEqual({ price: 25_017.5, since: 3_000 });
    // Klik 100 ms po změně: odeslala by se cena, kterou uživatel neviděl → nic.
    expect(liveManageSeenPriceProblem(shown, after, 3_100)).toMatch(/změnila na 25017\.50/);
    // Klik s cenou z doby před změnou (zastaralé „co jsem viděl“) se nikdy nepotvrdí.
    expect(liveManageSeenPriceProblem(shown, before, 9_000)).not.toBeNull();
    expect(liveManageSeenPriceProblem(shown, after, 3_400)).toBeNull();
  });

  it('zdroj: tlačítko „Posunout → cena“; klik kontroluje viděnou cenu před jediným runner.request', () => {
    expect(ticket).toMatch(/const moveLabel = \(plan: LiveManagePlan\) => \('intent' in plan \? `Posunout → \$\{formatPrice\(plan\.intent\.newPrice\)\}` : 'Posunout'\);/);
    const move = between(ticket, 'const moveLeg = ', 'const runBreakEven = ');
    const check = move.indexOf('liveManageSeenPriceProblem(moveShownRef.current[leg], plan.intent.newPrice, at)');
    expect(check).toBeGreaterThan(0);
    expect(move.slice(check)).toMatch(/if \(unseen\) \{[^\n]*return; \}\s*requestManage\(plan\.intent/);
    const effect = between(ticket, 'useEffect(() => {\n    const at = Date.now();\n    moveShownRef.current = {', '}, [shownStopPrice, shownTargetPrice]);');
    expect(effect).toMatch(/liveManageShownPrice\(moveShownRef\.current\.stopLoss, shownStopPrice, at\)/);
    expect(effect).toMatch(/liveManageShownPrice\(moveShownRef\.current\.takeProfit, shownTargetPrice, at\)/);
    expect(ticket).toMatch(/stopLoss: manageButton\(movePlans\.stopLoss, moveLabel\(movePlans\.stopLoss\)\),/);
    expect(ticket).toMatch(/takeProfit: manageButton\(movePlans\.takeProfit, moveLabel\(movePlans\.takeProfit\)\),/);
  });
});

// ---------------------------------------------------------------------------
// P3: dialog Flatten otevřený zkratkou — fokus na Zrušit

describe('P3: Flatten All ze zkratky má fokus na Zrušit (INV-UI-02)', () => {
  const dialog = (initialFocus?: 'confirm' | 'cancel') => renderToStaticMarkup(React.createElement(ConfirmActionDialog, {
    title: 'Flatten All?', message: 'Zavřít pozice?', confirmLabel: 'Flatten All', tone: 'danger', onResolve: () => {},
    ...(initialFocus ? { initialFocus } : {}),
  }));
  const buttons = (markup: string) => markup.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];

  it('zkratka (Shift+F i akce notifikace) = Zrušit; tlačítko lišty = beze změny (potvrzení)', () => {
    expect(liveSafetyDialogInitialFocus('hotkey')).toBe('cancel');
    expect(liveSafetyDialogInitialFocus('native-intent')).toBe('cancel');
    expect(liveSafetyDialogInitialFocus(undefined)).toBe('confirm');
    expect(liveSafetyDialogInitialFocus(null)).toBe('confirm');
  });

  it('vykreslený dialog: autofocus jen na Zrušit; výchozí dialog (ARM, kill…) beze změny', () => {
    const [cancel, confirm] = buttons(dialog('cancel'));
    expect(cancel).toMatch(/autofocus=""[^>]*>Zrušit</);
    expect(confirm).not.toMatch(/autofocus/);
    const [cancelDefault, confirmDefault] = buttons(dialog());
    expect(cancelDefault).not.toMatch(/autofocus/);
    expect(confirmDefault).toMatch(/autofocus=""[^>]*>Flatten All</);
  });

  it('posluchač zkratky předá zdroj; lišta z něj volí fokus dialogu', () => {
    const target = { id: 'g', name: 'Test', accountIds: [1], observedAt: 1_000, verified: true };
    const bus = createLiveSafetyShortcutBus();
    const open = vi.fn();
    bus.subscribe(liveSafetyShortcutListener({
      view: () => ({ target, confirmationOpen: false, pending: [], flattenPending: false }), open, ignored: vi.fn(), now: () => 2_000,
    }));
    bus.request('flatten-group', 'hotkey', 2_000);
    expect(open).toHaveBeenCalledWith({ action: 'flatten-group', target, source: 'hotkey' });
    const controls = source('components/LiveSafetyControls.tsx');
    expect(controls).toMatch(/initialFocus=\{liveSafetyDialogInitialFocus\(confirmation\.source\)\}/);
    // Tlačítko lišty dál otevírá bez zdroje (fokus na potvrzení jako dosud).
    expect(controls).toMatch(/onClick=\{\(\) => setConfirmation\(\{ action, target \}\)\}/);
  });
});

// ---------------------------------------------------------------------------
// Kontrolní seznam 25: klávesy v poli / dialogu, hranice 349/350 ms, cesta až k manage

describe('kontrolní seznam 25: Shift+X přes celou cestu až k jedinému close-position', () => {
  const summary = {
    kind: 'position', side: 'long', quantity: 1, entry: 21_000, entryType: 'Market', stop: 20_990, target: 21_020,
    mark: 21_005, openPnl: 10, accounts: 1, scopeLabel: null, leader: { accountId: 1, entry: 21_000, quantity: 1 }, rows: [],
  } as unknown as LiveChartPositionSummary;
  const lines = livePositionChartLines(summary, { manageable: true, canClose: true, entryAvg: 21_000, pointValue: 2 });
  const shiftX = (target: unknown = null) => ({ key: 'X', code: 'KeyX', shiftKey: true, target });

  /** Obsluha jako `hotkeyHandlerRef` obrazovky; × čáry → runner jako `onOrderLineCancel`. */
  const screen = (dialogDoc: { querySelectorAll: (s: string) => ArrayLike<unknown> } | null) => {
    const manage = vi.fn(async () => ({ type: 'leader-order-managed', status: 'acknowledged', blockers: [] }) as unknown as LeaderOrderManageResult);
    const run = createLiveManageRun({ manage: () => manage, busyRef: { current: false }, setPendingMove: () => {}, report: () => {} });
    const guard = createTwoStepGuard();
    const press = (at: number, target: unknown = null) => {
      const intent = liveHotkeyAction(shiftX(target), { dialogOpen: liveHotkeyOverlayOpen(dialogDoc), leaving: false, hidden: false });
      if (!intent) return;
      dispatchLiveHotkeyOutcome(resolveLiveHotkey(intent, { lines, breakEven: null, hasDraft: false, busy: false }, guard, at), {
        prefill: vi.fn(), discard: vi.fn(), breakEven: vi.fn(), notice: vi.fn(), openFlatten: vi.fn(() => true), toggleHelp: vi.fn(),
        cancelLine: line => { if (line.kind === 'entry' && summary.kind === 'position') void run('close-position', summary.stop); },
      });
    };
    return { manage, press };
  };
  const noDialog = { querySelectorAll: () => [] };
  const openDialog = { querySelectorAll: () => [{ getClientRects: () => ({ length: 1 }) }] };

  it('349 ms nic, 350 ms právě jedno close-position s expect = SL leadera', () => {
    const { manage, press } = screen(noDialog);
    press(1_000);
    press(1_349);
    expect(manage).not.toHaveBeenCalled();
    // Kotva se posunula na 1 349 ms a pak na 1 350 ms: potvrdí až stisk ≥ 350 ms po posledním.
    press(1_350);
    expect(manage).not.toHaveBeenCalled();
    press(1_699);
    expect(manage).not.toHaveBeenCalled();
    press(2_049);
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith('close-position', 20_990, undefined);
  });

  it('fokus v poli panelu nebo otevřený dialog (Flatten / OFF) = nic ani dvojím stiskem', () => {
    const input = screen(noDialog);
    input.press(1_000, { tagName: 'INPUT' });
    input.press(1_500, { tagName: 'INPUT' });
    expect(input.manage).not.toHaveBeenCalled();
    const dialog = screen(openDialog);
    dialog.press(1_000);
    dialog.press(1_500);
    expect(dialog.manage).not.toHaveBeenCalled();
    // Neznámý stav dokumentu = jako dialog.
    const unknown = screen(null);
    unknown.press(1_000);
    unknown.press(1_500);
    expect(unknown.manage).not.toHaveBeenCalled();
  });

  it('zdroj: × pozice na obrazovce = runLiveManage(close-position, SL leadera)', () => {
    const screenSource = source('components/LiveTradingScreen.tsx');
    expect(screenSource).toMatch(/if \(line\.kind === 'entry' && summary\?\.kind === 'position'\) void runLiveManage\('close-position', summary\.stop \?\? entryScaleIn\?\.stopLoss\);/);
  });
});

// ---------------------------------------------------------------------------
// Kontrolní seznam 25: „Přidat SL/TP“ z PC bez čerstvého stavu

describe('kontrolní seznam 25: attach z PC bez čerstvého stavu = „Neodesláno“, jde opravit', () => {
  it('chyba desku „není čerstvě ověřený — nic se neodeslalo“ = Neodesláno (ne neznámé)', () => {
    const notice = attachErrorNotice(new Error('Stav kopírky není čerstvě ověřený — nic se neodeslalo.'), 1_000);
    expect(notice.tone).toBe('bad');
    expect(notice.text).toMatch(/^Neodesláno: /);
    // Výjimka po odeslání (timeout relaye) = neznámé, nic neopakovat.
    const unknown = attachErrorNotice(new Error('relay timeout'), 1_000);
    expect(unknown.tone).toBe('warn');
    expect(unknown.text).toMatch(/Nic neopakuj\./);
  });

  it('zdroj: desk kontroluje čerstvý stav PŘED relayem; panel konečnost odvozuje z tónu', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    const attach = between(desk, 'const attachBrackets = useCallback(', '}, []);');
    const fresh = attach.indexOf('if (!armStatusRef.current.fresh');
    const relay = attach.indexOf('executeTradovateCopierRelayCommand(');
    expect(fresh).toBeGreaterThan(0);
    expect(relay).toBeGreaterThan(fresh);
    expect(attach.slice(fresh, relay)).toMatch(/throw new Error\('Stav kopírky není čerstvě ověřený — nic se neodeslalo\.'\);/);
    expect(ticket).toMatch(/const notice = attachErrorNotice\(reason, Date\.now\(\)\);\s*setAttachNotice\(\{ entryOperationId: operationId, notice, final: notice\.tone !== 'bad' \}\);/);
  });
});

// ---------------------------------------------------------------------------
// Kolo 3: potvrzení se zahodí i bez kliku; Správa pouští fokus
// ---------------------------------------------------------------------------

describe('kolo 3: rozběhnuté „Opravdu?“ nepřežije blokaci ani změnu klíče', () => {
  const ticket = source('components/LiveOrderTicket.tsx');

  it('holý Market: blokace i změna klíče (qty 1→2→1) potvrzení vynulují bez kliku', () => {
    expect(ticket).toMatch(/useEffect\(\(\) => \{ bareConfirmRef\.current = null; setBareConfirm\(null\); \}, \[bareKey\]\);/);
    expect(ticket).toMatch(/useEffect\(\(\) => \{ if \(directBlocked != null\) \{ bareConfirmRef\.current = null; setBareConfirm\(null\); \} \}, \[directBlocked\]\);/);
    expect(ticket).toMatch(/if \(directBlocked != null\) \{ setBareConfirmState\(null\); return; \}/);
  });

  it('Náhled: nečerstvý/zablokovaný náhled nebo jiný návrh potvrzení vynuluje', () => {
    expect(ticket).toMatch(/useEffect\(\(\) => \{ if \(!canSend\) \{ placeConfirmRef\.current = null; setPlaceConfirm\(null\); \} \}, \[canSend\]\);/);
    expect(ticket).toMatch(/useEffect\(\(\) => \{ placeConfirmRef\.current = null; setPlaceConfirm\(null\); \}, \[key\]\);/);
  });

  it('tlačítka Správy (Posunout, BE, BE+n, BE + poplatky) po kliku pouští fokus', () => {
    const manage = ticket.slice(ticket.indexOf('const action = (view: ManageButtonView'));
    expect(manage.slice(0, 400)).toMatch(/onClick=\{event => \{ event\.currentTarget\.blur\(\); onClick\(\); \}\}/);
  });
});
