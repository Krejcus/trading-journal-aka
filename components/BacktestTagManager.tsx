import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Trade } from '../types';
import { tradeValuesEqual } from '../services/tradePatch';
import {
  BACKTEST_TAG_CATEGORIES, BACKTEST_TAG_FIELDS, prepareBacktestTagLibraryChange, previewBacktestTagMerge,
  validateBacktestTagCommitPlan, validateBacktestTagLibrary,
  type BacktestLibraryTag, type BacktestTagCategory, type BacktestTagCommitPlan, type BacktestTagField,
  type BacktestTagLibrary, type BacktestTagLibraryChange,
} from '../services/backtestTagLibrary';

export interface BacktestTagManagerProps {
  library: BacktestTagLibrary;
  /** Only fully loaded, owner-filtered backtest trades. No claim about unloaded rows. */
  trades: readonly Trade[];
  ownerId: string;
  onCommit: (plan: BacktestTagCommitPlan) => Promise<void>;
  onClose?: () => void;
  open?: boolean;
  isDark?: boolean;
  headerContent?: React.ReactNode;
}
const categories: Record<BacktestTagCategory, string> = { setup: 'Setup', mistake: 'Chyba', context: 'Kontext' };
const fieldLabels: Record<BacktestTagField, string> = { tags: 'Vlastní tagy', htfConfluence: 'Ruční HTF tagy', ltfConfluence: 'Ruční LTF tagy' };
const statusLabels = { active: 'Aktivní', archived: 'Archivovaný', deleted: 'Odstraněný z nabídky', merged: 'Sloučený' };
const blank = { id: '', label: '', category: 'setup' as BacktestTagCategory, aliases: '' };
const textError = (reason: unknown) => reason instanceof Error ? reason.message : 'Změnu katalogu se nepodařilo uložit.';

export const assertBacktestTagDraftCurrent = (original: BacktestLibraryTag | undefined, library: BacktestTagLibrary) => {
  if (!original || !tradeValuesEqual(original, library.tags.find(tag => tag.id === original.id))) {
    throw new Error('Upravovaný tag se mezitím změnil. Rozepsané hodnoty zůstaly zachované; porovnej je s aktuálním katalogem a otevři novou úpravu.');
  }
};
export interface BacktestTagCommitAttempt { plan: BacktestTagCommitPlan; hash: string }
/** Capture a stable request before asynchronous work. Key order must not turn an
 * identical receipt retry into a different operation fingerprint. */
export const captureBacktestTagCommitAttempt = async (plan: BacktestTagCommitPlan): Promise<BacktestTagCommitAttempt> => {
  const captured = structuredClone(plan);
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(captured))));
  return { plan: captured, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
};
export const tagAttemptDefinitelyNotApplied = (reason: unknown) => Boolean(reason && typeof reason === 'object' && 'definitelyNotApplied' in reason && reason.definitelyNotApplied === true);

/** Data and persistence stay in the parent. Neither a prop refresh nor a failed
 * commit resets the draft or its preview; a fresh validation precedes each retry. */
