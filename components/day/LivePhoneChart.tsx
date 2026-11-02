import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionConfig, Trade } from '../../types';
import DayFullscreenChart from './DayFullscreenChart';
import { useDayController } from './useDayController';
import { focusRange } from './dayFocus';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import type { MarketTimeframe } from '../../services/marketData';
import { LIVE_PHONE_INSTRUMENT, draftSummary, readLivePillPrefs, writeLivePillPrefs, type LivePillPrefs } from '../../lib/livePhoneTrade';
import { draftFromPositionBox, type TicketDraft } from '../../lib/liveOrderTicket';
import { LiveChartNotice, LiveQtySheet, LiveTradePill, LiveTradeToggle } from './LivePhoneTrade';
import LivePhoneOrderSheet from './LivePhoneOrderSheet';
import { LivePhoneAttachSheet, LivePhonePositionBar } from './LivePhoneLiveActions';
import { useLiveTicketQuote } from '../../hooks/useLiveTicketQuote';
import { previewSymbolFromChartSource } from '../../lib/leaderEntryPreview';
import { snapToTick } from '../../lib/liveOrderTicket';
import {
  livePhoneBareMarket, livePhoneOperationId, livePhonePlacedText, livePhoneSheetEntry,
  type LivePhoneQuote, type LivePhoneTradeBridge,
} from '../../lib/livePhoneOrders';
import type { LiveEntryPreviewDraft } from '../../lib/leaderEntryPreview';
import { LivePhoneAccountsSheet, LivePhoneGroupPnl } from './LivePhoneAccounts';
import type { LiveChartPosition } from '../../lib/liveChartPosition';
import { createLivePriceLinesFeed } from '../../lib/livePriceLinesFeed';
import './dayJournal.css';

export interface LivePhoneChartSlots {
  /** LIVE hlavička nad grafem (LIVE ▾, skupina, stav kopírky); `group` = P&L skupiny místo názvu. */
  header: (group?: React.ReactNode) => React.ReactNode;
  /** Vrstvy LIVE nad grafem (menu záložek). */
  overlay?: React.ReactNode;
  /** Obchodování z telefonu (2. 11. 2026): stejný relay jako PC; null = jen zobrazení. */
  trade?: LivePhoneTradeBridge | null;
  /** Živá pozice a účty skupiny — stejný read model jako PC graf, jen zobrazení. */
  position: LiveChartPosition;
}

