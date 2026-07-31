import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link2, RefreshCw, EyeOff, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight, Unplug, Plus, X } from 'lucide-react';
import type { Account } from '../types';
import { KNOWN_FIRMS } from '../utils/accountFirm';
import {
  getImportedAccountsOverview,
  listAccountMap,
  ensureAccountMapRows,
  setAccountMapping,
  listAppAccounts,
  getSyncStatus,
  guessFirm,
  persistAccount,
  type ImportedAccountOverview,
  type AccountMapRow,
  type AppAccountOption,
} from '../services/importService';

// Sekce "Auto-import (Tradecopia)" v Settings → Systém.
// Zobrazuje detekované externí účty a umožňuje je namapovat na účty v appce.

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
};

const fmtPnl = (v: number) =>
  `${v >= 0 ? '+' : ''}$${Math.round(v).toLocaleString('en-US')}`;

// Relativní čas pro heartbeat — absolutní čas mátl (agent jede v 5min krocích,
// takže se kliknutím na Obnovit "nic neměnilo").
const fmtAgo = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'právě teď';
  if (mins === 1) return 'před minutou';
  if (mins < 60) return `před ${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? 'před hodinou' : `před ${hours} h`;
};

const labelCls = 'block text-[9px] uppercase font-black text-slate-500 tracking-widest';
const inputCls = (isDark: boolean) =>
  `w-full px-3 py-2 rounded-xl border outline-none text-sm font-bold transition-all ${isDark
    ? 'bg-slate-950 border-white/10 text-white focus:border-blue-500/50'
    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-blue-500/50'}`;

interface NewAccountDraft {
  name: string;
  initialBalance: number;
  firmOverride: string;
  phase: 'Challenge' | 'Funded';
  challengeCost: number;
  profitSplit: number;
  profitTarget: number;
}

export const ImportSettings: React.FC<{
  isDark: boolean;
  onToast?: (msg: string) => void;
  /** Vytvoří účet v appce (App drží accounts state + persistenci). */
  onCreateAccount?: (account: Account) => void;
}> = ({ isDark, onToast, onCreateAccount }) => {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<ImportedAccountOverview[]>([]);
  const [mapRows, setMapRows] = useState<AccountMapRow[]>([]);
  const [appAccounts, setAppAccounts] = useState<AppAccountOption[]>([]);
  const [syncStatus, setSyncStatus] = useState<{ lastData: string | null; lastHeartbeat: string | null }>({ lastData: null, lastHeartbeat: null });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showDisconnected, setShowDisconnected] = useState(false);
  // Modal zakládání účtu z detekované challenge (drží i cílový řádek mapy).
  const [draft, setDraft] = useState<{ row: AccountMapRow; acc: ImportedAccountOverview; form: NewAccountDraft } | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const ov = await getImportedAccountsOverview();
      const created = await ensureAccountMapRows(ov);
      const [map, accounts, status] = await Promise.all([
        listAccountMap(),
        listAppAccounts(),
        getSyncStatus(),
      ]);
      setOverview(ov);
      setMapRows(map);
      setAppAccounts(accounts);
      setSyncStatus(status);
      if (created > 0) onToast?.(`Detekováno ${created} nových účtů z importu`);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { reload(); }, [reload]);

  const mapFor = (extId: number) => mapRows.find(m => m.account_ext_id === extId);

  const updateMapping = async (row: AccountMapRow, update: Parameters<typeof setAccountMapping>[1]) => {
    setSavingId(row.id);
    const ok = await setAccountMapping(row.id, update);
    if (ok) {
      setMapRows(prev => prev.map(m => m.id === row.id ? { ...m, ...update } as AccountMapRow : m));
      onToast?.(update.status === 'ignored' ? 'Účet ignorován' : 'Mapování uloženo');
    }
    setSavingId(null);
  };

  // Nová challenge z importu ještě nemá účet v appce → otevři modal s formulářem.
  const openAccountForm = (acc: ImportedAccountOverview, row: AccountMapRow) => {
    setDraft({
      row,
      acc,
      form: {
        name: acc.account_name || `Účet ${acc.account_ext_id}`,
        initialBalance: 50000,
        firmOverride: guessFirm(acc.account_name, acc.entity_id) || '',
        phase: 'Challenge',
        challengeCost: 0,
        profitSplit: 90,
        profitTarget: 10,
      },
    });
  };

  const updateDraftForm = (patch: Partial<NewAccountDraft>) =>
    setDraft(prev => prev ? { ...prev, form: { ...prev.form, ...patch } } : prev);

  const submitDraft = async () => {
    if (!draft || !onCreateAccount) return;
    const { form, row } = draft;
    if (!form.name.trim()) return;
    setCreating(true);
    const account: Account = {
      id: crypto.randomUUID(),
      name: form.name.trim(),
      initialBalance: Number(form.initialBalance) || 0,
      challengeCost: Number(form.challengeCost) || 0,
      totalWithdrawals: 0,
      totalGrossWithdrawals: 0,
      profitSplit: Number(form.profitSplit) || 90,
      profitTarget: Number(form.profitTarget) || 10,
      phase: form.phase,
      accumulatedChallengePnL: 0,
      type: 'Funded',
      status: 'Active',
      currency: 'USD',
      propThreshold: 150,
      firmOverride: form.firmOverride.trim() || undefined,
      instrumentFees: { NQ: 2.8, MNQ: 0.74 },
      createdAt: Date.now(),
    };
    // Účet musí být v DB dřív než mapping (FK) — App state se ukládá asynchronně.
    const persisted = await persistAccount(account);
    if (!persisted) {
      onToast?.('Založení účtu selhalo');
      setCreating(false);
      return;
    }
    onCreateAccount(account);
    const ok = await setAccountMapping(row.id, { mapped_account_id: account.id, status: 'mapped' });
    if (ok) {
      setMapRows(prev => prev.map(m => m.id === row.id
        ? { ...m, mapped_account_id: account.id, status: 'mapped' as const }
        : m));
      setAppAccounts(prev => [...prev, { id: account.id, name: account.name, status: 'Active', type: 'Funded' }]);
      onToast?.(`Účet „${account.name}" založen a napojen na import`);
    } else {
      onToast?.('Účet vznikl, ale mapování selhalo — přiřaď ho ručně');
    }
    setCreating(false);
    setDraft(null);
  };

  // Aktivní = účet je aktuálně připojený v Tradecopii (flag drží sync agent).
  // Bez map řádku předpokládej aktivní — flag se srovná při dalším heartbeatu.
  const isActive = (extId: number) => mapFor(extId)?.is_connected !== false;

  // Připojené účty bez obchodů (čerstvé challenge) nejsou v overview (ten staví
  // na imported_trades) — doplň je z mapy, ať sedí počet s Tradecopií.
  const overviewIds = new Set(overview.map(o => o.account_ext_id));
  const accountsFromMapOnly: ImportedAccountOverview[] = mapRows
    .filter(m => !overviewIds.has(m.account_ext_id))
    .map(m => ({
      account_ext_id: m.account_ext_id,
      account_name: m.account_name,
      entity_id: m.entity_id,
      platform: null,
      trade_count: 0,
      total_pnl: 0,
      first_trade: null,
      last_trade: null,
      is_demo: typeof m.entity_id === 'string' && m.entity_id.toLowerCase().endsWith('-demo'),
    }));
  const allAccounts = [...overview, ...accountsFromMapOnly];
  const activeAccounts = allAccounts.filter(a => isActive(a.account_ext_id));
  const disconnectedAccounts = allAccounts.filter(a => !isActive(a.account_ext_id));

  const newCount = mapRows.filter(m => m.status === 'new' && m.is_connected !== false).length;
  // Agent posílá heartbeat každých 5 min — po 15 min ticha ho považuj za mrtvý.
  const agentAlive = !!syncStatus.lastHeartbeat
    && Date.now() - new Date(syncStatus.lastHeartbeat).getTime() < 15 * 60 * 1000;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex flex-col gap-0.5 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">
          <div className="flex items-center gap-2">
            {agentAlive ? (
              <><CheckCircle2 size={12} className="text-emerald-400" /> Agent běží · poslední kontrola {syncStatus.lastHeartbeat ? fmtAgo(syncStatus.lastHeartbeat) : '—'}</>
            ) : (
              <><AlertCircle size={12} className="text-amber-400" /> Agent se {syncStatus.lastHeartbeat ? `naposledy ohlásil ${new Date(syncStatus.lastHeartbeat).toLocaleString('cs-CZ')}` : 'zatím neohlásil'}</>
            )}
          </div>
          <div className="text-[9px] font-bold normal-case tracking-normal text-[var(--text-muted)]">
            {syncStatus.lastData ? `Poslední nová data: ${new Date(syncStatus.lastData).toLocaleString('cs-CZ')}` : 'Zatím žádná data'}
          </div>
        </div>
        <button
          onClick={reload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] text-[9px] font-black uppercase tracking-widest text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-blue-500/40 transition-all"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Obnovit
        </button>
      </div>

      {newCount > 0 && (
        <div className="mb-4 px-3 py-2 rounded-xl bg-blue-500/10 border border-blue-500/25 text-[10px] font-bold text-blue-400">
          🆕 {newCount} {newCount === 1 ? 'nový účet čeká' : newCount < 5 ? 'nové účty čekají' : 'nových účtů čeká'} na přiřazení
        </div>
      )}

      {loading && allAccounts.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-[var(--text-secondary)]">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : allAccounts.length === 0 ? (
        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          Žádná importovaná data. Sync agent běží na Macu s Tradecopií — zkontroluj `~/.alphatrade/tradecopia-sync.log`.
        </p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
          {[...activeAccounts, ...(showDisconnected ? disconnectedAccounts : [])].map(acc => {
            const m = mapFor(acc.account_ext_id);
            const mappedName = m?.mapped_account_id
              ? appAccounts.find(a => a.id === m.mapped_account_id)?.name
              : null;
            const isIgnored = m?.status === 'ignored';
            return (
              <div
                key={acc.account_ext_id}
                className={`p-3 rounded-xl border transition-all ${isIgnored
                  ? 'border-[var(--border-subtle)] opacity-50'
                  : m?.status === 'mapped'
                    ? 'border-emerald-500/25 bg-emerald-500/5'
                    : 'border-blue-500/30 bg-blue-500/5'}`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[11px] font-black text-[var(--text-primary)] truncate" title={acc.account_name || String(acc.account_ext_id)}>
                      {acc.account_name || `Účet ${acc.account_ext_id}`}
                      {acc.platform && acc.platform !== 'tradovate' && (
                        <span className="ml-2 text-[8px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 uppercase">{acc.platform}</span>
                      )}
                      {acc.is_demo && <span className="ml-2 text-[8px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400 uppercase">sim</span>}
                      {!isActive(acc.account_ext_id) && (
                        <span className="ml-2 text-[8px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 uppercase">odpojený</span>
                      )}
                    </div>
                    <div className="text-[9px] text-[var(--text-secondary)] mt-0.5">
                      {acc.trade_count > 0
                        ? `${acc.trade_count} obchodů · ${fmtPnl(acc.total_pnl)} · ${fmtDate(acc.first_trade)}–${fmtDate(acc.last_trade)}`
                        : 'zatím žádné obchody'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {m && !isIgnored && !m.mapped_account_id && isActive(acc.account_ext_id) && onCreateAccount && (
                      <button
                        title="Založit nový účet v appce — otevře formulář s předvyplněnými údaji z importu"
                        disabled={savingId === m.id}
                        onClick={() => openAccountForm(acc, m)}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-emerald-500/30 text-[9px] font-black uppercase tracking-widest text-emerald-500 hover:bg-emerald-500/10 transition-all"
                      >
                        <Plus size={11} /> Založit
                      </button>
                    )}
                    {m && !isIgnored && (
                      <select
                        value={m.mapped_account_id || ''}
                        disabled={savingId === m.id}
                        onChange={e => {
                          const val = e.target.value || null;
                          updateMapping(m, { mapped_account_id: val, status: val ? 'mapped' : 'new' });
                        }}
                        className="text-[10px] font-bold rounded-lg px-2 py-1.5 bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)] max-w-[180px]"
                      >
                        <option value="">— nepřiřazeno —</option>
                        {appAccounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    )}
                    {m && (
                      <button
                        title={isIgnored ? 'Obnovit účet' : 'Ignorovat účet (např. demo)'}
                        disabled={savingId === m.id}
                        onClick={() => updateMapping(m, isIgnored
                          ? { status: m.mapped_account_id ? 'mapped' : 'new' }
                          : { status: 'ignored' })}
                        className="p-1.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
                      >
                        {isIgnored ? <Link2 size={12} /> : <EyeOff size={12} />}
                      </button>
                    )}
                  </div>
                </div>
                {mappedName && !isIgnored && (
                  <div className="mt-1.5 text-[9px] font-bold text-emerald-400 flex items-center gap-1">
                    <Link2 size={10} /> {mappedName}
                  </div>
                )}
              </div>
            );
          })}
          {disconnectedAccounts.length > 0 && (
            <button
              onClick={() => setShowDisconnected(v => !v)}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--border-subtle)] text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-all"
            >
              {showDisconnected ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <Unplug size={11} />
              {showDisconnected ? 'Skrýt odpojené účty' : `Zobrazit odpojené účty (${disconnectedAccounts.length})`}
            </button>
          )}
        </div>
      )}

      {/* Portal do body: obalující Card má backdrop-filter, který by jinak vytvořil
          containing block a `fixed inset-0` by se centroval vůči kartě, ne viewportu. */}
      {draft && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => !creating && setDraft(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className={`w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 rounded-[28px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
          >
            <div className="flex items-start justify-between gap-3 mb-5">
              <div>
                <h3 className="text-base font-black uppercase tracking-tight text-[var(--text-primary)]">Nový účet z importu</h3>
                <p className="text-[10px] font-bold text-[var(--text-muted)] mt-0.5">
                  {draft.acc.trade_count > 0
                    ? `${draft.acc.trade_count} obchodů · ${fmtPnl(draft.acc.total_pnl)} · ${fmtDate(draft.acc.first_trade)}–${fmtDate(draft.acc.last_trade)}`
                    : 'zatím žádné obchody'}
                </p>
              </div>
              <button
                onClick={() => !creating && setDraft(null)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
              >
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="space-y-1.5 sm:col-span-2">
                <span className={labelCls}>Název účtu</span>
                <input
                  type="text" value={draft.form.name} autoFocus
                  onChange={e => updateDraftForm({ name: e.target.value })}
                  className={inputCls(isDark)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelCls}>Počáteční balance ($)</span>
                <input
                  type="number" value={draft.form.initialBalance}
                  onChange={e => updateDraftForm({ initialBalance: Number(e.target.value) })}
                  className={inputCls(isDark)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelCls}>Firma</span>
                <input
                  type="text" value={draft.form.firmOverride} list="import-firm-options"
                  placeholder="Vyber nebo napiš"
                  onChange={e => updateDraftForm({ firmOverride: e.target.value })}
                  className={inputCls(isDark)}
                />
                <datalist id="import-firm-options">
                  {KNOWN_FIRMS.map(f => <option key={f.key} value={f.label} />)}
                </datalist>
              </label>
              <label className="space-y-1.5">
                <span className={labelCls}>Fáze</span>
                <select
                  value={draft.form.phase}
                  onChange={e => updateDraftForm({ phase: e.target.value as 'Challenge' | 'Funded' })}
                  className={inputCls(isDark)}
                >
                  <option value="Challenge">Challenge</option>
                  <option value="Funded">Funded</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={`${labelCls} text-rose-500`}>Cena pořízení ($)</span>
                <input
                  type="number" value={draft.form.challengeCost}
                  onChange={e => updateDraftForm({ challengeCost: Number(e.target.value) })}
                  className={inputCls(isDark)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={`${labelCls} text-emerald-500`}>Profit split (%)</span>
                <input
                  type="number" value={draft.form.profitSplit}
                  onChange={e => updateDraftForm({ profitSplit: Number(e.target.value) })}
                  className={inputCls(isDark)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={`${labelCls} text-blue-500`}>Profit cíl (%)</span>
                <input
                  type="number" value={draft.form.profitTarget}
                  onChange={e => updateDraftForm({ profitTarget: Number(e.target.value) })}
                  className={inputCls(isDark)}
                />
              </label>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setDraft(null)} disabled={creating}
                className="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-all"
              >
                Zrušit
              </button>
              <button
                onClick={submitDraft} disabled={creating || !draft.form.name.trim()}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[10px] font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Vytvořit a napojit
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default ImportSettings;