export default function BacktestTagManager({ library, trades, ownerId, onCommit, onClose, open = true, isDark = false, headerContent }: BacktestTagManagerProps) {
  const [draft, setDraft] = useState(blank);
  const [draftOwner] = useState(ownerId);
  const draftOriginal = useRef<BacktestLibraryTag | undefined>(undefined);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [selectedTradeIds, setSelectedTradeIds] = useState<string[]>([]);
  const [fields, setFields] = useState<BacktestTagField[]>(['tags']);
  const [prepared, setPrepared] = useState<BacktestTagCommitPlan>();
  const [previewLabel, setPreviewLabel] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const attempted = useRef<BacktestTagCommitAttempt | undefined>(undefined);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, [open]);
  const state = useMemo(() => {
    try {
      if (!library || library.ownerId !== ownerId) throw new Error('Katalog patří jinému uživateli.');
      validateBacktestTagLibrary(library);
      return { tags: library.tags, error: undefined };
    } catch (reason) { return { tags: [] as BacktestLibraryTag[], error: textError(reason) }; }
  }, [library, ownerId]);
  const active = state.tags.filter(tag => tag.status === 'active');
  const hasDraft = Boolean(draft.id || draft.label || draft.aliases || draft.category !== 'setup');
  const invalidate = () => { setPrepared(undefined); setError(undefined); setNotice(undefined); };
  const changeDraft = (patch: Partial<typeof draft>) => { setDraft(value => ({ ...value, ...patch })); invalidate(); };
  const createContext = () => ({ ownerId, expectedRevision: library.revision, operationId: crypto.randomUUID() });
  const metadataPreview = (change: BacktestTagLibraryChange, label: string) => {
    if (prepared || (hasDraft && !['create', 'edit'].includes(change.type))) { setError('Nejdřív dokonči nebo zruš rozepsanou úpravu a její náhled.'); return; }
    try { setPrepared(prepareBacktestTagLibraryChange(library, change, createContext())); setPreviewLabel(label); setError(undefined); setNotice(undefined); }
    catch (reason) { setError(textError(reason)); }
  };
  const previewDraft = () => {
    if (draft.id) {
      try { assertBacktestTagDraftCurrent(draftOriginal.current, library); }
      catch (reason) { setError(textError(reason)); return; }
    }
    const values = { label: draft.label, category: draft.category, aliases: draft.aliases.split('\n').filter(value => value.trim()) };
    metadataPreview(draft.id ? { type: 'edit', id: draft.id, ...values } : { type: 'create', tag: { id: crypto.randomUUID(), ...values } }, draft.id ? 'Upravit tag v katalogu' : 'Přidat tag do katalogu');
  };
  const previewMerge = () => {
    if (prepared || hasDraft) { setError('Nejdřív dokonči nebo zruš rozepsanou úpravu a její náhled.'); return; }
    try {
      if (includeHistory && (selectedTradeIds.length === 0 || selectedTradeIds.length > 500)) throw new Error('Vyber 1–500 konkrétních načtených obchodů.');
      if (includeHistory && fields.length === 0) throw new Error('Vyber alespoň jedno pole historických obchodů.');
      const result = previewBacktestTagMerge(library, trades, { ...createContext(), sourceId, targetId,
        scope: { tradeIds: includeHistory ? selectedTradeIds : [], fields: includeHistory ? fields : [] } });
      setPrepared(result); setPreviewLabel('Sloučit tagy'); setError(undefined); setNotice(undefined);
    } catch (reason) { setError(textError(reason)); }
  };
  const commit = async () => {
    if (!prepared || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      const captured = await captureBacktestTagCommitAttempt(prepared);
      if (attempted.current?.hash !== captured.hash) validateBacktestTagCommitPlan(captured.plan, library, trades, ownerId);
      attempted.current = captured;
      await onCommit(captured.plan);
      attempted.current = undefined; draftOriginal.current = undefined;
      setPrepared(undefined); setDraft(blank); setSourceId(''); setTargetId('');
      setNotice('Změna byla potvrzena.');
    } catch (reason) { if (tagAttemptDefinitelyNotApplied(reason)) attempted.current = undefined; setError(textError(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  if (!open) return null;
  if (draftOwner !== ownerId) return <section role="dialog" aria-modal="true" aria-label="Správa tagů" className="fixed inset-0 z-[960] flex items-center justify-center bg-slate-950 text-white"><p role="alert">Uživatel se změnil. Znovu otevři správu tagů pro aktuální účet.</p>{onClose && <button type="button" onClick={onClose}>Zavřít</button>}</section>;
  const disabled = busy || Boolean(state.error);
  const field = `rounded border px-3 py-2 text-sm ${isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
  const muted = isDark ? 'text-slate-400' : 'text-slate-600';
  return <div className="fixed inset-0 z-[960] flex items-center justify-center bg-slate-950/50 p-4" role="presentation">
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="backtest-tag-manager-title"
      className={`max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border p-5 shadow-xl ${isDark ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-slate-50 text-slate-900'}`}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose?.(); }
        if (event.key === 'Tab') {
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') ?? [])].filter(item => item.getClientRects().length > 0);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="mb-5 flex items-start justify-between gap-4"><div><h2 id="backtest-tag-manager-title" className="text-lg font-bold">Správa tagů</h2><p className={`mt-1 text-xs ${muted}`}>Kategorie a aliasy patří katalogu. Historické obchody se mění jen ve výslovně potvrzeném rozsahu.</p></div>
        {onClose && <button type="button" disabled={busy} onClick={onClose} className="text-sm underline">Zavřít</button>}</header>
      {headerContent}
      {(error || state.error) && <p role="alert" className="mb-3 whitespace-pre-wrap text-sm text-red-500">{error || state.error}</p>}
      {notice && <p role="status" className="mb-3 text-sm text-blue-500">{notice}</p>}
      <div className="grid gap-5 md:grid-cols-2">
        <section className="space-y-3 rounded border border-slate-500/25 p-3"><h3 className="font-semibold">{draft.id ? 'Úprava tagu' : 'Nový tag'}</h3>
          <label className="block text-xs">Název<input aria-label="Název tagu" value={draft.label} disabled={disabled} onChange={event => changeDraft({ label: event.target.value })} className={`${field} mt-1 w-full`} /></label>
          <label className="block text-xs">Kategorie<select aria-label="Kategorie tagu" value={draft.category} disabled={disabled} onChange={event => changeDraft({ category: event.target.value as BacktestTagCategory })} className={`${field} mt-1 w-full`}>{BACKTEST_TAG_CATEGORIES.map(category => <option key={category} value={category}>{categories[category]}</option>)}</select></label>
          <label className="block text-xs">Aliasy · každý na nový řádek<textarea aria-label="Aliasy tagu" value={draft.aliases} disabled={disabled} rows={3} onChange={event => changeDraft({ aliases: event.target.value })} className={`${field} mt-1 w-full`} /></label>
          <p className={`text-xs ${muted}`}>Přejmenování zachová původní název jako alias. Texty v minulých obchodech zůstanou stejné.</p>
          <div className="flex gap-3"><button type="button" disabled={disabled} className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40" onClick={previewDraft}>Zobrazit náhled změny</button>{hasDraft && <button type="button" disabled={busy} className="text-xs underline" onClick={() => { draftOriginal.current = undefined; setDraft(blank); invalidate(); }}>Zrušit úpravu</button>}</div>
        </section>
        <section className="space-y-3 rounded border border-slate-500/25 p-3"><h3 className="font-semibold">Sloučení tagů</h3>
          <label className="block text-xs">Zdroj<select aria-label="Zdrojový tag" disabled={disabled} className={`${field} mt-1 w-full`} value={sourceId} onChange={event => { setSourceId(event.target.value); invalidate(); }}><option value="">Vyber tag</option>{active.map(tag => <option key={tag.id} value={tag.id}>{tag.label} · {categories[tag.category]}</option>)}</select></label>
          <label className="block text-xs">Cíl<select aria-label="Cílový tag" disabled={disabled} className={`${field} mt-1 w-full`} value={targetId} onChange={event => { setTargetId(event.target.value); invalidate(); }}><option value="">Vyber tag</option>{active.filter(tag => tag.id !== sourceId).map(tag => <option key={tag.id} value={tag.id}>{tag.label} · {categories[tag.category]}</option>)}</select></label>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={disabled} checked={includeHistory} onChange={event => { setIncludeHistory(event.target.checked); if (event.target.checked && selectedTradeIds.length === 0 && trades.length <= 500) setSelectedTradeIds(trades.map(trade => String(trade.id))); invalidate(); }} />Změnit také ruční tagy ve vybraných načtených obchodech</label>
          {includeHistory && <div className="space-y-2">{BACKTEST_TAG_FIELDS.map(key => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={disabled} checked={fields.includes(key)} onChange={event => { setFields(current => event.target.checked ? [...current, key] : current.filter(item => item !== key)); invalidate(); }} />{fieldLabels[key]}</label>)}</div>}
          {includeHistory && <div className="rounded border border-slate-500/25 p-2">
            <p className={`text-xs ${muted}`}>Vybráno {selectedTradeIds.length} / {trades.length} načtených obchodů · nejvýše 500</p>
            <div className="my-2 flex gap-3 text-xs"><button type="button" disabled={disabled || trades.length > 500} onClick={() => { setSelectedTradeIds(trades.map(trade => String(trade.id))); invalidate(); }} className="underline disabled:opacity-40">Vybrat všechny načtené</button><button type="button" disabled={disabled} onClick={() => { setSelectedTradeIds([]); invalidate(); }} className="underline">Zrušit výběr</button></div>
            <div className="max-h-36 space-y-1 overflow-y-auto">{trades.map(trade => <label key={String(trade.id)} className="flex items-start gap-2 text-[11px]"><input type="checkbox" disabled={disabled || (!selectedTradeIds.includes(String(trade.id)) && selectedTradeIds.length >= 500)} checked={selectedTradeIds.includes(String(trade.id))} onChange={event => { setSelectedTradeIds(current => event.target.checked ? [...current, String(trade.id)] : current.filter(id => id !== String(trade.id))); invalidate(); }} /><span>{trade.date ?? ''} {trade.instrument ?? trade.symbol ?? ''} · {String(trade.id)}</span></label>)}</div>
          </div>}
          <p className={`text-xs ${muted}`}>Cílový tag si zachová svou kategorii. Automatické tagy se nepřejmenovávají. Nenačtené obchody nejsou součástí této změny.</p>
          <button type="button" disabled={disabled || !sourceId || !targetId} onClick={previewMerge} className="rounded border border-violet-500 px-3 py-2 text-sm text-violet-500 disabled:opacity-40">Zobrazit dopad sloučení</button>
        </section>
      </div>
      {prepared && <section className="mt-5 space-y-3 rounded border border-blue-500/50 bg-blue-500/5 p-4" aria-label="Náhled změny tagů">
        <h3 className="font-semibold">{previewLabel}</h3>
        <p className="text-sm">{prepared.kind === 'merge' ? `${prepared.expectedLibrary.tags.find(tag => tag.id === prepared.sourceId)?.label} → ${prepared.library.tags.find(tag => tag.id === prepared.targetId)?.label} · cílová kategorie ${categories[prepared.library.tags.find(tag => tag.id === prepared.targetId)!.category]}` : 'Změna pouze katalogu. Žádný historický obchod se nepřepíše.'}</p>
        <p className={`text-xs ${muted}`}>Vybraný rozsah: {prepared.scope.tradeIds.length} obchodů · skutečně dotčených: {prepared.affectedTradeIds.length} · automatické výskyty ponechané beze změny: {prepared.skippedAutomatic.reduce((total, item) => total + item.labels.length, 0)}</p>
        {prepared.tradePatches.length > 0 && <details><summary className="cursor-pointer text-xs underline">Dotčené obchody a přesné změny</summary><ul className="mt-2 max-h-56 space-y-2 overflow-y-auto text-xs">{prepared.tradePatches.map(patch => <li key={patch.tradeId} className="rounded border border-slate-500/20 p-2"><strong>{patch.tradeId}</strong>{Object.entries(patch.updates).map(([key, value]) => <p key={key} className="break-words">{key === 'autoConfluence' ? 'Automatický původ' : fieldLabels[key as BacktestTagField]}: {JSON.stringify((patch.expected as Record<string, unknown>)[key] ?? [])} → {JSON.stringify(value)}</p>)}</li>)}</ul></details>}
        {prepared.kind === 'catalog' && <details><summary className="cursor-pointer text-xs underline">Přesná změna katalogu</summary><ul className="mt-2 text-xs">{prepared.library.tags.filter(tag => JSON.stringify(tag) !== JSON.stringify(prepared.expectedLibrary.tags.find(old => old.id === tag.id))).map(tag => <li key={tag.id}>{tag.label} · {categories[tag.category]} · {statusLabels[tag.status]} · aliasy: {tag.aliases.join(', ') || 'žádné'}</li>)}</ul></details>}
        <div className="flex gap-3"><button type="button" disabled={disabled} onClick={() => void commit()} className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'Ukládám…' : prepared.kind === 'merge' ? `Potvrdit sloučení · ${prepared.affectedTradeIds.length} obchodů` : 'Potvrdit změnu katalogu'}</button><button type="button" disabled={busy} onClick={() => setPrepared(undefined)} className="text-xs underline">Zavřít náhled</button></div>
      </section>}
      <section className="mt-5"><h3 className="mb-2 font-semibold">Katalog · {state.tags.filter(tag => tag.status !== 'merged').length} tagů</h3>
        <p className={`mb-3 text-xs ${muted}`}>Archivace a odstranění skryjí tag z nabídky. Historické výskyty i jeho identita zůstanou zachované; odstranění lze obnovit.</p>
        <div className="space-y-2">{state.tags.filter(tag => tag.status !== 'merged').map(tag => <article key={tag.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-500/25 p-3"><div><p className="text-sm font-semibold">{tag.label} <span className={`font-normal ${muted}`}>· {categories[tag.category]} · {statusLabels[tag.status]}</span></p>{tag.aliases.length > 0 && <p className={`text-xs ${muted}`}>Aliasy: {tag.aliases.join(', ')}</p>}</div><div className="flex flex-wrap gap-3 text-xs">
          <button type="button" disabled={disabled} className="underline" onClick={() => { if (hasDraft || prepared) { setError('Nejdřív dokonči nebo zruš rozepsanou úpravu a její náhled.'); return; } draftOriginal.current = structuredClone(tag); setDraft({ id: tag.id, label: tag.label, category: tag.category, aliases: tag.aliases.join('\n') }); invalidate(); }}>Upravit</button>
          <button type="button" disabled={disabled} className="underline" onClick={() => metadataPreview({ type: tag.status === 'active' ? 'archive' : 'restore', id: tag.id }, tag.status === 'active' ? 'Archivovat tag pouze v katalogu' : 'Obnovit tag v nabídce')}>{tag.status === 'active' ? 'Archivovat' : 'Obnovit'}</button>
          {tag.status !== 'deleted' && <button type="button" disabled={disabled} className="text-red-500 underline" onClick={() => metadataPreview({ type: 'delete', id: tag.id }, 'Odstranit tag pouze z nabídky')}>Odstranit z nabídky</button>}
        </div></article>)}</div>
      </section>
    </section>
  </div>;
}
