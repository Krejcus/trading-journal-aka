import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import BacktestWorkspace from '../../components/BacktestWorkspace';
import { createBacktestRuntime } from '../../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestClosedTrade, type BacktestRun } from '../../services/backtestTypes';
import { buildChartWorkspaceLayout } from '../../services/chartWorkspaceLayouts';
import { buildBacktestTradeRecalculationUpdates } from '../../services/backtestTradeRecalculation';
import type { BacktestAnalyticsRefreshCandidate } from '../../services/backtestAnalyticsRefresh';
import type { Trade } from '../../types';
import { qaState, QA_START_MS } from './state';
import { performanceData } from './performanceCandleStore';
import '../../index.css';

declare const __PERF_VARIANT__: string;
const CURSOR = Date.parse('2026-08-21T14:00:00Z') / 1000;
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = 'qa-performance-account';
const indicatorMode = new URLSearchParams(location.search).get('indicators') ?? 'all';
const initialClosed: BacktestClosedTrade[] = Array.from({ length: 80 }, (_, index) => ({
  id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`, runId: RUN_ID, instrument: 'MNQ',
  direction: 'Long', quantity: 1, entryPrice: 100, exitPrice: 102,
  entryTime: CURSOR - (80 - index) * 40 * 60, exitTime: CURSOR - (80 - index) * 40 * 60 + 180,
  grossPnl: 4, commission: .74, pnl: 3.26, reason: 'manual', initialStopLoss: 98, initialTakeProfit: 104,
  stopLoss: 98, takeProfit: 104, riskAmount: 4, mfeAmount: 4, maeAmount: 2, mfePoints: 2, maePoints: 1,
}));
const initialJournal: Trade[] = initialClosed.map(closed => ({
  id: closed.id, accountId: ACCOUNT_ID, backtestRunId: RUN_ID, instrument: closed.instrument, signal: 'Synthetic performance',
  direction: closed.direction, entryPrice: closed.entryPrice, exitPrice: closed.exitPrice, positionSize: 1,
  entryTime: closed.entryTime * 1000, timestamp: closed.exitTime * 1000, date: new Date(closed.exitTime * 1000).toISOString(),
  entryDate: new Date(closed.entryTime * 1000).toISOString(), exitDate: new Date(closed.exitTime * 1000).toISOString(),
  pnl: closed.pnl, riskAmount: 4, runUp: 4, drawdown: -2, duration: '3m', durationMinutes: 3,
  notes: '', tags: ['Synthetic'], htfConfluence: [], ltfConfluence: [],
}));
const makeRun = (): BacktestRun => {
  const now = Date.now();
  const enabled = indicatorMode !== 'none';
  const tree = buildChartWorkspaceLayout({ id: '3h', component: 'alphatrade-chart', panelIdPrefix: 'alphatrade-chart-',
    panelTitle: n => `Graf ${n}`, configs: ['1m', '5m', '15m'].map(timeframe => ({ root: 'MNQ', timeframe,
      showFvg: enabled && indicatorMode !== 'levels', showLevels: enabled && indicatorMode !== 'fvg', showStructure: enabled && indicatorMode === 'all' })),
    global: { tabEnableClose: true, tabEnableRename: false, splitterSize: 2, tabSetMinWidth: 180, tabSetMinHeight: 140 } });
  return { id: RUN_ID, accountId: ACCOUNT_ID, name: `Performance · ${__PERF_VARIANT__}`, status: 'paused', initialCapital: 50_000,
    baseCurrency: 'USD', startAt: QA_START_MS, endAt: Date.parse('2026-09-01T20:00:00Z'), executionSymbol: 'MNQ', replayInterval: '1m', cursorAt: CURSOR * 1000,
    config: { ...DEFAULT_BACKTEST_CONFIG, instruments: ['MNQ'], timezone: 'UTC' },
    workspaceState: { layoutId: '3h', layout: { version: 1, id: RUN_ID, name: 'Performance', panels: {}, tree },
      syncSettings: { symbol: false, interval: false, crosshair: true, time: true, drawings: true },
      appearance: { chartSettings: { symbol: { timeZone: 'UTC' } } } },
    runtimeState: { ...createBacktestRuntime(50_000), balance: 50_000 + 80 * 3.26, equity: 50_000 + 80 * 3.26,
      realizedPnl: 80 * 3.26, commissions: 80 * .74, closedTrades: structuredClone(initialClosed),
      fills: initialClosed.flatMap(closed => [
        { id: `${closed.id}:entry`, runId: RUN_ID, instrument: 'MNQ' as const, side: 'buy' as const, quantity: 1, price: 100, commission: .37, realizedPnl: 0, filledAt: closed.entryTime, reason: 'entry' as const },
        { id: `${closed.id}:exit`, runId: RUN_ID, instrument: 'MNQ' as const, side: 'sell' as const, quantity: 1, price: 102, commission: .37, realizedPnl: 4, filledAt: closed.exitTime, reason: 'manual' as const },
      ]), maxRevealedTime: CURSOR,
      replay: { phase: 'active', cursorTime: CURSOR, startTime: QA_START_MS / 1000, playing: false, speed: 10, stepMinutes: 1 } },
    revision: 0, schemaVersion: 1, createdAt: now, updatedAt: now, lastOpenedAt: now };
};

const counts = { closeCallbacks: 0, refreshed: 0, preflight: 0, journal: initialJournal.length };
const measurement = { started: performance.now(), frames: [] as number[], longTasks: 0, blockingMs: 0, maxTaskMs: 0,
  longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
const resetMeasurement = () => { measurement.started = performance.now(); measurement.frames = []; measurement.longTasks = 0; measurement.blockingMs = 0; measurement.maxTaskMs = 0; };
const snapshot = () => {
  const sorted = [...measurement.frames].sort((a, b) => a - b);
  return { variant: __PERF_VARIANT__, indicators: indicatorMode, elapsedSeconds: +( (performance.now() - measurement.started) / 1000).toFixed(1),
    frames: sorted.length, frameP95Ms: +(sorted[Math.floor((sorted.length - 1) * .95)] ?? 0).toFixed(2), frameMaxMs: +(sorted.at(-1) ?? 0).toFixed(2),
    longTasks: measurement.longTasks, totalBlockingMs: +measurement.blockingMs.toFixed(2), maxTaskMs: +measurement.maxTaskMs.toFixed(2),
    longTaskSupported: measurement.longTaskSupported, visibility: document.visibilityState, ...performanceData, ...counts };
};
(window as unknown as { __BACKTEST_PERF__: { snapshot: typeof snapshot; reset: typeof resetMeasurement } }).__BACKTEST_PERF__ = { snapshot, reset: resetMeasurement };

function Metrics() {
  const [stats, setStats] = useState(snapshot);
  const lastFrame = useRef<number | null>(null);
  useEffect(() => {
    let frame: number;
    const tick = (now: number) => {
      if (lastFrame.current !== null && lastFrame.current >= measurement.started && document.visibilityState === 'visible') {
        measurement.frames.push(now - lastFrame.current);
        if (measurement.frames.length > 30_000) measurement.frames.shift();
      }
      lastFrame.current = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const observer = measurement.longTaskSupported ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= measurement.started) {
        measurement.longTasks++; measurement.blockingMs += Math.max(0, entry.duration - 50); measurement.maxTaskMs = Math.max(measurement.maxTaskMs, entry.duration);
      }
    }) : null;
    observer?.observe({ type: 'longtask' });
    const timer = setInterval(() => setStats(snapshot()), 1000);
    const visible = () => { lastFrame.current = null; };
    document.addEventListener('visibilitychange', visible);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); observer?.disconnect(); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return <aside style={{ position: 'fixed', bottom: 3, left: 3, zIndex: 100000, padding: '5px 8px', border: '1px solid #475569', borderRadius: 5,
    pointerEvents: 'none', background: '#0f172aee', color: '#e2e8f0', font: '11px system-ui', maxWidth: 450 }}>
    <b>Synthetic QA · {stats.variant} · 3 panels · 10x · {indicatorMode}</b>
    <button onClick={() => { resetMeasurement(); setStats(snapshot()); }} style={{ pointerEvents: 'auto', marginLeft: 10, padding: '2px 5px', border: '1px solid #64748b' }}>Reset measurement</button>
    <output data-testid="performance-metrics" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
      {`${stats.elapsedSeconds}s · rAF p95 ${stats.frameP95Ms}ms / max ${stats.frameMaxMs}ms (${stats.frames} frames)\nLong tasks ${stats.longTasks} · blocking ${stats.totalBlockingMs}ms · max ${stats.maxTaskMs}ms\n${stats.warm ? 'Warm' : 'Warming'} · ${stats.sourceBars + stats.historyBars} bars · journal ${stats.journal} · close callbacks ${stats.closeCallbacks} · refreshed ${stats.refreshed} · preflight ${stats.preflight}`}
    </output>
  </aside>;
}

function Harness() {
  const [run, setRun] = useState(makeRun);
  const [open, setOpen] = useState(true);
  const [journal, setJournal] = useState(initialJournal);
  const journalRef = useRef(new Map(initialJournal.map(trade => [String(trade.id), trade])));
  const persist = useCallback(async (trade: Trade) => {
    counts.closeCallbacks++;
    journalRef.current.set(String(trade.id), structuredClone(trade));
    counts.journal = journalRef.current.size;
    setJournal([...journalRef.current.values()]);
  }, []);
  const resolve = useCallback(async (identities: readonly { tradeId: string; runId: string; accountId: string; instrument: string }[], signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    counts.preflight++;
    return { durableIds: new Set(identities.filter(identity => {
      const trade = journalRef.current.get(identity.tradeId);
      return trade?.backtestRunId === identity.runId && trade.accountId === identity.accountId && trade.instrument === identity.instrument;
    }).map(identity => identity.tradeId)) };
  }, []);
  const refresh = useCallback(async (candidates: BacktestAnalyticsRefreshCandidate[]) => {
    for (const candidate of candidates) {
      const trade = journalRef.current.get(candidate.tradeId);
      if (trade) journalRef.current.set(candidate.tradeId, { ...trade, ...buildBacktestTradeRecalculationUpdates(trade, candidate.recalculated), backtestAnalyticsRefresh: candidate.stamp });
    }
    counts.refreshed += candidates.length;
    setJournal([...journalRef.current.values()]);
  }, []);
  return <>{open ? <BacktestWorkspace run={run} isDark onClose={next => { setRun(next); setOpen(false); }}
    journalTrades={journal} onTradeClosed={persist} onResolveClosedTrades={resolve} onTradeAnalyticsRefresh={refresh} />
    : <button onClick={() => setOpen(true)}>Reopen synthetic workspace</button>}<Metrics /></>;
}
qaState.marketDelayMs = 0;
const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
