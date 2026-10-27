import React, { useEffect, useMemo, useRef, useState } from 'react';
import DayLivePositionChip from './DayLivePositionChip';
import { useLivePriceLinesBinding } from '../../hooks/useLivePriceLinesBinding';
import type { JournalLivePositionStore } from '../../lib/journalLivePositionStore';
import type { LivePriceLinesFeed } from '../../lib/livePriceLinesFeed';
import { Maximize2 } from 'lucide-react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Trade } from '../../types';
import CandleKitTradeChart from '../CandleKitTradeChart';
import { QuantumSpinner } from '../QuantumLoader';
import { aggregateCandles, MARKET_TIMEFRAME_MINUTES, type MarketTimeframe } from '../../services/marketData';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../../services/detailIndicators';
import { tradeChartTiming } from '../../services/tradeChartData';
import ChartNotesLayer from '../ChartNotesLayer';
import { chartNotesOfTrades } from '../../lib/chartNotes';
import DayNotesLayer, { type DayBand, type DayPinPoint, type DayPinView } from './DayNotesLayer';
import { dayAnchorTrade, focusTarget, reviewFocusKey, useReviewFocus } from './dayFocus';
import { useResetViewOnOpen } from '../../hooks/useResetViewOnOpen';
import type { DayController } from './useDayController';
import { useLiveCandleBinding } from '../../hooks/useLiveCandleBinding';

const TIMEFRAMES: MarketTimeframe[] = ['1m', '5m', '15m'];

/**
 * Graf dne pro telefon: stejný review graf (obchody dne, indikátory
 * z detailu) bez workspace, s vrstvou poznámek. Ťuknutí v režimu
 * umisťování vrátí čas a cenu.
 */
