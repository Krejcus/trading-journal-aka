import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, PanelRightClose, PanelRightOpen, Power, Volume2, VolumeX, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type LiveOrderEntryBridge } from './AlphaTradeChartWorkspace';
import LiveOrderTicket, {
  formatPrice,
  formatUsd,
  liveTicketNewDraft,
  liveTicketPrefsStorage,
  useLiveBracketTemplateLibrary,
  type TicketScope,
} from './LiveOrderTicket';
import LiveHotkeysHelp, {
  dispatchLiveHotkeyOutcome,
  liveHotkeyOverlayOpen,
  liveHotkeyReplayBlocked,
  liveHotkeysStorage,
  liveReleaseTicketFocus,
  readLiveHotkeysEnabled,
  writeLiveHotkeysEnabled,
  LIVE_HOTKEY_REPLAY_TEXT,
} from './LiveHotkeysHelp';
import LiveGroupChip from './LiveGroupChip';
import LiveTradeToasts from './LiveTradeToasts';
import { QuantumSpinner } from './QuantumLoader';
import ChartDataStatus from './ChartDataStatus';
import { useDayChartData } from '../hooks/useDayChartData';
import { useLiveTicketQuote } from '../hooks/useLiveTicketQuote';
import { perfDuration, perfMark } from '../lib/perfTrace';
import {
  markLiveCommandPaint,
  type LiveCommandTraceStage,
  type LiveCommandWorkerTiming,
} from '../lib/liveCommandPerformance';
import { DAY_ANCHOR_ACCOUNT_ID, chartMarketDay, pragueDayKey } from '../lib/dayJournal';
import {
  LIVE_ATTACH_OWNER,
  LIVE_DRAFT_ID,
  draftFromPositionBox,
  liveAttachChartLines,
  liveDraftChartLines,
  clickedOrderType,
  snapToTick,
  ticketQuantity,
  withBracket,
  withEntryPrice,
  type LiveAttachLegs,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketInstrument,
  type TicketOrderType,
  type TicketQuote,
  type TicketSide,
} from '../lib/liveOrderTicket';
import { liveTicketDraftBase, liveTicketInitialQuantity, readLiveTicketPrefs } from '../lib/liveTicketPrefs';
import { defaultLiveBracketTemplate } from '../lib/liveBracketTemplates';
import { liveHotkeyAction, liveHotkeyDraft, resolveLiveHotkey } from '../lib/liveHotkeys';
import { requestLiveSafetyConfirmation } from '../lib/liveSafetyShortcut';
import { LIVE_ACTION_CHANGED_TEXT, type LiveClickState } from '../lib/liveClickGate';
import { isLiveDisplayOnlyLine } from '../lib/liveWorkingOrderLines';
import { liveManageResultNotice, useLiveManageRunner, useLiveManageRunnerState, type LiveManageOutcome } from '../hooks/useLiveManageRunner';
import { LIVE_COMMAND_BUSY_TEXT, runWithCommandLock } from '../hooks/liveCommandRuns';
import { createLiveBareCloseRun } from '../hooks/liveCommandRuns';
import { liveBareLineEntryId, type LiveBareCloseOffer } from '../lib/liveBareCloseUi';
import type { BareLeaderTrade } from '../lib/manualBareClose';
import { useLiveFillAnnounceMode, useLiveFillAnnouncer } from '../hooks/useLiveFillAnnouncer';
import { LIVE_FILL_ANNOUNCE_LABELS, LIVE_FILL_ANNOUNCE_MODES } from '../lib/liveFillAnnouncer';
import { previewSymbolFromChartSource } from '../lib/leaderEntryPreview';
import { LIVE_ATTACH_SENT_HOLD_MS, liveAttachDefaults, liveAttachIntent, liveAttachMarket, type LiveAttachInput, type LiveBareEntryRecord } from '../lib/liveBareEntry';
import type { LivePhonePosition } from '../lib/livePhoneOrders';
import type { LiveChartFills, LiveChartWorkingOrders } from '../hooks/useLiveChartData';
import {
  GROUP_TARGET,
  SAMPLE_LIVE_TRADE_GROUP,
  effectiveTarget,
  targetAccount,
  type LiveTradeGroup,
  type LiveTradeTarget,
} from '../lib/liveTradeTarget';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../services/detailIndicators';
import { createLivePriceLinesFeed } from '../lib/livePriceLinesFeed';
import { LIVE_ATTACH_SEND_ACTION, LIVE_PENDING_ADD_LINE_ID, LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../lib/liveChartOrderLines';
import { liveDisplayOpenPnl, withIbkrTightenMark } from '../lib/liveChartPosition';
import type { LiveChartPosition } from '../lib/liveChartPosition';
import type { LiveChartDisarm } from '../lib/liveTradeGroupSource';
import type { LeaderEntryPreviewResult, LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import { buildLiveStatusStrip, liveAttentionReasons, type LiveStatusStripInput, type LiveStatusTone } from '../services/liveStatusStrip';
import type { TradovateLiveTab } from '../lib/tradovateLiveTab';
import type { LiveScreenThemePreference } from '../services/liveScreenTheme';
import LiveThemeToggle from './LiveThemeToggle';
import type { LiveTicketScaleIn } from '../lib/liveScaleIn';

/**
 * LIVE → Graf: živý graf MNQ přes celou obrazovku s panelem objednávky vpravo
 * a záložkami LIVE nahoře (Filip 29. 10.: klik na LIVE otevře rovnou graf).
 *
 * Jen UI. Svíčky jsou stejné jako v grafu dne (historie + živá svíčka).
 * Panel objednávky, ⚡ z position boxu, pravý klik do grafu a čáry návrhu
 * nic neodesílají. Stav kopírky v hlavičce je stejný model jako stavová
 * lišta LIVE (jen zobrazení) — vrstva přes celou obrazovku nesmí schovat, že
 * je kopírka vypnutá, zastavená nebo v incidentu. Účty skupiny, dnešní
 * výsledky, limity a pozice dodává desk ze stejných dat jako přehled
 * (`hooks/useLiveChartData.ts`); jediná akce je Vypnout přes safety cestu
 * desku (INV-UI-02). Ukázková skupina jen v dev s přepínačem.
 */

const ROOT = 'MNQ' as const;
const INSTRUMENT: TicketInstrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const NO_TRADES: Trade[] = [];
const MINUTE = 60_000;
/**
 * Ukázkové účty jen v dev buildu a jen s přepínačem — nikdy jako náhrada za
 * chybějící skutečnou skupinu (dev server je přihlášený do živého účtu).
 */
const sampleGroupEnabled = () => {
  if (!import.meta.env.DEV) return false;
  try { return window.localStorage.getItem('at:dev:live-chart-sample') === '1'; } catch { return false; }
};
/** Stejný text jako přehled LIVE při vypnutí bez ověřeného stavu. */
const UNVERIFIED_DISARM_TEXT = 'Aktuální stav kopírky ani pozic se teď nepodařilo ověřit. Vypnutí je bezpečné ve flat stavu; uprostřed obchodu by followeři přestali dostávat posuny SL a výstupy. Pozice nezavírá — k tomu slouží Flatten All, k úplnému zastavení brokerových akcí Kill switch.';
const TONE: Record<LiveStatusTone, { dot: string; text: string; ring: string }> = {
  muted: { dot: 'bg-slate-400', text: 'text-slate-500', ring: 'border-slate-500/30' },
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-500', ring: 'border-emerald-500/40' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', ring: 'border-amber-500/50' },
  danger: { dot: 'bg-rose-500', text: 'text-rose-500', ring: 'border-rose-500/60' },
};

/** Stav kopírky z desku pro hlavičku grafu (jen zobrazení, neautorizuje nic). */
export type LiveTradingCopierState = Pick<LiveStatusStripInput, 'status' | 'available' | 'pending' | 'transport' | 'journalHealth'> & {
  /** Počet připojení Tradovate, která chtějí nové přihlášení. */
  reconnectRequired: number;
};
export type LiveTradingCopyEvent = NonNullable<NonNullable<LiveTradingCopierState['status']>['recentCopyEvents']>[number];

export interface LiveTradingTab {
  id: TradovateLiveTab;
  label: string;
  icon: React.ElementType;
}

interface Props {
  isDark: boolean;
  /** Volba motivu LIVE (přepínač v liště grafu); isDark už je podle ní. */
  themePreference?: LiveScreenThemePreference;
  tabs: LiveTradingTab[];
  onNavigate: (tab: TradovateLiveTab) => void;
  /** Záložky jsou dočasně zamčené (desk čeká na potvrzení změny konfigurace); přehled zůstává dostupný. */
  navigationBlocked?: boolean;
  copier: LiveTradingCopierState;
  /** Události pro karty obchodů (poll ∪ expozice přímo z workeru, F2a); chybí = ze statusu. */
  copyEvents?: readonly LiveTradingCopyEvent[];
  /** Měření poslední rychlé expozice; nepoužívá se pro stav ani příkazy. */
  liveExposurePaint?: {
    id: string;
    receivedPerformanceAt: number;
    operationId?: string;
    stage?: LiveCommandTraceStage;
    workerTiming?: LiveCommandWorkerTiming;
  } | null;
  /** Monotónní čas kliknutí/otevření záložky pro měření lazy-loadu a prvních svíček. */
  chartOpenPerformanceAt?: number;
  /** Dohrává se odchod z grafu (animace, vrstva už nebere kliky). */
  leaving?: boolean;
  group?: LiveTradeGroup | null;
  position?: LiveChartPosition | null;
  disarm?: LiveChartDisarm | null;
  onDisarm?: () => Promise<{ tone: 'info' | 'error'; text: string }>;
  onTargetChange?: (target: LiveTradeTarget) => void;
  onPreviewEntry?: (draft: LiveEntryPreviewDraft) => Promise<LeaderEntryPreviewResult>;
  onPlaceEntry?: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  onManageEntry?: (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;
  /** Průměrný vstup spravovaného obchodu leadera od workeru (SL na BE). */
  manageEntryAvgPrice?: number | null;
  /** Worker umí zavřít obchod z grafu (× u pozice). */
  manageCloseSupported?: boolean;
  /** Worker umí SL/TP nevyplněného vstupu a TP blíž k trhu (`manual-order-pending-legs-v1`). */
  managePendingLegsSupported?: boolean;
  /** Worker umí nativní Market ručního vstupu (`manual-entry-market-v1`). */
  entryMarketSupported?: boolean;
  /** Strop kontraktů ručního vstupu skupiny workeru. */
  entryMaxContracts?: number;
  /** Přikoupení do otevřené pozice (worker `manual-entry-scale-in-v1`): SL/TP pozice a stav. */
  entryScaleIn?: LiveTicketScaleIn | null;
  /** Front kontrakt podle brokera (jen Limit/Stop bez IBKR). */
  entryFrontContract?: string | null;
  // ── U1/U3/U4/U5/U7/U8/U10 (3. 11. 2026): výchozí hodnoty = dnešní chování ──
  /** Worker inzeruje holý Market a „Přidat SL/TP“ (`manual-entry-bare-v1`); výchozí false. */
  entryBareSupported?: boolean;
  /** Vlastní přijatý holý Market bez nohou (desk `newestOpenBareEntry`); výchozí null. */
  entryBareEntry?: LiveBareEntryRecord | null;
  /** Pozice leadera skupiny workeru na symbolu grafu (`liveAttachIntent.position`); výchozí null. */
  entryLeaderPosition?: LivePhonePosition | null;
  /** Deskový `attachBrackets` (jen s bare capability); chybí = „Přidat SL/TP“ se nenabídne. */
  onAttachBrackets?: (input: LiveAttachInput) => Promise<LeaderOrderManageResult>;
  /** Brána odeslání z desku (tatáž jako telefonní lišta) pro holý Market; výchozí null. */
  entryBlockedReason?: string | null;
  /** Leader execution skupiny workeru — podklad Správy v panelu (U10); výchozí null = bez Správy. */
  manageLeaderAccountId?: number | null;
  /** Pracující příkazy jako čáry JEN PRO ZOBRAZENÍ (U5); výchozí null = žádné. */
  workingOrders?: LiveChartWorkingOrders | null;
  /** Šipky plnění leadera (U4, jen zobrazení); výchozí null = žádné. */
  liveFills?: LiveChartFills | null;
  /** Přihlášený uživatel — jen klíč knihovny šablon SL/TP na zařízení (U8); výchozí null. */
  userId?: string | null;
  // ── C7/C8 (4. 11. 2026): výchozí hodnoty = dnešní chování ──
  /** Nabídka × u vlastní holé pozice (desk `liveBareCloseOffer`, jen zobrazení); výchozí null. */
  bareClose?: LiveBareCloseOffer | null;
  /** Deskový `closeBareLeader` (jen s capability C8); chybí = × holé pozice se nenabídne. */
  onBareClose?: (seen: BareLeaderTrade) => Promise<LeaderOrderManageResult>;
  /** Sdílený zámek jednoho příkazu desku (lišta „Zrušit čekající“, Dashboard); chybí = vlastní zámek obrazovky. */
  manageLockRef?: React.MutableRefObject<boolean> | null;
  /** Přehrávání v grafu (U3-PC) pro desk — lišta pod grafem pak „Zrušit čekající“ nenabídne. */
  onReplayChange?: (active: boolean) => void;
}

/** Text pojistky U3-PC u tlačítka Objednávka během přehrávání v grafu. */
const REPLAY_TICKET_TEXT = 'Přehrávání v grafu — panel objednávky je vypnutý. Flatten All je na Live Dashboardu.';

/**
 * Volba zvuku/hlasu při fillu (U7) v liště grafu — výchozí Vypnuto, klik přepne
 * Vypnuto → Tón → Hlas. Klik je gesto: odemkne zvuk a přehraje ukázku. Jen zobrazení.
 */
const LiveFillAnnounceToggle: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const [mode, setMode] = useLiveFillAnnounceMode();
  const next = LIVE_FILL_ANNOUNCE_MODES[(LIVE_FILL_ANNOUNCE_MODES.indexOf(mode) + 1) % LIVE_FILL_ANNOUNCE_MODES.length];
  const Icon = mode === 'voice' ? AudioLines : mode === 'tone' ? Volume2 : VolumeX;
  const title = `Zvuk při fillu: ${LIVE_FILL_ANNOUNCE_LABELS[mode]} (klik → ${LIVE_FILL_ANNOUNCE_LABELS[next]}). Jen v otevřeném grafu s fokusem okna.`;
  return <button
    type="button"
    onClick={() => setMode(next)}
    title={title}
    aria-label={title}
    className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-md ${isDark ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}
  >
    <Icon size={15} />
    {mode !== 'off' && <i className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />}
  </button>;
};

function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const LiveTradingScreen: React.FC<Props> = ({
  isDark, themePreference = 'app', tabs, onNavigate, navigationBlocked = false, copier, copyEvents, liveExposurePaint, chartOpenPerformanceAt = 0, leaving = false,
  group: workerGroup = null, position = null, disarm = null, onDisarm, onTargetChange, onPreviewEntry, onPlaceEntry, onManageEntry, manageEntryAvgPrice, managePendingLegsSupported, manageCloseSupported = false, entryMarketSupported = false, entryMaxContracts = 1, entryFrontContract = null, entryScaleIn = null,
  entryBareSupported = false, entryBareEntry = null, entryLeaderPosition = null, onAttachBrackets, entryBlockedReason = null, manageLeaderAccountId = null,
  workingOrders = null, liveFills = null, userId = null,
  bareClose = null, onBareClose, manageLockRef = null, onReplayChange,
}) => {
  const now = useMinuteNow();
  const day = chartMarketDay(pragueDayKey(now));
  const chart = useDayChartData(day, NO_TRADES, NO_TRADES, now, { perfScope: 'live' });
  const chartComponentMeasured = useRef(false);
  const chartCandlesMeasured = useRef(false);
  const chartCandlesDataMeasured = useRef(false);
  useEffect(() => {
    if (chartComponentMeasured.current || chartOpenPerformanceAt <= 0) return;
    chartComponentMeasured.current = true;
    perfDuration('live:chart:component-ready', performance.now() - chartOpenPerformanceAt);
  }, [chartOpenPerformanceAt]);
  useEffect(() => {
    if (chartCandlesMeasured.current || chartOpenPerformanceAt <= 0 || chart.candles.length === 0) return undefined;
    if (!chartCandlesDataMeasured.current) {
      chartCandlesDataMeasured.current = true;
      perfDuration('live:chart:first-candles-data', performance.now() - chartOpenPerformanceAt);
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        chartCandlesMeasured.current = true;
        perfDuration('live:chart:first-candles-paint', performance.now() - chartOpenPerformanceAt);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [chart.candles.length, chartOpenPerformanceAt]);
  const measuredExposureIds = useRef(new Set<string>());
  const exposurePaintFrames = useRef(new Set<number>());
  useEffect(() => () => {
    for (const frame of exposurePaintFrames.current) window.cancelAnimationFrame(frame);
    exposurePaintFrames.current.clear();
    measuredExposureIds.current.clear();
  }, []);
  useEffect(() => {
    if (!liveExposurePaint || measuredExposureIds.current.has(liveExposurePaint.id)) return;
    measuredExposureIds.current.add(liveExposurePaint.id);
    // Novější exposure nesmí zrušit měření předchozího brokerového účinku.
    // Každý seq dostane vlastní dva snímky; zruší se až při unmountu grafu.
    const firstFrame = window.requestAnimationFrame(() => {
      exposurePaintFrames.current.delete(firstFrame);
      const secondFrame = window.requestAnimationFrame(() => {
        exposurePaintFrames.current.delete(secondFrame);
        measuredExposureIds.current.delete(liveExposurePaint.id);
        perfDuration('live:exposure:to-paint', performance.now() - liveExposurePaint.receivedPerformanceAt);
        if (liveExposurePaint.operationId && liveExposurePaint.stage) {
          markLiveCommandPaint({
            operationId: liveExposurePaint.operationId,
            stage: liveExposurePaint.stage,
            receivedPerformanceAt: liveExposurePaint.receivedPerformanceAt,
            workerTiming: liveExposurePaint.workerTiming,
          });
        }
      });
      exposurePaintFrames.current.add(secondFrame);
    });
    exposurePaintFrames.current.add(firstFrame);
  }, [liveExposurePaint]);

  // Kotva grafu bez obchodu (jako graf dne) — určí jen první záběr.
  const [anchor] = useState<Trade>(() => ({
    id: `live-trading:${day}`,
    accountId: DAY_ANCHOR_ACCOUNT_ID,
    instrument: ROOT,
    symbol: ROOT,
    signal: '',
    pnl: 0,
    date: day,
    direction: 'Long',
    timestamp: now,
    entryTime: now - 90 * MINUTE,
    durationMinutes: 90,
  } as Trade));

  // Orientační bid/ask panelu = živá cena z kanálu (výjimka INV-UI-04, Filip 30. 10.:
  // jen zobrazení panelu a strop ceny příkazu uživatele), jinak close poslední svíčky.
  // Rychlá cena = čáry návrhu a Market jdou s trhem (dřív svíčka stará i desítky sekund).
  const candleClose = chart.candles.at(-1)?.close ?? null;
  const tick = useLiveTicketQuote(chart.liveFeed, ROOT, candleClose);
  const lastPrice = tick?.price ?? candleClose;
  const quoteInfo = {
    source: chart.liveSource,
    capturedAt: tick?.at ?? chart.liveCapturedAt,
    stale: chart.liveStatus !== 'live',
  };
  const quote = useMemo<TicketQuote | null>(() => {
    if (lastPrice == null) return null;
    const bid = snapToTick(lastPrice, INSTRUMENT.tickSize);
    return { bid, ask: bid + INSTRUMENT.tickSize };
  }, [lastPrice]);

  // Stav kopírky stejným modelem jako stavová lišta LIVE (INV-UI-01/03:
  // obnovený nebo starý stav je jen zobrazení, po grace „Neověřeno“).
  const strip = buildLiveStatusStrip({ status: copier.status, available: copier.available, pending: copier.pending, transport: copier.transport, journalHealth: copier.journalHealth });
  const copierChip = strip.chips.find(chip => chip.id === 'copier') ?? null;
  const workerChip = strip.chips.find(chip => chip.id === 'worker' && chip.tone !== 'muted') ?? null;
  // Co přehled hlásí a chip Kopírka neodliší (zapnutá s rozjetím, incidentem…).
  const attention = liveAttentionReasons(strip, copier.status, copier.available);
  // Ukázka jen s přepínačem; stav kopírky v ní je pravidlový stav ze skutečné skupiny, jinak neověřený.
  const [sample] = useState(sampleGroupEnabled);
  const group = useMemo<LiveTradeGroup | null>(
    () => workerGroup ?? (sample ? { ...SAMPLE_LIVE_TRADE_GROUP, armed: null } : null),
    [sample, workerGroup],
  );
  // Panel je ve výchozím stavu zavřený; otevře ho tlačítko Objednávka, propsání
  // boxu (pravý klik) nebo pravý klik do grafu.
  const [ticketOpen, setTicketOpen] = useState(false);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [fromBox, setFromBox] = useState(false);
  // Jednotky SL/TP z předvoleb zařízení (U4) — jen zobrazení panelu.
  const [units, setUnits] = useState<TicketBracketUnits>(() => readLiveTicketPrefs(liveTicketPrefsStorage()).units);
  const [scope, setScope] = useState<TicketScope>('account');
  const [pickedTarget, setPickedTarget] = useState<LiveTradeTarget>(GROUP_TARGET);
  const target = group ? effectiveTarget(group, pickedTarget) : GROUP_TARGET;
  const targetKey = target.kind === 'group' ? 'group' : target.accountId;
  // Desk počítá pozici pro cíl panelu (skupina / jeden účet).
  useEffect(() => {
    onTargetChange?.(targetKey === 'group' ? GROUP_TARGET : { kind: 'account', accountId: targetKey });
  }, [onTargetChange, targetKey]);
  // Živá pozice leadera ve štítcích jako návrh (tažení SL/TP, BE, × čekajícího vstupu).
  // Posun čeká na potvrzení workerem: čára drží novou cenu se štítkem „odesílám“.
  const summary = position?.summary ?? null;
  // Pojistky utažení SL a BE: bez ceny z P&L brokera smí vzít čerstvou kotaci IBKR téhož
  // kontraktu (2. 11. 2026; jen blokuje, nic neautorizuje). Při akci se vyhodnotí znovu.
  const guardSummaryAt = useCallback((at: number) => (summary
    ? withIbkrTightenMark(summary, position?.symbol ?? null, { source: quoteInfo.source, price: tick?.price ?? null, at: tick?.at ?? null, stale: quoteInfo.stale }, at)
    : null), [summary, position?.symbol, quoteInfo.source, quoteInfo.stale, tick]);
  const guardSummary = useMemo(() => guardSummaryAt(Date.now()), [guardSummaryAt]);
  // Živé P&L jen do štítku (INV-UI-04); bez čerstvé ceny IBKR téhož kontraktu číslo brokera.
  const displayOpenPnl = useMemo(() => (summary ? liveDisplayOpenPnl(summary, position?.symbol ?? null,
    { source: quoteInfo.source, price: tick?.price ?? null, at: tick?.at ?? null, stale: quoteInfo.stale }, INSTRUMENT.pointValue, Date.now()) : null),
  [summary, position?.symbol, quoteInfo.source, quoteInfo.stale, tick]);
  // Hláška nad grafem; `until` = vlastní konec, jinak 8 s.
  const [lineNotice, setLineNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string; at: number; until?: number } | null>(null);
  // Správa obchodu leadera (U10): JEDEN runner a jeden zámek pro čáry grafu, zkratky i sekci
  // Správa v panelu — jediná cesta je `onManageEntry` desku (worker vše ověří znovu, nic se neopakuje).
  // Zámek je sdílený s deskem (lišta „Zrušit čekající“, Dashboard „Zrušit“), když ho desk dodá.
  const ownManageState = useLiveManageRunnerState();
  const manageState = manageLockRef ? { ...ownManageState, busyRef: manageLockRef } : ownManageState;
  const liveBusyRef = manageState.busyRef;
  const manageRunner = useLiveManageRunner({
    manage: onManageEntry,
    state: manageState,
    onNotice: notice => setLineNotice(notice),
    landed: { stopLoss: summary?.stop, takeProfit: summary?.target },
  });
  const pendingMove = manageRunner.pendingMove;
  const runLiveManage = manageRunner.run;
  // C8: × holé pozice (čára, Shift+X, panel) TÝMŽ zámkem jako správa; odejde jen nabídka, kterou
  // uživatel viděl (id cíle je v id čáry), a jen když ji worker teď nabízí.
  const bareOffer = bareClose && onBareClose ? bareClose : null;
  const bareOfferRef = useRef(bareOffer);
  bareOfferRef.current = bareOffer;
  const onBareCloseRef = useRef(onBareClose);
  onBareCloseRef.current = onBareClose;
  const bareCloseRun = useMemo(() => createLiveBareCloseRun({
    close: () => onBareCloseRef.current,
    busyRef: manageState.busyRef,
    setPendingMove: manageState.setPendingMove,
    report: notice => setLineNotice(notice),
  }), [manageState.busyRef, manageState.setPendingMove]);
  const closeBare = useCallback(async (entryOperationId: string): Promise<LiveManageOutcome | null> => {
    const offer = bareOfferRef.current;
    if (!offer || offer.trade.entryOperationId !== entryOperationId) {
      setLineNotice({ at: Date.now(), tone: 'bad', text: 'Holá pozice se mezitím změnila — nic se neodeslalo.' });
      return null;
    }
    if (!offer.enabled) {
      setLineNotice({ at: Date.now(), tone: 'bad', text: `${offer.reason ?? 'Zavřít teď nejde.'} Nic se neodeslalo.` });
      return null;
    }
    return bareCloseRun(offer.trade);
  }, [bareCloseRun]);
  useEffect(() => {
    if (!lineNotice) return undefined;
    const timer = window.setTimeout(() => setLineNotice(current => (current === lineNotice ? null : current)), Math.max(0, (lineNotice.until ?? lineNotice.at + 8_000) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [lineNotice]);
  // Cenové čáry pozice: workspace je vynechá v panelu, kde pozici kreslí štítky (jinak by byla dvakrát).
  const [positionLines] = useState(createLivePriceLinesFeed);
  useEffect(() => {
    positionLines.publish(position?.symbol ?? null, position?.lines ?? []);
  }, [position, positionLines]);
  useEffect(() => () => positionLines.publish(null, []), [positionLines]);
  // Vypnutí kopírky (INV-UI-02): jedno odeslání naráz, neověřený stav s potvrzením.
  const [disarmConfirm, setDisarmConfirm] = useState(false);
  const [disarmBusy, setDisarmBusy] = useState(false);
  const [disarmResult, setDisarmResult] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  // Zámek nezávislý na překreslení: dvojklik nesmí poslat dvě brzdy (každá má nový relay klíč).
  const disarmInFlightRef = useRef(false);
  const runDisarm = useCallback(async () => {
    if (!onDisarm || disarmBusy || disarmInFlightRef.current) return;
    disarmInFlightRef.current = true;
    setDisarmConfirm(false);
    setDisarmBusy(true);
    setDisarmResult(null);
    try { setDisarmResult(await onDisarm()); } finally { disarmInFlightRef.current = false; setDisarmBusy(false); }
  }, [disarmBusy, onDisarm]);
  // Návrh se sám nezakládá: čáry SL/TP na živém grafu jen když o ně uživatel požádá.
  // Profil indikátorů (FVG, levely, struktura) se mění za běhu — bez odběru by graf
  // po každém přepnutí vrátil stav z otevření (probliknutí, změna až po obnovení).
  const [tradeIndicators, setTradeIndicators] = useState(readTradeChartIndicators);
  useEffect(() => onTradeChartIndicatorsChange(setTradeIndicators), []);

  // Market: SL a TP jedou s cenou (drží nastavenou vzdálenost od vstupu).
  const marketEntryRef = useRef<number | null>(null);
  const marketSideRef = useRef<string | null>(null);
  useEffect(() => {
    if (!quote || draft?.type !== 'market') { marketEntryRef.current = null; return; }
    const entry = draft.side === 'buy' ? quote.ask : quote.bid;
    // Přepnutí strany (ask ↔ bid) nesmí SL/TP posunout o tick.
    const previous = marketSideRef.current === draft.side ? marketEntryRef.current : null;
    marketSideRef.current = draft.side;
    marketEntryRef.current = entry;
    // Přikoupení drží SL/TP pozice (zamčené v panelu) — s cenou nejedou.
    if (entryScaleIn != null && entryScaleIn.side === draft.side && entryScaleIn.stopLoss != null && entryScaleIn.targetPrice != null) return;
    if (previous == null || previous === entry) return;
    const delta = entry - previous;
    setDraft(current => (current && current.type === 'market' ? {
      ...current,
      stopLoss: current.stopLoss == null ? null : snapToTick(current.stopLoss + delta, INSTRUMENT.tickSize),
      takeProfit: current.takeProfit == null ? null : snapToTick(current.takeProfit + delta, INSTRUMENT.tickSize),
    } : current));
  }, [draft?.side, draft?.type, quote, entryScaleIn?.side, entryScaleIn?.stopLoss, entryScaleIn?.targetPrice]);

  const updateDraft = useCallback((next: TicketDraft | null) => {
    setDraft(next);
    if (!next) setFromBox(false);
  }, []);

  // Stránka pod vrstvou neroluje.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  // U3-PC pojistka: graf hlásí přehrávání (LIVE ho nenabízí; kdyby běželo, je panel
  // zavřený a vypnutý, zkratky nic nenavrhnou ani nespustí a čáry jsou jen pro čtení).
  const [chartReplay, setChartReplay] = useState(false);
  useEffect(() => { if (chartReplay) setTicketOpen(false); }, [chartReplay]);
  const onReplayChangeRef = useRef(onReplayChange);
  onReplayChangeRef.current = onReplayChange;
  useEffect(() => { onReplayChangeRef.current?.(chartReplay); }, [chartReplay]);
  useEffect(() => () => onReplayChangeRef.current?.(false), []);
  const replayNotice = useCallback(() => setLineNotice({ at: Date.now(), tone: 'bad', text: LIVE_HOTKEY_REPLAY_TEXT }), []);

  // U8: výchozí šablona SL/TP (★) pro nové návrhy — jen předvyplnění, nic neautorizuje.
  const templates = useLiveBracketTemplateLibrary(userId);
  const customTemplate = templates.library.defaultId != null ? defaultLiveBracketTemplate(templates.library) : null;
  // U4: velikost nového návrhu z předvoleb zařízení (do stropu skupiny); čte se znovu,
  // když návrh zmizí nebo se otevře panel (panel předvolby sám ukládá).
  const hasDraft = draft != null;
  const ticketPrefs = useMemo(() => readLiveTicketPrefs(liveTicketPrefsStorage()), [hasDraft, ticketOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Nový návrh panelu (tlačítko strany, pravý klik): předvolby zařízení + výchozí šablona. Jen předvyplnění. */
  const newDraft = useCallback((
    side: TicketSide, type: TicketOrderType, price: number,
    base?: Partial<Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>> | null,
  ): TicketDraft | null => {
    if (!quote) return null;
    const result = liveTicketNewDraft({
      side, type, price, instrument: INSTRUMENT, quote, prefs: readLiveTicketPrefs(liveTicketPrefsStorage()),
      maxContracts: entryMaxContracts, template: customTemplate, scaleIn: entryScaleIn, base: base ?? null,
    });
    if (result.notes.length > 0) setLineNotice({ at: Date.now(), tone: 'warn', text: result.notes.join(' ') });
    return result.draft;
  }, [customTemplate, entryMaxContracts, entryScaleIn, quote]);

  // U4 „Přidat SL/TP“ k vlastnímu holému Marketu: rozpracované nohy panelu a jejich čáry
  // „· přidat“ — tah mění jen nohy v panelu, odešle je až tlačítko „Odeslat SL a TP“.
  const [attachLegs, setAttachLegs] = useState<LiveAttachLegs | null>(null);
  const attachEntry = entryBareSupported && onAttachBrackets ? entryBareEntry : null;
  const attachSide: 'long' | 'short' | null = attachEntry?.side === 'Buy' ? 'long' : attachEntry?.side === 'Sell' ? 'short' : null;
  const attachQuantity = attachEntry?.quantity ?? entryLeaderPosition?.quantity ?? 1;
  const attachReference = manageEntryAvgPrice ?? summary?.entry ?? null;
  const attachLines = useMemo(() => (attachEntry && attachSide && attachLegs && attachLegs.entryOperationId === attachEntry.operationId && !chartReplay
    ? liveAttachChartLines(attachLegs, { side: attachSide, quantity: attachQuantity }, attachReference, INSTRUMENT)
    : []), [attachEntry, attachLegs, attachQuantity, attachReference, attachSide, chartReplay]);
  const attachOperationId = attachEntry?.operationId ?? null;
  // Nohy vytažené ze štítků na čáře pozice (panel je nepotřebuje).
  const attachChipLegs = attachLegs && attachLegs.entryOperationId === attachOperationId ? attachLegs : null;
  // Odesláno s výsledkem přijato / neznámo: nic se nenabízí znovu (panel i čára, jeden stav).
  const [attachSentFor, setAttachSentFor] = useState<string | null>(null);
  const attachSent = attachSentFor != null && attachSentFor === attachOperationId;
  useEffect(() => {
    if (!attachSentFor) return undefined;
    const timer = window.setTimeout(() => setAttachSentFor(null), LIVE_ATTACH_SENT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [attachSentFor]);
  const attachChips = useMemo(() => {
    if (!attachOperationId || !attachSide || chartReplay || attachSent || summary?.kind !== 'position') return null;
    const missing = ([['stopLoss', attachChipLegs?.stopLoss], ['takeProfit', attachChipLegs?.takeProfit]] as const).filter(([, value]) => value == null).map(([kind]) => kind);
    return { missing, canSend: missing.length === 0 };
  }, [attachChipLegs?.stopLoss, attachChipLegs?.takeProfit, attachOperationId, attachSent, attachSide, chartReplay, summary?.kind]);
  const addChartAttachLegRef = useRef<(kind: 'stopLoss' | 'takeProfit', price?: number) => void>(() => undefined);
  addChartAttachLegRef.current = (kind, price) => {
    if (!attachOperationId || !attachSide) return;
    const market = quote ? liveAttachMarket(attachSide, quote) : null;
    const at = price != null ? snapToTick(price, INSTRUMENT.tickSize) : market != null ? liveAttachDefaults(attachSide, market, INSTRUMENT.tickSize)[kind] : null;
    if (at == null) { setLineNotice({ at: Date.now(), tone: 'bad', text: 'Čekám na cenu — nohu teď nejde připravit.' }); return; }
    setAttachLegs(previous => {
      const base = previous && previous.entryOperationId === attachOperationId ? previous : { entryOperationId: attachOperationId, stopLoss: null, takeProfit: null };
      return kind === 'stopLoss' ? { ...base, stopLoss: at } : { ...base, takeProfit: at };
    });
  };
  const sendChartAttachRef = useRef<() => Promise<void>>(async () => undefined);
  sendChartAttachRef.current = async () => {
    if (!attachEntry || !onAttachBrackets || !attachChipLegs || attachSent) return;
    if (chartReplay) { replayNotice(); return; }
    if (manageState.busyRef.current) { setLineNotice({ at: Date.now(), tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT }); return; }
    // Záměr až při kliku: čerstvá kotace IBKR téhož kontraktu, pozice = holý vstup, ≥ 8 ticků (rozhoduje worker).
    const intent = liveAttachIntent({
      bareEntry: attachEntry, position: entryLeaderPosition,
      quote: quote && quoteInfo.capturedAt != null ? { symbol: previewSymbolFromChartSource(quoteInfo.source), bid: quote.bid, ask: quote.ask, at: quoteInfo.capturedAt } : null,
      stopLoss: attachChipLegs.stopLoss, takeProfit: attachChipLegs.takeProfit, tickSize: INSTRUMENT.tickSize, now: Date.now(),
    });
    if ('error' in intent) { setLineNotice({ at: Date.now(), tone: 'bad', text: intent.error }); return; }
    try {
      const result = await runWithCommandLock(manageState.busyRef, () => onAttachBrackets(intent.attach));
      setLineNotice(liveManageResultNotice('attach-brackets', result, Date.now()));
      if (result.status === 'acknowledged' || result.status === 'unknown') {
        setAttachSentFor(attachEntry.operationId);
        setAttachLegs(null);
      }
    } catch {
      // Výjimka relaye neříká, že nic neodešlo.
      setAttachSentFor(attachEntry.operationId);
      setAttachLegs(null);
      setLineNotice({ at: Date.now(), tone: 'warn', text: 'Výsledek SL/TP je neznámý — zkontroluj pozici, nic neopakuj.' });
    }
  };

  const liveLines = useMemo(() => (guardSummary ? livePositionChartLines(guardSummary, {
    manageable: Boolean(onManageEntry),
    pendingLegs: managePendingLegsSupported === true,
    attachChips,
    // × u pozice jen za čerstvě zapnuté kopírky (ne shadow) — jinak by kopie zůstaly otevřené (Flatten na přehledu).
    canClose: manageCloseSupported && copier.available && copier.status?.armed === true && copier.status.shadowMode !== true,
    entryAvg: manageEntryAvgPrice ?? null,
    pointValue: INSTRUMENT.pointValue,
    displayOpenPnl,
    ...(pendingMove ? { pending: { [pendingMove.kind]: pendingMove.price } } : {}),
    pendingAdd: entryScaleIn?.pendingAdd ?? null,
    bareClose: bareOffer?.enabled ? { entryOperationId: bareOffer.trade.entryOperationId } : null,
  }) : []), [attachChips, copier.available, copier.status, displayOpenPnl, manageCloseSupported, managePendingLegsSupported, manageEntryAvgPrice, onManageEntry, pendingMove, guardSummary, entryScaleIn?.pendingAdd, bareOffer]);
  // U4/U5: kontrakt grafu — IBKR zdroj nese měsíc, jinak pozice, jinak front podle brokera.
  // Jiný kontrakt (týden rollu) nebo neznámý = šipky ani pracující příkazy se nekreslí.
  const chartContract = previewSymbolFromChartSource(quoteInfo.source) ?? position?.symbol ?? entryFrontContract ?? null;
  const shownFills = useMemo(() => (liveFills && liveFills.fills.length > 0 && liveFills.symbol != null && liveFills.symbol === chartContract
    ? { key: liveFills.key, fills: liveFills.fills, open: liveFills.open }
    : null), [chartContract, liveFills]);
  const shownWorking = workingOrders && workingOrders.contract != null && workingOrders.contract === chartContract
    && (workingOrders.lines.length > 0 || workingOrders.badges.length > 0) ? workingOrders : null;

  // U7: zvuk/hlas při fillu — stejné události a brána jako karty obchodů, jen okno s fokusem.
  useLiveFillAnnouncer({
    events: copier.available ? copyEvents ?? copier.status?.recentCopyEvents : undefined,
    fills: copier.available ? liveFills?.fills : undefined,
    fillsSymbol: liveFills?.symbol ?? null,
    available: copier.available,
    enabled: !leaving,
    requireFocus: true,
  });

  // U1: klávesové zkratky — opt-in (výchozí VYPNUTO), volba jen na tomto zařízení.
  const [hotkeysOn, setHotkeysOn] = useState(() => readLiveHotkeysEnabled(liveHotkeysStorage()));
  const [hotkeysHelp, setHotkeysHelp] = useState(false);
  const changeHotkeys = useCallback((on: boolean) => {
    writeLiveHotkeysEnabled(liveHotkeysStorage(), on);
    setHotkeysOn(on);
  }, []);
  // Poslední stisk Shift+E/X/C: rychlý dvojstisk nepošle druhý příkaz.
  const hotkeyRepeatRef = useRef<LiveClickState | null>(null);
  // Esc z grafu (most `onEscape`) i posluchač kláves volají vždy nejnovější obsluhu.
  const hotkeyHandlerRef = useRef<(event: KeyboardEvent, fromChartEscape: boolean) => void>(() => undefined);

  const picked = group ? targetAccount(group, target) : null;
  const orderLines = useMemo(
    () => [...liveLines, ...(draft && quote && ticketOpen ? liveDraftChartLines(draft, INSTRUMENT, quote, picked?.short) : []), ...attachLines],
    [attachLines, draft, liveLines, picked?.short, quote, ticketOpen],
  );

  const liveOrderEntry = useMemo<LiveOrderEntryBridge>(() => ({
    executionInstrument: ROOT,
    chartOrderQuantity: draft && quote ? Math.max(1, ticketQuantity(draft, INSTRUMENT, quote)) : liveTicketInitialQuantity(ticketPrefs, entryMaxContracts),
    orderLines,
    onEscape: event => hotkeyHandlerRef.current(event, true),
    onReplayActiveChange: setChartReplay,
    liveFills: shownFills,
    liveDisplayOrders: shownWorking,
    onQuickOrder: ({ drawing }) => {
      if (chartReplay) return { ok: false, message: LIVE_HOTKEY_REPLAY_TEXT };
      if (!quote) return { ok: false, message: 'Čekám na cenu z grafu.' };
      try {
        const next = draftFromPositionBox(drawing, INSTRUMENT, quote);
        setDraft(next.draft);
        setFromBox(true);
        setTicketOpen(true);
        const kind = next.draft.type === 'market' ? 'MKT' : next.draft.type === 'limit' ? 'LMT' : 'STP';
        return {
          ok: true,
          message: `${next.draft.side === 'buy' ? 'BUY' : 'SELL'} ${kind} ${next.quantity} @ ${formatPrice(next.draft.price)} — zkontroluj v panelu`,
        };
      } catch (reason) {
        return { ok: false, message: reason instanceof Error ? reason.message : 'Z boxu se nepodařilo vytvořit návrh.' };
      }
    },
    onChartOrder: input => {
      if (!quote || chartReplay) return;
      // Typ podle živé kotace, ne podle viditelné svíčky grafu (historie po odscrollování).
      const type = input.price != null ? clickedOrderType(input.side, snapToTick(input.price, INSTRUMENT.tickSize), quote, INSTRUMENT.tickSize) : input.type;
      // Počet z menu grafu je výslovná volba (šablona ho nepřepíše); velikost podle rizika z návrhu, jinak z předvoleb.
      const next = newDraft(input.side, type, input.price ?? quote.ask, { sizing: draft?.sizing, quantity: input.quantity, riskUsd: draft?.riskUsd });
      if (!next) return;
      setDraft(next);
      setFromBox(false);
      setTicketOpen(true);
    },
    livePositionOwnerId: LIVE_POSITION_OWNER,
    onOrderLineChange: (line, kind, price, startLine) => {
      // Čáry jen pro zobrazení (pracující příkazy, U5) nikdy nic nemění ani neposílají.
      if (isLiveDisplayOnlyLine(line)) return;
      if (line.ownerId === LIVE_POSITION_OWNER) {
        if (chartReplay) { replayNotice(); return; }
        if (!summary || kind === 'entry') return;
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        const current = kind === 'stopLoss' ? summary.stop : summary.target;
        // „Co jsem viděl“ = cena při chycení čáry; změnila-li se během tahu, nic neposílat.
        if (startLine && startLine.price !== current) {
          setLineNotice({ at: Date.now(), tone: 'bad', text: `${kind === 'stopLoss' ? 'SL' : 'TP'} se během tažení změnil — nic se neodeslalo.` });
          return;
        }
        if (snapped === current) return;
        const blocked = liveLineMoveBlockReason(guardSummaryAt(Date.now()) ?? summary, kind, snapped, { pendingLegs: managePendingLegsSupported === true });
        if (blocked) { setLineNotice({ at: Date.now(), tone: 'bad', text: blocked }); return; }
        void runLiveManage(kind === 'stopLoss' ? 'move-stop' : 'move-target', current, snapped, kind);
        return;
      }
      if (line.ownerId === LIVE_ATTACH_OWNER) {
        // „· přidat“ (U4): tah mění jen nohy v panelu; nic neodchází.
        if (kind === 'entry') return;
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        setAttachLegs(previous => (previous && attachOperationId != null && previous.entryOperationId === attachOperationId
          ? (kind === 'stopLoss' ? { ...previous, stopLoss: snapped } : { ...previous, takeProfit: snapped })
          : previous));
        return;
      }
      if (line.ownerId !== LIVE_DRAFT_ID) return;
      setDraft(previous => {
        if (!previous) return previous;
        if (kind === 'entry') return withEntryPrice(previous, price, INSTRUMENT);
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        return kind === 'stopLoss' ? { ...previous, stopLoss: snapped } : { ...previous, takeProfit: snapped };
      });
    },
    onOrderLineSwallowed: () => setLineNotice({ at: Date.now(), tone: 'warn', text: LIVE_ACTION_CHANGED_TEXT }),
    onOrderLineCancel: line => {
      if (isLiveDisplayOnlyLine(line)) return;
      if (line.ownerId === LIVE_POSITION_OWNER && chartReplay) { replayNotice(); return; }
      // Čekající přikoupení: zrušit jen jeho vstup (desk pošle `cancel-entry` jeho lístku s jeho qty).
      if (line.id === LIVE_PENDING_ADD_LINE_ID) {
        if (entryScaleIn?.pendingAdd?.price != null) void runLiveManage('cancel-entry', entryScaleIn.pendingAdd.price);
        return;
      }
      if (line.ownerId === LIVE_POSITION_OWNER) {
        // C8: × holé pozice (z čáry / Shift+X) — jen nabídka s týmž id cíle.
        const bareEntryId = liveBareLineEntryId(line.id);
        if (bareEntryId != null) { void closeBare(bareEntryId); return; }
        if (line.kind === 'entry' && summary?.kind === 'pending') void runLiveManage('cancel-entry', summary.leader?.entry);
        // Zavřít obchod: „co jsem viděl“ = SL leadera (+ qty leadera v desku); worker ověří tvar u brokera.
        // Pozice z přikoupení s rozjetými SL: „co jsem viděl“ = nejochrannější SL od workeru (worker ho porovná znovu).
        if (line.kind === 'entry' && summary?.kind === 'position') void runLiveManage('close-position', summary.stop ?? entryScaleIn?.stopLoss);
        return;
      }
      // × u „· přidat“ vyhodí jen rozpracovanou nohu z návrhu; u brokera nic.
      if (line.ownerId === LIVE_ATTACH_OWNER) {
        const leg = line.kind;
        setAttachLegs(previous => (previous ? (leg === 'stopLoss' ? { ...previous, stopLoss: null } : leg === 'takeProfit' ? { ...previous, takeProfit: null } : previous) : previous));
        return;
      }
      if (line.ownerId !== LIVE_DRAFT_ID) return;
      if (line.kind === 'entry') { updateDraft(null); return; }
      setDraft(previous => (previous ? (line.kind === 'stopLoss' ? { ...previous, stopLoss: null } : { ...previous, takeProfit: null }) : previous));
    },
    onOrderLineAction: (line, actionId) => {
      if (isLiveDisplayOnlyLine(line)) return;
      if (line.ownerId === LIVE_POSITION_OWNER && actionId === LIVE_ATTACH_SEND_ACTION) { void sendChartAttachRef.current(); return; }
      if (line.ownerId !== LIVE_POSITION_OWNER || actionId !== 'break-even' || !summary) return;
      if (chartReplay) { replayNotice(); return; }
      const be = liveBreakEven(guardSummaryAt(Date.now()) ?? summary, manageEntryAvgPrice ?? null);
      if (be.blocked || be.price == null) { setLineNotice({ at: Date.now(), tone: 'bad', text: be.blocked ?? 'BE teď nejde.' }); return; }
      void runLiveManage('move-stop', summary.stop, be.price, 'stopLoss');
    },
    onOrderLineAddBracket: (line, kind, price) => {
      // „+ SL“ / „+ TP“ u holé pozice: jen návrh nohy, odchází až tlačítkem na čáře.
      if (line.ownerId === LIVE_POSITION_OWNER) { addChartAttachLegRef.current(kind, price); return; }
      if (!quote || line.ownerId !== LIVE_DRAFT_ID) return;
      setDraft(previous => (previous ? withBracket(previous, kind === 'stopLoss' ? 'sl' : 'tp', INSTRUMENT, quote, price) : previous));
    },
  }), [attachOperationId, chartReplay, closeBare, draft, entryMaxContracts, guardSummaryAt, manageEntryAvgPrice, newDraft, orderLines, quote, replayNotice, runLiveManage, shownFills, shownWorking, summary, ticketPrefs, updateDraft, entryScaleIn?.pendingAdd, entryScaleIn?.stopLoss]);

  /**
   * Klávesa → záměr → funkce obrazovky (U1). Rozhoduje `resolveLiveHotkey`; BE, zavřít
   * a zrušit čekající jdou přes TYTÉŽ funkce čáry jako myš (most výše).
   * Nikdy `onPlaceEntry` ani odeslání panelu — vstup odešle jen tlačítko panelu.
   */
  const prefillFromHotkey = (side: TicketSide) => {
    const now = Date.now();
    const base = draft
      ? { sizing: draft.sizing, quantity: draft.quantity, riskUsd: draft.riskUsd }
      : liveTicketDraftBase(readLiveTicketPrefs(liveTicketPrefsStorage()), entryMaxContracts);
    const brackets = customTemplate && quote ? { template: customTemplate, quote } : null;
    const result = liveHotkeyDraft(side, {
      quote, quoteAt: quoteInfo.capturedAt, quoteStale: quoteInfo.stale, marketSupported: entryMarketSupported,
      instrument: INSTRUMENT, base, now,
      // Výchozí šablona (★) smí změnit jen SL/TP; typ, cenu ani velikost ne.
      ...(brackets ? {
        applyBrackets: (next: TicketDraft) => liveTicketNewDraft({
          side: next.side, type: next.type, price: next.price, instrument: INSTRUMENT, quote: brackets.quote,
          maxContracts: entryMaxContracts, template: brackets.template, scaleIn: entryScaleIn,
          base: { sizing: next.sizing, quantity: next.quantity, riskUsd: next.riskUsd },
        }).draft,
      } : {}),
    });
    if ('error' in result) { setLineNotice({ at: now, tone: 'bad', text: result.error }); return; }
    // Fokus pryč z panelu (hlavně z tlačítka Odeslat po kliku, který nic neodeslal):
    // Enter / mezerník by jinak nový návrh odeslal bez myši (oponentura vlny B).
    liveReleaseTicketFocus(typeof document === 'undefined' ? null : document);
    setDraft(result.draft);
    setFromBox(false);
    setTicketOpen(true);
    setLineNotice({ at: now, tone: 'ok', text: `Návrh ${side === 'buy' ? 'BUY' : 'SELL'} ${result.draft.type === 'market' ? 'MKT' : 'LMT'} v panelu — odešle ho jen tlačítko panelu.` });
  };
  hotkeyHandlerRef.current = (event, fromChartEscape) => {
    if (!hotkeysOn) return;
    // Esc s otevřenou nápovědou patří nápovědě.
    if (fromChartEscape && hotkeysHelp) return;
    const intent = liveHotkeyAction(event, {
      dialogOpen: disarmConfirm || liveHotkeyOverlayOpen(typeof document === 'undefined' ? null : document),
      leaving,
      hidden: typeof document === 'undefined' || document.visibilityState !== 'visible',
      // Esc smí zahodit návrh jen z mostu grafu (kreslení ve všech panelech nečinné).
      ...(fromChartEscape ? { drawingIdle: true } : {}),
    });
    if (!intent || (intent.kind === 'discard-draft' && !fromChartEscape)) return;
    const now = Date.now();
    const replayText = liveHotkeyReplayBlocked(intent, chartReplay);
    if (replayText) {
      event.preventDefault();
      setLineNotice({ at: now, tone: 'bad', text: replayText });
      return;
    }
    // BE stejnou funkcí jako tlačítko na čáře, spočítané v okamžiku stisku.
    const breakEven = summary ? liveBreakEven(guardSummaryAt(now) ?? summary, manageEntryAvgPrice ?? null) : null;
    const outcome = resolveLiveHotkey(intent, { lines: orderLines, breakEven, hasDraft: draft != null, busy: liveBusyRef.current }, hotkeyRepeatRef, now);
    if (outcome.kind === 'none') return;
    event.preventDefault();
    dispatchLiveHotkeyOutcome(outcome, {
      prefill: prefillFromHotkey,
      discard: () => updateDraft(null),
      breakEven: line => liveOrderEntry.onOrderLineAction?.(line, 'break-even'),
      cancelLine: line => liveOrderEntry.onOrderLineCancel(line),
      notice: notice => setLineNotice({ at: now, ...notice }),
      // Shift+F jen požádá LiveSafetyControls o dialog Flatten All (INV-UI-02); nic neprovede.
      openFlatten: () => requestLiveSafetyConfirmation('flatten-group', 'hotkey'),
      toggleHelp: () => setHotkeysHelp(open => !open),
    });
  };
  useEffect(() => {
    if (!hotkeysOn) return undefined;
    const onKeyDown = (event: KeyboardEvent) => hotkeyHandlerRef.current(event, false);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hotkeysOn]);

  const surface = isDark ? 'bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900';
  const bar = isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white';
  const tabTone = (active: boolean) => (active
    ? 'border-indigo-500 text-indigo-500'
    : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-100' : 'text-slate-500 hover:text-slate-900'}`);

  const screen = (
    <div className={`fixed inset-0 z-[300] flex flex-col ${leaving ? 'live-chart-leave' : 'live-chart-enter'} ${surface} ${isDark ? 'dark' : ''}`} style={{ bottom: 'var(--live-safety-height, 0px)' }} role="region" aria-label="LIVE graf" aria-hidden={leaving || undefined}>
      {/* Aurorová záře při příchodu — jednou, pak je průhledná a nebere kliky. */}
      <div className="live-chart-aurora" aria-hidden="true" />
      {/* Vlastní vrstva nad grafem: rozbalovací okna hlavičky (účty skupiny,
          potvrzení vypnutí) jinak zapadnou pod plovoucí prvky grafu. */}
      <header className={`live-chart-header relative z-[800] flex h-11 shrink-0 items-center gap-1 border-b px-2 ${bar}`}>
        <span className="px-2 text-[11px] font-black tracking-[0.14em] text-indigo-500">LIVE</span>
        <nav className="flex h-full min-w-0 items-stretch gap-0.5 overflow-x-auto no-scrollbar" aria-label="LIVE navigace">
          {tabs.map(item => {
            const Icon = item.icon;
            const active = item.id === 'chart';
            // Na přehled (DISARM, kill) se jde vždy — INV-UI-02.
            const blocked = navigationBlocked && !active && item.id !== 'overview';
            return <button
              key={item.id}
              type="button"
              disabled={blocked}
              title={blocked ? 'Čekám na potvrzení změny konfigurace workerem' : undefined}
              onClick={() => onNavigate(item.id)}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[11.5px] font-bold transition-colors disabled:cursor-wait disabled:opacity-40 ${tabTone(active)}`}
            ><Icon size={13} />{item.label}</button>;
          })}
        </nav>
        <span className="flex-1" />
        {chart.liveSource && <span className={`hidden whitespace-nowrap px-2 font-mono text-[10px] 2xl:inline ${isDark ? 'text-slate-500' : 'text-slate-400'}`} title="Zdroj živé svíčky">{chart.liveSource}</span>}
        {/* Skutečný stav kopírky (jako stavová lišta LIVE); klik vede na přehled s vypnutím. */}
        {strip.notice && <button type="button" onClick={() => onNavigate('overview')} title={strip.notice} className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-rose-500/60 bg-rose-500/10 px-2.5 text-[11px] font-extrabold text-rose-500">Incident kopírky →</button>}
        {!strip.notice && attention.length > 0 && <button type="button" onClick={() => onNavigate('overview')} title={`Na přehledu: ${attention.join(', ')}.`} className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 text-[11px] font-extrabold text-amber-600">Zkontroluj Live Dashboard →</button>}
        {copier.reconnectRequired > 0 && <button type="button" onClick={() => onNavigate('overview')} className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 text-[11px] font-extrabold text-amber-600">Tradovate: přihlásit znovu</button>}
        {workerChip && <button type="button" onClick={() => onNavigate('overview')} title={workerChip.title} className={`flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-bold ${TONE[workerChip.tone].ring}`}>
          <i className={`h-[7px] w-[7px] rounded-full ${TONE[workerChip.tone].dot}`} />Worker <b className={TONE[workerChip.tone].text}>{workerChip.value}</b>
        </button>}
        {copierChip && <button
          type="button"
          onClick={() => onNavigate('overview')}
          title={`${copierChip.title ?? 'Stav kopírky ze stavu workeru.'} Zapnutí a vypnutí je na Live Dashboardu.`}
          className={`flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-bold ${TONE[copierChip.tone].ring} ${isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-white/70'}`}
        >
          <i className={`h-[7px] w-[7px] rounded-full ${TONE[copierChip.tone].dot}`} />Kopírka <b className={TONE[copierChip.tone].text}>{copierChip.value}</b>
        </button>}
        {disarm && onDisarm && <div className="relative">
          <button
            type="button"
            disabled={disarmBusy}
            onClick={() => (disarm.unverified ? setDisarmConfirm(open => !open) : void runDisarm())}
            title="Vypne kopírku stejnou cestou jako Live Dashboard. Pozice nezavírá; followeři přestanou dostávat posuny SL a výstupy."
            className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-rose-500/50 px-2.5 text-[11px] font-extrabold text-rose-500 hover:bg-rose-500/10 disabled:cursor-wait disabled:opacity-60"
          ><Power size={12} />{disarmBusy ? 'Vypínám…' : disarm.label}</button>
          {disarmConfirm && <div role="dialog" aria-label="Vypnout kopírku bez ověřeného stavu" className={`absolute right-0 top-[calc(100%+6px)] z-[95] grid w-[340px] gap-2 rounded-xl border p-3 text-[11.5px] leading-snug shadow-xl ${isDark ? 'border-white/10 bg-[#0d1219] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}>
            <b className="text-[12.5px]">Vypnout kopírku bez ověřeného stavu?</b>
            <span>{UNVERIFIED_DISARM_TEXT}</span>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDisarmConfirm(false)} className={`h-8 rounded-lg border px-3 font-extrabold ${isDark ? 'border-white/15' : 'border-slate-300'}`}>Zpět</button>
              <button type="button" onClick={() => void runDisarm()} className="h-8 rounded-lg bg-rose-600 px-3 font-extrabold text-white">Přesto vypnout</button>
            </div>
          </div>}
          {disarmResult && !disarmConfirm && <div role="status" className={`absolute right-0 top-[calc(100%+6px)] z-[95] w-[320px] rounded-xl border p-2.5 text-[11px] font-bold leading-snug shadow-xl ${disarmResult.tone === 'error' ? 'border-rose-500/50 bg-rose-500/10 text-rose-500' : isDark ? 'border-white/10 bg-[#0d1219] text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}>
            {disarmResult.text}
            <button type="button" onClick={() => setDisarmResult(null)} className="ml-2 opacity-70" aria-label="Zavřít">×</button>
          </div>}
        </div>}
        {group && <LiveGroupChip
          isDark={isDark}
          group={group}
          target={target}
          copierChip={copierChip}
          onOpenDashboard={() => onNavigate('overview')}
        />}
        <button
          type="button"
          // U3-PC pojistka: během přehrávání v grafu se panel neotevře (nic se z něj neodešle).
          disabled={chartReplay}
          title={chartReplay ? REPLAY_TICKET_TEXT : undefined}
          onClick={() => setTicketOpen(open => !open)}
          className={`ml-1 flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-extrabold disabled:cursor-not-allowed disabled:opacity-45 ${ticketOpen
            ? isDark ? 'bg-white/10 text-white' : 'bg-slate-900/[0.06] text-slate-900'
            : 'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-[0_6px_16px_-8px_#2563eb]'}`}
        >{ticketOpen ? <><PanelRightClose size={13} />Skrýt objednávku</> : <><PanelRightOpen size={13} />Objednávka</>}
          {/* Se zavřeným panelem ukazuje tlačítko běžící pozici (jen zobrazení z brokera). */}
          {!ticketOpen && summary?.kind === 'position' && <span className="rounded-[5px] bg-white/[0.18] px-1.5 py-px font-mono text-[10px] font-extrabold">
            {summary.side === 'long' ? 'LONG' : 'SHORT'} {summary.quantity}{(displayOpenPnl ?? summary.openPnl) != null ? ` · ${formatUsd((displayOpenPnl ?? summary.openPnl)!)}` : ''}
          </span>}
        </button>
        <button
          type="button"
          onClick={() => onNavigate('overview')}
          title="Zavřít graf (Live Dashboard)"
          aria-label="Zavřít graf"
          className={`ml-0.5 flex h-8 w-8 items-center justify-center rounded-md ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950'}`}
        ><X size={16} /></button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <ChartDataStatus quality={chart.quality} />
          <div className="relative min-h-0 flex-1">
          {lineNotice && <div role="status" className={`absolute left-1/2 top-2 z-[700] max-w-[440px] -translate-x-1/2 rounded-lg border px-3 py-1.5 text-[11.5px] font-bold shadow-lg ${lineNotice.tone === 'ok'
            ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-200'
            : lineNotice.tone === 'bad' ? 'border-rose-500/40 bg-rose-950/90 text-rose-200' : 'border-amber-500/40 bg-amber-950/90 text-amber-100'}`}>{lineNotice.text}</div>}
          <LiveTradeToasts events={copier.available ? copyEvents ?? copier.status?.recentCopyEvents : undefined} copierArmed={copier.available && copier.status?.armed === true && copier.status.shadowMode !== true} isDark={isDark} />
          {chart.candles.length > 0 ? (
            <AlphaTradeChartWorkspace
              key={day}
              embedded
              trade={anchor}
              entryMs={anchor.entryTime!}
              exitMs={anchor.timestamp}
              initialRoot={ROOT}
              layoutScope="live-trading"
              defaultLayoutId="1"
              initialCandles={chart.candles}
              isDark={isDark}
              toolbarEnd={<>
                <LiveFillAnnounceToggle isDark={isDark} />
                <LiveHotkeysHelp isDark={isDark} enabled={hotkeysOn} onEnabledChange={changeHotkeys} open={hotkeysHelp} onOpenChange={setHotkeysHelp} />
                <LiveThemeToggle isDark={isDark} preference={themePreference} />
              </>}
              tradeIndicators={tradeIndicators}
              onTradeIndicatorsChange={writeTradeChartIndicators}
              liveCandles={chart.liveFeed}
              resetViewOnOpen
              liveOrderEntry={liveOrderEntry}
              livePriceLines={positionLines}
              onClose={() => onNavigate('overview')}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              {chart.loading ? <QuantumSpinner /> : (
                <div className="max-w-[420px]">
                  <p className="m-0 text-sm font-extrabold">Svíčky pro dnešek nejsou</p>
                  <p className={`mt-1.5 text-[12.5px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{chart.error ?? 'Živé svíčky chybí — zkontroluj worker a zdroj ceny (IBKR / TradingView).'}</p>
                </div>
              )}
            </div>
          )}
          </div>
        </div>
        {/* Přilepený ke grafu; zavřený zůstává připojený (bez šířky, inert),
            aby otevření i zavření mohlo plynule animovat. */}
        <div className={`live-chart-ticket-dock ${ticketOpen && !chartReplay ? 'is-open' : ''}`} inert={!ticketOpen || chartReplay} aria-hidden={!ticketOpen || chartReplay || undefined}>
        <aside className="live-chart-ticket h-full w-[304px]">
          <LiveOrderTicket
            isDark={isDark}
            instrument={INSTRUMENT}
            quote={quote}
            draft={draft}
            onDraft={updateDraft}
            fromBox={fromBox}
            units={units}
            onUnits={setUnits}
            scope={scope}
            onScope={setScope}
            group={group}
            target={target}
            onTarget={setPickedTarget}
            quoteInfo={quoteInfo}
            position={position}
            onPreviewEntry={onPreviewEntry}
            {...(onPlaceEntry ? { onPlaceEntry } : {})}
            {...(onManageEntry ? { onManageEntry } : {})}
            manageEntryAvgPrice={manageEntryAvgPrice ?? null}
            entryMarketSupported={entryMarketSupported}
            entryMaxContracts={entryMaxContracts}
            entryScaleIn={entryScaleIn}
            entryFrontContract={entryFrontContract}
            // U4/U8/U10 (3. 11. 2026): jen podklady panelu; příkazy dál jen přes callbacky desku.
            entryBareSupported={entryBareSupported}
            entryBareEntry={entryBareEntry}
            entryLeaderPosition={entryLeaderPosition}
            {...(onAttachBrackets ? { onAttachBrackets } : {})}
            entryBlockedReason={entryBlockedReason}
            attachLegs={attachLegs}
            onAttachLegs={setAttachLegs}
            manageLeaderAccountId={manageLeaderAccountId}
            manageGuardAt={guardSummaryAt}
            manageRunner={onManageEntry ? manageRunner : null}
            managePendingLegs={managePendingLegsSupported === true}
            attachPanelOpen={ticketOpen && !chartReplay}
            attachSent={attachSent}
            onAttachSent={setAttachSentFor}
            // C8: × holé pozice i z panelu — tatáž funkce jako čára (jeden zámek, id cíle).
            bareClose={bareOffer}
            {...(bareOffer ? { onBareClose: closeBare } : {})}
            // Vstup, Přidat SL/TP i × z panelu jdou TÍMTÉŽ zámkem jako čáry, zkratky, lišta C7 a Dashboard.
            commandLockRef={liveBusyRef}
            userId={userId}
            onNewDraft={side => {
              if (!quote) return;
              const next = newDraft(side, 'limit', side === 'buy' ? quote.ask - 10 : quote.bid + 10);
              if (next) { setDraft(next); setFromBox(false); }
            }}
            onClose={() => setTicketOpen(false)}
          />
        </aside>
        </div>
      </div>
    </div>
  );
  return createPortal(screen, document.body);
};

export default LiveTradingScreen;
