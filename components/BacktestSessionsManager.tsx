import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { Layers, Plus, FlaskConical, Download, Play, Archive, RefreshCw, CheckCircle2, Copy } from 'lucide-react';
import { Account, Trade } from '../types';
import { storageService } from '../services/storageService';
import { pointValueFor } from '../services/tradovateImport';
import {
  archiveBacktestRun,
  createBacktestRun,
  listBacktestRuns,
  saveBacktestRun,
} from '../services/backtestRunService';
import type { BacktestRun } from '../services/backtestTypes';
import type { ChartWorkspaceLayoutId } from '../services/chartWorkspaceLayouts';

const SAVED_CHART_LAYOUT_KEY = 'alphatrade.candlekit.layout.alphatrade-market-workspace';
const CHART_LAYOUT_ID_KEY = 'alphatrade:chart-workspace-layout';

const readSavedChartLayout = (): { layout?: unknown; layoutId?: ChartWorkspaceLayoutId } => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SAVED_CHART_LAYOUT_KEY);
    const layoutId = window.localStorage.getItem(CHART_LAYOUT_ID_KEY) as ChartWorkspaceLayoutId | null;
    return { layout: raw ? JSON.parse(raw) : undefined, layoutId: layoutId ?? undefined };
  } catch {
    return {};
  }
};

const sanitizeSavedLayout = (value: unknown, allowNq: boolean): unknown => {
  if (allowNq || value == null) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeSavedLayout(item, allowNq));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === 'root' && item === 'NQ' ? 'MNQ' : sanitizeSavedLayout(item, allowNq),
  ]));
};

// positionSize (počet kontraktů): z uloženého pole, jinak dopočet z risku: riskAmount / (SL vzdálenost × $/bod).
const derivePositionSize = (t: any): number | null => {
  if (t.positionSize != null) return Number(t.positionSize);
  if (t.quantity != null) return Number(t.quantity);
  const risk = Number(t.riskAmount), e = Number(t.entryPrice), s = Number(t.stopLoss);
  const pv = pointValueFor(t.instrument || t.symbol || '');
  const slDist = Math.abs(e - s);
  if (risk > 0 && slDist > 0 && pv > 0) return Math.round(risk / (slDist * pv));
  return null;
};

interface Props {
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  trades: Trade[];
  onUpdate: (accounts: Account[]) => void;
  onDelete?: (id: string) => void;
  onOpenRun: (run: BacktestRun) => void;
}

// ── Export backtest obchodů do JSON pro AI analýzu (Claude Opus 4.8) ──────────
const EXPORT_LEGEND = {
  _o_souboru: "Export backtest obchodů z AlphaTrade. Každý obchod = 1 reálně zapsaný trade + 'counterfactual' (co by se stalo při jiném SL / TP / managementu, dopočítáno z barů). Slouží k AI analýze: najít edge, porovnat SL/TP/BE varianty, ověřit držení biasu, projít poznámky.",
  pole: {
    direction: "Long / Short",
    outcome: "Win / Loss / BE — reálný výsledek",
    pnl: "reálný PnL v $",
    slPlacement: "kam reálně dal SL: fvg (pod FVG) | swing (pod strukturní swing) | ote (pod 0.79 OTE) | other",
    targetType: "kam cílil TP: deviation | daily | fixed_rr | liquidity | other",
    management: "řízení pozice: trail_bos (trail za strukturou) | fixed (set&forget) | partial_runner | be_runner",
    sessionBias: "bias session (Long/Short/Neutral) zadaný PŘED obchodováním",
    biasAligned: "true = obchod ve směru biasu, false = proti biasu, null = Neutral/nezadáno",
    mfeR: "Max Favorable Excursion v R (kam až cena došla ve prospěch)",
    maeR: "Max Adverse Excursion v R (kam až proti)",
    counterfactual: "CO KDYBY. swing/ote/fvg = 3 varianty SL: každá má fixní-TP výsledek (outcome/rr/realizedR) i 'trail' (strukturní trailing: reason tp/trail+/trail/open, realizedR). tpTargets = co kdyby cílil na různé likviditní úrovně (label/price/outcome/realizedR), risk base = swing SL. realizedR = výsledek v R-násobcích.",
    excursion: "KAM BY TO DOŠLO DO KONCE DNE (Filip nesmí držet přes noc, vystupuje limitem na levelech). mfePotentialR=max favorable (může >TP), tpR, leftOnTableR=co zbylo na stole, levels[]=likvidní levely ve směru (reached/r/bars), trail=strukturní trailing.",
    entryMap: "VSTUPNÍ MODEL: structureType (CHoCH=reverzal / BoS=pokračování) + structureOrder, odrazLevels=od jakého levelu se cena odrazila, entryFvg=entry na hraně FVG.",
    htfConfluence_ltfConfluence: "ručně zvolené konfluence (tagy); SL/TP/entry jsou i tady jako tagy (SL Swing, TP VWAP, Odraz …, Entry FVG)",
    notes: "poznámky k obchodu · sessionPreNotes/PostNotes = poznámky k celé session",
  },
};

