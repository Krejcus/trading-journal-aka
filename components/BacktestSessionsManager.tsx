import { backtestSessionStats } from '../services/backtestSessionStats';
import { bindResearchRule, type BacktestResearchBinding } from '../services/backtestResearchCases';
import { useWorkspaceLibrary } from '../hooks/useWorkspaceLibrary';
import { workspaceTemplateForNewSession } from '../services/chartWorkspaceLibrary';
import { blindReviewProgress, type BlindReviewDoc } from '../services/backtestBlindReview';
import { loadBlindReview } from '../services/backtestBlindReviewStore';
import { chartAppearanceUserId } from '../services/chartAppearanceScope';
import { summarizeWorkspaceDocument } from '../services/chartWorkspaceDocument';
import { buildBacktestAiExport } from '../services/backtestAiExport';
import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Layers, Plus, FlaskConical, Download, Play, Archive, RefreshCw, CheckCircle2, Copy, Search, List, LayoutGrid, ArrowRight, ChevronDown } from 'lucide-react';
import { Account, Trade, LabExperiment } from '../types';
import { storageService } from '../services/storageService';
import {
  archiveBacktestRun,
  createBacktestRun,
  listBacktestRuns,
  listBacktestRunConflictCopies,
  type BacktestRunConflictCopy,
  saveBacktestRun,
} from '../services/backtestRunService';
import type { BacktestRun } from '../services/backtestTypes';
import type { TransitionRect } from './BacktestRunTransition';
import type { ChartWorkspaceLayoutId } from '../services/chartWorkspaceLayouts';

const iconBtn = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-active)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40';

const sessionStatus = (run: BacktestRun): { label: string; tone: string } => {
  if (run.status === 'completed') return { label: 'Dokončeno', tone: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500' };
  if (run.cursorAt) return { label: 'Pozastaveno', tone: 'border-amber-500/25 bg-amber-500/10 text-amber-500' };
  return { label: 'Nová', tone: 'border-violet-500/25 bg-violet-500/10 text-violet-400' };
};

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString('cs-CZ');

/** Kde se v session skončilo — v časové zóně session. */
const cursorLabel = (run: BacktestRun) => {
  if (run.cursorAt === null) return '';
  try {
    return new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: run.config.timezone }).format(run.cursorAt);
  } catch {
    return new Date(run.cursorAt).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
};

interface Props {
  /** Optional rollback/preview of the existing presentation. */
  enhanced?: boolean;
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  trades: Trade[];
  onUpdate: (accounts: Account[]) => void;
  onDelete?: (id: string) => void;
  /** `origin` = karta, ze které se graf rozvine (BacktestRunTransition). */
  onOpenRun: (run: BacktestRun, origin?: TransitionRect | null) => void;
  onOpenBlindReview?: (doc: BlindReviewDoc) => void;
}

