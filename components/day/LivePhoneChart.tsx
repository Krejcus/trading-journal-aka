import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionConfig, Trade } from '../../types';
import DayFullscreenChart from './DayFullscreenChart';
import { useDayController } from './useDayController';
import { focusRange } from './dayFocus';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import { rememberPhoneChartView } from '../../lib/chartView';
import { CHART_PROFILE_APPLIED_EVENT } from '../../services/chartProfile';
import type { MarketTimeframe } from '../../services/marketData';
import { LIVE_PHONE_INSTRUMENT, draftSummary, readLivePillPrefs, writeLivePillPrefs, type LivePillPrefs } from '../../lib/livePhoneTrade';
import { draftFromPositionBox, type TicketDraft } from '../../lib/liveOrderTicket';
import { LiveChartNotice, LiveFillAnnounceSetting, LiveQtySheet, LiveTradePill, LiveTradeToggle } from './LivePhoneTrade';
import LivePhoneOrderSheet, { livePhoneSheetPayload } from './LivePhoneOrderSheet';
import LivePhoneDraftBar from './LivePhoneDraftBar';
import LivePhoneManageSheet from './LivePhoneManageSheet';
import LivePhoneReplayLiveChip from './LivePhoneReplayLiveChip';
import { LivePhoneAttachSheet, LivePhoneCancelPendingChip, LivePhonePositionBar, livePhonePositionBarShown, createLivePhoneBarClose, useLivePhoneBarGuard } from './LivePhoneLiveActions';
import { LIVE_ACTION_CHANGED_TEXT } from '../../lib/liveClickGate';
import { LIVE_COMMAND_BUSY_TEXT, createLiveBareCloseRun } from '../../hooks/liveCommandRuns';
import { useLiveTicketQuote } from '../../hooks/useLiveTicketQuote';
import { useLiveFillAnnounceMode, useLiveFillAnnouncer } from '../../hooks/useLiveFillAnnouncer';
import { useLivePositionBoxFollow } from '../../hooks/useLivePositionBoxFollow';
import LiveChartAutomationSettings, { LiveBoxFollowPane } from '../LiveChartAutomationSettings';
import { previewSymbolFromChartSource } from '../../lib/leaderEntryPreview';
import { useLiveNoPriceNotice, useLiveResumeState } from '../../hooks/useLiveResumeState';
import { LIVE_ATTACH_SENT_HOLD_MS, LIVE_BARE_QUOTE_MAX_AGE_MS, liveAttachDefaults, liveAttachIntent, liveQuoteStaleText } from '../../lib/liveBareEntry';
import type { LiveAttachLegs } from '../../lib/liveOrderTicket';
import { snapToTick } from '../../lib/liveOrderTicket';
import {
  livePhoneBareMarket, livePhonePillScaleIn, livePhoneCancelPendingChipShown, livePhoneOperationId, livePhonePlacedText, livePhoneScaleInBlocked, livePhoneScaleInDraft,
  type LivePhoneQuote, type LivePhoneTradeBridge,
} from '../../lib/livePhoneOrders';
import type { LiveEntryPreviewDraft } from '../../lib/leaderEntryPreview';
import type { LiveWorkingOrdersView } from '../../lib/liveWorkingOrderLines';
import { LivePhoneAccountsSheet, LivePhoneGroupPnl } from './LivePhoneAccounts';
import { liveDisplayOpenPnl, liveShownOpenPnl, withIbkrTightenMark, type LiveChartPosition } from '../../lib/liveChartPosition';
import LiveTradeToasts from '../LiveTradeToasts';
import type { TradeToast } from '../../lib/liveTradeToasts';
import {
  LivePhoneOrderLines, LivePhoneWorkingBadges, livePhoneDraftAfterAddBracket, livePhoneDraftAfterDrag, livePhoneDraftAfterRemove, livePhoneDraftLines,
  livePhoneMarketDraftFollow, livePhoneWorkingView, useLivePhoneLineState,
} from './LivePhoneOrderLines';
import { LivePhoneAlertLines, LivePhoneAlertList, LivePhoneAlertSheet, LivePhoneAlertsButton, LivePhoneCrosshairPlus, LivePhonePlusSheet } from './LivePhoneAlerts';
import { alertTitle, movedAlert, newPriceAlert, priceAlertEventTitle, type PriceAlert } from '../../lib/priceAlerts';
import { PRICE_ALERT_REARM_EVENT, useFreshPriceAlertEvents, usePriceAlertStore } from '../../services/priceAlertStoreHook';
import { isNativeBuild } from '../../utils/runtimeConfig';
import { alertVoiceText, speakAlertText } from '../../services/alertVoice';
import { playAlertTone } from '../../services/priceAlertSounds';
import { ALERT_FIRE_MS } from '../../lib/alertFireEffect';
import { useLiveFillArrows } from './useLiveFillArrows';
import { liveFillsNotInJournal } from '../../lib/liveFillMarkers';
import type { LiveFillMarker } from '../../lib/liveFillMarkers';
import { limitIsMarketable, newTicketDraft, stopIsTriggered, type TicketQuote } from '../../lib/liveOrderTicket';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { MarketCandle } from '../../services/marketData';
import { perfDuration } from '../../lib/perfTrace';
import { markLiveCommandPaint, type LiveCommandTraceStage, type LiveCommandWorkerTiming } from '../../lib/liveCommandPerformance';
import './dayJournal.css';

/** Dotyk mladší než tohle po otevření menu plusu se ignoruje (stejná hranice jako druhý klik čar). */
const LIVE_PLUS_GHOST_TAP_MS = 350;

export interface LivePhoneChartSlots {
  /** LIVE hlavička nad grafem (LIVE ▾, skupina, stav kopírky); `group` = P&L skupiny místo názvu. */
  header: (group?: React.ReactNode) => React.ReactNode;
  /** Vrstvy LIVE nad grafem (menu záložek). */
  overlay?: React.ReactNode;
  /** Obchodování z telefonu (2. 11. 2026): stejný relay jako PC; null = jen zobrazení. */
  trade?: LivePhoneTradeBridge | null;
  /** Živá pozice a účty skupiny — stejný read model jako PC graf, jen zobrazení. */
  position: LiveChartPosition;
  /** Události kopírky z workeru → karty vlevo dole jako na PC (`LiveTradeToasts`). */
  copyEvents?: React.ComponentProps<typeof LiveTradeToasts>['events'];
  /** Kopírka čerstvě zapnutá (ne shadow) — tečky kopií na kartách. */
  copierArmed?: boolean;
  /** Plnění živého obchodu → šipky hned po vyplnění (napojí datová vrstva). */
  fills?: readonly LiveFillMarker[];
  /** Obchod plnění je otevřený (šipky bez výstupu). */
  fillsOpen?: boolean;
  /** Kontrakt plnění (`MNQZ6`) — šipky jen nad stejným kontraktem grafu. */
  fillsSymbol?: string;
  /** Kdo hlídá upozornění (text do seznamu); null = zatím nikdo. */
  alertWatch?: string | null;
  /** Spuštěná upozornění od datové vrstvy → bliknutí čáry a karta. */
  alertEvents?: readonly { id: string; alertId: string; at: number; price: number }[];
  /**
   * U5 (3. 11. 2026): pracující příkazy leadera jen jako čáry pro zobrazení (ověřené čtení
   * příkazů, `LiveChartWorkingOrders` desku). Nikdy nejdou do `trade` ani do správy.
   */
  workingOrders?: (LiveWorkingOrdersView & { contract: string | null }) | null;
  /** U8: klíč knihovny šablon SL/TP na zařízení (nic neautorizuje); null = nepřihlášeno. */
  userId?: string | null;
  /** F2a E2E diagnostika: stejný první paint jako desktop, jen lokální měření. */
  liveExposurePaint?: {
    id: string;
    receivedPerformanceAt: number;
    operationId?: string;
    stage?: LiveCommandTraceStage;
    workerTiming?: LiveCommandWorkerTiming;
  } | null;
}