/** Market jen s cenou kanálu mladší než tohle (worker ji ověří znovu proti IBKR). */
const PHONE_MARKET_QUOTE_MAX_AGE_MS = 3_000;

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
  const [timeframe, setTimeframeState] = useState<MarketTimeframe>(() => readStoredDayChartTimeframe(typeof window === 'undefined' ? null : window.localStorage));
  const setTimeframe = (next: MarketTimeframe) => { setTimeframeState(next); writeStoredDayChartTimeframe(window.localStorage, next); };
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
  const contract = previewSymbolFromChartSource(ctl.chart.liveSource);
  const quote = useMemo<LivePhoneQuote | null>(() => {
    if (!tick || ctl.chart.liveStatus !== 'live') return null;
    const bid = snapToTick(tick.price, LIVE_PHONE_INSTRUMENT.tickSize);
    return { symbol: contract, bid, ask: bid + LIVE_PHONE_INSTRUMENT.tickSize, at: tick.at };
  }, [tick, contract, ctl.chart.liveStatus]);
  // Jeden příkaz naráz (zámek přes ref — dvojklep nepošle druhý; nový operationId jen za nový pokus).
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const say = (text: string) => setNotice({ key: Date.now(), text });
  const send = async (draft: LiveEntryPreviewDraft | { error: string }) => {
    if ('error' in draft) { say(draft.error); return; }
    if (!trade || busyRef.current) return;
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
      : trade.blockedReason ?? (market && !trade.marketSupported ? 'Worker zatím neumí Market.'
        : !quote || Date.now() - quote.at > PHONE_MARKET_QUOTE_MAX_AGE_MS ? 'Cena není čerstvá (starší než 3 s) — nic se neodeslalo.'
          : !(quote.symbol ?? (market ? null : trade.frontContract)) ? 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.' : null)
  );
  const sheetContract = (type: string): string | null => (quote?.symbol ?? (type === 'limit' ? trade?.frontContract ?? null : null)
  );
  // Lišta: Koupit / Prodat = holý Market hned (Filip 1. 11.), SL/TP doplní „Přidat SL/TP“.
  const onSide = (side: 'buy' | 'sell') => {
    const blocked = sendBlocked(true) ?? (!trade!.bareSupported ? 'Worker zatím neumí Market bez SL/TP.'
      : pill.qty > trade!.maxContracts ? `Strop ručního vstupu je ${trade!.maxContracts} kontraktů.` : null);
    if (blocked) { say(blocked); return; }
    void send(livePhoneBareMarket(side, pill.qty, quote!));
  };
  const [attachOpen, setAttachOpen] = useState(false);
  const position = trade?.position ?? null;
  const marketNow = quote ? (position?.side === 'short' ? quote.ask : quote.bid) : null;
  // Objednávka z position toolu: návrh jako ⚡ na PC (draftFromPositionBox), velikost v kontraktech.
  const [order, setOrder] = useState<{ key: number; draft: TicketDraft } | null>(null);
  const quoteOf = (lastPrice: number) => ({ bid: lastPrice, ask: lastPrice });
  // Pozice v grafu: čáry vstupu a SL/TP z read modelu (jen zobrazení, neověřené = žádné čáry).
  const chartPosition = slots.position;
  const [priceLines] = useState(createLivePriceLinesFeed);
  useEffect(() => { priceLines.publish(chartPosition.symbol, chartPosition.lines); }, [chartPosition.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => priceLines.publish(null, []), [priceLines]);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const showGroup = chartPosition.summary != null || chartPosition.issue != null;
  useEffect(() => { if (!chartPosition.summary) setAccountsOpen(false); }, [chartPosition.summary]);
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
        header: slots.header(showGroup ? <LivePhoneGroupPnl position={chartPosition} onOpen={() => setAccountsOpen(true)} /> : undefined),
        priceLines,
        overlay: ({ lastPrice }) => <>
          {slots.overlay}
          {accountsOpen && chartPosition.summary && <LivePhoneAccountsSheet position={chartPosition} onClose={() => setAccountsOpen(false)} />}
          {qtySheet && <LiveQtySheet value={pill.qty} onClose={() => setQtySheet(false)} onDone={qty => { savePill({ ...pill, qty }); setQtySheet(false); }} />}
          {order && lastPrice != null && (
            <LivePhoneOrderSheet
              key={order.key}
              initial={order.draft}
              instrument={LIVE_PHONE_INSTRUMENT}
              quote={quoteOf(lastPrice)}
              onClose={() => setOrder(null)}
              onSubmit={draft => {
                setOrder(null);
                const blocked = sendBlocked(draft.type === 'market')
                  ?? (draft.quantity > (trade?.maxContracts ?? 1) ? `Strop ručního vstupu je ${trade?.maxContracts ?? 1} kontraktů.` : null);
                if (blocked) { say(`${draftSummary(draft)} — ${blocked}`); return; }
                // Limit/Stop bez IBKR: kontrakt podle brokera (worker ho ověří znovu); Market jen z IBKR.
                void send(livePhoneSheetEntry(draft, LIVE_PHONE_INSTRUMENT, { ...quote!, symbol: sheetContract(draft.type) }));
              }}
            />
          )}
          {attachOpen && position && marketNow != null && position.bareEntryOperationId && (
            <LivePhoneAttachSheet
              side={position.side}
              market={marketNow}
              tickSize={LIVE_PHONE_INSTRUMENT.tickSize}
              onClose={() => setAttachOpen(false)}
              onSubmit={(stopLoss, takeProfit) => {
                setAttachOpen(false);
                if (!trade || busyRef.current) return;
                busyRef.current = true;
                setBusy(true);
                void trade.attach({ entryOperationId: position.bareEntryOperationId!, symbol: position.symbol, quantity: position.quantity, expectPrice: marketNow, stopLoss, takeProfit })
                  .then(result => say(result.status === 'acknowledged' ? 'SL a TP přijaty brokerem.'
                    : result.status === 'blocked' ? `Neodesláno: ${result.blockers[0]?.text ?? ''}` : result.reason ?? 'Výsledek neznámý — zkontroluj pozici.'))
                  .catch(error => say(`Neodesláno / neznámé: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'}`))
                  .finally(() => { busyRef.current = false; setBusy(false); });
              }}
            />
          )}
        </>,
        onPositionOrder: (drawing, { lastPrice }) => {
          if (lastPrice == null) { setNotice({ key: Date.now(), text: 'Cena trhu zatím není — objednávku nejde připravit.' }); return; }
          try {
            const { draft, quantity } = draftFromPositionBox(drawing, LIVE_PHONE_INSTRUMENT, quoteOf(lastPrice));
            setOrder({ key: Date.now(), draft: { ...draft, sizing: 'qty', quantity: Math.max(1, quantity) } });
          } catch (error) {
            setNotice({ key: Date.now(), text: error instanceof Error ? error.message : 'Position box nejde převést na objednávku.' });
          }
        },
        // Bid/ask ze streamu přijde s napojením dat; zatím poslední cena svíčky.
        chartLayer: ({ lastPrice }) => <>
          {position && <LivePhonePositionBar
            side={position.side} quantity={position.quantity} symbol={position.symbol} pending={position.pending}
            unprotected={position.bareEntryOperationId != null} busy={busy}
            onAttach={() => { if (marketNow == null) say('Cena není čerstvá — SL/TP teď nejde připravit.'); else setAttachOpen(true); }}
            onClose={() => { void trade?.flatten().then(say, error => say(`Flatten: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'}`)); }}
          />}
          <LiveTradePill prefs={pill} onPrefs={savePill} bid={quote?.bid ?? lastPrice} ask={quote?.ask ?? lastPrice} onQty={() => setQtySheet(true)} onSide={onSide} />
          {notice && <LiveChartNotice key={notice.key} text={notice.text} onDone={clearNotice} />}
        </>,
        symbol: LIVE_PHONE_INSTRUMENT.symbol,
        toolbar: <LiveTradeToggle on={pill.on} onToggle={() => savePill({ ...pill, on: !pill.on })} />,
      }}
    />
  );
}
