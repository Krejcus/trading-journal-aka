import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRightClose, PanelRightOpen, Power, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type LiveOrderEntryBridge } from './AlphaTradeChartWorkspace';
import LiveOrderTicket, { formatPrice, type TicketScope } from './LiveOrderTicket';
import LiveGroupChip from './LiveGroupChip';
import LiveTradeToasts from './LiveTradeToasts';
import { QuantumSpinner } from './QuantumLoader';
import ChartDataStatus from './ChartDataStatus';
import { useDayChartData } from '../hooks/useDayChartData';
import { useLiveTicketQuote } from '../hooks/useLiveTicketQuote';
import { perfDuration, perfMark } from '../lib/perfTrace';
import { DAY_ANCHOR_ACCOUNT_ID, chartMarketDay, pragueDayKey } from '../lib/dayJournal';
import {
  draftFromPositionBox,
  liveDraftChartLines,
  newTicketDraft,
  snapToTick,
  ticketQuantity,
  withBracket,
  withEntryPrice,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketInstrument,
  type TicketQuote,
} from '../lib/liveOrderTicket';
import {
  GROUP_TARGET,
  SAMPLE_LIVE_TRADE_GROUP,
  effectiveTarget,
  targetAccount,
  type LiveTradeGroup,
  type LiveTradeTarget,
} from '../lib/liveTradeTarget';
import { readTradeChartIndicators, writeTradeChartIndicators } from '../services/detailIndicators';
import { createLivePriceLinesFeed } from '../lib/livePriceLinesFeed';
import { LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPosition } from '../lib/liveChartPosition';
import type { LiveChartDisarm } from '../lib/liveTradeGroupSource';
import type { LeaderEntryPreviewResult, LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import { buildLiveStatusStrip, liveAttentionReasons, type LiveStatusStripInput, type LiveStatusTone } from '../services/liveStatusStrip';
import type { TradovateLiveTab } from '../lib/tradovateLiveTab';

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
  tabs: LiveTradingTab[];
  onNavigate: (tab: TradovateLiveTab) => void;
  /** Záložky jsou dočasně zamčené (desk čeká na potvrzení změny konfigurace); přehled zůstává dostupný. */
  navigationBlocked?: boolean;
  copier: LiveTradingCopierState;
  /** Události pro karty obchodů (poll ∪ expozice přímo z workeru, F2a); chybí = ze statusu. */
  copyEvents?: readonly LiveTradingCopyEvent[];
  /** Měření poslední rychlé expozice; nepoužívá se pro stav ani příkazy. */
  liveExposurePaint?: { id: string; receivedPerformanceAt: number } | null;
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
}

