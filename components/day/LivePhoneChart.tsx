import React, { useCallback, useState } from 'react';
import type { SessionConfig, Trade } from '../../types';
import DayFullscreenChart from './DayFullscreenChart';
import { useDayController } from './useDayController';
import { focusRange } from './dayFocus';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import type { MarketTimeframe } from '../../services/marketData';
import { readLivePillPrefs, writeLivePillPrefs, type LivePillPrefs } from '../../lib/livePhoneTrade';
import { LiveChartNotice, LiveQtySheet, LiveTradePill, LiveTradeToggle } from './LivePhoneTrade';
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
        overlay: <>
          {slots.overlay}
          {qtySheet && <LiveQtySheet value={pill.qty} onClose={() => setQtySheet(false)} onDone={qty => { savePill({ ...pill, qty }); setQtySheet(false); }} />}
        </>,
        // Bid/ask ze streamu přijde s napojením dat; zatím poslední cena svíčky.
        chartLayer: ({ lastPrice }) => <>
          <LiveTradePill prefs={pill} onPrefs={savePill} bid={lastPrice} ask={lastPrice} onQty={() => setQtySheet(true)} onSide={onSide} />
          {notice && <LiveChartNotice key={notice.key} text={notice.text} onDone={clearNotice} />}
        </>,
        toolbar: <LiveTradeToggle on={pill.on} onToggle={() => savePill({ ...pill, on: !pill.on })} />,
      }}
    />
  );
}