const buildTradeRecord = (t: any) => ({
  date: t.date, entryDate: t.entryDate, entryTime: t.entryTime,
  instrument: t.instrument || t.symbol, direction: t.direction, session: t.session,
  outcome: t.outcome, pnl: t.pnl, riskAmount: t.riskAmount, positionSize: derivePositionSize(t),
  entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit, exitPrice: t.exitPrice,
  durationMinutes: t.durationMinutes, executionStatus: t.executionStatus,
  slPlacement: t.slPlacement ?? null, targetType: t.targetType ?? null, targetLevel: t.targetLevel ?? null, management: t.management ?? null,
  sessionBias: t.sessionBias ?? null, biasAligned: t.biasAligned ?? null,
  htfConfluence: t.htfConfluence ?? [], ltfConfluence: t.ltfConfluence ?? [],
  emotions: t.emotions ?? [], mistakes: t.mistakes ?? [],
  notes: t.notes ?? null, sessionPreNotes: t.sessionPreNotes ?? null, sessionPostNotes: t.sessionPostNotes ?? null,
  mfeR: t.mfeR ?? null, maeR: t.maeR ?? null, mfePoints: t.mfePoints ?? null, maePoints: t.maePoints ?? null,
  runUp: t.runUp ?? null, drawdown: t.drawdown ?? null,
  excursionAvailable: t.excursionAvailable ?? null,
  excursion: t.excursion ?? null,
  entryMap: t.entryMap ?? null,
  counterfactual: t.counterfactual ?? null,
  schemaVersion: t.schemaVersion ?? null, source: t.source ?? null,
});

