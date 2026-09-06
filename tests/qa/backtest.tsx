import { buildBacktestTradeRecalculationUpdates } from '../../services/backtestTradeRecalculation';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import BacktestTradeReviewDialog from '../../components/BacktestTradeReviewDialog';
import { collectBacktestTagSuggestions } from '../../services/backtestTagCatalog';
import type { Trade } from '../../types';
import BacktestWorkspace from '../../components/BacktestWorkspace';
import { createBacktestRuntime } from '../../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRun } from '../../services/backtestTypes';
import { QA_START_MS, qaState, notifyQa } from './state';
import '../../index.css';

const createRun = (resume = false): BacktestRun => {
  const now = Date.now();
  const cursor = resume ? QA_START_MS + 17 * 86_400_000 : QA_START_MS;
  return { id: `qa-${now}`, accountId: 'qa-account', name: 'Isolated synthetic backtest', status: 'paused', initialCapital: 50_000,
    baseCurrency: 'USD', startAt: QA_START_MS, endAt: Date.parse('2026-09-01T20:00:00Z'), executionSymbol: 'MNQ', replayInterval: '1m', cursorAt: cursor,
    config: { ...DEFAULT_BACKTEST_CONFIG, timezone: 'UTC' }, workspaceState: { layoutId: '1' },
    runtimeState: { ...createBacktestRuntime(50_000), replay: { phase: 'active', cursorTime: cursor / 1000, startTime: QA_START_MS / 1000, playing: false, speed: 1, stepMinutes: 1 } },
    revision: 0, schemaVersion: 1, createdAt: now, updatedAt: now, lastOpenedAt: now };
};
const reviewFixture: Trade = { id: 'review-qa-1', accountId: 'qa-account', backtestRunId: 'qa-run', direction: 'Long', instrument: 'MNQ', signal: 'QA', pnl: 25, runUp: 30, drawdown: -5, date: '2026-08-03T14:00:00Z', timestamp: Date.parse('2026-08-03T14:00:00Z'), duration: '1m', durationMinutes: 1, notes: 'Původní poznámka', tags: ['Trpělivost'], htfConfluence: ['U VWAP'], ltfConfluence: ['Odraz od PDL'], autoConfluence: { htf: ['U VWAP'], ltf: ['Odraz od PDL'] } };
function Harness() {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTrade, setReviewTrade] = useState(reviewFixture);
  const [savedReview, setSavedReview] = useState(reviewFixture);
  const [reviewError, setReviewError] = useState(false);
  const [run, setRun] = useState(createRun);
  const [open, setOpen] = useState(true);
  const [, refresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { const update = () => refresh(value => value + 1); window.addEventListener('backtest-qa-change', update); return () => window.removeEventListener('backtest-qa-change', update); }, []);
  const button = { border: '1px solid #475569', borderRadius: 4, padding: '3px 6px', background: '#1e293b', color: '#fff', fontSize: 11 };
  const reset = (resume = false) => { qaState.trades = []; qaState.savedRun = null; qaState.cloudRun = null; setRun(createRun(resume)); setOpen(true); notifyQa(); };
  return <>
    {reviewOpen && <BacktestTradeReviewDialog trade={reviewTrade} isDark onClose={() => setReviewOpen(false)} onCaptureSnapshot={() => ''}
      tagSuggestions={collectBacktestTagSuggestions([savedReview], { htf: ['Denní level'], ltf: ['Můj vstup'] })}
      onRecalculate={() => ({ ...reviewTrade, htfConfluence: ['Nový auto HTF'], ltfConfluence: ['Nový auto LTF'], autoConfluence: { htf: ['Nový auto HTF'], ltf: ['Nový auto LTF'] } })}
      onSave={async updates => { if (reviewError) { setReviewError(false); throw new Error('QA simulated save failure'); } const next = { ...reviewTrade, ...updates }; setSavedReview(next); setReviewTrade(next); }} />}

    {open && <BacktestWorkspace key={run.id} run={run} isDark onClose={next => { setRun(next); setOpen(false); }}
      journalTrades={qaState.trades}
      tagSuggestions={collectBacktestTagSuggestions(qaState.trades)}
      onTradeAnalyticsRefresh={async candidates => { qaState.trades = qaState.trades.map(trade => {
        const candidate = candidates.find(item => item.tradeId === trade.id);
        return candidate ? { ...trade, ...buildBacktestTradeRecalculationUpdates(trade, candidate.recalculated), backtestAnalyticsRefresh: candidate.stamp } : trade;
      }); notifyQa(); }}
      onTradeClosed={async trade => { qaState.trades = [...qaState.trades.filter(value => value.id !== trade.id), structuredClone(trade)]; notifyQa(); }}
      onTradeReviewSave={async (id, updates) => { qaState.trades = qaState.trades.map(trade => String(trade.id) === id ? { ...trade, ...updates } : trade); notifyQa(); }} />}
    <aside data-testid="qa-controls" style={{ position: 'fixed', bottom: 4, left: 4, zIndex: 100000, width: expanded ? 425 : 230, maxHeight: '20vh', overflow: 'auto', padding: 8, border: '1px solid #475569', borderRadius: 8, background: '#0f172aee', color: '#e2e8f0', font: '11px system-ui' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b>QA · synthetic / local only</b><button style={button} onClick={() => setExpanded(value => !value)}>{expanded ? 'Collapse' : 'Expand QA'}</button></div>
      <output data-testid="qa-trade-count">Closed trades: {qaState.trades.length}</output>
      <span> · local saves {qaState.localSaves}</span>
      {expanded && <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, margin: '8px 0' }}>
          <button style={button} onClick={() => { setOpen(false); setReviewTrade(savedReview); setReviewOpen(true); }}>Open review fixture</button>
          <button style={button} onClick={() => setReviewTrade(current => ({ ...current, notes: 'Background refresh' }))}>Refresh same trade</button>
          <button style={button} onClick={() => setReviewError(true)}>Fail review save</button>
          <button style={button} onClick={() => reset()}>Fresh session</button>
          <button style={button} onClick={() => reset(true)}>Resume day 18</button>
          <button style={button} onClick={() => { if (qaState.savedRun) { setRun(structuredClone(qaState.savedRun)); setOpen(false); setTimeout(() => setOpen(true), 0); } }}>Reopen saved</button>
          <button style={button} onClick={() => { qaState.failMarketRequests = 1; notifyQa(); }}>Fail next market request</button>
          <button style={button} onClick={() => { qaState.failLocalSaves = 1; notifyQa(); }}>Fail next local save</button>
        </div>
        <label>Market delay ms <input type="number" min="0" value={qaState.marketDelayMs} onChange={event => { qaState.marketDelayMs = Number(event.target.value); notifyQa(); }} style={{ width: 75, color: 'white' }} /></label>
        <p>Failures armed: market {qaState.failMarketRequests}, local save {qaState.failLocalSaves}. Synthetic MNQ starts near100, tick0.25; calendar contains weekend and daily gaps.</p>
        <output data-testid="qa-runtime"><pre style={{ fontSize: 10, whiteSpace: 'pre-wrap' }}>{JSON.stringify(qaState.savedRun ? {
          appearance: qaState.savedRun.workspaceState?.appearance,
          panels: qaState.savedRun.workspaceState?.panels,
          cursor: new Date(qaState.savedRun.cursorAt ?? 0).toISOString(),
          researchJournal: qaState.savedRun.runtimeState.researchJournal ? { ...qaState.savedRun.runtimeState.researchJournal, revisions: qaState.savedRun.runtimeState.researchJournal.revisions.map(item => ({ ...item, screenshotDataUrl: item.screenshotDataUrl ? `[snapshot ${item.screenshotDataUrl.length} characters]` : undefined })) } : undefined, maxRevealedTime: qaState.savedRun.runtimeState.maxRevealedTime,
          balance: qaState.savedRun.runtimeState.balance, equity: qaState.savedRun.runtimeState.equity,
          positions: qaState.savedRun.runtimeState.positions,
          fills: qaState.savedRun.runtimeState.fills.length, closedTrades: qaState.savedRun.runtimeState.closedTrades.length,
          pending: qaState.savedRun.runtimeState.orders.filter(order => order.status === 'pending'),
        } : { status: 'Waiting for first local checkpoint' }, null, 2)}</pre></output>
        <output data-testid="qa-saved-review"><pre>{JSON.stringify(savedReview, null, 2)}</pre></output>
        <details><summary>Market requests ({qaState.marketRequests.length})</summary><pre style={{ fontSize: 9, whiteSpace: 'pre-wrap' }}>{JSON.stringify(qaState.marketRequests, null, 2)}</pre></details>
        <details><summary>Saved journal trades ({qaState.trades.length})</summary><pre style={{ fontSize: 9, whiteSpace: 'pre-wrap' }}>{JSON.stringify(qaState.trades, null, 2)}</pre></details>
      </>}
      {!open && <button style={button} onClick={() => setOpen(true)}>Open workspace</button>}
    </aside>
  </>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