const downloadJSON = (filename: string, data: any) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const BacktestSessionsManager: React.FC<Props> = ({ theme, accounts, trades, onUpdate, onOpenRun, onOpenBlindReview, enhanced = true }) => {
  const [blindReview, setBlindReview] = useState<BlindReviewDoc | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => void loadBlindReview().then(doc => { if (active) setBlindReview(doc); }).catch(() => { if (active) setBlindReview(null); });
    refresh();
    window.addEventListener('alphatrade:blind-review-closed', refresh);
    return () => { active = false; window.removeEventListener('alphatrade:blind-review-closed', refresh); };
  }, []);
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
  const [researchCases, setResearchCases] = useState<LabExperiment[]>([]);
  const [researchError, setResearchError] = useState<string>();
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchCaseId, setResearchCaseId] = useState('');
  const [researchRevisionId, setResearchRevisionId] = useState('');
  const [researchRole, setResearchRole] = useState<BacktestResearchBinding['role']>('development');
  const creatingRef = useRef(false);
  const [strategy, setStrategy] = useState('');
  const [commission, setCommission] = useState('0.37');
  const [slippage, setSlippage] = useState('0');
  const [timezone, setTimezone] = useState('Europe/Prague');
  const [startingLayout, setStartingLayout] = useState<ChartWorkspaceLayoutId>('2h');
  const workspaceLibrary = useWorkspaceLibrary();
  const [selectedTemplate, setSelectedTemplate] = useState('default');
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [conflictCopies, setConflictCopies] = useState<BacktestRunConflictCopy[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [runFilter, setRunFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [runSearch, setRunSearch] = useState('');
  const [runSort, setRunSort] = useState<'recent' | 'name'>('recent');
  const [runView, setRunView] = useState<'list' | 'cards'>('list');

  const [error, setError] = useState<string | null>(null);

  // „Načítám…“ jen při prvním načtení (výchozí stav). Obnova po zavření grafu
  // nechá karty stát — graf se do své karty skládá a seznam neproblikne.
  const loadRuns = useCallback(async () => {
    try {
      const [nextRuns, copies] = await Promise.all([listBacktestRuns(), listBacktestRunConflictCopies()]);
      setRuns(nextRuns); setConflictCopies(copies); setError(null);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Session se nepodařilo načíst.'); }
    finally { setLoadingRuns(false); }
  }, []);

  useEffect(() => {
    void loadRuns();
    const refresh = () => void loadRuns();
    window.addEventListener('alphatrade:backtest-run-saved', refresh);
    return () => window.removeEventListener('alphatrade:backtest-run-saved', refresh);
  }, [loadRuns]);

  useEffect(() => {
    if (!showCreateForm) return;
    const owner = chartAppearanceUserId(); let active = true;
    setResearchLoading(true); setResearchError(undefined); setResearchCases([]);
    void storageService.getLabExperiments().then(items => {
      if (active && owner === chartAppearanceUserId()) setResearchCases(items.filter(item => item.world === 'backtest' && item.research));
    }).catch(reason => { if (active) setResearchError(reason instanceof Error ? reason.message : 'Pravidla se nepodařilo načíst.'); })
      .finally(() => { if(active) setResearchLoading(false); });
    return () => { active = false; };
  }, [showCreateForm]);
  const selectedResearch = researchCases.find(item => item.id === researchCaseId);
  const selectedRevision = selectedResearch?.research?.revisions.find(item => item.id === researchRevisionId);

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

  const statsByRun = useMemo(() => new Map(runs.filter(run => run.status !== 'archived').map(run => [run.id, backtestSessionStats(run)])), [runs]);

  const inputCls = `w-full rounded-lg px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`;

  const [exporting, setExporting] = useState(false);
  const exportSessions = async (sess: Account[], single?: boolean) => {
    const ids = sess.map(s => String(s.id));
    const owner = chartAppearanceUserId();
    setExporting(true);
    try {
      // Dotáhni PLNÝ blob z DB (in-memory trades mají blob stržený → counterfactual/excursion null).
      const full = await storageService.getTradesWithDataByAccounts(ids, undefined, { strict:true, ...(typeof owner === 'string' ? { expectedOwnerId:owner } : {}) });
      if (full.length === 0) return;
      if (owner !== chartAppearanceUserId()) throw new Error('Uživatel se změnil. Export zrušen.');
      const out = buildBacktestAiExport(sess, full, runs);
      const stamp = new Date().toISOString().slice(0, 10);
      const namePart = single && sess[0] ? sess[0].name.replace(/[^\w-]+/g, '_') : 'vse';
      downloadJSON(`backtest-${namePart}-${stamp}.json`, out);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Export se nepodařil.');
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
    if (creatingRef.current) return;
    const n = name.trim();
    const s = Number(size);
    const startAt = new Date(`${startDate}T00:00:00`).getTime();
    const endAt = new Date(`${endDate}T23:59:59`).getTime();
    if (!n || !s || s <= 0 || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      setError('Zkontroluj název, kapitál a rozsah datumů.');
      return;
    }
    creatingRef.current = true; setCreating(true);
    setError(null);
    const owner = chartAppearanceUserId();
    const account = createAccount(n, s);
    try {
      if (workspaceLibrary.owner !== chartAppearanceUserId()) throw new Error('Uživatel se změnil. Znovu vyber workspace šablonu.');
      const savedWorkspace = workspaceTemplateForNewSession(chartAppearanceUserId(), selectedTemplate, includeNq ? ['MNQ', 'NQ'] : ['MNQ']) ?? { layoutId: selectedTemplate === 'default' ? '2h' as const : startingLayout };
      let researchBinding: BacktestResearchBinding | undefined;
      if (researchCaseId) {
        const currentCases = await storageService.getLabExperiments();
        if (owner !== chartAppearanceUserId()) throw new Error('Uživatel se změnil. Session nebyla vytvořená.');
        const experiment = currentCases.find(item => item.id === researchCaseId);
        if (!experiment) throw new Error('Výzkumný případ již není dostupný. Obnov jeho seznam.');
        researchBinding = await bindResearchRule({ experiment, revisionId:researchRevisionId, role:researchRole, marketStart:startAt, marketEnd:endAt,
          recordedAt:Date.now(), operationId:crypto.randomUUID(), runs, trades, historyComplete:false });
      }
      if (owner !== chartAppearanceUserId()) throw new Error('Uživatel se změnil. Session nebyla vytvořená.');
      onUpdate([...accounts, account]);
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
          researchBinding,
          timezone,
          commissionPerSide: { MNQ: Math.max(0, Number(commission) || 0), NQ: 1.4 },
          slippageTicks: { MNQ: Math.max(0, Number(slippage) || 0), NQ: Math.max(0, Number(slippage) || 0) },
        },
        workspaceState: savedWorkspace,
      });
      setRuns(current => [run, ...current]);
      setName('');
      setStrategy('');
      onOpenRun(run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session se nepodařilo vytvořit.');
    } finally {
      creatingRef.current = false; setCreating(false);
    }
  };

  const duplicateRun = async (source: BacktestRun) => {
    if (creatingRef.current) return;
    creatingRef.current = true; setCreating(true);
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
        config: { ...source.config, ...(source.config.researchBinding ? { researchBinding: { ...structuredClone(source.config.researchBinding),
          id:crypto.randomUUID(), boundAt:Date.now(), exposureAtBinding:'already-observed' as const,
          exposureReasons:['Kopie existující výzkumné session; nejde o nový neviděný vzorek.'],
          priorRunIds:[...new Set([...source.config.researchBinding.priorRunIds,source.id])] } } : {}) },
        workspaceState: { ...source.workspaceState, panels: undefined },
      });
      setRuns(current => [duplicated, ...current]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session se nepodařilo duplikovat.');
    } finally {
      creatingRef.current = false; setCreating(false);
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

  const availableRuns = runs.filter(run => run.status !== 'archived');
  const activeRuns = availableRuns.filter(run => run.status !== 'completed');
  const completedRuns = availableRuns.filter(run => run.status === 'completed');
  const lastRun = activeRuns.filter(run => run.cursorAt !== null)
    .reduce<BacktestRun | undefined>((latest, run) => !latest || (run.lastOpenedAt ?? run.updatedAt) > (latest.lastOpenedAt ?? latest.updatedAt) ? run : latest, undefined);
  const query = runSearch.trim().toLocaleLowerCase('cs');
  const visibleRuns = enhanced ? availableRuns
    .filter(run => (runFilter === 'all' || (runFilter === 'completed' ? run.status === 'completed' : run.status !== 'completed'))
      && (!query || `${run.name} ${run.config.strategy ?? ''} ${run.config.instruments.join(' ')}`.toLocaleLowerCase('cs').includes(query)))
    .sort((a, b) => runSort === 'name' ? a.name.localeCompare(b.name, 'cs') : (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt)) : availableRuns;

  const lastStats = lastRun ? statsByRun.get(lastRun.id) : undefined;
  const percent = (value: number | null) => value === null ? '—' : `${value.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %`;
  const pf = (stats: ReturnType<typeof backtestSessionStats>) => stats.profitFactorState === 'no-losses' ? '∞' : stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2);
  const cash = (value: number | null) => value === null ? '—' : `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(2)}`;

  return (
    <div data-bt-sessions="" data-bt-enhanced={enhanced || undefined} data-bt-view={enhanced ? runView : undefined} className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto px-4 lg:px-8 pt-[80px] lg:pt-[96px] pb-20">
      <div className="flex items-center gap-3 border-b pb-4 mb-6 border-[var(--border-subtle)]">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
          <Layers size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">{enhanced ? 'Backtest sessions' : 'SESSIONS'}</h2>
          <p className="text-[11px] font-bold text-slate-500 tracking-wide">{runs.filter(run => run.status !== 'archived').length} replay session{runs.length === 1 ? '' : 's'}</p>
        </div>
        <div className="flex items-center gap-2">
          {conflictCopies.length > 0 && <button onClick={() => downloadJSON(`backtest-lokalni-kopie-${new Date().toISOString().slice(0, 10)}.json`, conflictCopies)} title="Export lokálního postupu uchovaného při konfliktu s cloudem" className="rounded-lg border border-amber-500/30 px-3 py-2 text-[11px] font-bold text-amber-500">Lokální kopie ({conflictCopies.length})</button>}
          {totalTrades > 0 && (
            <button disabled={exporting} onClick={() => exportSessions(sessions)} title="Export všech backtest obchodů do JSON (pro AI analýzu)"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-black transition-all ${isDark ? 'bg-violet-500/15 text-violet-300 hover:bg-violet-500/25' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'}`}>
              <Download size={14} /> Export vše
            </button>
          )}
          <button
            onClick={() => { setShowCreateForm(current => !current); setError(null); }}
            aria-expanded={showCreateForm}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[11px] font-black text-white transition-colors hover:bg-violet-500"
          >
            <Plus size={14} className={`transition-transform ${showCreateForm ? 'rotate-45' : ''}`} />
            {showCreateForm ? 'Zavřít' : 'Nová session'}
          </button>
        </div>
      </div>

      {blindReview && onOpenBlindReview && (() => {
        const progress = blindReviewProgress(blindReview);
        return (
          <div className={`mb-6 flex items-center gap-3 rounded-lg border p-4 ${isDark ? 'border-violet-500/30 bg-violet-500/10' : 'border-violet-200 bg-violet-50'}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{blindReview.name}</p>
              <p className="text-[11px] font-semibold text-slate-500">Odpovězeno {progress.answered} z {progress.total}. Nic se odtud neukládá do deníku ani statistik.</p>
            </div>
            <button onClick={() => onOpenBlindReview(blindReview)} className="rounded-lg bg-violet-600 px-3 py-2 text-[11px] font-black text-white transition-colors hover:bg-violet-500">
              {progress.answered ? 'Pokračovat' : 'Začít'}
            </button>
          </div>
        );
      })()}

      {/* Nová obnovitelná session */}
      {showCreateForm && (enhanced ? (
        <section className="bt-create-shell" data-bt-create="" aria-label="Nová replay session">
          <div className="theme-card bt-create-main">
            <div className="bt-form-heading"><span>01</span><div><h3>Co chceš otestovat?</h3><p>Jeden setup, jasné období, vlastní tempo.</p></div></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Název session</label>
            <input aria-label="Název session" value={name} onChange={e => setName(e.target.value)} placeholder="např. NQ Silver Bullet" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div className="sm:col-span-2"><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Strategie / playbook</label><input aria-label="Strategie / playbook" value={strategy} onChange={event => setStrategy(event.target.value)} placeholder="volitelné" className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Od</label><input type="date" aria-label="Od" value={startDate} onChange={event => setStartDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Do</label><input type="date" aria-label="Do" value={endDate} max={latestHistoricalDate} onChange={event => setEndDate(event.target.value)} className={inputCls} /></div>
          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Velikost účtu ($)</label>
            <input type="number" aria-label="Velikost účtu" value={size} onChange={e => setSize(e.target.value)} placeholder="50000" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Timezone</label><select aria-label="Timezone" value={timezone} onChange={event => setTimezone(event.target.value)} className={inputCls}><option value="Europe/Prague">Praha</option><option value="America/New_York">New York</option><option value="UTC">UTC</option></select></div>
            </div>
            <div className="bt-form-heading bt-form-heading--second"><span>02</span><div><h3>Pracovní plocha</h3><p>Stejné grafy a nástroje, na které jsi zvyklý.</p></div></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={`sm:col-span-2 flex items-center justify-between rounded-lg border px-3 py-2 border-[var(--border-subtle)] bg-[var(--bg-page)]`}><div><p className="text-xs font-black">Instrumenty</p><p className="text-[10px] text-slate-500">Entry vždy MNQ · společný 1m replay clock</p></div><div className="flex gap-2"><span className="rounded-lg bg-violet-500/15 px-2 py-1 text-[10px] font-black text-violet-500">MNQ</span><label className="flex cursor-pointer items-center gap-1 text-[10px] font-black"><input type="checkbox" checked={includeNq} onChange={event => setIncludeNq(event.target.checked)} /> NQ</label></div></div>
          <div className="sm:col-span-2">
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Výchozí layout</label>
            <select
              value={selectedTemplate === 'preset' ? startingLayout : selectedTemplate}
              onChange={event => {
                const value = event.target.value;
                if (value === 'default' || value.startsWith('template:')) setSelectedTemplate(value);
                else { setSelectedTemplate('preset'); setStartingLayout(value as ChartWorkspaceLayoutId); }
              }}
              className={inputCls}
            >
              <option value="default">{workspaceLibrary.library.defaultId ? `Výchozí: ${workspaceLibrary.library.templates.find(item => item.id === workspaceLibrary.library.defaultId)?.name}` : 'Výchozí · 2 grafy'}</option>
              {workspaceLibrary.library.templates.map(template => {
                const summary = summarizeWorkspaceDocument(template.document);
                const incompatible = !includeNq && summary.roots.includes('NQ');
                return <option key={template.id} value={`template:${template.id}`} disabled={incompatible}>{template.name}{incompatible ? ' · vyžaduje NQ' : ` · ${summary.panels} grafy`}</option>;
              })}
              <option value="1">1 graf</option><option value="2h">2 vedle sebe</option><option value="2v">2 nad sebou</option><option value="4">4 grafy</option>
            </select>
            <p className="mt-1 text-[10px] text-slate-500">{workspaceLibrary.error || 'Šablony uložené v grafu obsahují i kresby, indikátory a vzhled. Knihovna je lokální pro tento účet.'}</p>
          </div>
            </div>
            <details className="bt-create-advanced">
              <summary><span>Exekuce a výzkum<small>Komise, skluz a konkrétní verze pravidel</small></span><ChevronDown size={16}/></summary>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Komise MNQ / strana</label><input type="number" step="0.01" min="0" aria-label="Komise MNQ / strana" value={commission} onChange={event => setCommission(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Slippage (ticky)</label><input type="number" step="1" min="0" aria-label="Slippage v ticích" value={slippage} onChange={event => setSlippage(event.target.value)} className={inputCls} /></div>
          <div className="sm:col-span-2 rounded-lg border border-violet-500/20 p-3 space-y-2">
            <label className="block text-xs font-semibold">Výzkumný případ
              <select aria-label="Výzkumný případ" className={`${inputCls} mt-1`} value={researchCaseId} disabled={researchLoading} onChange={event=>{
                const item=researchCases.find(candidate=>candidate.id===event.target.value); setResearchCaseId(event.target.value);
                setResearchRevisionId(item?.research?.revisions.at(-1)?.id??''); setResearchRole('development');
              }}><option value="">Volný replay bez výzkumného případu</option>{researchCases.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select>
            </label>
            {researchLoading && <p className="text-xs text-slate-500">Načítám uložená pravidla…</p>}
            {researchError && <p role="alert" className="text-xs text-amber-500">{researchError}</p>}
            {selectedResearch && <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs">Verze pravidel<select aria-label="Verze pravidel" className={`${inputCls} mt-1`} value={researchRevisionId} onChange={event=>setResearchRevisionId(event.target.value)}>
                {selectedResearch.research?.revisions.map(revision=><option key={revision.id} value={revision.id} disabled={revision.recordedAt===null}>v{revision.version} · {revision.reason}</option>)}
              </select></label>
              <label className="text-xs">Účel session<select aria-label="Účel výzkumné session" className={`${inputCls} mt-1`} value={researchRole} onChange={event=>setResearchRole(event.target.value as BacktestResearchBinding['role'])}>
                <option value="development">Vývoj pravidla</option><option value="validation" disabled={!selectedRevision?.definition.validation}>Plánované ověření</option>
              </select></label>
              {selectedRevision && <div className="sm:col-span-2 text-xs text-slate-500"><p className="whitespace-pre-wrap">{selectedRevision.definition.rule}</p><p className="mt-1">Vyvrácení: {selectedRevision.definition.falsification}</p>
                <p className="mt-1">{selectedRevision.definition.timeZone} · vývoj {selectedRevision.definition.development ? `${selectedRevision.definition.development.from} až ${selectedRevision.definition.development.through}` : 'bez omezení'} · ověření {selectedRevision.definition.validation ? `${selectedRevision.definition.validation.from} až ${selectedRevision.definition.validation.through}` : 'nenaplánováno'}</p>
              </div>}
              <p className="sm:col-span-2 text-xs text-amber-500">Uloží se tato konkrétní verze. Plánované ověření zatím není uzamčený neviděný vzorek; úplná historie předchozího zobrazení není doložená.</p>
            </div>}
          </div>
              </div>
            </details>
          </div>
          <aside className="theme-card bt-create-summary">
            <span className="bt-overline">NOVÁ REPLAY SESSION</span>
            <h3>{name.trim() || 'Tvůj další backtest'}</h3>
            <p>{strategy.trim() || 'Volný replay'}</p>
            <dl><div><dt>Instrumenty</dt><dd>MNQ{includeNq ? ' + NQ' : ''}</dd></div><div><dt>Období</dt><dd>{startDate} → {endDate}</dd></div><div><dt>Kapitál</dt><dd>${Number(size || 0).toLocaleString('en-US')}</dd></div><div><dt>Časová zóna</dt><dd>{timezone}</dd></div><div><dt>Komise MNQ</dt><dd>${Math.max(0, Number(commission) || 0).toFixed(2)} / strana</dd></div><div><dt>Skluz</dt><dd>{slippage || '0'} ticků</dd></div><div><dt>Výzkum</dt><dd>{selectedResearch?.title || 'Volný replay'}</dd></div></dl>
          <button onClick={() => void create()} disabled={!name.trim() || !Number(size) || creating}
            className="sm:col-span-2 flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-semibold transition-all active:scale-95">
            {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />} Vytvořit a otevřít
          </button>
            <small>Nastavení zůstává součástí této session.</small>
            {error && <p role="alert" className="text-xs font-bold text-rose-500">{error}</p>}
          </aside>
        </section>
      ) : (
<div className="theme-card p-4 rounded-lg mb-6 animate-in fade-in slide-in-from-top-2 duration-200">
        <p className={`text-[11px] font-semibold mb-3 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Nová session</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Název session</label>
            <input aria-label="Název session" value={name} onChange={e => setName(e.target.value)} placeholder="např. NQ Silver Bullet" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Velikost účtu ($)</label>
            <input type="number" aria-label="Velikost účtu" value={size} onChange={e => setSize(e.target.value)} placeholder="50000" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Strategie / playbook</label><input aria-label="Strategie / playbook" value={strategy} onChange={event => setStrategy(event.target.value)} placeholder="volitelné" className={inputCls} /></div>
          <div className="sm:col-span-2 rounded-lg border border-violet-500/20 p-3 space-y-2">
            <label className="block text-xs font-semibold">Výzkumný případ
              <select aria-label="Výzkumný případ" className={`${inputCls} mt-1`} value={researchCaseId} disabled={researchLoading} onChange={event=>{
                const item=researchCases.find(candidate=>candidate.id===event.target.value); setResearchCaseId(event.target.value);
                setResearchRevisionId(item?.research?.revisions.at(-1)?.id??''); setResearchRole('development');
              }}><option value="">Volný replay bez výzkumného případu</option>{researchCases.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select>
            </label>
            {researchLoading && <p className="text-xs text-slate-500">Načítám uložená pravidla…</p>}
            {researchError && <p role="alert" className="text-xs text-amber-500">{researchError}</p>}
            {selectedResearch && <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs">Verze pravidel<select aria-label="Verze pravidel" className={`${inputCls} mt-1`} value={researchRevisionId} onChange={event=>setResearchRevisionId(event.target.value)}>
                {selectedResearch.research?.revisions.map(revision=><option key={revision.id} value={revision.id} disabled={revision.recordedAt===null}>v{revision.version} · {revision.reason}</option>)}
              </select></label>
              <label className="text-xs">Účel session<select aria-label="Účel výzkumné session" className={`${inputCls} mt-1`} value={researchRole} onChange={event=>setResearchRole(event.target.value as BacktestResearchBinding['role'])}>
                <option value="development">Vývoj pravidla</option><option value="validation" disabled={!selectedRevision?.definition.validation}>Plánované ověření</option>
              </select></label>
              {selectedRevision && <div className="sm:col-span-2 text-xs text-slate-500"><p className="whitespace-pre-wrap">{selectedRevision.definition.rule}</p><p className="mt-1">Vyvrácení: {selectedRevision.definition.falsification}</p>
                <p className="mt-1">{selectedRevision.definition.timeZone} · vývoj {selectedRevision.definition.development ? `${selectedRevision.definition.development.from} až ${selectedRevision.definition.development.through}` : 'bez omezení'} · ověření {selectedRevision.definition.validation ? `${selectedRevision.definition.validation.from} až ${selectedRevision.definition.validation.through}` : 'nenaplánováno'}</p>
              </div>}
              <p className="sm:col-span-2 text-xs text-amber-500">Uloží se tato konkrétní verze. Plánované ověření zatím není uzamčený neviděný vzorek; úplná historie předchozího zobrazení není doložená.</p>
            </div>}
          </div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Od</label><input type="date" aria-label="Od" value={startDate} onChange={event => setStartDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Do</label><input type="date" aria-label="Do" value={endDate} max={latestHistoricalDate} onChange={event => setEndDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Komise MNQ / strana</label><input type="number" step="0.01" min="0" aria-label="Komise MNQ / strana" value={commission} onChange={event => setCommission(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Slippage (ticky)</label><input type="number" step="1" min="0" aria-label="Slippage v ticích" value={slippage} onChange={event => setSlippage(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[11px] font-semibold text-slate-500 mb-1 block">Timezone</label><select aria-label="Timezone" value={timezone} onChange={event => setTimezone(event.target.value)} className={inputCls}><option value="Europe/Prague">Praha</option><option value="America/New_York">New York</option><option value="UTC">UTC</option></select></div>
          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1 block">Výchozí layout</label>
            <select
              value={selectedTemplate === 'preset' ? startingLayout : selectedTemplate}
              onChange={event => {
                const value = event.target.value;
                if (value === 'default' || value.startsWith('template:')) setSelectedTemplate(value);
                else { setSelectedTemplate('preset'); setStartingLayout(value as ChartWorkspaceLayoutId); }
              }}
              className={inputCls}
            >
              <option value="default">{workspaceLibrary.library.defaultId ? `Výchozí: ${workspaceLibrary.library.templates.find(item => item.id === workspaceLibrary.library.defaultId)?.name}` : 'Výchozí · 2 grafy'}</option>
              {workspaceLibrary.library.templates.map(template => {
                const summary = summarizeWorkspaceDocument(template.document);
                const incompatible = !includeNq && summary.roots.includes('NQ');
                return <option key={template.id} value={`template:${template.id}`} disabled={incompatible}>{template.name}{incompatible ? ' · vyžaduje NQ' : ` · ${summary.panels} grafy`}</option>;
              })}
              <option value="1">1 graf</option><option value="2h">2 vedle sebe</option><option value="2v">2 nad sebou</option><option value="4">4 grafy</option>
            </select>
            <p className="mt-1 text-[10px] text-slate-500">{workspaceLibrary.error || 'Šablony uložené v grafu obsahují i kresby, indikátory a vzhled. Knihovna je lokální pro tento účet.'}</p>
          </div>
          <div className={`sm:col-span-2 flex items-center justify-between rounded-lg border px-3 py-2 border-[var(--border-subtle)] bg-[var(--bg-page)]`}><div><p className="text-xs font-black">Instrumenty</p><p className="text-[10px] text-slate-500">Entry vždy MNQ · společný 1m replay clock</p></div><div className="flex gap-2"><span className="rounded-lg bg-violet-500/15 px-2 py-1 text-[10px] font-black text-violet-500">MNQ</span><label className="flex cursor-pointer items-center gap-1 text-[10px] font-black"><input type="checkbox" checked={includeNq} onChange={event => setIncludeNq(event.target.checked)} /> NQ</label></div></div>
          <button onClick={() => void create()} disabled={!name.trim() || !Number(size) || creating}
            className="sm:col-span-2 flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-semibold transition-all active:scale-95">
            {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />} Vytvořit a otevřít
          </button>
        </div>
        {error && <p className="mt-3 text-xs font-bold text-rose-500">{error}</p>}
      </div>
      ))}


      {error && !showCreateForm && <p role="alert" className="mb-3 text-xs font-bold text-rose-500">{error}</p>}
      {enhanced && !showCreateForm && <>
        {lastRun && <article className="bt-resume theme-card">
          <div className="bt-resume-main"><span className="bt-overline">NAVÁZAT NA POSLEDNÍ SESSION</span><h3>{lastRun.name}</h3><p>{lastRun.config.instruments.join(' + ')} · {cursorLabel(lastRun)} · {lastRun.config.timezone}</p>{lastStats && <div className="bt-resume-stats"><span>Win rate <b>{percent(lastStats.winRate)}</b></span><span>Profit factor <b>{pf(lastStats)}</b></span><span><b>{lastStats.count}</b> uzavřených obchodů</span></div>}</div>
          <div className="bt-resume-result"><span>Dosavadní P&amp;L</span><strong className={lastRun.runtimeState.realizedPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{lastRun.runtimeState.realizedPnl >= 0 ? '+' : '−'}${Math.abs(lastRun.runtimeState.realizedPnl).toFixed(2)}</strong><div className="bt-resume-progress"><i style={{width:`${progress(lastRun)}%`}}/></div></div>
          <button className="bt-resume-button" onClick={event=>onOpenRun(lastRun,event.currentTarget.closest('article')?.getBoundingClientRect())}><Play size={14} fill="currentColor"/>Pokračovat<ArrowRight size={15}/></button>
        </article>}
        <div className="bt-runs-tools">
          <div className="bt-runs-tabs" role="group" aria-label="Stav sessions">
            {([['all','Všechny',availableRuns.length],['active','Rozpracované',activeRuns.length],['completed','Dokončené',completedRuns.length]] as const).map(([id,label,count])=><button key={id} aria-pressed={runFilter===id} onClick={()=>setRunFilter(id)}>{label}<span>{count}</span></button>)}
          </div>
          <div className="bt-runs-controls"><label className="bt-runs-search"><Search size={14}/><input value={runSearch} onChange={e=>setRunSearch(e.target.value)} aria-label="Hledat session" placeholder="Najít session…"/></label>
            <select aria-label="Řazení sessions" value={runSort} onChange={e=>setRunSort(e.target.value as 'recent'|'name')}><option value="recent">Naposledy otevřené</option><option value="name">Podle názvu</option></select>
            <div className="bt-runs-view"><button aria-label="Seznam sessions" aria-pressed={runView==='list'} onClick={()=>setRunView('list')}><List size={16}/></button><button aria-label="Karty sessions" aria-pressed={runView==='cards'} onClick={()=>setRunView('cards')}><LayoutGrid size={15}/></button></div>
          </div>
        </div>
        <p className="bt-stats-note">Statistiky z uzavřených pozic · po nákladech · partial výstupy se počítají společně</p>
      </>}
      {(!enhanced || !showCreateForm) && <>
      {/* Nové replay sessions */}
      {loadingRuns ? <div className="py-10 text-center text-xs text-slate-500">Načítám sessions…</div> : visibleRuns.length === 0 ? (
        <div className={`text-center py-14 px-6 rounded-lg border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          <p>{enhanced && availableRuns.length ? 'Žádná session neodpovídá filtru.' : 'Zatím žádná obnovitelná session.'}</p>
          <button onClick={() => { if (enhanced && availableRuns.length) { setRunSearch(''); setRunFilter('all'); } else setShowCreateForm(true); }} className="mt-3 rounded-lg bg-violet-600 px-4 py-2 text-[11px] font-semibold text-white hover:bg-violet-500">{enhanced && availableRuns.length ? 'Zrušit filtry' : 'Vytvořit první session'}</button>
        </div>
      ) : (
        <div className="bt-runs-grid grid grid-cols-1 md:grid-cols-2 gap-3">
          {visibleRuns.map(run => {
            const st = statsByAcc.get(String(run.accountId)) || { count: run.runtimeState.closedTrades.length, pnl: run.runtimeState.realizedPnl };
            const metrics = statsByRun.get(run.id)!;
            const pnlPos = run.runtimeState.realizedPnl >= 0;
            const pct = progress(run);
            const status = sessionStatus(run);
            return (
              <article key={run.id} data-backtest-run-card={run.id} aria-label={`Session ${run.name}`}
                className="bt-session-card theme-card group flex min-h-[232px] flex-col overflow-hidden rounded-lg">
                <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
                  <div className="bt-session-card__icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-violet-400">
                    <FlaskConical size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[13.5px] font-bold text-[var(--text-primary)]">{run.name}</h3>
                      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />{status.label}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">${run.initialCapital.toLocaleString('en-US')} · {run.config.instruments.join(' + ')}</p>
                  </div>
                </header>

                {enhanced ? <dl className="bt-session-stats" aria-label="Statistiky session">
                  <div><dt>P&amp;L</dt><dd className={pnlPos ? 'text-emerald-500' : 'text-rose-500'}>{cash(run.runtimeState.realizedPnl)}</dd></div>
                  <div title="Počet celých uzavřených pozic. Partial výstupy se sčítají."><dt>Obchody</dt><dd>{metrics.count}</dd></div>
                  <div title="Výherní pozice / všechny uzavřené pozice včetně BE."><dt>Win rate</dt><dd>{percent(metrics.winRate)}</dd><small>{metrics.count ? `${metrics.wins} W / ${metrics.losses} L / ${metrics.breakeven} BE` : 'Zatím bez obchodů'}</small></div>
                  <div title="Součet zisků / absolutní součet ztrát uzavřených pozic, po nákladech. ∞ = ziskové obchody bez ztrát."><dt>Profit factor</dt><dd>{pf(metrics)}</dd></div>
                  <div title="Čistý výsledek na jednu celou uzavřenou pozici."><dt>Průměr / obchod</dt><dd className={metrics.averagePnl !== null && metrics.averagePnl < 0 ? 'text-rose-500' : undefined}>{cash(metrics.averagePnl)}</dd></div>
                  <div title="Maximální propad realizovaného P&L doložených uzavřených pozic. Nezahrnuje otevřené P&L ani intrabarový propad."><dt>Max. drawdown</dt><dd>{metrics.maxDrawdown === null ? '—' : `${metrics.maxDrawdown > 0 ? '−' : ''}$${metrics.maxDrawdown.toFixed(2)}`}</dd></div>
                </dl> : (
                <dl className="grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
                  <div className="min-w-0 px-3 py-3 sm:px-4">
                    <dt className="text-[11px] font-medium text-[var(--text-secondary)]">P&amp;L</dt>
                    <dd className={`mt-1 truncate font-mono text-[13px] font-semibold tabular-nums sm:text-[15px] ${pnlPos ? 'text-emerald-500' : 'text-rose-500'}`}>{pnlPos ? '+' : ''}${run.runtimeState.realizedPnl.toFixed(2)}</dd>
                  </div>
                  <div className="min-w-0 px-3 py-3 sm:px-4">
                    <dt className="text-[11px] font-medium text-[var(--text-secondary)]">Obchody</dt>
                    <dd className="mt-1 text-[13px] font-semibold tabular-nums text-[var(--text-primary)] sm:text-[15px]">{st.count}</dd>
                  </div>
                  <div className="min-w-0 px-3 py-3 sm:px-4">
                    <dt className="text-[11px] font-medium text-[var(--text-secondary)]">Splněno</dt>
                    <dd className="mt-1 text-[13px] font-semibold tabular-nums text-[var(--text-primary)] sm:text-[15px]">{pct.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %</dd>
                  </div>
                </dl>

                )}

                <div className="px-4 pt-3.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]" role="progressbar" aria-label="Průběh session" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                    <div className="bt-session-card__progress h-full rounded-full" style={{ width: `${Math.max(pct, run.cursorAt ? 1.5 : 0)}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-[var(--text-secondary)]">
                    <span>{dateLabel(run.startAt)}</span>
                    {run.cursorAt !== null && <span className="truncate font-medium text-[var(--text-primary)]">Kurzor {cursorLabel(run)}{enhanced ? ` · ${pct.toLocaleString('cs-CZ', {maximumFractionDigits:1})} %` : ''}</span>}
                    <span>{dateLabel(run.endAt)}</span>
                  </div>
                  {enhanced && metrics.excludedExits > 0 && <p className="bt-stats-incomplete">{metrics.excludedExits} výstupů není ve statistikách: pozice ještě běží nebo chybí úplná data.</p>}
                </div>

                <footer className="mt-auto flex items-center gap-2 px-4 pb-4 pt-4">
                  <button
                    onClick={event => {
                      const card = event.currentTarget.closest<HTMLElement>('[data-backtest-run-card]');
                      onOpenRun(run, card?.getBoundingClientRect() ?? null);
                    }}
                    className="bt-session-card__open inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold text-white transition-[transform,filter] active:scale-[0.98]"
                  ><Play size={13} fill="currentColor" />{run.cursorAt ? 'Pokračovat' : 'Spustit'}</button>
                  <button onClick={() => void duplicateRun(run)} disabled={creating} className={iconBtn} title="Duplikovat session" aria-label="Duplikovat session"><Copy size={15} /></button>
                  <button onClick={() => void changeStatus(run, run.status === 'completed' ? 'archived' : 'completed')} className={iconBtn} title={run.status === 'completed' ? 'Archivovat' : 'Dokončit'} aria-label={run.status === 'completed' ? 'Archivovat' : 'Dokončit'}>{run.status === 'completed' ? <Archive size={15} /> : <CheckCircle2 size={15} />}</button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      </>}
      {sessions.length > runs.length && <p className="mt-5 text-center text-[10px] text-slate-500">Původní AlphaBridge backtest účty zůstávají zachované; nové replay sessions používají rozšířený formát.</p>}
    </div>
  );
};

export default BacktestSessionsManager;