const NO_FILLS: readonly LiveFillMarker[] = [];
/** Nejvýš tolik karet upozornění najednou, ať nevytlačí kartu rizika. */
const ALERT_CARDS_MAX = 2;
/** Přehrávání ukazuje historii: z lišty, plusu, listu ani lišty návrhu se nic neodešle (N1, U3). */
const REPLAY_NO_TRADE = 'Přehrávání — obchoduj v živém grafu. Nic se neodeslalo.';
/** Lišta pozice nahoře zabírá ~52 px; štítky pod ní. */
const BELOW_POSITION_BAR = 56;
/** Místo pro „Zrušit čekající“ nad odznaky pracujících příkazů (C7). */
const CANCEL_PENDING_CHIP_SPACE = 38;

/**
 * Návrh objednávky: list (`sheet`), nebo stažený do lišty návrhu s čarami v grafu (`chart`, U2).
 * `template` = nový návrh z „+“ (výchozí šablona SL/TP), position box a návrat z lišty ne.
 */
interface PhoneOrder { key: number; draft: TicketDraft; mode: 'sheet' | 'chart'; template: boolean }

/** Šipky plnění (hook uvnitř vrstvy grafu, kde je API panelu). */
function LiveFillArrows(props: { api: ChartViewApi | null; fills: readonly LiveFillMarker[]; open: boolean; candles: readonly MarketCandle[]; intervalSeconds: number; enabled: boolean; isDark: boolean }) {
  useLiveFillArrows(props);
  return null;
}

/** Market jen s cenou kanálu mladší než tohle (worker ji ověří znovu proti IBKR). */
const PHONE_MARKET_QUOTE_MAX_AGE_MS = LIVE_BARE_QUOTE_MAX_AGE_MS;

/**
 * LIVE → Graf na telefonu: graf dneška z deníku (stejné svíčky, kreslení,
 * kolečko intervalů) v LIVE režimu — nativní lišta zůstává a graf se
 * nezavírá. Jen zobrazení; obchodní cesty se napojí zvlášť.
 */
