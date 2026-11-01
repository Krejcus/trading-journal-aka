import React, { useState } from 'react';
import type { SessionConfig, Trade } from '../../types';
import DayFullscreenChart from './DayFullscreenChart';
import { useDayController } from './useDayController';
import { focusRange } from './dayFocus';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import type { MarketTimeframe } from '../../services/marketData';
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
      live={slots}
    />
  );
}
