import React, { useState, useCallback } from 'react';
import { Link2, AlertTriangle, HelpCircle, Loader2, Check, EyeOff, Skull, RefreshCw, CheckSquare } from 'lucide-react';
import {
  runPairing,
  applyMatch,
  assignToIncident,
  ignoreExecutions,
} from '../services/importService';
import { groupExecutions, describeGroupContext } from '../services/importPairing';
import type { ExecutionGroup, ManualLinkOption } from '../services/importPairing';
import type { PairingRunResult } from '../services/importService';
import type { DailyReview } from '../types';
import ImportManualLinkModal from './ImportManualLinkModal';

// Fronta importu: co se spárovalo s deníkem, co nemá záznam a co je nejednoznačné.
// Záměrně NEHODNOTÍ obchody (žádné „nevalidní") — ukazuje jen fakta a nechává
// rozhodnutí na uživateli.

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
const fmtMoney = (v: number) => `${v >= 0 ? '+' : ''}$${Math.round(v).toLocaleString('en-US')}`;

const fmtGap = (seconds: number | null) => {
  if (seconds == null) return 'první v session';
  if (seconds < 60) return `${seconds} s po předchozím`;
  const min = Math.round(seconds / 60);
  return `${min} min po předchozím`;
};

export const ImportQueue: React.FC<{
  isDark: boolean;
  onToast?: (msg: string) => void;
  onIncidentSaved?: (review: DailyReview) => void | Promise<void>;
}> = ({ isDark, onToast, onIncidentSaved }) => {
  const [result, setResult] = useState<PairingRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [incidentRef, setIncidentRef] = useState('');
  const [manualGroup, setManualGroup] = useState<ExecutionGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await runPairing());
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  const confirmAllMatches = async () => {
    if (!result || result.matched.length === 0) return;
    setBusy(true);
    try {
      let ok = 0;
      for (const m of result.matched) {
        if (await applyMatch(m.execution.id, String(m.trade.id), m.score)) ok++;
      }
      onToast?.(ok === result.matched.length
        ? `Potvrzeno ${ok} spárování`
        : `Potvrzeno ${ok} z ${result.matched.length} — zbytek zůstal bezpečně ve frontě`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Výběr je vždy po celé fan-out skupině — kopie jednoho obchodu patří k sobě. */
  const toggleGroup = (ids: string[]) =>
    setSelected(prev => {
      const next = new Set(prev);
      const allSelected = ids.every(id => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  /** Vybere/odznačí celou skupinu řádků najednou — jinak by tilt session
   *  znamenala 20+ kliknutí, než se dá vůbec něco udělat. */
  const selectMany = (ids: string[], on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const bulkIncident = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const review = await assignToIncident([...selected], incidentRef);
      if (review && onIncidentSaved) {
        // Incident už je v tuto chvíli atomicky uložený v DB. Selhání lokálního
        // cache callbacku proto nesmí změnit úspěch na falešnou chybu ani nechat
        // řádky ve starém UI stavu; další načtení data srovná.
        try {
          await onIncidentSaved(review);
        } catch (error) {
          console.warn('[import] incident persisted, local review refresh failed:', error);
        }
      }
      onToast?.(review ? `${selected.size} exekucí zapsáno do skutečného incidentu` : 'Přiřazení selhalo — data zůstala ve frontě');
      if (review) setIncidentRef('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const bulkIgnore = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const ok = await ignoreExecutions([...selected]);
      onToast?.(ok ? `${selected.size} exekucí ignorováno` : 'Akce selhala — nevyřešené řádky zůstaly ve frontě');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const confirmManualLink = async (option: ManualLinkOption) => {
    setBusy(true);
    try {
      let ok = 0;
      for (const pair of option.pairs) {
        if (await applyMatch(pair.execution.id, String(pair.trade.id))) ok++;
      }
      onToast?.(ok === option.pairs.length
        ? `Propojeno ${ok} ${ok === 1 ? 'exekuce' : 'exekucí'} s existujícím obchodem`
        : `Propojeno ${ok} z ${option.pairs.length} — zbytek zůstal bezpečně ve frontě`);
      setManualGroup(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const cardCls = `p-3 rounded-xl border transition-all ${isDark ? 'border-white/10' : 'border-slate-200'}`;
  // Fan-out kopie sluč do jednoho řádku — rozhodovat se má o obchodu, ne o kopii.
  const unmatchedGroups = groupExecutions(result?.unmatched || []);

  const allUnmatchedIds = unmatchedGroups.flatMap(g => g.executions.map(e => e.id));
  const allSelected = allUnmatchedIds.length > 0 && allUnmatchedIds.every(id => selected.has(id));
  // Součet přes vybrané kopie = reálný dopad na účty, tj. částka do incidentu.
  // Rozpad na funded vs. challenge: na funded jde o reálné peníze, na challenge
  // o riziko poplatku — do incidentu se to alokuje jinak.
  const selectedBreakdown = (() => {
    let funded = 0, challenge = 0, ostatni = 0;
    const fundedAccounts = new Set<string>(), challengeAccounts = new Set<string>();
    const pnlByAccount = new Map<string, number>();
    for (const e of result?.unmatched || []) {
      if (!selected.has(e.id)) continue;
      const pnl = Number(e.pnl) || 0;
      const info = result?.accountInfo.get(e.account_ext_id);
      const accountKey = info?.accountId || `external:${e.account_ext_id}`;
      pnlByAccount.set(accountKey, (pnlByAccount.get(accountKey) || 0) + pnl);
      if (info?.phase === 'Funded') { funded += pnl; fundedAccounts.add(info.accountId); }
      else if (info?.phase === 'Challenge') { challenge += pnl; challengeAccounts.add(info.accountId); }
      else ostatni += pnl;
    }
    return {
      funded, challenge, ostatni,
      total: funded + challenge + ostatni,
      fundedCount: fundedAccounts.size,
      challengeCount: challengeAccounts.size,
      allAccountsNegative: [...pnlByAccount.values()].every(value => value < 0),
    };
  })();
  const selectedPnl = selectedBreakdown.total;

  // Výběr po dnech — tilt session bývá jeden den, ale fronta může nést i starší
  // nevyřešené zbytky. Zobrazí se, jen když je dnů víc.
  const unmatchedDays = (() => {
    const byDay = new Map<string, { ids: string[]; groupCount: number }>();
    for (const g of unmatchedGroups) {
      const key = g.sample.entry_at.slice(0, 10);
      const bucket = byDay.get(key) || { ids: [], groupCount: 0 };
      bucket.ids.push(...g.executions.map(e => e.id));
      bucket.groupCount += 1;
      byDay.set(key, bucket);
    }
    return [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, v]) => ({ key, label: fmtDay(`${key}T12:00:00Z`), ...v }));
  })();

  // Spárované seskup stejně, ale nes s sebou skóre shody (průměr přes kopie).
  const matchedGroups = (() => {
    const matches = result?.matched || [];
    const byExecution = new Map(matches.map(match => [match.execution.id, match]));
    return groupExecutions(matches.map(match => match.execution))
      .map(group => {
        const execs = group.executions.map(execution => byExecution.get(execution.id)!).filter(Boolean);
        return {
          key: group.key,
          sample: group.sample,
          accountCount: group.accountCount,
          totalPnl: group.totalPnl,
          avgScore: execs.reduce((sum, match) => sum + match.score, 0) / execs.length,
        };
      })
      .sort((a, b) => new Date(b.sample.entry_at).getTime() - new Date(a.sample.entry_at).getTime());
  })();

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          Porovná exekuce z Tradecopie s obchody v deníku. Nic neuloží, dokud nepotvrdíš.
        </p>
        <button
          onClick={load} disabled={loading || busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] text-[9px] font-black uppercase tracking-widest text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-blue-500/40 transition-all"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Spárovat
        </button>
      </div>

      {!result ? (
        <p className="text-[10px] text-[var(--text-muted)]">Spusť párování tlačítkem výše.</p>
      ) : (
        <div className="space-y-5">
          {/* ── Spárováno ── */}
          <section>
            <h4 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-emerald-500 mb-2">
              <Link2 size={12} /> Spárováno ({matchedGroups.length}{result.matched.length !== matchedGroups.length ? ` obchodů · ${result.matched.length} kopií` : ''})
            </h4>
            {result.matched.length === 0 ? (
              <p className="text-[10px] text-[var(--text-muted)]">Žádné automatické shody.</p>
            ) : (
              <>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {matchedGroups.map(g => (
                    <div key={g.key} className={`${cardCls} border-emerald-500/25 bg-emerald-500/5`}>
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="font-bold text-[var(--text-primary)]">
                          {fmtDay(g.sample.entry_at)} {fmtTime(g.sample.entry_at)} · {g.sample.symbol} · {g.sample.direction}
                        </span>
                        <span className={g.totalPnl >= 0 ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>
                          {fmtMoney(g.totalPnl)}
                        </span>
                      </div>
                      <div className="text-[9px] text-[var(--text-secondary)] mt-0.5">
                        {g.sample.qty}× · vstup {g.sample.direction === 'Short' ? g.sample.sell_price : g.sample.buy_price}
                        {g.accountCount > 1 && ` · na ${g.accountCount} účtech`}
                        {' · '}shoda {Math.round(g.avgScore)} %
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={confirmAllMatches} disabled={busy}
                  className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[9px] font-black uppercase tracking-widest transition-all"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Potvrdit vše
                </button>
              </>
            )}
          </section>

          {/* ── Nejednoznačné ── */}
          {result.ambiguous.length > 0 && (
            <section>
              <h4 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-amber-500 mb-2">
                <HelpCircle size={12} /> Nejednoznačné ({result.ambiguous.length})
              </h4>
              <div className="space-y-2">
                {result.ambiguous.map(a => (
                  <div key={a.execution.id} className={`${cardCls} border-amber-500/30 bg-amber-500/5`}>
                    <div className="text-[10px] font-bold text-[var(--text-primary)]">
                      {fmtDay(a.execution.entry_at)} {fmtTime(a.execution.entry_at)} · {a.execution.symbol} · {fmtMoney(a.execution.pnl)}
                    </div>
                    <div className="text-[9px] text-[var(--text-secondary)] mt-1 mb-1.5">
                      Sedí víc obchodů — vyber správný:
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {a.candidates.map(c => (
                        <button
                          key={String(c.id)}
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const ok = await applyMatch(a.execution.id, String(c.id));
                              onToast?.(ok ? 'Spárováno' : 'Spárování selhalo — nic se nezměnilo');
                              await load();
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-[9px] font-bold text-[var(--text-primary)] hover:bg-amber-500/10 transition-all"
                        >
                          vstup {c.entryPrice} · {c.entryTime ? fmtTime(new Date(c.entryTime).toISOString()) : '—'} · {fmtMoney(c.pnl)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Bez záznamu v deníku ── */}
          <section>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <h4 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-blue-400">
                <AlertTriangle size={12} /> Bez záznamu v deníku ({unmatchedGroups.length}{result.unmatched.length !== unmatchedGroups.length ? ` obchodů · ${result.unmatched.length} kopií` : ''})
              </h4>
              {unmatchedGroups.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {unmatchedDays.length > 1 && unmatchedDays.map(day => (
                    <button
                      key={day.key}
                      onClick={() => selectMany(day.ids, !day.ids.every(id => selected.has(id)))}
                      className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[9px] font-black uppercase tracking-widest text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-blue-500/40 transition-all"
                    >
                      {day.label} ({day.groupCount})
                    </button>
                  ))}
                  <button
                    onClick={() => selectMany(allUnmatchedIds, !allSelected)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-blue-500/40 text-[9px] font-black uppercase tracking-widest text-blue-400 hover:bg-blue-500/10 transition-all"
                  >
                    <CheckSquare size={11} /> {allSelected ? 'Zrušit výběr' : 'Vybrat vše'}
                  </button>
                </div>
              )}
            </div>
            {unmatchedGroups.length === 0 ? (
              <p className="text-[10px] text-[var(--text-muted)]">Všechny exekuce mají svůj obchod.</p>
            ) : (
              <>
                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {unmatchedGroups.map(g => {
                    const ctx = describeGroupContext(g, unmatchedGroups);
                    const ids = g.executions.map(e => e.id);
                    const isSel = ids.every(id => selected.has(id));
                    const s = g.sample;
                    return (
                      <div
                        key={g.key}
                        className={`${cardCls} flex items-center gap-2 ${isSel ? 'border-blue-500/50 bg-blue-500/10' : 'hover:border-blue-500/30'}`}
                      >
                        <button onClick={() => toggleGroup(ids)} className="min-w-0 flex-1 text-left">
                          <div className="flex items-center justify-between gap-2 text-[10px]">
                            <span className="font-bold text-[var(--text-primary)]">
                              {fmtDay(s.entry_at)} {fmtTime(s.entry_at)} · {s.symbol} · {s.direction}
                            </span>
                            <span className={g.totalPnl >= 0 ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>
                              {fmtMoney(g.totalPnl)}
                            </span>
                          </div>
                          {/* Podklad k rozhodnutí — fakta, ne hodnocení. */}
                          <div className="text-[9px] text-[var(--text-secondary)] mt-0.5">
                            {s.qty}× · vstup {s.direction === 'Short' ? s.sell_price : s.buy_price}
                            {g.accountCount > 1 && ` · na ${g.accountCount} účtech`}
                            {' · '}{fmtGap(ctx.gapSeconds)}
                            {ctx.sameMinuteCount > 1 && ` · ${ctx.sameMinuteCount} vstupy ve stejné minutě`}
                          </div>
                        </button>
                        <button
                          onClick={() => setManualGroup(g)}
                          disabled={busy}
                          className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-blue-500/35 text-blue-500 hover:bg-blue-500/10 disabled:opacity-40 text-[8px] font-black uppercase tracking-widest transition-all"
                        >
                          <Link2 size={11} /> Propojit
                        </button>
                      </div>
                    );
                  })}
                </div>

                {selected.size > 0 && (
                  <div className={`mt-3 p-3 rounded-xl border ${isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)] mb-2">
                      Vybráno: {unmatchedGroups.filter(g => g.executions.every(e => selected.has(e.id))).length} obchodů ({selected.size} kopií) ·{' '}
                      <span className={selectedPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{fmtMoney(selectedPnl)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-[9px] font-bold normal-case tracking-normal">
                      {selectedBreakdown.fundedCount > 0 && (
                        <span className="text-[var(--text-secondary)]">
                          Funded ({selectedBreakdown.fundedCount} účtů):{' '}
                          <span className={selectedBreakdown.funded >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                            {fmtMoney(selectedBreakdown.funded)}
                          </span>
                        </span>
                      )}
                      {selectedBreakdown.challengeCount > 0 && (
                        <span className="text-[var(--text-secondary)]">
                          Challenge ({selectedBreakdown.challengeCount} účtů):{' '}
                          <span className={selectedBreakdown.challenge >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                            {fmtMoney(selectedBreakdown.challenge)}
                          </span>
                        </span>
                      )}
                      {selectedBreakdown.ostatni !== 0 && (
                        <span className="text-[var(--text-secondary)]">
                          Bez fáze:{' '}
                          <span className={selectedBreakdown.ostatni >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                            {fmtMoney(selectedBreakdown.ostatni)}
                          </span>
                        </span>
                      )}
                    </div>
                    <input
                      type="text" value={incidentRef} onChange={e => setIncidentRef(e.target.value)}
                      placeholder="Označení incidentu (nepovinné)"
                      className={`w-full mb-2 px-3 py-2 rounded-lg border text-xs font-bold outline-none ${isDark ? 'bg-slate-950 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                    />
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={bulkIncident} disabled={busy || selectedPnl >= 0 || !selectedBreakdown.allAccountsNegative}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-600/90 hover:bg-rose-600 disabled:opacity-50 text-white text-[9px] font-black uppercase tracking-widest transition-all"
                      >
                        <Skull size={11} /> Přiřadit k incidentu
                      </button>
                      <button
                        onClick={bulkIgnore} disabled={busy}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[9px] font-black uppercase tracking-widest transition-all"
                      >
                        <EyeOff size={11} /> Ignorovat
                      </button>
                    </div>
                    <p className="text-[9px] text-[var(--text-muted)] mt-2">
                      Incident se nepočítá do win rate ani statistik setupů, ale zůstává v Net P&amp;L a v datech pro analýzu.
                    </p>
                    {(selectedPnl >= 0 || !selectedBreakdown.allAccountsNegative) && (
                      <p className="text-[9px] font-bold text-amber-500 mt-1">
                        Incident lze vytvořit jen z výběru, který je ztrátový na každém dotčeném účtu.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          {result.skipped.length > 0 && (
            <p className="text-[9px] text-[var(--text-muted)]">
              Přeskočeno {result.skipped.length} exekucí
              {result.skipped.some(s => s.reason === 'before-cutoff') && ' (před cutoffem)'}
              {result.skipped.some(s => s.reason === 'no-account-map') && ' (nenamapovaný účet)'}.
            </p>
          )}
        </div>
      )}
      {manualGroup && result && (
        <ImportManualLinkModal
          group={manualGroup}
          result={result}
          isDark={isDark}
          onClose={() => !busy && setManualGroup(null)}
          onConfirm={confirmManualLink}
        />
      )}
    </div>
  );
};

export default ImportQueue;
