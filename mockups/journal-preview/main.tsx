import TradeDetailModal from '../../components/TradeDetailModal';
import ManualTradeForm from '../../components/ManualTradeForm';
import { aggregateHistoryTrades } from '../../lib/tradeHistoryPresentation';
import { journalReviewPatch } from '../../lib/journalReviewPatch';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CandleKitTradeChart from '../../components/CandleKitTradeChart';
import TradeExecutionTimeline from '../../components/TradeExecutionTimeline';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import JournalReviewInbox from '../../components/JournalReviewInbox';
import JournalImportStatus from '../../components/JournalImportStatus';
import JournalSourceStatus from '../../components/JournalSourceStatus';
import { JOURNAL_BACKFILL_TYPES } from '../../lib/journalBackfillPlan';
import type { JournalConnectionSources } from '../../services/journalSourceStatus';
import LiveJournalHistory from '../../components/LiveJournalHistory';
import DashboardCalendar from '../../components/DashboardCalendar';
import AccountExecutionChart from '../../components/AccountExecutionChart';
import type { JournalInboxKind, JournalInboxPage, JournalRetainedReview } from '../../services/journalReviewInbox';
import type { Account, PnLDisplayMode, User } from '../../types';
import type { Trade } from '../../types';
import type { MarketCandle } from '../../services/marketData';
import { aggregateCandles } from '../../services/marketDataCalculations';
import type { TradeExecutionHistory } from '../../lib/tradeExecutionHistory';
import type { JournalProtectionEvent } from '../../lib/tradovateJournalEvidence';

