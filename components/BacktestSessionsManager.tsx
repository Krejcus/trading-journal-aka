import { bindResearchRule, type BacktestResearchBinding } from '../services/backtestResearchCases';
import { useWorkspaceLibrary } from '../hooks/useWorkspaceLibrary';
import { workspaceTemplateForNewSession } from '../services/chartWorkspaceLibrary';
import { chartAppearanceUserId } from '../services/chartAppearanceScope';
import { summarizeWorkspaceDocument } from '../services/chartWorkspaceDocument';
import { buildBacktestAiExport } from '../services/backtestAiExport';
import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Layers, Plus, FlaskConical, Download, Play, Archive, RefreshCw, CheckCircle2, Copy } from 'lucide-react';
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
import type { ChartWorkspaceLayoutId } from '../services/chartWorkspaceLayouts';

interface Props {
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  trades: Trade[];
  onUpdate: (accounts: Account[]) => void;
  onDelete?: (id: string) => void;
  onOpenRun: (run: BacktestRun) => void;
}

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
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
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

  const inputCls = `w-full rounded-lg px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`;
  const cardCls = isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm';

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

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto px-4 lg:px-8 pt-[80px] lg:pt-[96px] pb-20">
      <div className="flex items-center gap-3 border-b pb-4 mb-6 border-[var(--border-subtle)]">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
          <Layers size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl md:text-3xl font-black tracking-tighter italic">SESSIONS</h2>
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

      {/* Nová obnovitelná session */}
      {showCreateForm && <div className={`p-4 rounded-lg border mb-6 animate-in fade-in slide-in-from-top-2 duration-200 ${cardCls}`}>
        <p className={`text-[10px] font-black uppercase tracking-widest mb-3 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Nová session</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Název session</label>
            <input aria-label="Název session" value={name} onChange={e => setName(e.target.value)} placeholder="např. NQ Silver Bullet" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Velikost účtu ($)</label>
            <input type="number" aria-label="Velikost účtu" value={size} onChange={e => setSize(e.target.value)} placeholder="50000" className={inputCls}
              onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
          </div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Strategie / playbook</label><input aria-label="Strategie / playbook" value={strategy} onChange={event => setStrategy(event.target.value)} placeholder="volitelné" className={inputCls} /></div>
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
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Od</label><input type="date" aria-label="Od" value={startDate} onChange={event => setStartDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Do</label><input type="date" aria-label="Do" value={endDate} max={latestHistoricalDate} onChange={event => setEndDate(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Komise MNQ / strana</label><input type="number" step="0.01" min="0" aria-label="Komise MNQ / strana" value={commission} onChange={event => setCommission(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Slippage (ticky)</label><input type="number" step="1" min="0" aria-label="Slippage v ticích" value={slippage} onChange={event => setSlippage(event.target.value)} className={inputCls} /></div>
          <div><label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Timezone</label><select aria-label="Timezone" value={timezone} onChange={event => setTimezone(event.target.value)} className={inputCls}><option value="Europe/Prague">Praha</option><option value="America/New_York">New York</option><option value="UTC">UTC</option></select></div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1 block">Výchozí layout</label>
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
          <div className={`sm:col-span-2 flex items-center justify-between rounded-lg border px-3 py-2 ${isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50'}`}><div><p className="text-xs font-black">Instrumenty</p><p className="text-[10px] text-slate-500">Entry vždy MNQ · společný 1m replay clock</p></div><div className="flex gap-2"><span className="rounded-lg bg-violet-500/15 px-2 py-1 text-[10px] font-black text-violet-500">MNQ</span><label className="flex cursor-pointer items-center gap-1 text-[10px] font-black"><input type="checkbox" checked={includeNq} onChange={event => setIncludeNq(event.target.checked)} /> NQ</label></div></div>
          <button onClick={() => void create()} disabled={!name.trim() || !Number(size) || creating}
            className="sm:col-span-2 flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-black uppercase tracking-widest transition-all active:scale-95">
            {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />} Vytvořit a otevřít
          </button>
        </div>
        {error && <p className="mt-3 text-xs font-bold text-rose-500">{error}</p>}
      </div>}

      {error && !showCreateForm && <p role="alert" className="mb-3 text-xs font-bold text-rose-500">{error}</p>}
      {/* Nové replay sessions */}
      {loadingRuns ? <div className="py-10 text-center text-xs text-slate-500">Načítám sessions…</div> : runs.filter(run => run.status !== 'archived').length === 0 ? (
        <div className={`text-center py-14 px-6 rounded-lg border border-dashed ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
          <p>Zatím žádná obnovitelná session.</p>
          <button onClick={() => setShowCreateForm(true)} className="mt-3 rounded-lg bg-violet-600 px-4 py-2 text-[10px] font-black uppercase tracking-wider text-white hover:bg-violet-500">Vytvořit první session</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {runs.filter(run => run.status !== 'archived').map(run => {
            const st = statsByAcc.get(String(run.accountId)) || { count: run.runtimeState.closedTrades.length, pnl: run.runtimeState.realizedPnl };
            const pnlPos = run.runtimeState.realizedPnl >= 0;
            const pct = progress(run);
            return (
              <div key={run.id} className={`flex min-h-[250px] flex-col p-4 rounded-lg border ${cardCls}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                    <FlaskConical size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-black truncate">{run.name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${run.status === 'completed' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}>{run.status === 'completed' ? 'Dokončeno' : run.cursorAt ? 'Pozastaveno' : 'Nová'}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] font-bold text-slate-500">${run.initialCapital.toLocaleString('en-US')} · {run.config.instruments.join(' + ')}</p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className={`rounded-lg border px-3 py-2.5 ${isDark ? 'border-white/5 bg-white/[0.025]' : 'border-slate-100 bg-slate-50'}`}>
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">P&amp;L</p>
                    <p className={`mt-1 truncate font-mono text-sm font-bold ${pnlPos ? 'text-emerald-500' : 'text-rose-500'}`}>{pnlPos ? '+' : ''}${run.runtimeState.realizedPnl.toFixed(2)}</p>
                  </div>
                  <div className={`rounded-lg border px-3 py-2.5 ${isDark ? 'border-white/5 bg-white/[0.025]' : 'border-slate-100 bg-slate-50'}`}>
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Obchody</p>
                    <p className="mt-1 text-sm font-black">{st.count}</p>
                  </div>
                  <div className={`rounded-lg border px-3 py-2.5 ${isDark ? 'border-white/5 bg-white/[0.025]' : 'border-slate-100 bg-slate-50'}`}>
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Splněno</p>
                    <p className="mt-1 text-sm font-black">{pct.toFixed(1)} %</p>
                  </div>
                </div>

                <div className="mt-4">
                  <div className={`h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} /></div>
                  <div className="mt-1.5 flex justify-between text-[9px] font-bold text-slate-500"><span>{new Date(run.startAt).toLocaleDateString('cs-CZ')}</span><span>{new Date(run.endAt).toLocaleDateString('cs-CZ')}</span></div>
                </div>

                <div className="mt-auto flex items-center gap-2 pt-4">
                  <button onClick={() => onOpenRun(run)} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 text-[10px] font-black text-white hover:bg-violet-500"><Play size={13} fill="currentColor" />{run.cursorAt ? 'Pokračovat' : 'Spustit'}</button>
                  <button onClick={() => void duplicateRun(run)} disabled={creating} className={`flex h-9 w-9 items-center justify-center rounded-lg border ${isDark ? 'border-white/5 text-slate-400 hover:bg-white/5' : 'border-slate-200 text-slate-500 hover:bg-slate-100'}`} title="Duplikovat session"><Copy size={15} /></button>
                  <button onClick={() => void changeStatus(run, run.status === 'completed' ? 'archived' : 'completed')} className={`flex h-9 w-9 items-center justify-center rounded-lg border ${isDark ? 'border-white/5 text-slate-400 hover:bg-white/5' : 'border-slate-200 text-slate-500 hover:bg-slate-100'}`} title={run.status === 'completed' ? 'Archivovat' : 'Dokončit'}>{run.status === 'completed' ? <Archive size={15} /> : <CheckCircle2 size={15} />}</button>
                </div>
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