export default function DayCompactChart({ ctl, isDark, height, range, focusKeyPrefix, selectedTrade, pins, bubbles, placing, onPick, onCancelPlacing, pending, nowTime, bands, overlay, timeframe, onTimeframe, onExpand, liveStore, positionLines }: {
  ctl: DayController;
  /** Živá pozice z kopírky (deník dneška; jen zobrazení). */
  liveStore?: JournalLivePositionStore;
  positionLines?: LivePriceLinesFeed;
  isDark: boolean;
  height: number;
  /** Timeframe drží rodič (sdílí ho s celoobrazovkovým grafem). */
  timeframe: MarketTimeframe;
  onTimeframe: (timeframe: MarketTimeframe) => void;
  /** Tlačítko „zvětšit“ (celá obrazovka na telefonu). */
  onExpand?: () => void;
  range: { from: number; to: number };
  focusKeyPrefix: string;
  selectedTrade: Trade | null;
  pins: DayPinView[];
  bubbles: 'all' | 'selected';
  placing: 'note' | 'voice' | null;
  onPick: (point: DayPinPoint) => void;
  onCancelPlacing: () => void;
  pending: DayPinPoint | null;
  nowTime?: number | null;
  bands: DayBand[];
  overlay?: React.ReactNode;
}) {
  const [indicators, setIndicators] = useState(readTradeChartIndicators);
  useEffect(() => onTradeChartIndicatorsChange(setIndicators), []);
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const raw = ctl.chart.candles;
  const candles = useMemo(() => aggregateCandles(raw, timeframe), [raw, timeframe]);
  const barTimes = useMemo(() => candles.map(candle => candle.time), [candles]);
  const tradeNotes = useMemo(() => chartNotesOfTrades(ctl.chart.chartTrades), [ctl.chart.chartTrades]);
  // Živá poslední svíčka z kanálu ceny (jen překreslení v grafu).
  useLiveCandleBinding(ctl.chart.liveFeed, [{ api, root: 'MNQ', timeframe, rawCandles: raw }]);
  // Deník dneška se otevírá jako „Reset chart view“ (poslední svíčka vpravo).
  useResetViewOnOpen(api, ctl.isToday && !selectedTrade, raw.length > 0);
  useLivePriceLinesBinding(positionLines ?? null, [{ api, root: 'MNQ' }]);

  const target = focusTarget(range);
  const anchorRef = useRef<{ day: string; trade: Trade } | null>(null);
  if (!anchorRef.current || anchorRef.current.day !== ctl.day) anchorRef.current = { day: ctl.day, trade: dayAnchorTrade(ctl.day, target) };
  const anchor = anchorRef.current.trade;
  const chartTrade = selectedTrade ?? anchor;
  const timing = selectedTrade ? tradeChartTiming(selectedTrade) : { entryMs: anchor.entryTime!, exitMs: anchor.timestamp };
  const focusKey = reviewFocusKey(focusKeyPrefix, selectedTrade?.id);
  const detail = selectedTrade ? { ...tradeChartTiming(selectedTrade), id: String(selectedTrade.id) } : { entryMs: target.entryMs, exitMs: target.exitMs, id: String(anchor.id) };
  useReviewFocus(focusKey, { entryMs: detail.entryMs, exitMs: detail.exitMs, id: detail.id }, Boolean(api), `${ctl.day}:${timeframe}`);

  const toggle = (id: 'fvg' | 'levels' | 'structure') => writeTradeChartIndicators({ ...indicators, [id]: !indicators[id] });

  return (
    <div className="dj" style={{ borderTop: '1px solid var(--dj-line)', borderBottom: '1px solid var(--dj-line)', background: isDark ? '#05080f' : '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>MNQ</span>
        <div role="group" aria-label="Timeframe" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--dj-chip)' }}>
          {TIMEFRAMES.map(item => (
            <button key={item} type="button" aria-pressed={timeframe === item} onClick={() => onTimeframe(item)} style={{ height: 24, padding: '0 7px', borderRadius: 6, border: 0, cursor: 'pointer', font: '700 11px Inter, sans-serif', background: timeframe === item ? 'var(--dj-text)' : 'transparent', color: timeframe === item ? 'var(--dj-bg)' : 'var(--dj-muted)' }}>{item}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {(['levels', 'fvg'] as const).map(id => (
          <button key={id} type="button" aria-pressed={indicators[id]} onClick={() => toggle(id)} style={{ height: 24, padding: '0 7px', borderRadius: 6, cursor: 'pointer', font: '600 10.5px Inter, sans-serif', border: indicators[id] ? '1px solid var(--dj-line)' : '1px dashed var(--dj-line)', background: indicators[id] ? 'var(--dj-chip)' : 'transparent', color: indicators[id] ? 'var(--dj-text)' : 'var(--dj-muted)' }}>{id === 'levels' ? 'Úrovně' : 'FVG'}</button>
        ))}
        {onExpand && <button type="button" className="dj-btn" aria-label="Graf na celou obrazovku" onClick={onExpand} style={{ width: 30, height: 24, borderRadius: 6, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0 }}><Maximize2 size={13} /></button>}
      </div>
      <div ref={containerRef} style={{ position: 'relative', height }}>
        {candles.length ? (
          <CandleKitTradeChart
            key={`${ctl.day}:${timeframe}`}
            trade={chartTrade}
            candles={candles}
            rawCandles={raw}
            timeframe={timeframe}
            entryMs={timing.entryMs}
            exitMs={timing.exitMs}
            showFvg={indicators.fvg}
            showLevels={indicators.levels}
            showStructure={indicators.structure}
            isDark={isDark}
            compactMode
            phoneLayout
            hideOhlcLegend
            compactToolbar
            hideDrawingToolbar
            hideFocusButton
            reviewMode
            contextTrades={ctl.chart.chartTrades}
            drawingKeyId={`day:${ctl.day}`}
            drawingScope="day"
            onChartApiReady={setApi}
            onToggleFvg={() => toggle('fvg')}
            onToggleLevels={() => toggle('levels')}
            onToggleStructure={() => toggle('structure')}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16, textAlign: 'center' }}>
            {ctl.chart.loading ? <QuantumSpinner /> : <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-text-2)' }}>{ctl.chart.error ?? 'Svíčky pro tenhle den zatím nejsou. Živé čtení z TradingView chybí.'}</p>}
          </div>
        )}
        {/* Poznámky k obchodům dne (detail obchodu, Review) — jen pro čtení. */}
        {tradeNotes.length > 0 && (
          <ChartNotesLayer
            chartApi={api}
            containerRef={containerRef}
            notes={tradeNotes}
            barTimes={barTimes}
            replayCursor={null}
            editable={false}
            isDark={isDark}
            addRequest={null}
            onChange={() => {}}
          />
        )}
        <DayNotesLayer
          chartApi={api}
          containerRef={containerRef}
          barTimes={barTimes}
          intervalSeconds={MARKET_TIMEFRAME_MINUTES[timeframe] * 60}
          pins={pins}
          selectedId={ctl.selected?.kind === 'note' ? ctl.selected.id : null}
          onSelect={id => ctl.setSelected(id ? { kind: 'note', id } : null)}
          bubbles={bubbles}
          placing={placing}
          placingHint="Ťukni, kam to patří"
          onPick={onPick}
          onCancelPlacing={onCancelPlacing}
          pending={pending}
          nowTime={nowTime}
          bands={bands}
          ticks={ctl.mindTicks}
        />
        {overlay}
        {liveStore && <DayLivePositionChip store={liveStore} compact />}
      </div>
    </div>
  );
}