function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const LiveTradingScreen: React.FC<Props> = ({
  isDark, tabs, onNavigate, navigationBlocked = false, copier, copyEvents, liveExposurePaint, chartOpenPerformanceAt = 0, leaving = false,
  group: workerGroup = null, position = null, disarm = null, onDisarm, onTargetChange, onPreviewEntry, onPlaceEntry, onManageEntry, manageEntryAvgPrice, manageCloseSupported = false,
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
  const measuredExposureId = useRef<string | null>(null);
  useEffect(() => {
    if (!liveExposurePaint || measuredExposureId.current === liveExposurePaint.id) return undefined;
    measuredExposureId.current = liveExposurePaint.id;
    let painted = false;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        painted = true;
        perfDuration('live:exposure:to-paint', performance.now() - liveExposurePaint.receivedPerformanceAt);
      });
    });
    return () => {
      if (!painted) perfMark('live:exposure:paint-superseded');
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
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
  const [ticketOpen, setTicketOpen] = useState(true);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [fromBox, setFromBox] = useState(false);
  const [units, setUnits] = useState<TicketBracketUnits>('pts');
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
  const [pendingMove, setPendingMove] = useState<{ kind: 'stopLoss' | 'takeProfit'; price: number; until: number } | null>(null);
  const [lineNotice, setLineNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string; at: number } | null>(null);
  const liveBusyRef = useRef(false);
  useEffect(() => {
    if (!pendingMove) return undefined;
    const landed = pendingMove.kind === 'stopLoss' ? summary?.stop : summary?.target;
    if (landed === pendingMove.price) { setPendingMove(null); return undefined; }
    if (!Number.isFinite(pendingMove.until)) return undefined;
    const timer = window.setTimeout(() => setPendingMove(null), Math.max(0, pendingMove.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pendingMove, summary?.stop, summary?.target]);
  useEffect(() => {
    if (!lineNotice) return undefined;
    const timer = window.setTimeout(() => setLineNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [lineNotice]);
  const liveLines = useMemo(() => (summary ? livePositionChartLines(summary, {
    manageable: Boolean(onManageEntry),
    // × u pozice jen za čerstvě zapnuté kopírky (ne shadow) — jinak by kopie zůstaly otevřené (Flatten na přehledu).
    canClose: manageCloseSupported && copier.available && copier.status?.armed === true && copier.status.shadowMode !== true,
    entryAvg: manageEntryAvgPrice ?? null,
    pointValue: INSTRUMENT.pointValue,
    ...(pendingMove ? { pending: { [pendingMove.kind]: pendingMove.price } } : {}),
  }) : []), [copier.available, copier.status, manageCloseSupported, manageEntryAvgPrice, onManageEntry, pendingMove, summary]);
  const runLiveManage = useCallback(async (
    action: LeaderOrderManageAction, expectPrice: number | null | undefined, newPrice?: number, move?: 'stopLoss' | 'takeProfit',
  ) => {
    if (!onManageEntry || expectPrice == null) return;
    if (liveBusyRef.current) { setLineNotice({ at: Date.now(), tone: 'warn', text: 'Čeká se na výsledek předchozí změny — nic se neodeslalo.' }); return; }
    liveBusyRef.current = true;
    // „Odesílám“ drží, dokud příkaz neskončí (relay čeká až ~35 s), pak ještě chvíli na dosednutí ceny.
    if (move && newPrice != null) setPendingMove({ kind: move, price: newPrice, until: Number.POSITIVE_INFINITY });
    try {
      const result = await onManageEntry(action, expectPrice, newPrice);
      if (result.status !== 'acknowledged') setPendingMove(null);
      else setPendingMove(current => (current ? { ...current, until: Date.now() + 5_000 } : current));
      setLineNotice({ at: Date.now(), ...(result.status === 'acknowledged'
        ? (result.reason && /zastavila|spustil|vyplnil|skončil|ne tímto|Flatten/.test(result.reason)
          ? { tone: 'warn' as const, text: result.reason }
          : { tone: 'ok' as const, text: action === 'cancel-entry' ? 'Vstup zrušen; kopírka zruší kopie.'
            : action === 'close-position' ? 'Leader zavřen; kopírka zavírá kopie.' : 'Posunuto u leadera; kopírka posune kopie.' })
        : result.status === 'blocked' ? { tone: 'bad' as const, text: `Neodesláno: ${result.blockers.map(issue => issue.text).join(' ')}` }
          : result.status === 'rejected' ? { tone: 'bad' as const, text: result.reason ?? 'Broker změnu odmítl.' }
            : { tone: 'warn' as const, text: result.reason ?? 'Výsledek neznámý — zkontroluj leadera v Tradovate.' }) });
    } catch (reason) {
      setPendingMove(null);
      const message = reason instanceof Error ? reason.message : 'chyba';
      // Prokazatelně neodeslané (strop, rozestup, chybějící cesta, neověřený stav) = „Neodesláno“.
      setLineNotice({ at: Date.now(), ...(/entry-busy|manage-daily-cap|entry-daily-cap|Chybí cesta|není čerstvě ověřený|nic se neodeslalo/.test(message)
        ? { tone: 'bad' as const, text: `Neodesláno: ${/entry-busy/.test(message) ? 'jiná změna se právě zpracovává' : message.slice(0, 120)}` }
        : { tone: 'warn' as const, text: `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate.` }) });
    } finally {
      liveBusyRef.current = false;
    }
  }, [onManageEntry]);
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
  const [tradeIndicators] = useState(readTradeChartIndicators);

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
    if (previous == null || previous === entry) return;
    const delta = entry - previous;
    setDraft(current => (current && current.type === 'market' ? {
      ...current,
      stopLoss: current.stopLoss == null ? null : snapToTick(current.stopLoss + delta, INSTRUMENT.tickSize),
      takeProfit: current.takeProfit == null ? null : snapToTick(current.takeProfit + delta, INSTRUMENT.tickSize),
    } : current));
  }, [draft?.side, draft?.type, quote]);

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

  const picked = group ? targetAccount(group, target) : null;
  const orderLines = useMemo(
    () => [...liveLines, ...(draft && quote && ticketOpen ? liveDraftChartLines(draft, INSTRUMENT, quote, picked?.short) : [])],
    [draft, liveLines, picked?.short, quote, ticketOpen],
  );

  const liveOrderEntry = useMemo<LiveOrderEntryBridge>(() => ({
    executionInstrument: ROOT,
    chartOrderQuantity: draft && quote ? Math.max(1, ticketQuantity(draft, INSTRUMENT, quote)) : 1,
    orderLines,
    onQuickOrder: ({ drawing }) => {
      if (!quote) return { ok: false, message: 'Čekám na cenu z grafu.' };
      try {
        const next = draftFromPositionBox(drawing, INSTRUMENT, quote);
        setDraft(next.draft);
        setFromBox(true);
        setTicketOpen(true);
        const kind = next.draft.type === 'market' ? 'MKT' : next.draft.type === 'limit' ? 'LMT' : 'STP';
        return {
          ok: true,
          message: `⚡ ${next.draft.side === 'buy' ? 'BUY' : 'SELL'} ${kind} ${next.quantity} @ ${formatPrice(next.draft.price)} — zkontroluj v panelu`,
        };
      } catch (reason) {
        return { ok: false, message: reason instanceof Error ? reason.message : 'Z boxu se nepodařilo vytvořit návrh.' };
      }
    },
    onChartOrder: input => {
      if (!quote) return;
      setDraft(previous => newTicketDraft(input.side, input.type, input.price ?? quote.ask, INSTRUMENT, quote, {
        sizing: previous?.sizing ?? 'qty',
        quantity: input.quantity,
        riskUsd: previous?.riskUsd ?? 200,
      }));
      setFromBox(false);
      setTicketOpen(true);
    },
    livePositionOwnerId: LIVE_POSITION_OWNER,
    onOrderLineChange: (line, kind, price, startLine) => {
      if (line.ownerId === LIVE_POSITION_OWNER) {
        if (!summary || kind === 'entry') return;
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        const current = kind === 'stopLoss' ? summary.stop : summary.target;
        // „Co jsem viděl“ = cena při chycení čáry; změnila-li se během tahu, nic neposílat.
        if (startLine && startLine.price !== current) {
          setLineNotice({ at: Date.now(), tone: 'bad', text: `${kind === 'stopLoss' ? 'SL' : 'TP'} se během tažení změnil — nic se neodeslalo.` });
          return;
        }
        if (snapped === current) return;
        const blocked = liveLineMoveBlockReason(summary, kind, snapped);
        if (blocked) { setLineNotice({ at: Date.now(), tone: 'bad', text: blocked }); return; }
        void runLiveManage(kind === 'stopLoss' ? 'move-stop' : 'move-target', current, snapped, kind);
        return;
      }
      setDraft(previous => {
        if (!previous) return previous;
        if (kind === 'entry') return withEntryPrice(previous, price, INSTRUMENT);
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        return kind === 'stopLoss' ? { ...previous, stopLoss: snapped } : { ...previous, takeProfit: snapped };
      });
    },
    onOrderLineCancel: line => {
      if (line.ownerId === LIVE_POSITION_OWNER) {
        if (line.kind === 'entry' && summary?.kind === 'pending') void runLiveManage('cancel-entry', summary.leader?.entry);
        // Zavřít obchod: „co jsem viděl“ = SL leadera (+ qty leadera v desku); worker ověří tvar u brokera.
        if (line.kind === 'entry' && summary?.kind === 'position') void runLiveManage('close-position', summary.stop);
        return;
      }
      if (line.kind === 'entry') { updateDraft(null); return; }
      setDraft(previous => (previous ? (line.kind === 'stopLoss' ? { ...previous, stopLoss: null } : { ...previous, takeProfit: null }) : previous));
    },
    onOrderLineAction: (line, actionId) => {
      if (line.ownerId !== LIVE_POSITION_OWNER || actionId !== 'break-even' || !summary) return;
      const be = liveBreakEven(summary, manageEntryAvgPrice ?? null);
      if (be.blocked || be.price == null) { setLineNotice({ at: Date.now(), tone: 'bad', text: be.blocked ?? 'BE teď nejde.' }); return; }
      void runLiveManage('move-stop', summary.stop, be.price, 'stopLoss');
    },
    onOrderLineAddBracket: (_line, kind, price) => {
      if (!quote) return;
      setDraft(previous => (previous ? withBracket(previous, kind === 'stopLoss' ? 'sl' : 'tp', INSTRUMENT, quote, price) : previous));
    },
  }), [draft, manageEntryAvgPrice, orderLines, quote, runLiveManage, summary, updateDraft]);

  const surface = isDark ? 'bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900';
  const bar = isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white';
  const tabTone = (active: boolean) => (active
    ? 'border-indigo-500 text-indigo-500'
    : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-100' : 'text-slate-500 hover:text-slate-900'}`);

  const screen = (
    <div className={`fixed inset-0 z-[300] flex flex-col ${leaving ? 'live-chart-leave' : 'live-chart-enter'} ${surface} ${isDark ? 'dark' : ''}`} style={{ bottom: 'var(--live-safety-height, 100px)' }} role="region" aria-label="LIVE graf" aria-hidden={leaving || undefined}>
      {/* Aurorová záře při příchodu — jednou, pak je průhledná a nebere kliky. */}
      <div className="live-chart-aurora" aria-hidden="true" />
      <header className={`live-chart-header flex h-11 shrink-0 items-center gap-1 border-b px-2 ${bar}`}>
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
          onClick={() => setTicketOpen(open => !open)}
          className={`ml-1 flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-extrabold ${ticketOpen
            ? isDark ? 'bg-white/10 text-white' : 'bg-slate-900/[0.06] text-slate-900'
            : 'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-[0_6px_16px_-8px_#2563eb]'}`}
        >{ticketOpen ? <><PanelRightClose size={13} />Skrýt objednávku</> : <><PanelRightOpen size={13} />Objednávka</>}</button>
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
        {ticketOpen && <aside className="live-chart-ticket w-[304px] shrink-0 p-2 pl-0">
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
            onNewDraft={side => { if (quote) { setDraft(newTicketDraft(side, 'limit', side === 'buy' ? quote.ask - 10 : quote.bid + 10, INSTRUMENT, quote)); setFromBox(false); } }}
            onClose={() => setTicketOpen(false)}
          />
        </aside>}
      </div>
    </div>
  );
  return createPortal(screen, document.body);
};

export default LiveTradingScreen;