const downloadJSON = (filename: string, data: any) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const BacktestSessionsManager: React.FC<Props> = ({ theme, accounts, trades, onUpdate, onOpenRun }) => {
  const isDark = theme !== 'light';
  const [name, setName] = useState('');
  const [size, setSize] = useState('50000');
  const latestHistoricalDate = useMemo(() => {
    const value = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    return value.toISOString().slice(0, 10);
  }, []);
  const monthAgo = useMemo(() => {
    const value = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    return value.toISOString().slice(0, 10);
  }, []);
  const [startDate, setStartDate] = useState(monthAgo);
  const [endDate, setEndDate] = useState(latestHistoricalDate);
  const [includeNq, setIncludeNq] = useState(true);
  const [strategy, setStrategy] = useState('');
  const [commission, setCommission] = useState('0.37');
  const [slippage, setSlippage] = useState('0');
  const [timezone, setTimezone] = useState('Europe/Prague');
  const [startingLayout, setStartingLayout] = useState<ChartWorkspaceLayoutId>('2h');
  const [useSavedLayout, setUseSavedLayout] = useState(() => Boolean(readSavedChartLayout().layout));
  const savedLayoutAvailable = useMemo(() => Boolean(readSavedChartLayout().layout), []);
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try { setRuns(await listBacktestRuns()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Session se nepodařilo načíst.'); }
    finally { setLoadingRuns(false); }
  }, []);

  useEffect(() => {
    void loadRuns();
    const refresh = () => void loadRuns();
    window.addEventListener('alphatrade:backtest-run-saved', refresh);
    return () => window.removeEventListener('alphatrade:backtest-run-saved', refresh);
  }, [loadRuns]);

  const sessions = useMemo(() => accounts.filter(a => a.type === 'Backtest' && a.status === 'Active'), [accounts]);

  const statsByAcc = useMemo(() => {
    const m = new Map<string, { count: number; pnl: number }>();
    for (const t of trades) {
      const k = String(t.accountId);
      const cur = m.get(k) || { count: 0, pnl: 0 };
      cur.count++; cur.pnl += (t.pnl || 0);
      m.set(k, cur);
    }
    return m;
  }, [trades]);

  const inputCls = `w-full rounded-xl px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`;
  const cardCls = isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm';

  const [exporting, setExporting] = useState(false);
  const exportSessions = async (sess: Account[], single?: boolean) => {
    const ids = sess.map(s => String(s.id));
    setExporting(true);
    try {
      // Dotáhni PLNÝ blob z DB (in-memory trades mají blob stržený → counterfactual/excursion null).
      const full = await storageService.getTradesWithDataByAccounts(ids);
      if (full.length === 0) return;
      const out = {
        _legenda: EXPORT_LEGEND,
        exportovano: new Date().toISOString(),
        sessions: sess.map(s => ({ id: s.id, name: s.name, initialBalance: s.initialBalance })),
        pocetObchodu: full.length,
        obchody: full.map(buildTradeRecord),
      };
      const stamp = new Date().toISOString().slice(0, 10);
      const namePart = single && sess[0] ? sess[0].name.replace(/[^\w-]+/g, '_') : 'vse';
      downloadJSON(`backtest-${namePart}-${stamp}.json`, out);
    } finally {
      setExporting(false);
    }
  };

  const totalTrades = useMemo(() => {
    const ids = new Set(sessions.map(s => String(s.id)));
    return trades.filter(t => ids.has(String(t.accountId))).length;
  }, [sessions, trades]);

  const createAccount = (accountName: string, capital: number): Account => ({
    id: crypto.randomUUID(), name: accountName, initialBalance: capital, challengeCost: 0,
    totalWithdrawals: 0, totalGrossWithdrawals: 0, profitSplit: 100, profitTarget: 10,
    phase: undefined, accumulatedChallengePnL: 0, type: 'Backtest', status: 'Active',
    currency: 'USD', propThreshold: 150, instrumentFees: { NQ: 2.8, MNQ: 0.74 }, createdAt: Date.now(),
  } as unknown as Account);

  const create = async () => {
    const n = name.trim();
    const s = Number(size);
    const startAt = new Date(`${startDate}T00:00:00`).getTime();
    const endAt = new Date(`${endDate}T23:59:59`).getTime();
    if (!n || !s || s <= 0 || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      setError('Zkontroluj název, kapitál a rozsah datumů.');
      return;
    }
    setCreating(true);
    setError(null);
    const account = createAccount(n, s);
    onUpdate([...accounts, account]);
    try {
      const savedWorkspace = useSavedLayout ? readSavedChartLayout() : {};
      const run = await createBacktestRun({
        accountId: account.id,
        name: n,
        initialCapital: s,
        startAt,
        endAt,
        config: {
          instruments: includeNq ? ['MNQ', 'NQ'] : ['MNQ'],
          executionInstrument: 'MNQ',
          strategy: strategy.trim() || undefined,
          timezone,
          commissionPerSide: { MNQ: Math.max(0, Number(commission) || 0), NQ: 1.4 },
          slippageTicks: { MNQ: Math.max(0, Number(slippage) || 0), NQ: Math.max(0, Number(slippage) || 0) },
        },
        workspaceState: {
          layout: sanitizeSavedLayout(savedWorkspace.layout, includeNq),
          layoutId: savedWorkspace.layoutId ?? startingLayout,
        },
      });
      setRuns(current => [run, ...current]);
      setName('');
      setStrategy('');
      onOpenRun(run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session se nepodařilo vytvořit.');
    } finally {
      setCreating(false);
    }
  };

  const duplicateRun = async (source: BacktestRun) => {
    setCreating(true);
    setError(null);
    try {
      const duplicateName = `${source.name} – kopie`;
      const account = createAccount(duplicateName, source.initialCapital);
      onUpdate([...accounts, account]);
      const duplicated = await createBacktestRun({
        accountId: String(account.id),
        name: duplicateName,
        initialCapital: source.initialCapital,
        startAt: source.startAt,
        endAt: source.endAt,
        config: source.config,
        workspaceState: { ...source.workspaceState, panels: undefined },
      });
      setRuns(current => [duplicated, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session se nepodařilo duplikovat.');
    } finally {
      setCreating(false);
    }
  };

  const progress = (run: BacktestRun) => run.cursorAt === null ? 0 : Math.max(0, Math.min(100,
    ((run.cursorAt - run.startAt) / (run.endAt - run.startAt)) * 100,
  ));

  const changeStatus = async (run: BacktestRun, status: 'completed' | 'archived') => {
    const next = status === 'archived'
      ? await archiveBacktestRun(run)
      : await saveBacktestRun(run, { status: 'completed', runtimeState: { ...run.runtimeState, replay: { ...run.runtimeState.replay, playing: false } } });
    setRuns(current => current.map(item => item.id === run.id ? next : item));
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-2xl mx-auto px-4 lg:px-8 pt-[80px] lg:pt-[96px] pb-20">
      <div className="flex items-center gap-3 border-b pb-4 mb-6 border-[var(--border-subtle)]">
        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
          <Layers size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl md:text-3xl font-black tracking-tighter italic">SESSIONS</h2>
          <p className="text-[11px] font-bold text-slate-500 tracking-wide">{runs.filter(run => run.status !== 'archived').length} replay session{runs.length === 1 ? '' : 's'}</p>
        </div>
        {totalTrades > 0 && (
          <button onClick={() => exportSessions(sessions)} title="Export všech backtest obchodů do JSON (pro AI analýzu)"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-black transition-all ${isDark ? 'bg-violet-500/15 text-violet-300 hover:bg-violet-500/25' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'}`}>
            <Download size={14} /> Export vše
          </button>
        )}
      </div>

      {/* Nová obnovitelná session */}
      <div className={`p-4 rounded-2xl border mb-6 ${cardCls}`}>
        <p className={`text-[10px] font-black uppercase tracking-widest mb-3 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Nová session</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Název session</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="např. NQ Silver Bullet" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Velikost účtu ($)</label>
            <input type="number" value={size} onChange={e => setSize(e.target.value)} placeholder="50000" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Strategie / playbook</label><input value={strategy} onChange={event => setStrategy(event.target.value)} placeholder="volitelné" className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Od</label><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Do</label><input type="date" value={endDate} max={latestHistoricalDate} onChange={event => setEndDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Komise MNQ / strana</label><input type="number" step="0.01" min="0" value={commission} onChange={event => setCommission(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Slippage (ticky)</label><input type="number" step="1" min="0" value={slippage} onChange={event => setSlippage(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Timezone</label><select value={timezone} onChange={event => setTimezone(event.target.value)} className={inputCls}><option value="Europe/Prague">Praha</option><option value="America/New_York">New York</option><option value="UTC">UTC</option></select></div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Výchozí layout</label>
            <select
              value={useSavedLayout ? 'saved' : startingLayout}
              onChange={event => {
                if (event.target.value === 'saved') setUseSavedLayout(true);
                else { setUseSavedLayout(false); setStartingLayout(event.target.value as ChartWorkspaceLayoutId); }
              }}
              className={inputCls}
            >
              <option value="saved" disabled={!savedLayoutAvailable}>Můj uložený layout{savedLayoutAvailable ? '' : ' (není uložený)'}</option>
              <option value="1">1 graf</option><option value="2h">2 vedle sebe</option><option value="2v">2 nad sebou</option><option value="4">4 grafy</option>
            </select>
          </div>
          <div className={`sm:col-span-2 flex items-center justify-between rounded-xl border px-3 py-2 ${isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50'}`}><div><p className="text-xs font-black">Instrumenty</p><p className="text-[10px] text-slate-500">Entry vždy MNQ · společný 1m replay clock</p></div><div className="flex gap-2"><span className="rounded-lg bg-violet-500/15 px-2 py-1 text-[10px] font-black text-violet-500">MNQ</span><label className="flex cursor-pointer items-center gap-1 text-[10px] font-black"><input type="checkbox" checked={includeNq} onChange={event => setIncludeNq(event.target.checked)} /> NQ</label></div></div>
          <button onClick={() => void create()} disabled={!name.trim() || !Number(size) || creating}
            className="sm:col-span-2 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-black uppercase tracking-widest transition-all active:scale-95">
            {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />} Vytvořit a otevřít
          </button>
        </div>
        {error && <p className="mt-3 text-xs font-bold text-rose-500">{error}</p>}
      </div>

      {/* Nové replay sessions */}
      {loadingRuns ? <div className="py-10 text-center text-xs text-slate-500">Načítám sessions…</div> : runs.filter(run => run.status !== 'archived').length === 0 ? (
        <div className={`text-center py-14 px-6 rounded-2xl border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          Zatím žádná obnovitelná session. Vytvoř první nahoře.
        </div>
      ) : (
        <div className="space-y-3">
          {runs.filter(run => run.status !== 'archived').map(run => {
            const st = statsByAcc.get(String(run.accountId)) || { count: run.runtimeState.closedTrades.length, pnl: run.runtimeState.realizedPnl };
            const pnlPos = run.runtimeState.realizedPnl >= 0;
            const pct = progress(run);
            return (
              <div key={run.id} className={`p-4 rounded-2xl border ${cardCls}`}>
                <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                  <FlaskConical size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2"><p className="text-sm font-black truncate">{run.name}</p><span className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${run.status === 'completed' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}>{run.status === 'completed' ? 'Dokončeno' : run.cursorAt ? 'Pozastaveno' : 'Nová'}</span></div>
                  <p className="text-[11px] font-bold text-slate-500">${run.initialCapital.toLocaleString('en-US')} · {run.config.instruments.join(' + ')} · {st.count} obchod{st.count === 1 ? '' : st.count >= 2 && st.count <= 4 ? 'y' : 'ů'}</p>
                </div>
                {(st.count > 0 || run.runtimeState.realizedPnl !== 0) && (
                  <span className={`text-sm font-black font-mono px-2.5 py-1 rounded-lg ${pnlPos ? (isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (isDark ? 'bg-rose-500/15 text-rose-400' : 'bg-rose-100 text-rose-700')}`}>
                    {pnlPos ? '+' : ''}${run.runtimeState.realizedPnl.toFixed(2)}
                  </span>
                )}
                <button onClick={() => onOpenRun(run)} className="flex h-9 items-center gap-1.5 rounded-xl bg-violet-600 px-3 text-[10px] font-black text-white hover:bg-violet-500"><Play size={13} fill="currentColor" />{run.cursorAt ? 'Pokračovat' : 'Spustit'}</button>
                <button onClick={() => void duplicateRun(run)} disabled={creating} className={`flex h-9 w-9 items-center justify-center rounded-xl ${isDark ? 'text-slate-400 hover:bg-white/5' : 'text-slate-500 hover:bg-slate-100'}`} title="Duplikovat session"><Copy size={15} /></button>
                <button onClick={() => void changeStatus(run, run.status === 'completed' ? 'archived' : 'completed')} className={`flex h-9 w-9 items-center justify-center rounded-xl ${isDark ? 'text-slate-400 hover:bg-white/5' : 'text-slate-500 hover:bg-slate-100'}`} title={run.status === 'completed' ? 'Archivovat' : 'Dokončit'}>{run.status === 'completed' ? <Archive size={15} /> : <CheckCircle2 size={15} />}</button>
                </div>
                <div className={`mt-3 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 flex justify-between text-[9px] font-bold text-slate-500"><span>{new Date(run.startAt).toLocaleDateString('cs-CZ')}</span><span>{pct.toFixed(1)} %</span><span>{new Date(run.endAt).toLocaleDateString('cs-CZ')}</span></div>
              </div>
            );
          })}
        </div>
      )}

      {sessions.length > runs.length && <p className="mt-5 text-center text-[10px] text-slate-500">Původní AlphaBridge backtest účty zůstávají zachované; nové replay sessions používají rozšířený formát.</p>}
    </div>
  );
};

export default BacktestSessionsManager;
