import React, { useCallback, useState } from 'react';
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
import './dayJournal.css';

export interface LivePhoneChartSlots {
  /** LIVE hlavička nad grafem (LIVE ▾, skupina, stav kopírky). */
  header: React.ReactNode;
  /** Vrstvy LIVE nad grafem (menu záložek). */
  overlay?: React.ReactNode;
}

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
  // Fáze A: lišta je jen UI. Odesílání z telefonu se napojí zvlášť (invarianty + oponentura).
  const onSide = (side: 'buy' | 'sell') => setNotice({ key: Date.now(), text: `${side === 'buy' ? 'Koupit' : 'Prodat'} ${pill.qty} market — nic se neodeslalo. Odesílání z telefonu napojíme v další fázi.` });
  // Objednávka z position toolu: návrh jako ⚡ na PC (draftFromPositionBox), velikost v kontraktech.
  const [order, setOrder] = useState<{ key: number; draft: TicketDraft } | null>(null);
  const quoteOf = (lastPrice: number) => ({ bid: lastPrice, ask: lastPrice });
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
        header: slots.header,
        overlay: ({ lastPrice }) => <>
          {slots.overlay}
          {qtySheet && <LiveQtySheet value={pill.qty} onClose={() => setQtySheet(false)} onDone={qty => { savePill({ ...pill, qty }); setQtySheet(false); }} />}
          {order && lastPrice != null && (
            <LivePhoneOrderSheet
              key={order.key}
              initial={order.draft}
              instrument={LIVE_PHONE_INSTRUMENT}
              quote={quoteOf(lastPrice)}
              onClose={() => setOrder(null)}
              onSubmit={draft => { setOrder(null); setNotice({ key: Date.now(), text: `${draftSummary(draft)} — nic se neodeslalo. Odesílání z telefonu napojíme v další fázi.` }); }}
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
          <LiveTradePill prefs={pill} onPrefs={savePill} bid={lastPrice} ask={lastPrice} onQty={() => setQtySheet(true)} onSide={onSide} />
          {notice && <LiveChartNotice key={notice.key} text={notice.text} onDone={clearNotice} />}
        </>,
        symbol: LIVE_PHONE_INSTRUMENT.symbol,
        toolbar: <LiveTradeToggle on={pill.on} onToggle={() => savePill({ ...pill, on: !pill.on })} />,
      }}
    />
  );
}