const start = Date.parse('2026-09-10T13:30:00Z');
const inboxAccounts = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), name: index === 0 ? 'Leader' : `Účet ${index + 1}`, type: 'Paper', initialBalance: 50000 } as Account));
const loadInboxPage = async (kind: JournalInboxKind, options: { accountIds?: string[] } = {}): Promise<JournalInboxPage> => ({
  rows: inboxAccounts.filter(account => !options.accountIds || ((kind !== 'pending' || Number(account.id) % 3 !== 0) && options.accountIds.includes(account.id))).map(account => ({
    id: `fictional-review-${account.id}`, accountId: kind === 'pending' && Number(account.id) % 3 === 0 ? null : account.id,
    externalAccountId: Number(account.id), instrument: 'MNQ', date: new Date(start + (kind === 'pending' ? 1 : -1) * 86_400_000 + Number(account.id) * 73).toISOString(),
    state: kind === 'pending' ? 'pending' : 'estimated', hasReview: kind === 'retained',
    pendingReason: Number(account.id) % 3 === 1 ? 'open' : Number(account.id) % 3 === 2 ? 'accounting-pending' : 'account-not-linked',
  })), next: null,
});
const loadInboxReview = async (id: string): Promise<JournalRetainedReview> => ({ id, screenshots: [], drawingCount: 0,
  notes: [{ label: 'Poznámky', text: 'Fiktivní původní poznámka. Obchod měl starší odhad výsledku; poznámka zůstává dostupná, odhad se nezapočítává do potvrzeného P&L.' }],
});
const candles: MarketCandle[] = Array.from({ length: 75 }, (_, index) => {
  const minute = index - 25;
  const open = minute >= 0 ? 20_111 + minute * 0.68 + Math.sin(minute * 0.6) * 0.6
    : 20_100 + index * 0.35 + Math.sin(index * 0.6) * 1.2;
  const close = open + 0.35 + Math.sin(index) * 0.25;
  // Fictional candles cover every account fill and do not cross its confirmed
  // stop before the illustrated manual exits. They are not broker market data.
  const low = minute === 0 ? 20_108.5 : minute === 12 ? 20_116.5 : Math.min(open, close) - 0.75;
  const high = minute === 12 ? 20_121 : Math.max(open, close) + 1.5;
  return { time: start / 1_000 + minute * 60, open, high, low, close, volume: 120 + index * 7 };
});
const accounts = Array.from({ length: 12 }, (_, index): Trade => {
  const accountId = index + 1;
  const quantity = 1 + index % 3;
  const entryAt = start + 12_123 + index * 73;
  const exitAt = start + 12 * 60_000 + 30_789 + index * 41;
  const entryPrice = 20_109 + index * 0.25;
  const exitPrice = 20_117 + index * 0.25 + (index % 2 ? -0.5 : 0.5);
  const change = (id: number, at: number, price: number, status: JournalProtectionEvent['status'] = 'confirmed'): JournalProtectionEvent => ({
    id: `${accountId}:${id}`, orderId: `stop-${accountId}`, commandId: String(id), accountId, at,
    timeSource: 'broker', kind: 'sl', price, quantity, status, operation: id === 1 ? 'new' : 'modify',
    ...(status === 'rejected' ? { reason: 'Fiktivní odmítnutí změny; předchozí SL zůstal aktivní.' } : {}),
  });
  const fees = quantity * 1.24;
  const grossPnl = (exitPrice - entryPrice) * quantity * 2;
  const history: TradeExecutionHistory = {
    connectionId: 'fictional-connection', environment: 'demo', accountId,
    fills: [
      { id: `${accountId}:entry`, orderId: `${accountId}:entry`, accountId, contractId: 1, at: entryAt, timeSource: 'broker',
        side: 'Buy', quantity, allocatedQuantity: quantity, price: entryPrice, fees: fees / 2, feeCurrencyId: 840, role: 'entry' },
      { id: `${accountId}:exit`, orderId: `${accountId}:exit`, accountId, contractId: 1, at: exitAt, timeSource: 'broker',
        side: 'Sell', quantity, allocatedQuantity: quantity, price: exitPrice, fees: fees / 2, feeCurrencyId: 840, role: 'exit' },
    ],
    protection: [
      change(1, entryAt + 85, 20_099),
      { ...change(2, entryAt + 88, 20_131), kind: 'tp', orderId: `target-${accountId}`, operation: 'new' },
      change(3, start + 4 * 60_000 + 4_125 + index * 11, 20_104),
      change(4, start + 4 * 60_000 + 4_635 + index * 11, 20_107),
      change(5, start + 4 * 60_000 + 44_400 + index * 11, 20_109, index === 10 ? 'rejected' : 'confirmed'),
      ...(index === 8 ? [change(6, start + 7 * 60_000 + 123, 20_111)] : []),
    ],
    gaps: index === 8 ? [{ from: start + 5 * 60_000, to: start + 6 * 60_000 }] : [],
    grossPnl, fees, netPnl: grossPnl - fees, complete: index !== 8, issues: index === 8 ? ['connection-gap'] : [],
  };
  return { id: `fictional-${accountId}`, copierTradeId: `journal:fictional-${accountId}`, accountId: String(accountId), instrument: 'MNQ', symbol: 'MNQU6',
    signal: 'Fiktivní ukázka', source: 'copier', direction: 'Long', pnl: grossPnl - fees, entryTime: entryAt,
    timestamp: exitAt, date: new Date(exitAt).toISOString(), entryPrice, exitPrice, stopLoss: 20_099, takeProfit: 20_131,
    positionSize: quantity, duration: '12m', durationMinutes: 12, runUp: 0, drawdown: 0, executionHistory: history,
    groupId: 'fictional-group', isMaster: index === 0 };
});

