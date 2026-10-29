import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import type { Trade } from '../types';
import AlphaTradeChartWorkspace, { type LiveOrderEntryBridge } from './AlphaTradeChartWorkspace';
import LiveOrderTicket, { formatPrice, type TicketScope } from './LiveOrderTicket';
import LiveGroupChip from './LiveGroupChip';
import { QuantumSpinner } from './QuantumLoader';
import { useDayChartData } from '../hooks/useDayChartData';
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
import { buildLiveStatusStrip, liveAttentionReasons, type LiveStatusStripInput, type LiveStatusTone } from '../services/liveStatusStrip';
import type { TradovateLiveTab } from '../lib/tradovateLiveTab';

/**
 * LIVE → Graf: živý graf MNQ přes celou obrazovku s panelem objednávky vpravo
 * a záložkami LIVE nahoře (Filip 29. 10.: klik na LIVE otevře rovnou graf).
 *
 * Jen UI. Svíčky jsou stejné jako v grafu dne (historie + živá svíčka).
 * Panel objednávky, ⚡ z position boxu, pravý klik do grafu a čáry návrhu
 * nic neodesílají. Skutečný je jen stav kopírky v hlavičce (stejný model
 * jako stavová lišta LIVE, jen zobrazení) — vrstva přes celou obrazovku nesmí
 * schovat, že je kopírka vypnutá, zastavená nebo v incidentu. Účty skupiny
 * jsou do napojení na worker ukázková data, a to jen v dev buildu.
 */

const ROOT = 'MNQ' as const;
const INSTRUMENT: TicketInstrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const NO_TRADES: Trade[] = [];
const MINUTE = 60_000;
/** Ukázkové účty jen v dev buildu — do produkce se vymyšlená čísla nedostanou. */
const SAMPLE_GROUP_ENABLED = import.meta.env.DEV;
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
  /** Dohrává se odchod z grafu (animace, vrstva už nebere kliky). */
  leaving?: boolean;
}

function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const LiveTradingScreen: React.FC<Props> = ({ isDark, tabs, onNavigate, navigationBlocked = false, copier, leaving = false }) => {
  const now = useMinuteNow();
  const day = chartMarketDay(pragueDayKey(now));
  const chart = useDayChartData(day, NO_TRADES, NO_TRADES, now);

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

  // Orientační bid/ask panelu = close poslední svíčky dat grafu a o tick výš.
  // Rozpracovanou svíčku z kanálu ceny čte jen napojení grafu (INV-UI-04,
  // tests/tvPriceClientGuards.test.ts); skutečná kotace přijde od brokera
  // s napojením panelu.
  const lastPrice = chart.candles.at(-1)?.close ?? null;
  const quoteInfo = {
    source: chart.liveSource,
    capturedAt: chart.liveCapturedAt,
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
  const armed = copier.available && copier.status ? copier.status.armed : null;
  const group = useMemo<LiveTradeGroup | null>(
    () => (SAMPLE_GROUP_ENABLED ? { ...SAMPLE_LIVE_TRADE_GROUP, armed } : null),
    [armed],
  );
  const [ticketOpen, setTicketOpen] = useState(true);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [fromBox, setFromBox] = useState(false);
  const [units, setUnits] = useState<TicketBracketUnits>('pts');
  const [scope, setScope] = useState<TicketScope>('account');
  const [pickedTarget, setPickedTarget] = useState<LiveTradeTarget>(GROUP_TARGET);
  const target = group ? effectiveTarget(group, pickedTarget) : GROUP_TARGET;
  // Návrh se sám nezakládá: čáry SL/TP na živém grafu jen když o ně uživatel požádá.
  const [tradeIndicators] = useState(readTradeChartIndicators);

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
    () => (draft && quote && ticketOpen ? liveDraftChartLines(draft, INSTRUMENT, quote, picked?.short) : []),
    [draft, picked?.short, quote, ticketOpen],
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
    onOrderLineChange: (_line, kind, price) => {
      setDraft(previous => {
        if (!previous) return previous;
        if (kind === 'entry') return withEntryPrice(previous, price, INSTRUMENT);
        const snapped = snapToTick(price, INSTRUMENT.tickSize);
        return kind === 'stopLoss' ? { ...previous, stopLoss: snapped } : { ...previous, takeProfit: snapped };
      });
    },
    onOrderLineCancel: line => {
      if (line.kind === 'entry') { updateDraft(null); return; }
      setDraft(previous => (previous ? (line.kind === 'stopLoss' ? { ...previous, stopLoss: null } : { ...previous, takeProfit: null }) : previous));
    },
    onOrderLineAddBracket: (_line, kind, price) => {
      if (!quote) return;
      setDraft(previous => (previous ? withBracket(previous, kind === 'stopLoss' ? 'sl' : 'tp', INSTRUMENT, quote, price) : previous));
    },
  }), [draft, orderLines, quote, updateDraft]);

  const surface = isDark ? 'bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900';
  const bar = isDark ? 'border-white/10 bg-[#0d1219]' : 'border-slate-200 bg-white';
  const tabTone = (active: boolean) => (active
    ? 'border-indigo-500 text-indigo-500'
    : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-100' : 'text-slate-500 hover:text-slate-900'}`);

  const screen = (
    <div className={`fixed inset-0 z-[300] flex flex-col ${leaving ? 'live-chart-leave' : 'live-chart-enter'} ${surface} ${isDark ? 'dark' : ''}`} role="dialog" aria-label="LIVE graf" aria-hidden={leaving || undefined}>
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
        <div className="relative min-w-0 flex-1">
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