export default function LivePhoneChart({ trades, allTrades, sessions, isDark, onUpdateTrade, slots, onLeave }: {
  trades: readonly Trade[];
  allTrades: readonly Trade[];
  sessions: readonly SessionConfig[];
  isDark: boolean;
  onUpdateTrade: (id: string | number, updates: Partial<Trade>) => unknown;
  slots: LivePhoneChartSlots;
  /** Escape / systémové zpět: přejde na Live Dashboard. */
  onLeave: () => void;
}) {
  const ctl = useDayController({ trades, allTrades, sessions, onUpdateTrade });
  const measuredExposureIds = useRef(new Set<string>());
  const exposurePaintFrames = useRef(new Set<number>());
  useEffect(() => () => {
    for (const frame of exposurePaintFrames.current) window.cancelAnimationFrame(frame);
    exposurePaintFrames.current.clear();
    measuredExposureIds.current.clear();
  }, []);
  useEffect(() => {
    const paint = slots.liveExposurePaint;
    if (!paint || measuredExposureIds.current.has(paint.id)) return;
    measuredExposureIds.current.add(paint.id);
    const firstFrame = window.requestAnimationFrame(() => {
      exposurePaintFrames.current.delete(firstFrame);
      const secondFrame = window.requestAnimationFrame(() => {
        exposurePaintFrames.current.delete(secondFrame);
        measuredExposureIds.current.delete(paint.id);
        perfDuration('live:exposure:to-paint', performance.now() - paint.receivedPerformanceAt);
        if (paint.operationId && paint.stage) {
          markLiveCommandPaint({
            operationId: paint.operationId,
            stage: paint.stage,
            receivedPerformanceAt: paint.receivedPerformanceAt,
            workerTiming: paint.workerTiming,
          });
        }
      });
      exposurePaintFrames.current.add(secondFrame);
    });
    exposurePaintFrames.current.add(firstFrame);
  }, [slots.liveExposurePaint]);
  const [timeframe, setTimeframeState] = useState<MarketTimeframe>(() => readStoredDayChartTimeframe(typeof window === 'undefined' ? null : window.localStorage));
  const setTimeframe = (next: MarketTimeframe) => { setTimeframeState(next); writeStoredDayChartTimeframe(window.localStorage, next); rememberPhoneChartView(); };
  // Převzetí z jiného zařízení.
  useEffect(() => {
    const reload = () => setTimeframeState(readStoredDayChartTimeframe(window.localStorage));
    window.addEventListener(CHART_PROFILE_APPLIED_EVENT, reload);
    return () => window.removeEventListener(CHART_PROFILE_APPLIED_EVENT, reload);
  }, []);
  const range = focusRange({ mode: 'day', session: 'ny', scope: ctl.scope, windows: ctl.chartWindows, now: ctl.now, isToday: ctl.isToday });
  const [pill, setPill] = useState<LivePillPrefs>(() => readLivePillPrefs(typeof window === 'undefined' ? null : window.localStorage));
  const savePill = (next: LivePillPrefs) => { setPill(next); writeLivePillPrefs(window.localStorage, next); };
  const [qtySheet, setQtySheet] = useState(false);
  const [notice, setNotice] = useState<{ key: number; text: string } | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const trade = slots.trade ?? null;
  // Živá cena jako panel na PC: kanál ceny grafu, kontrakt jen ze zdroje IBKR (INV-UI-04).
  const candleClose = ctl.chart.candles.at(-1)?.close ?? null;
  const tick = useLiveTicketQuote(ctl.chart.liveFeed, 'MNQ', candleClose);
  // Po návratu z pozadí je na obrazovce starý stav: musí to být vidět, dokud nepřijde živá cena.
  const resuming = useLiveResumeState(tick != null || ctl.chart.liveStatus === 'live', tick?.at ?? null);
  const noPriceNotice = useLiveNoPriceNotice(true, tick?.at ?? null, resuming);
  const contract = previewSymbolFromChartSource(ctl.chart.liveSource);
  const quote = useMemo<LivePhoneQuote | null>(() => {
    if (!tick || ctl.chart.liveStatus !== 'live') return null;
    const bid = snapToTick(tick.price, LIVE_PHONE_INSTRUMENT.tickSize);
    return { symbol: contract, bid, ask: bid + LIVE_PHONE_INSTRUMENT.tickSize, at: tick.at };
  }, [tick, contract, ctl.chart.liveStatus]);
  // Jeden příkaz naráz (zámek přes ref — dvojklep nepošle druhý; nový operationId jen za nový pokus).
  // Zámek je JEDEN pro celý graf i desk (oponentura UI C7/C8 kolo 1): vstup, attach, × / BE / posun
  // z čar, list správy, Zavřít holé pozice i „Zrušit čekající“; s deskem (`trade.commandLockRef`)
  // ho sdílí i Dashboard „Zrušit“. Flatten jím nikdy neprochází (INV-UI-02).
  const ownLineState = useLivePhoneLineState();
  const lineState = trade?.commandLockRef ? { ...ownLineState, busyRef: trade.commandLockRef } : ownLineState;
  const busyRef = lineState.busyRef;
  const [busy, setBusy] = useState(false);
  const say = (text: string) => setNotice({ key: Date.now(), text });
  const send = async (draft: LiveEntryPreviewDraft | { error: string }) => {
    if ('error' in draft) { say(draft.error); return; }
    if (!trade) return;
    if (busyRef.current) { say(LIVE_COMMAND_BUSY_TEXT); return; }
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await trade.place(draft, livePhoneOperationId());
      say(livePhonePlacedText(result));
    } catch (error) {
      say(`Neodesláno / neznámé: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'} — nic neopakuj, zkontroluj pozici.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const sendBlocked = (market: boolean): string | null => (
    !trade ? 'Odesílání z telefonu tu není dostupné.'
      : trade.blockedReason ?? (resuming ? 'Čekám na živou cenu — nic se neodeslalo.' : market && !trade.marketSupported ? 'Worker zatím neumí Market.'
        : !quote || Date.now() - quote.at > PHONE_MARKET_QUOTE_MAX_AGE_MS ? liveQuoteStaleText(quote?.at ?? null, Date.now())
          : !(quote.symbol ?? (market ? null : trade.frontContract)) ? 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.' : null)
  );
  // Lišta: Koupit / Prodat = holý Market hned (Filip 1. 11.), SL/TP se doplní z čáry; v pozici přikoupení.
  // Přehrávání: graf ukazuje historii — živý Market z lišty nikdy (N1, 3. 11.; lišta je navíc schovaná).
  const onSide = (side: 'buy' | 'sell', replay: boolean) => {
    if (replay) { say(REPLAY_NO_TRADE); return; }
    const scaleIn = trade?.scaleIn ?? null;
    const blocked = sendBlocked(true) ?? (scaleIn ? null : !trade!.bareSupported ? 'Worker zatím neumí Market bez SL/TP.'
      : pill.qty > trade!.maxContracts ? `Strop ručního vstupu je ${trade!.maxContracts} kontraktů.` : null);
    if (blocked) { say(blocked); return; }
    // V pozici jde lišta jako přikoupení se SL/TP pozice (holý Market by worker v pozici zastavil).
    void send(scaleIn ? livePhonePillScaleIn(side, pill.qty, quote!, scaleIn, trade!.maxContracts) : livePhoneBareMarket(side, pill.qty, quote!));
  };
  const [attachOpen, setAttachOpen] = useState(false);
  const position = trade?.position ?? null;
  const marketNow = quote ? (position?.side === 'short' ? quote.ask : quote.bid) : null;
  // Nohy holé pozice vytažené ze štítků „+ SL“ / „+ TP“ na čáře; odcházejí až tlačítkem na čáře.
  const [chipLegs, setChipLegs] = useState<LiveAttachLegs | null>(null);
  const bareOperationId = position?.bareEntryOperationId ?? null;
  const shownChipLegs = chipLegs && chipLegs.entryOperationId === bareOperationId ? chipLegs : null;
  const [chipSentFor, setChipSentFor] = useState<string | null>(null);
  const chipSent = chipSentFor != null && chipSentFor === bareOperationId;
  useEffect(() => {
    if (!chipSentFor) return undefined;
    const timer = window.setTimeout(() => setChipSentFor(null), LIVE_ATTACH_SENT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [chipSentFor]);
  const sendAttach = (stopLoss: number, takeProfit: number) => {
    if (!trade || !position || !position.bareEntryOperationId) return;
    const operationId = position.bareEntryOperationId;
    if (chipSent) { say('SL a TP už odešly — výsledek ověř na pozici, nic neopakuj.'); return; }
    if (busyRef.current) { say(LIVE_COMMAND_BUSY_TEXT); return; }
    // Stejná brána jako PC: čerstvá cena téhož kontraktu, pozice = holý vstup, ≥ 8 ticků (rozhoduje worker).
    const intent = liveAttachIntent({
      bareEntry: { operationId, symbol: position.symbol, side: position.side === 'long' ? 'Buy' : 'Sell', quantity: position.quantity },
      position, quote, stopLoss, takeProfit, tickSize: LIVE_PHONE_INSTRUMENT.tickSize, now: Date.now(),
    });
    if ('error' in intent) { say(intent.error); return; }
    busyRef.current = true;
    setBusy(true);
    const sent = () => { setChipSentFor(operationId); setChipLegs(null); };
    void trade.attach(intent.attach)
      .then(result => {
        say(result.status === 'acknowledged' ? result.reason ?? 'SL a TP přijaty brokerem.'
          : result.status === 'blocked' ? `Neodesláno: ${result.blockers[0]?.text ?? ''}` : result.reason ?? 'Výsledek neznámý — zkontroluj pozici.');
        if (result.status === 'acknowledged' || result.status === 'unknown') sent();
      })
      .catch(() => { sent(); say('Výsledek SL/TP je neznámý — zkontroluj pozici, nic neopakuj.'); })
      .finally(() => { busyRef.current = false; setBusy(false); });
  };
  const attachChipBridge = trade && position && bareOperationId && !chipSent ? {
    legs: shownChipLegs,
    side: position.side,
    quantity: position.quantity,
    reference: trade.entryAvg ?? null,
    onLeg: (kind: 'stopLoss' | 'takeProfit', price: number | null | undefined) => {
      const at = price === null ? null : price !== undefined ? price
        : marketNow != null && quote != null && Date.now() - quote.at <= LIVE_BARE_QUOTE_MAX_AGE_MS ? liveAttachDefaults(position.side, marketNow, LIVE_PHONE_INSTRUMENT.tickSize)[kind] : undefined;
      if (at === undefined) { say('Cena není čerstvá — nohu teď nejde připravit.'); return; }
      setChipLegs(previous => {
        const base = previous && previous.entryOperationId === bareOperationId ? previous : { entryOperationId: bareOperationId, stopLoss: null, takeProfit: null };
        return kind === 'stopLoss' ? { ...base, stopLoss: at } : { ...base, takeProfit: at };
      });
    },
    onSend: () => {
      if (shownChipLegs?.stopLoss != null && shownChipLegs.takeProfit != null) sendAttach(shownChipLegs.stopLoss, shownChipLegs.takeProfit);
    },
  } : null;
  // Objednávka z position toolu: návrh jako ⚡ na PC (draftFromPositionBox), velikost v kontraktech.
  const [order, setOrder] = useState<PhoneOrder | null>(null);
  const openOrder = (draft: TicketDraft, template: boolean) => setOrder({ key: Date.now(), draft, mode: 'sheet', template });
  // Návrh v grafu (U2): tah čar mění jen návrh tady — k brokerovi jde až tlačítkem lišty/listu.
  const editDraft = (update: (draft: TicketDraft) => TicketDraft | null) => setOrder(current => {
    if (!current || current.mode !== 'chart') return current;
    const next = update(current.draft);
    return next ? { ...current, draft: next } : null;
  });
  const chartDraft = order?.mode === 'chart' ? order.draft : null;
  const quoteOf = (lastPrice: number) => ({ bid: lastPrice, ask: lastPrice });
  // Pozice v grafu: čáry vstupu a SL/TP z read modelu (jen zobrazení, neověřené = žádné čáry).
  // Pozici kreslí štítky jako na PC (LivePhoneOrderLines) v každém okně grafu (U3).
  const chartPosition = slots.position;
  // Telefon nemá výběr účtu, pohled je pro zařízení vždy tentýž.
  const registerBoxFollow = useLivePositionBoxFollow({ position: chartPosition, target: 'phone', events: slots.copyEvents });
  // Šipky plnění: jen dnešní den a jen plnění, která deník ještě nekreslí (stejné id plnění u brokera).
  const journalFillIds = useMemo(() => new Set(ctl.chart.chartTrades.flatMap(trade => trade.executionHistory?.fills.map(fill => String(fill.id)) ?? [])), [ctl.chart.chartTrades]);
  // Kontrakt grafu: IBKR zdroj nese konkrétní měsíc; souvislá řada TV = front od brokera; jinak pozice.
  // Jiný měsíc (týden rollu) nebo neznámý kontrakt = šipky se nekreslí (ceny by seděly o spread vedle).
  const chartContract = previewSymbolFromChartSource(ctl.chart.liveSource) ?? chartPosition.symbol ?? trade?.frontContract ?? null;
  const shownFills = useMemo(() => (ctl.isToday && slots.fillsSymbol != null && slots.fillsSymbol === chartContract
    ? liveFillsNotInJournal(slots.fills ?? NO_FILLS, journalFillIds) : NO_FILLS), [ctl.isToday, slots.fills, slots.fillsSymbol, chartContract, journalFillIds]);
  // Pojistky utažení SL a BE jako PC (LiveTradingScreen.guardSummaryAt): bez ceny z P&L brokera
  // čerstvá kotace IBKR téhož kontraktu (≤ 3 s). Jen blokuje, nic neautorizuje (INV-UI-04).
  const guardAt = useCallback((at: number) => (chartPosition.summary
    ? withIbkrTightenMark(chartPosition.summary, chartPosition.symbol ?? null,
      { source: ctl.chart.liveSource ?? null, price: tick?.price ?? null, at: tick?.at ?? null, stale: ctl.chart.liveStatus !== 'live' }, at)
    : null), [chartPosition.summary, chartPosition.symbol, ctl.chart.liveSource, ctl.chart.liveStatus, tick]);
  // Živé P&L jen do štítku (INV-UI-04); bez čerstvé ceny IBKR téhož kontraktu číslo brokera.
  const displayOpenPnl = useMemo(() => (chartPosition.summary ? liveDisplayOpenPnl(chartPosition.summary, chartPosition.symbol ?? null,
    { source: ctl.chart.liveSource ?? null, price: tick?.price ?? null, at: tick?.at ?? null, stale: ctl.chart.liveStatus !== 'live' }, LIVE_PHONE_INSTRUMENT.pointValue, Date.now()) : null),
  [chartPosition.summary, chartPosition.symbol, ctl.chart.liveSource, ctl.chart.liveStatus, tick]);
  const shownOpenPnl = chartPosition.summary ? liveShownOpenPnl(chartPosition.summary, displayOpenPnl) : null;
  // „Zavřít / Zrušit“ lišty pozice: zrušení čekajícího vstupu jde sdíleným zámkem čar (jeden příkaz naráz).
  const barTradeRef = useRef(trade);
  barTradeRef.current = trade;
  const barClose = useMemo(() => createLivePhoneBarClose({
    trade: () => barTradeRef.current,
    busyRef: lineState.busyRef,
    setPendingMove: lineState.setPendingMove,
    say: text => setNotice({ key: Date.now(), text }),
  }), [lineState.busyRef, lineState.setPendingMove]);
  // C8: „Zavřít“ holé pozice = deskový closeBare TÝMŽ zámkem čar; odejde jen nabídka s klíčem,
  // který uživatel potvrdil (akce + entryOperationId). Neaktivní nabídka = jen důvod, nic neodejde.
  const barBareCloseRun = useMemo(() => createLiveBareCloseRun({
    close: () => barTradeRef.current?.closeBare,
    busyRef: lineState.busyRef,
    setPendingMove: lineState.setPendingMove,
    report: notice => setNotice({ key: Date.now(), text: notice.text }),
  }), [lineState.busyRef, lineState.setPendingMove]);
  // C7: čip schová jen to, co lišta pozice ruší cíleně (`manage` + tentýž jediný vstup);
  // jinak by „Zrušit“ lišty spustilo Flatten a cílené C7 by na grafu chybělo.
  const cancelPendingChip = livePhoneCancelPendingChipShown({
    cancelPending: trade?.cancelPending, canCancel: trade?.cancelPendingEntries != null, barManage: trade?.manage != null, position,
  });
  // Lišta nad grafem se v běžném provozu nekreslí (Filip 5. 11.): × je na čáře, SL/TP na ✎ a štítcích.
  // Zůstává jen, když čára zavřít neumí (přehrávání, kopírka vypnutá, pozice mimo appku): bez ní by v grafu nebyla cesta ven.
  const positionBarShown = (replay: boolean) => livePhonePositionBarShown({
    position, replay, manage: trade?.manage != null, closeSupported: trade?.closeSupported === true, bareCloseEnabled: trade?.bareClose?.enabled === true && trade.closeBare != null,
  });
  const barBareClose = (key: string) => {
    const offer = barTradeRef.current?.bareClose ?? null;
    if (!offer || offer.key !== key) { say('Holá pozice se mezitím změnila — nic se neodeslalo.'); return; }
    if (!offer.enabled) { say(`${offer.reason ?? 'Zavřít teď nejde.'} Nic se neodeslalo.`); return; }
    void barBareCloseRun(offer.trade);
  };
  // Pojistka lišty: lišta se bez pozice odmontuje, přechod Zrušit → Flatten se zapomenout nesmí.
  const barGuard = useLivePhoneBarGuard(
    position ? (position.pending ? 'cancel' : 'flatten') : null,
    position && !position.pending && trade?.closeBare ? trade.bareClose ?? null : null,
  );
  // Typ příkazu a kontrola proti trhu z čerstvé kotace (≤ 3 s), jako PC — ne z close svíčky.
  const freshQuote = (): TicketQuote | null => (quote && Date.now() - quote.at <= PHONE_MARKET_QUOTE_MAX_AGE_MS ? { bid: quote.bid, ask: quote.ask } : null);
  // Orientační cena návrhu v grafu (stejná jako pro list); null = cena zatím není.
  const draftQuote = (lastPrice: number | null): TicketQuote | null => freshQuote() ?? (lastPrice != null ? quoteOf(lastPrice) : null);
  // Market návrh v grafu: SL a TP jedou s cenou jako na PC (list si svůj návrh drží sám).
  const marketEntryRef = useRef<{ side: string; entry: number } | null>(null);
  useEffect(() => {
    if (!quote || !chartDraft || chartDraft.type !== 'market') { marketEntryRef.current = null; return; }
    const entry = chartDraft.side === 'buy' ? quote.ask : quote.bid;
    // Přepnutí strany (ask ↔ bid) nesmí SL/TP posunout o tick.
    const previous = marketEntryRef.current?.side === chartDraft.side ? marketEntryRef.current.entry : null;
    marketEntryRef.current = { side: chartDraft.side, entry };
    if (previous == null || previous === entry) return;
    editDraft(draft => livePhoneMarketDraftFollow(draft, previous, entry, trade?.scaleIn, LIVE_PHONE_INSTRUMENT.tickSize));
  }, [quote, chartDraft?.side, chartDraft?.type]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pracující příkazy (U5): jen zobrazení, jen když kontrakt čar sedí s kontraktem grafu (IBKR měsíc).
  const working = useMemo(() => livePhoneWorkingView(slots.workingOrders, contract), [slots.workingOrders, contract]);
  // Správa pozice (U10): list s číslem a BE variantami — otevře ✎ na čáře nebo „SL/TP“ v liště pozice.
  const [manageLeg, setManageLeg] = useState<{ key: number; leg: 'stopLoss' | 'takeProfit' } | null>(null);
  const openManage = trade?.manage ? (leg: 'stopLoss' | 'takeProfit') => setManageLeg({ key: Date.now(), leg }) : undefined;
  // Zvuk/hlas při fillu (U7): stejné události jako karty (brána `runtimeAvailable` v desku), volba opt-in.
  useLiveFillAnnouncer({ events: slots.copyEvents, fills: slots.fills, fillsSymbol: slots.fillsSymbol, available: slots.copyEvents != null, requireFocus: false });
  const [fillMode, setFillMode] = useLiveFillAnnounceMode();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const showGroup = chartPosition.summary != null || chartPosition.issue != null;
  useEffect(() => { if (!chartPosition.summary) { setAccountsOpen(false); setManageLeg(null); } }, [chartPosition.summary]);
  // Lišta návrhu nad obchodní lištou (je-li dole), karty obchodů nad lištou návrhu.
  const draftBarBottom = pill.on && pill.y >= 0.5 ? 90 : 34;
  // Karty vlevo dole, které nevznikly z událostí kopírky (upozornění).
  const [cards, setCards] = useState<TradeToast[]>([]);
  // Lokální karty nikdy nejsou sticky (nesmí se hromadit nad lištou ani vytlačit kartu rizika).
  const card = useCallback((tone: TradeToast['tone'], badge: string, title: string, line: string, ms?: number, extra?: Pick<TradeToast, 'alertColor' | 'alertBeacon'>) => {
    const at = Date.now();
    setCards(current => [...current.slice(-5), { id: `local-${at}-${Math.random().toString(36).slice(2, 6)}`, at, tone, badge, title, line, pnl: null, accounts: 0, sticky: false, ms, ...extra }]);
  }, []);
  // Upozornění na cenu: přihlášený = server (sdílené s PC, hlídá Mac worker z IBKR), jinak jen zařízení.
  const alertStore = usePriceAlertStore();
  const alertState = useSyncExternalStore(alertStore.subscribe, alertStore.getState, alertStore.getState);
  // Spuštění ze serveru (úroveň uživatele, ne cena trhu); slot datové vrstvy má přednost.
  const alertEvents = useMemo(() => slots.alertEvents ?? (alertState.events ?? []).filter(event => !event.suppressed)
    .map(event => ({ id: event.id, alertId: event.alertId, at: event.at, price: event.level })), [slots.alertEvents, alertState.events]);
  const [selectedAlert, setSelectedAlert] = useState<string | null>(null);
  const [editAlert, setEditAlert] = useState<string | null>(null);
  const [alertList, setAlertList] = useState(false);
  const [plus, setPlus] = useState<number | null>(null);
  const plusOpenedAt = useRef(0);
  /** Plus odešle holý Limit/Stop hned jen na ověřeně flat účtu a bez rozpracovaného návrhu (ten by zahodil). */
  const plusInstant = trade?.barePendingSupported === true && order == null && chartPosition.summary == null && chartPosition.issue == null;
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set());
  // „Zapnout znovu“ z notifikace: výsledek musí být vidět, jinak by člověk věřil, že alert hlídá.
  useEffect(() => {
    const onRearm = (event: Event) => {
      const ok = (event as CustomEvent<{ ok?: boolean }>).detail?.ok === true;
      card(ok ? 'amber' : 'red', 'Upoz.', ok ? 'Upozornění znovu zapnuto' : 'Upozornění se NEZAPNULO', ok ? 'Mac ho zase hlídá, jakmile má cenu' : 'Už běží, je smazané, nebo se znovu spustilo. Zkontroluj seznam.', 8_000);
    };
    window.addEventListener(PRICE_ALERT_REARM_EVENT, onRearm);
    return () => window.removeEventListener(PRICE_ALERT_REARM_EVENT, onRearm);
  }, [card]);
  useFreshPriceAlertEvents(alertStore, alertEvents, (event, alert) => {
    const title = priceAlertEventTitle(alert, event.price);
    // Nejvýš 2 karty upozornění najednou, ať nevytlačí kartu rizika.
    setCards(current => {
      const alerts = current.filter(item => item.badge === 'Upoz.');
      return alerts.length >= ALERT_CARDS_MAX ? current.filter(item => item !== alerts[0]) : current;
    });
    // Karta s číselníkem a majákem: cena nahoře, směr, pod ním zpráva.
    card('amber', 'Upoz.', title.replace(/\s[\d\s\u00A0.,]+$/, ''), alert?.note ?? '', 8_000, { alertBeacon: { price: event.price }, ...(alert ? { alertColor: alert.line.color } : {}) });
    // Nativně v popředí hraje zvuk už notifikace; tón jen když notifikace nepřijde.
    if (alert?.channels.sound !== false && (!isNativeBuild || alert?.channels.phone === false)) void playAlertTone(alert?.channels.tone);
    if (alert?.channels.voice) speakAlertText(alertVoiceText(title, alert.note));
    if (!alert) return;
    setFlashIds(current => new Set(current).add(alert.id));
    window.setTimeout(() => setFlashIds(current => { const next = new Set(current); next.delete(alert.id); return next; }), ALERT_FIRE_MS);
  });
  const market = ctl.chart.candles.at(-1)?.close ?? null;
  const editing = editAlert ? alertState.alerts.find(alert => alert.id === editAlert) ?? null : null;
  const moveAlert = (id: string, price: number) => {
    const alert = alertStore.getState().alerts.find(item => item.id === id);
    if (!alert) return;
    const next = movedAlert(alert, price, market);
    alertStore.update(next);
    card('blue', 'Posun', 'Upozornění posunuto', `${alert.price.toFixed(2)} → ${next.price.toFixed(2)} · ${alertTitle(next).split(' ').slice(1, -1).join(' ')}`);
  };
  const removeAlert = (id: string) => {
    alertStore.remove(id);
    if (selectedAlert === id) setSelectedAlert(null);
    card('muted', 'Zrušeno', 'Upozornění zrušeno', '');
  };
  // Odeslání návrhu — tlačítko listu i [Odeslat] lišty návrhu (U2) jdou JEN touto cestou:
  // přehrávání, přikoupení, brány desku, strop, kontrola proti čerstvé kotaci a příkaz přesně
  // jako náhled (`livePhoneSheetPayload`). Velikost = zobrazené N (`livePhoneSheetSubmitDraft`).
  const submitSheetDraft = (draft: TicketDraft, replay: boolean) => {
    if (replay) { say(`${draftSummary(draft)} — ${REPLAY_NO_TRADE}`); return; }
    // Běží jiný příkaz: návrh zůstane (dřív by zmizel a nic by neodešlo).
    if (busyRef.current) { say(`${draftSummary(draft)} — předchozí příkaz ještě běží, nic se neodeslalo.`); return; }
    // Přikoupení s jinými SL/TP / nad strop: list zůstane otevřený, ať jde opravit (nic neodešlo).
    const scaleBlocked = livePhoneScaleInBlocked(draft, draft.quantity, trade?.scaleIn, trade?.maxContracts ?? 1);
    if (scaleBlocked) { say(`${draftSummary(draft)} — ${scaleBlocked}`); return; }
    // List se zavře (hláška by byla za ním); návrh v grafu zůstane, ať jde opravit tažením.
    const keep = order?.mode === 'chart';
    const refuse = (text: string) => { if (!keep) setOrder(null); say(`${draftSummary(draft)} — ${text}`); };
    const blocked = sendBlocked(draft.type === 'market')
      ?? (draft.quantity > (trade?.maxContracts ?? 1) ? `Strop ručního vstupu je ${trade?.maxContracts ?? 1} kontraktů.` : null);
    if (blocked) { refuse(blocked); return; }
    // Znovu proti čerstvé kotaci: limit/stop, který by se teď hned vyplnil, neposílat.
    const now = freshQuote();
    const crossed = now && draft.type === 'limit' && limitIsMarketable(draft, now) ? 'limit je už na druhé straně trhu (vyplnil by se hned)'
      : now && draft.type === 'stop' && stopIsTriggered(draft, now) ? 'stop je už za trhem (spustil by se hned)' : null;
    if (crossed) { refuse(`${crossed}, nic se neodeslalo.`); return; }
    setOrder(null);
    // Limit/Stop bez IBKR: kontrakt podle brokera (worker ho ověří znovu); Market jen z IBKR.
    void send(livePhoneSheetPayload(draft, LIVE_PHONE_INSTRUMENT, quote, trade?.frontContract ?? null));
  };
  const backToSheet = () => setOrder(current => (current ? { ...current, key: Date.now(), mode: 'sheet', template: false } : current));
  const replayLive = chartPosition.summary
    ? { side: chartPosition.summary.side, quantity: chartPosition.summary.quantity, pending: chartPosition.summary.kind === 'pending' } : null;
  return (
    <DayFullscreenChart
      ctl={ctl}
      isDark={isDark}
      timeframe={timeframe}
      onTimeframe={setTimeframe}
      range={range}
      focusKeyPrefix={`live:${ctl.scope}`}
      selectedTrade={null}
      onClose={onLeave}
      live={{
        header: slots.header(showGroup ? <LivePhoneGroupPnl position={chartPosition} openPnl={shownOpenPnl} onOpen={() => setAccountsOpen(true)} /> : undefined),
        overlay: ({ lastPrice, api, candles, replay }) => <>
          {slots.overlay}
          {accountsOpen && chartPosition.summary && <LivePhoneAccountsSheet position={chartPosition} onClose={() => setAccountsOpen(false)} />}
          {plus != null && !replay && (
            <LivePhonePlusSheet
              price={plus}
              market={lastPrice}
              quote={freshQuote()}
              quantity={pill.qty}
              instantBare={plusInstant}
              onClose={() => setPlus(null)}
              onOrder={(side, type) => {
                // Okamžité odeslání: stejný dotyk, který otevřel menu, nesmí trefit položku pod prstem.
                if (Date.now() - plusOpenedAt.current < LIVE_PLUS_GHOST_TAP_MS) return;
                const price = plus;
                setPlus(null);
                if (replay) { say(REPLAY_NO_TRADE); return; }
                if (lastPrice == null) { say('Cena trhu zatím není — objednávku nejde připravit.'); return; }
                // Stejný list a odeslání jako objednávka z position boxu (kontroly beze změny).
                // V pozici na stejnou stranu = přikoupení: list převezme SL/TP pozice.
                // Nový návrh z „+“ se otevře bez SL/TP (Filip 5. 11.); přikoupení je převezme z pozice.
                const plusDraft = { ...newTicketDraft(side, type, price, LIVE_PHONE_INSTRUMENT, freshQuote() ?? quoteOf(lastPrice), { sizing: 'qty' as const, quantity: pill.qty, riskUsd: 200 }), stopLoss: null, takeProfit: null };
                // Filip 7. 11.: na flat účtu odešle Limit/Stop bez SL/TP hned, počet z lišty. Jinak list jako dřív.
                if (plusInstant && type !== 'market') { submitSheetDraft(plusDraft, replay); return; }
                openOrder(livePhoneScaleInDraft(plusDraft, trade?.scaleIn), false);
              }}
              onAlert={() => {
                const alert = newPriceAlert(plus, lastPrice, alertStore.getState().defaults);
                alertStore.add(alert);
                setPlus(null);
                card('amber', 'Upoz.', 'Upozornění přidáno', `${alertTitle(alert)} · ${!alertState.sync ? 'jen v tomto zařízení (nepřihlášeno)' : alertState.sync === 'offline' ? 'zatím neuloženo — server nedostupný, odešle se později' : slots.alertWatch ? 'hlídá Mac · zvoneček = výběr, dvojklep = nastavení' : 'uloženo — Mac ho teď nehlídá'}`);
              }}
              onLine={() => {
                const engine = api?.drawing?.engine;
                const time = candles.at(-1)?.time;
                setPlus(null);
                if (!engine || time == null) return;
                engine.commit({ id: engine.newDrawingId(), tool: 'HorizontalLine', points: [{ time, price: plus }], style: engine.getDefaultStyle() } as Parameters<typeof engine.commit>[0]);
              }}
            />
          )}
          {editing && (
            <LivePhoneAlertSheet
              key={editing.id}
              alert={editing}
              market={lastPrice}
              onClose={() => setEditAlert(null)}
              onDelete={id => { setEditAlert(null); removeAlert(id); }}
              onSave={(next: PriceAlert) => {
                alertStore.update({ ...next, updatedAt: Date.now() });
                // Co uložíš, dostanou i další nová upozornění.
                alertStore.setDefaults({ frequency: next.frequency, expiry: next.expiry, line: next.line, channels: next.channels });
                setEditAlert(null);
              }}
            />
          )}
          {alertList && (
            <LivePhoneAlertList
              alerts={alertState.alerts}
              watching={slots.alertWatch ?? null}
              error={alertState.error ?? null}
              onClose={() => setAlertList(false)}
              onEdit={id => { setAlertList(false); setEditAlert(id); }}
              onRemove={removeAlert}
            />
          )}
          {qtySheet && <LiveQtySheet value={pill.qty} onClose={() => setQtySheet(false)} onDone={qty => { savePill({ ...pill, qty }); setQtySheet(false); }} />}
          {/* lastPrice je za přehrávání null — list se nevykreslí (historická cena, U3). */}
          {order?.mode === 'sheet' && lastPrice != null && (
            <LivePhoneOrderSheet
              key={order.key}
              initial={order.draft}
              instrument={LIVE_PHONE_INSTRUMENT}
              quote={freshQuote() ?? quoteOf(lastPrice)}
              trade={trade}
              liveQuote={quote}
              userId={slots.userId ?? null}
              applyDefaultTemplate={order.template}
              // „Upravit v grafu“ (U2): list se stáhne do lišty návrhu, návrh se dolaďuje čarami.
              onEditInChart={draft => setOrder(current => (current ? { ...current, draft, mode: 'chart' } : current))}
              onClose={() => setOrder(null)}
              onSubmit={draft => submitSheetDraft(draft, replay)}
            />
          )}
          {/* Správa pozice (U10): jen otevře list; odesílá sdílený runner se zámkem čar (lineState). */}
          {manageLeg && !replay && (
            <LivePhoneManageSheet
              key={manageLeg.key}
              summary={chartPosition.summary}
              guardAt={guardAt}
              leg={manageLeg.leg}
              pendingLegs={trade?.pendingLegs === true}
              manage={trade?.manage ?? null}
              state={lineState}
              entryAvg={trade?.entryAvg ?? null}
              leaderAccountId={trade?.leaderAccountId ?? null}
              onNotice={say}
              onClose={() => setManageLeg(null)}
            />
          )}
          {attachOpen && position && marketNow != null && position.bareEntryOperationId && (
            <LivePhoneAttachSheet
              side={position.side}
              market={marketNow}
              tickSize={LIVE_PHONE_INSTRUMENT.tickSize}
              userId={slots.userId ?? null}
              onClose={() => setAttachOpen(false)}
              onSubmit={(stopLoss, takeProfit) => {
                setAttachOpen(false);
                sendAttach(stopLoss, takeProfit);
              }}
            />
          )}
        </>,
        onPositionOrder: (drawing, { lastPrice, replay }) => {
          if (replay) { say(REPLAY_NO_TRADE); return; }
          if (lastPrice == null) { setNotice({ key: Date.now(), text: 'Cena trhu zatím není — objednávku nejde připravit.' }); return; }
          try {
            const { draft, quantity } = draftFromPositionBox(drawing, LIVE_PHONE_INSTRUMENT, freshQuote() ?? quoteOf(lastPrice));
            // V pozici na stejnou stranu = přikoupení: list viditelně převezme SL/TP pozice.
            // SL/TP z boxu — výchozí šablona se nepoužije.
            openOrder(livePhoneScaleInDraft({ ...draft, sizing: 'qty', quantity: Math.max(1, quantity) }, trade?.scaleIn), false);
          } catch (error) {
            setNotice({ key: Date.now(), text: error instanceof Error ? error.message : 'Position box nejde převést na objednávku.' });
          }
        },
        // Ovládací čáry v každém okně grafu (U3): štítky pozice, BE, ×, tah SL/TP, návrh (U2),
        // pracující příkazy (U5) a ✎ správy (U10) v měřítku toho okna; zámek jednoho příkazu
        // (`lineState`) je společný. Za přehrávání nic — graf je historický (INV-UI-01).
        paneLayer: ({ api, replay, active, lastPrice }) => (api && !replay ? <>
          <LiveBoxFollowPane api={api} register={registerBoxFollow} />
          {noPriceNotice && (
            <div aria-live="polite" style={{ position: 'absolute', top: 12, left: 0, right: 0, zIndex: 6, pointerEvents: 'none', display: 'flex', justifyContent: 'center' }}>
              <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }}>
                Živá cena teď nechodí
              </span>
            </div>
          )}
          {resuming && (
            <div
              aria-live="polite"
              style={{ position: 'absolute', inset: 0, zIndex: 6, pointerEvents: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 12, background: isDark ? 'rgba(2,6,23,.55)' : 'rgba(255,255,255,.6)' }}
            >
              <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#0f172a', boxShadow: '0 1px 4px rgba(0,0,0,.3)' }}>
                Načítám živá data…
              </span>
            </div>
          )}
          <LivePhoneOrderLines
            api={api}
            state={lineState}
            summary={chartPosition.summary}
            guardAt={guardAt}
            displayOpenPnl={displayOpenPnl}
            manage={trade?.manage ?? null}
            bareClose={trade?.closeBare && trade.bareClose?.enabled ? { entryOperationId: trade.bareClose.trade.entryOperationId, key: trade.bareClose.key } : null}
            onBareClose={barBareClose}
            attach={trade?.bareLeg && trade.bareLegTrade ? null : attachChipBridge}
            bareLeg={trade?.bareLeg && trade.bareLegTrade ? intent => trade.bareLeg!(trade.bareLegTrade!, intent) : null}
            moveLimit={trade?.moveLimit === true}
            pendingLegs={trade?.pendingLegs === true}
            canClose={trade?.closeSupported === true}
            entryAvg={trade?.entryAvg ?? null}
            pendingAdd={trade?.scaleIn?.pendingAdd ?? trade?.barePartial ?? null}
            closeExpect={trade?.scaleIn?.stopLoss ?? null}
            isDark={isDark}
            onNotice={say}
            extraLines={working.lines}
            draftLines={(() => {
              const draftAt = chartDraft ? draftQuote(lastPrice) : null;
              return chartDraft && draftAt ? livePhoneDraftLines(chartDraft, LIVE_PHONE_INSTRUMENT, draftAt, trade?.scaleIn) : undefined;
            })()}
            onDraftChange={(kind, price) => editDraft(draft => livePhoneDraftAfterDrag(draft, kind, price, LIVE_PHONE_INSTRUMENT))}
            onDraftRemove={kind => editDraft(draft => livePhoneDraftAfterRemove(draft, kind))}
            onDraftAddBracket={(kind, price) => {
              const draftAt = draftQuote(lastPrice);
              if (draftAt) editDraft(draft => livePhoneDraftAfterAddBracket(draft, kind, LIVE_PHONE_INSTRUMENT, draftAt, price));
            }}
            onManage={openManage}
          />
          <LivePhoneAlertLines
            api={api}
            alerts={alertState.alerts}
            selectedId={selectedAlert}
            flashIds={flashIds}
            onSelect={setSelectedAlert}
            onEdit={id => { setSelectedAlert(id); setEditAlert(id); }}
            onMove={moveAlert}
            onRemove={removeAlert}
          />
          {/* Plusko u kříže jen v aktivním okně (ve dvou oknech by se ukázalo dvakrát). */}
          {active && <LivePhoneCrosshairPlus api={api} onPlus={price => { plusOpenedAt.current = Date.now(); setPlus(price); }} />}
        </> : null),
        // Bid/ask ze streamu přijde s napojením dat; zatím poslední cena svíčky.
        chartLayer: ({ lastPrice, api, candles, intervalSeconds, replay, exitReplay }) => <>
          <LiveFillArrows api={api} fills={shownFills} open={slots.fillsOpen === true} candles={candles} intervalSeconds={intervalSeconds} enabled={!replay && slots.fillsOpen != null && shownFills.length > 0} isDark={isDark} />
          {!replay && <LivePhoneWorkingBadges badges={working.badges} top={(positionBarShown(replay) ? BELOW_POSITION_BAR : 8) + (cancelPendingChip ? CANCEL_PENDING_CHIP_SPACE : 0)} />}
          {/* C7: „Zrušit čekající“ jen s pohledem desku a mimo přehrávání; sdílený zámek čar. */}
          {!replay && cancelPendingChip && trade?.cancelPending && trade.cancelPendingEntries && <LivePhoneCancelPendingChip
            view={trade.cancelPending}
            lockRef={lineState.busyRef}
            cancel={trade.cancelPendingEntries}
            top={positionBarShown(replay) ? BELOW_POSITION_BAR : 8}
            onNotice={say}
          />}
          <LiveTradeToasts events={slots.copyEvents} copierArmed={slots.copierArmed ?? false} isDark={isDark} placement={{ left: 8, bottom: chartDraft && !replay ? draftBarBottom + 72 : 84 }} extra={cards} capExtra />
          {positionBarShown(replay) && position && <LivePhonePositionBar
            side={position.side} quantity={position.quantity} symbol={position.symbol} pending={position.pending}
            unprotected={position.bareEntryOperationId != null} busy={busy}
            onAttach={() => { if (marketNow == null) say('Cena není čerstvá — SL/TP teď nejde připravit.'); else setAttachOpen(true); }}
            // Správa (U10) jen mimo přehrávání; Zavřít a Přidat SL/TP zůstávají (snižují riziko, INV-UI-02).
            onManage={openManage && !replay ? () => openManage('stopLoss') : undefined}
            // Čekající vstup se ruší cílenou cestou × (cancel-entry, i za vypnuté kopírky) — ne
            // Flattenem skupiny, který by navíc kopírku vypnul (TEL-ZRUŠIT, 3. 11.) — a přes
            // sdílený zámek čar (`lineState.busyRef`): souběžně s × / BE z čáry nic druhého.
            // Flatten jen u pozice nebo když cílená cesta není k dispozici; zámek ho neblokuje.
            onClose={() => { void barClose(position); }}
            // C8: „Zavřít“ holé pozice (close-position) jen s nabídkou workeru a mimo přehrávání;
            // Flatten zůstává vedle (mimo zámek) a u holé pozice se VŽDY jmenuje „Flatten“.
            bareClose={!replay && trade?.closeBare ? trade.bareClose ?? null : null}
            onBareClose={barBareClose}
            guard={barGuard}
            onSwallowed={() => say(LIVE_ACTION_CHANGED_TEXT)}
          />}
          {/* Přehrávání (U3): štítek živého stavu a cesta zpět; obchodovat jde jen v živém grafu. */}
          {replay && <LivePhoneReplayLiveChip position={replayLive} pnl={shownOpenPnl} top={positionBarShown(replay) ? BELOW_POSITION_BAR : 8} onExit={exitReplay} />}
          {/* Lišta návrhu (U2): [Odeslat] = stejná cesta jako tlačítko listu (submitSheetDraft). */}
          {chartDraft && !replay && lastPrice != null && (
            <LivePhoneDraftBar
              draft={chartDraft}
              instrument={LIVE_PHONE_INSTRUMENT}
              quote={freshQuote() ?? quoteOf(lastPrice)}
              trade={trade}
              busy={busy}
              bottom={draftBarBottom}
              onSubmit={draft => submitSheetDraft(draft, replay)}
              onEdit={backToSheet}
              onDiscard={() => setOrder(null)}
            />
          )}
          {/* Při přehrávání je graf historický: lišta by poslala živý Market nad starými svíčkami (N1, 3. 11.). */}
          {!replay && <LiveTradePill isDark={isDark} prefs={pill} onPrefs={savePill} bid={resuming ? null : quote?.bid ?? null} ask={resuming ? null : quote?.ask ?? null} onQty={() => setQtySheet(true)} onSide={side => onSide(side, replay)} />}
          {notice && <LiveChartNotice key={notice.key} text={notice.text} onDone={clearNotice} />}
        </>,
        // Menu ⋯: zvuk / hlas při fillu (U7) — opt-in, výchozí Vypnuto.
        hubExtra: <>
          <LiveFillAnnounceSetting mode={fillMode} onMode={setFillMode} />
          <p style={{ margin: '18px 0 6px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' }}>Automatika</p>
          <div style={{ borderRadius: 14, border: '1px solid var(--dj-line)', padding: '6px 12px 10px' }}>
            <LiveChartAutomationSettings isDark={isDark} />
          </div>
        </>,
        symbol: LIVE_PHONE_INSTRUMENT.symbol,
        toolbar: <>
          <LivePhoneAlertsButton count={alertState.alerts.filter(alert => alert.status !== 'triggered').length} onClick={() => setAlertList(true)} />
          <LiveTradeToggle on={pill.on} onToggle={() => savePill({ ...pill, on: !pill.on })} />
        </>,
      }}
    />
  );
}