type PreviewMediaMode = 'none' | 'available' | 'metadata-error' | 'sign-error';
const withPreviewMedia = (trade: Trade, mode: PreviewMediaMode): Trade => ({ ...trade,
  copierSnapshotLoadError: mode === 'metadata-error',
  copierSnapshots: trade.id === 'fictional-1' && ['available', 'sign-error'].includes(mode) ? [
    { kind: 'entry', at: trade.entryTime! + 150, path: 'fictional/entry.png' },
    { kind: 'exit', at: trade.timestamp + 150, path: 'fictional/exit.png' },
  ] : [],
});
// Test media is generated from the same fictional candles as this preview.
// It is never uploaded or passed to the broker capture service.
const previewSnapshotUrl = (kind: string) => {
  const rows = candles.slice(0, kind === 'entry' ? 27 : 40);
  const y = (price: number) => 570 - (price - 20095) * 11;
  const bars = rows.map((c, i) => {
    const x = 45 + i * 24, color = c.close >= c.open ? '#10b981' : '#f43f5e';
    return `<line x1="${x}" x2="${x}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${color}"/><rect x="${x-5}" y="${y(Math.max(c.open,c.close))}" width="10" height="${Math.max(2,Math.abs(c.close-c.open)*11)}" fill="${color}"/>`;
  }).join('');
  const grid = [20100,20110,20120,20130].map(price => `<line x1="30" x2="1010" y1="${y(price)}" y2="${y(price)}" stroke="#e2e8f0"/><text x="1020" y="${y(price)+4}" fill="#64748b" font-size="12">${price}</text>`).join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="650" viewBox="0 0 1100 650"><rect width="1100" height="650" fill="#f8fafc"/><rect x="20" y="70" width="1060" height="530" rx="8" fill="white" stroke="#e2e8f0"/><g font-family="Inter,Arial,sans-serif"><text x="32" y="34" font-size="20" font-weight="800" fill="#0f172a">AlphaTrade · MNQ</text><text x="32" y="55" font-size="12" fill="#64748b">FIKTIVNÍ SNÍMEK · ${kind.toUpperCase()} · Leader · 1 minuta</text>${grid}${bars}<line x1="30" x2="1010" y1="${y(20109)}" y2="${y(20109)}" stroke="#10b981" stroke-dasharray="6 4"/><text x="32" y="628" font-size="12" fill="#64748b">Testovací obrázek ze stejných fiktivních dat jako interaktivní graf.</text></g></svg>`)}`;
};
const unavailableChart = async (): Promise<Trade | null> => null;
const loadPreviewSources = async (): Promise<JournalConnectionSources[]> => [{ connectionId: 'fictional', environment: 'demo',
  sources: JOURNAL_BACKFILL_TYPES.map((type, index) => ({ type, recordedAt: index === 5 ? null : start,
    metadata: index === 5 ? null : { kind: index === 4 ? 'unavailable' : 'observed',
      startedAt: start - 20_000, completedAt: start, scope: index >= 8 ? 'known-parents' : 'available-list',
      scanned: index === 4 ? null : 96, recorded: index === 4 ? null : 3, contended: index === 4 ? null : 0,
      requested: index >= 8 ? 100 : null, remaining: index >= 8 ? 105 : null } })),
}];
const failPreviewSources = async (): Promise<JournalConnectionSources[]> => { throw new Error('fictional-unavailable'); };

function Preview() {
  const [detailOpen, setDetailOpen] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [combinedDetail, setCombinedDetail] = useState(false);
  const [previewPnlMode, setPreviewPnlMode] = useState<PnLDisplayMode>('usd');
  const [editOpen, setEditOpen] = useState(false);
  const [savedReview, setSavedReview] = useState<Record<string, Partial<Trade>>>({});
  const [snapshotMode, setSnapshotMode] = useState<'original' | 'corrected' | 'missing'>('original');
  const [mediaMode, setMediaMode] = useState<PreviewMediaMode>('none');
  const [processingImport, setProcessingImport] = useState(false);
  const [failReview, setFailReview] = useState(false);
  const [selected, setSelected] = useState(0);
  const [combined, setCombined] = useState(true);
  const [dark, setDark] = useState(false);
  const [failedChart, setFailedChart] = useState(false);
  const [failedSources, setFailedSources] = useState(false);
  const [candleScenario, setCandleScenario] = useState<'complete' | 'gap' | 'edges'>('complete');
  const [chartTimeframe, setChartTimeframe] = useState<'1m' | '5m'>('1m');
  const [visual, setVisual] = useState<'screenshots' | 'chart'>('screenshots');
  const trade = withPreviewMedia({ ...accounts[selected], ...savedReview[accounts[selected].accountId] }, mediaMode);
  const loadPreviewDetail = useCallback(async (id: string): Promise<Trade | null> => {
    const found = accounts.find(row => row.id === id);
    return found ? withPreviewMedia({ ...found, ...savedReview[found.accountId] }, mediaMode) : null;
  }, [mediaMode, savedReview]);
  const loadPreviewSelection = useCallback(async (ids: readonly string[]) => {
    const result = (await Promise.all(ids.map(loadPreviewDetail))).filter((row): row is Trade => row !== null);
    if (snapshotMode === 'missing') return result.slice(1);
    if (snapshotMode !== 'corrected') return result;
    return result.map(row => {
      const extra = row.positionSize! * 2;
      return { ...row, exitPrice: row.exitPrice! + 1, pnl: row.pnl + extra, timestamp: row.timestamp + 125,
        date: new Date(row.timestamp + 125).toISOString(), executionHistory: { ...row.executionHistory!,
          grossPnl: row.executionHistory!.grossPnl! + extra, netPnl: row.pnl + extra,
          fills: row.executionHistory!.fills.map(fill => fill.role === 'exit' ? { ...fill, price: fill.price + 1, at: fill.at + 125 } : fill) } };
    });
  }, [loadPreviewDetail, snapshotMode]);
  const signPreviewSnapshots = useCallback(async (snapshots: NonNullable<Trade['copierSnapshots']>) => {
    if (mediaMode === 'sign-error') return [];
    return snapshots.map(snapshot => ({ ...snapshot, url: previewSnapshotUrl(snapshot.kind) }));
  }, [mediaMode]);
  useEffect(() => { document.documentElement.classList.toggle('light-theme', !dark); }, [dark]);
  const total = combined ? accounts.reduce((sum, item) => sum + item.pnl, 0) : trade.pnl;
  const previewRawCandles = React.useMemo(() => candles.filter(candle => candleScenario === 'complete'
    || (candleScenario === 'gap' ? !(candle.time >= start / 1000 + 4 * 60 && candle.time < start / 1000 + 6 * 60)
      : candle.time > start / 1000 && candle.time < start / 1000 + 12 * 60)), [candleScenario]);
  const previewCandles = React.useMemo(() => aggregateCandles(previewRawCandles, chartTimeframe), [previewRawCandles, chartTimeframe]);
  return <main className="min-h-screen bg-theme-page p-4 md:p-8 font-sans text-theme-primary">
    <header className="mx-auto flex max-w-[1500px] items-center gap-4 mb-5">
      <img src="/logos/at_logo_light_clean.png" className="h-10 w-10" alt="AlphaTrade" />
      <span className="font-black text-lg">Historie obchodu</span>
      <span className="text-xs text-slate-500">Všechna data v této ukázce jsou fiktivní.</span>
      <button className="rounded-xl border border-slate-500/20 px-3 py-2 text-xs" onClick={() => { setCombinedDetail(false); setDetailOpen(true); }}>Detail aplikace</button>
      <button className="rounded-xl border border-slate-500/20 px-3 py-2 text-xs" onClick={() => setEditOpen(true)}>Hodnocení vybraného účtu</button>
      <label className="text-xs"><input type="checkbox" checked={failReview} onChange={event => setFailReview(event.target.checked)} /> Simulovat chybu uložení</label>
      <button className="ml-auto rounded-xl border border-slate-500/20 px-3 py-2 text-xs" onClick={() => setDark(value => !value)}>{dark ? 'Světlý vzhled' : 'Tmavý vzhled'}</button>
    </header>
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3 flex items-center gap-3 text-xs text-slate-500"><label>Výsledek v detailu <select aria-label="Zobrazení P&L" className="ml-2 rounded-lg border border-slate-500/20 bg-theme-card p-2" value={previewPnlMode} onChange={event => setPreviewPnlMode(event.target.value as PnLDisplayMode)}><option value="usd">P&L</option><option value="percent">Procenta kapitálu</option><option value="rr">R násobek</option></select></label>
        <button className="rounded-lg border border-slate-500/20 p-2" onClick={() => { setCombinedDetail(true); setDetailOpen(true); }}>Kombinovaný detail 12 účtů</button></div>
      <label className="mb-3 block text-xs text-slate-500"><input type="checkbox" checked={showCalendar} onChange={event => setShowCalendar(event.target.checked)} /> Ukázat kalendář aplikace</label>
      {showCalendar && <div className="mb-4"><DashboardCalendar trades={combined ? accounts : [trade]} preps={[]} reviews={[]} theme={dark ? 'dark' : 'light'} accounts={inboxAccounts} initialBalance={combined ? 600000 : 50000} emotions={[]} pnlFormat={previewPnlMode} user={{ currency: 'USD' } as User} exchangeRates={null} onOpenTrade={row => {
        const index = accounts.findIndex(account => account.id === row.id);
        if (index < 0) return;
        setSelected(index); setCombinedDetail(false); setDetailOpen(true);
      }} /></div>}
      <label className="mb-3 block text-xs text-slate-500">Aktualizace detailu <select aria-label="Test čerstvých výsledků" className="ml-2 rounded-lg border border-slate-500/20 bg-theme-card p-2" value={snapshotMode} onChange={event => setSnapshotMode(event.target.value as typeof snapshotMode)}><option value="original">Stejné údaje jako v seznamu</option><option value="corrected">Novější výstup a P&L všech účtů</option><option value="missing">Jeden účet nelze ověřit</option></select></label>
      <label className="mb-3 block text-xs text-slate-500">Snímky v detailu aplikace <select aria-label="Test automatických snímků" className="ml-2 rounded-lg border border-slate-500/20 bg-theme-card p-2" value={mediaMode} onChange={event => setMediaMode(event.target.value as PreviewMediaMode)}>
        <option value="none">Bez automatických snímků</option><option value="available">ENTRY a EXIT leadera</option><option value="metadata-error">Nedostupná metadata</option><option value="sign-error">Chyba načtení obrázků</option>
      </select></label>
      <label className="mb-3 block text-xs text-slate-500"><input type="checkbox" checked={processingImport} onChange={event => setProcessingImport(event.target.checked)} /> Ukázat zpracování dlouhé historie</label>
      <JournalImportStatus report={{ completedAt: start, connections: [{ connectionId: 'fictional', state: processingImport ? 'processing' : 'pending', through: 42, pending: processingImport ? 0 : 12, unassigned: 0 }] }}
        running={false} error={false} />
      <label className="mb-3 block text-xs text-slate-500"><input type="checkbox" checked={failedSources} onChange={event => setFailedSources(event.target.checked)} /> Simulovat chybu přehledu podkladů</label>
      <JournalSourceStatus connections={[{ connectionId: 'fictional', accountCount: 12 }]} loadSources={failedSources ? failPreviewSources : loadPreviewSources} />
      <JournalReviewInbox accounts={inboxAccounts} loadPage={loadInboxPage} loadReview={loadInboxReview} />
      <div className="mb-4"><LiveJournalHistory trades={accounts} accounts={inboxAccounts} mode={combined ? 'combined' : 'individual'}
        onMode={value => setCombined(value === 'combined')} onSelect={item => { setSelected(Math.max(0, accounts.findIndex(row => row.accountId === item.accountId))); setVisual('screenshots'); }} /></div>
      <button className="mb-4 text-xs text-indigo-500" onClick={() => setFailedChart(value => !value)}>{failedChart ? 'Skrýt test nedostupných podkladů' : 'Ukázat chybu načtení grafu'}</button>
      {failedChart && <div className="relative h-64 mb-4 rounded-xl border border-slate-500/20 bg-theme-card"><AccountExecutionChart trade={trade} isDark={dark} loadTrade={unavailableChart} /></div>}

    </div>
    <section className={`mx-auto max-w-[1500px] rounded-[40px] overflow-hidden border shadow-xl ${dark ? 'bg-theme-card border-white/10' : 'bg-white border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-4 px-6 py-5 border-b border-slate-500/10">
        <span className="text-xl font-black">MNQ <span className="text-emerald-500">Long</span></span>
        <span className="text-xs text-slate-500">10. září 2026 · {combined ? '12 účtů s plněním' : `Účet ${selected + 1}`}</span>
        <strong className="ml-auto text-2xl font-black text-emerald-500 tabular-nums">+${total.toFixed(2)}</strong>
        <div className="flex gap-1 rounded-xl bg-slate-500/5 p-1 text-xs">
          {[true, false].map(mode => <button key={String(mode)} onClick={() => setCombined(mode)} className={`rounded-lg px-3 py-2 ${combined === mode ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}>{mode ? 'Kombinované' : 'Individuální'}</button>)}
        </div>
      </div>
      <div className="grid lg:grid-cols-[260px_1fr] min-h-[730px]">
        <aside className="p-5 border-r border-slate-500/10">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-4">{combined ? 'Účty a rozdíly' : 'Vybraný účet'}</p>
          <p className="text-xs leading-relaxed text-slate-500 mb-4">Účet 11 má odmítnutý posun SL. Účet 9 má výpadek záznamu. Účet 13 nemá plnění a do výsledku se nepočítá.</p>
          <label className="block text-xs text-slate-500 mb-2" htmlFor="preview-account">Účet v grafu</label>
          <select id="preview-account" className="w-full rounded-xl border border-slate-500/20 bg-theme-card p-3 text-xs" value={selected} onChange={event => setSelected(Number(event.target.value))}>
            {accounts.map((item, index) => <option key={item.id} value={index}>{index === 0 ? 'Leader' : `Účet ${index + 1}`} · ${item.pnl.toFixed(2)}</option>)}
          </select>
          <dl className="mt-6 space-y-4 text-xs tabular-nums">
            <div><dt className="text-slate-500">Vstup vybraného účtu</dt><dd className="mt-1 font-bold">{trade.entryPrice?.toLocaleString('cs-CZ')}</dd></div>
            <div><dt className="text-slate-500">Výstup vybraného účtu</dt><dd className="mt-1 font-bold">{trade.exitPrice?.toLocaleString('cs-CZ')}</dd></div>
            <div><dt className="text-slate-500">Kontrakty</dt><dd className="mt-1 font-bold">{trade.positionSize}</dd></div>
          </dl>
        </aside>
        <div className="flex min-w-0 flex-col h-[730px]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-500/10">
            {(['screenshots', 'chart'] as const).map(mode => <button key={mode} onClick={() => setVisual(mode)} className={`rounded-lg px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${visual === mode ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}>{mode === 'screenshots' ? 'Screenshoty' : 'Graf'}</button>)}
            <span className="ml-auto text-[10px] text-slate-500">{selected === 0 ? 'Leader' : `Účet ${selected + 1}`} · vlastní časy a plnění</span>
          </div>
          {visual === 'screenshots' ? <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-500 text-xs"><span>Fiktivní obchod nemá screenshot.</span><button className="rounded-lg bg-emerald-500 px-4 py-2 text-white font-bold" onClick={() => setVisual('chart')}>Otevřít graf s historií SL/TP</button></div> : <>
            <div className="flex flex-wrap gap-3 px-4 py-2 text-xs text-[var(--text-secondary)]">
              <label>Svíčky <select aria-label="Test pokrytí svíček" className="rounded border border-slate-500/20 bg-theme-card p-1" value={candleScenario} onChange={event => setCandleScenario(event.target.value as typeof candleScenario)}><option value="complete">Souvislá ukázka</option><option value="gap">Chybí dvě minuty s posuny SL</option><option value="edges">Bez svíčky vstupu a výstupu</option></select></label>
              <label>Interval <select aria-label="Interval ukázky" className="rounded border border-slate-500/20 bg-theme-card p-1" value={chartTimeframe} onChange={event => setChartTimeframe(event.target.value as typeof chartTimeframe)}><option value="1m">1 minuta</option><option value="5m">5 minut</option></select></label>
            </div>
            <div className="relative flex-1 min-h-0"><CandleKitTradeChart trade={trade} candles={previewCandles} rawCandles={previewRawCandles} timeframe={chartTimeframe} entryMs={trade.entryTime!} exitMs={trade.timestamp} showFvg={false} showLevels={false} showStructure={false} isDark={dark} compactMode /></div>
            <TradeExecutionTimeline history={trade.executionHistory} isDark={dark} candleCoverage={{ candles: previewRawCandles, intervalSeconds: 60 }} />
          </>}
        </div>
      </div>
    </section>
    {detailOpen && <TradeDetailModal trade={combinedDetail ? aggregateHistoryTrades(accounts)[0] : trade} pnlDisplayMode={previewPnlMode} accountName={inboxAccounts[selected].name} theme={dark ? 'dark' : 'light'}
      emotions={[]} accounts={inboxAccounts} allTrades={accounts} onClose={() => setDetailOpen(false)} onDelete={() => setDetailOpen(false)}
      loadTradeDetail={loadPreviewDetail} loadJournalDetails={loadPreviewSelection} signCopierSnapshots={signPreviewSnapshots} onUpdateTrade={async updates => {
        if (failReview || combinedDetail) return false;
        setSavedReview(previous => ({ ...previous, [trade.accountId]: { ...previous[trade.accountId], ...journalReviewPatch(trade, updates) } }));
        return true;
      }} />}
    {editOpen && <ManualTradeForm editTrade={trade} onUpdate={async updates => {
      if (failReview) throw new Error('fictional-save-failed');
      setSavedReview(previous => ({ ...previous, [trade.accountId]: { ...previous[trade.accountId], ...journalReviewPatch(trade, updates) } }));
    }} onClose={() => setEditOpen(false)} theme={dark ? 'dark' : 'light'} accounts={inboxAccounts}
      activeAccountId={trade.accountId} availableEmotions={[]} availableMistakes={['Pozdní vstup']} availableHtfOptions={['Trend']} availableLtfOptions={['Reakce']} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary name="Fiktivní historie"><Preview /></ErrorBoundary>);
