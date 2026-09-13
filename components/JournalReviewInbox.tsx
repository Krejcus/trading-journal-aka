import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Loader2, X } from 'lucide-react';
import type { Account } from '../types';
import type { storageService } from '../services/storageService';
import type { JournalInboxKind, JournalInboxPage, JournalInboxRow, JournalRetainedReview } from '../services/journalReviewInbox';
import ImageZoomModal from './ImageZoomModal';

const labels: Record<JournalInboxRow['state'], string> = {
  pending: 'Čeká na úplné údaje', invalidated: 'Vyžaduje nové ověření',
  superseded: 'Původní záznam', estimated: 'Starší odhad kopie', 'legacy-unverified': 'Čeká na ověření původu',
};
const pendingLabels: Record<string, string> = {
  'account-not-linked': 'Chybí přiřazení účtu', 'account-link-conflict': 'Účet je přiřazen vícekrát',
  'invalid-journal-account': 'Neplatné přiřazení účtu', open: 'Otevřená pozice',
  incomplete: 'Neúplný průběh pozice', 'accounting-pending': 'Čeká na vyúčtování a poplatky',
};
const dateLabel = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('cs-CZ') : 'Čas není doložen';
const defaultLoadPage: typeof storageService.getJournalReviewInbox = async (...args) =>
  (await import('../services/storageService')).storageService.getJournalReviewInbox(...args);
const defaultLoadReview: typeof storageService.getJournalRetainedReview = async (...args) =>
  (await import('../services/storageService')).storageService.getJournalRetainedReview(...args);

/** Review records stay accessible outside confirmed trade/P&L collections.
 * Closed by default; list pages and screenshots are fetched only on demand. */
export default function JournalReviewInbox({ accounts, refreshVersion, loadPage = defaultLoadPage, loadReview = defaultLoadReview }: {
  accounts: Account[];
  refreshVersion?: number;
  loadPage?: typeof storageService.getJournalReviewInbox;
  loadReview?: typeof storageService.getJournalRetainedReview;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<JournalInboxKind>('pending');
  const [account, setAccount] = useState('');
  const [after, setAfter] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [page, setPage] = useState<JournalInboxPage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<JournalInboxRow | null>(null);
  const [review, setReview] = useState<JournalRetainedReview | null>(null);
  const [reviewState, setReviewState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [zoom, setZoom] = useState<number | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setPage(null); setError(false); setSelected(null); setZoom(null);
    void loadPage(kind, { after, accountIds: account ? [account] : undefined, signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setPage(value); })
      .catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [open, kind, account, after, retry, loadPage, refreshVersion]);
  useEffect(() => {
    if (!selected || !open) return;
    const abort = new AbortController();
    const focused = document.activeElement as HTMLElement | null;
    setReview(null); setReviewState('loading'); setZoom(null);
    closeButton.current?.focus();
    void loadReview(selected.id, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setReview(value); setReviewState(value ? 'ready' : 'missing'); } })
      .catch(() => { if (!abort.signal.aborted) setReviewState('error'); });
    return () => { abort.abort(); focused?.focus(); };
  }, [selected, open, loadReview]);
  const resetPage = () => { setAfter(null); setPrevious([]); setPage(null); setSelected(null); };
  return <section className="mb-4 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setSelected(null); setZoom(null); }}
      className="flex w-full items-center gap-3 p-4 text-left">
      <FileText size={17} className="text-slate-500" />
      <span className="flex-1"><span className="block text-sm font-bold">Neúplné záznamy a původní poznámky</span>
        <span className="block text-xs text-slate-500">Oddělený archiv · nezapočítává se do P&L ani počtu kopií</span></span>
      {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
    </button>
    {open && <div className="border-t border-[var(--border-subtle)] p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['pending', 'retained'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value}
          onClick={() => { setKind(value); resetPage(); }}
          className={`rounded-md px-3 py-2 text-xs font-bold ${kind === value ? 'bg-indigo-500/15 text-indigo-400' : 'text-slate-500'}`}>
          {value === 'pending' ? 'Čekající záznamy' : 'Starší záznamy'}</button>)}
        <select aria-label="Účet v archivu" value={account} onChange={event => { setAccount(event.target.value); resetPage(); }}
          className="ml-auto max-w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-2 text-xs">
          <option value="">Všechny účty v archivu</option>
          {accounts.filter(value => value.type !== 'Backtest').map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
      </div>
      <p className="mb-3 text-xs text-slate-500">Archiv má vlastní filtr účtu. Čekající záznam může mít otevřenou pozici, chybějící poplatky nebo neověřené přiřazení. Starší odhad nepotvrzuje provedení kopie.</p>
      {error ? <div role="alert" className="text-sm">Archiv se nepodařilo načíst. <button type="button" onClick={() => setRetry(value => value + 1)} className="text-indigo-400 underline">Zkusit znovu</button></div>
        : !page ? <div role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> Načítám archiv…</div>
        : <>
          {!page.rows.length && <p className="py-3 text-sm text-slate-500">Na této stránce nejsou žádné záznamy pro zvolený účet.</p>}
          <div className="divide-y divide-[var(--border-subtle)]">{page.rows.map(row => <div key={row.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1"><div className="text-sm font-bold">{row.instrument} <span className="font-normal text-slate-500">· {accounts.find(value => value.id === row.accountId)?.name || (row.externalAccountId ? `Účet ${row.externalAccountId} · nepřiřazen` : 'Původní účet')}</span></div>
              <div className="text-xs text-slate-500">{dateLabel(row.date)} · {row.state === 'pending' && row.pendingReason ? pendingLabels[row.pendingReason] || labels.pending : labels[row.state]}</div></div>
            {row.hasReview && <button type="button" onClick={() => setSelected(row)} className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-xs font-bold">Poznámky a obrázky</button>}
          </div>)}</div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <button type="button" disabled={!previous.length} onClick={() => { setAfter(previous.at(-1) ?? null); setPrevious(value => value.slice(0, -1)); }} className="px-3 py-2 disabled:opacity-30">Předchozí</button>
            <span className="text-slate-500">Strana {previous.length + 1}</span>
            <button type="button" disabled={!page.next} onClick={() => { setPrevious(value => [...value, after]); setAfter(page.next); }} className="px-3 py-2 disabled:opacity-30">Další</button>
          </div>
        </>}
      {selected && <div className="mt-4 rounded-lg border border-[var(--border-subtle)] p-4" aria-label="Původní poznámky">
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-bold">{selected.instrument} · původní poznámky a obrázky</h3>
          <button ref={closeButton} type="button" aria-label="Zavřít poznámky" onClick={() => { setSelected(null); setZoom(null); }}><X size={18} /></button></div>
        {reviewState === 'loading' && <p role="status" className="text-xs text-slate-500">Načítám poznámky…</p>}
        {reviewState === 'error' && <p role="alert" className="text-xs text-slate-500">Poznámky se nepodařilo načíst. Zavři detail a zkus jej otevřít znovu.</p>}
        {reviewState === 'missing' && <p className="text-xs text-slate-500">Původní záznam už není dostupný.</p>}
        {reviewState === 'ready' && review && <>
          <div className="mb-3 flex gap-2 overflow-x-auto">{review.screenshots.map((src, index) => <button key={src} type="button" onClick={() => setZoom(index)} aria-label={`Zvětšit obrázek ${index + 1}`}>
            <img src={src} loading="lazy" alt={`Screenshot obchodu ${index + 1}`} className="h-28 w-44 max-w-none rounded-md border border-[var(--border-subtle)] object-cover" /></button>)}</div>
          {review.notes.map(note => <div key={note.label} className="mb-3"><h4 className="text-xs font-bold text-slate-500">{note.label}</h4><p className="whitespace-pre-wrap break-words text-sm">{note.text}</p></div>)}
          {!!review.noteHistory?.revisions.length && <details className="mb-3 text-xs"><summary className="cursor-pointer font-bold">Historie poznámek ({review.noteHistory.revisions.length})</summary>
            {review.noteHistory.revisions.map(note => <div key={note.id} className="mt-2 border-l border-[var(--border-subtle)] pl-3"><div className="text-slate-500">{new Date(note.clientCapturedAt).toLocaleString('cs-CZ')} · {note.phase === 'before' ? 'Před obchodem' : note.phase === 'during' ? 'Během obchodu' : 'Po obchodě'}</div><p className="whitespace-pre-wrap break-words">{note.operation === 'clear' ? 'Poznámka vymazána' : note.text}</p></div>)}</details>}
          {!review.screenshots.length && !review.notes.length && !review.noteHistory?.revisions.length && <p className="text-xs text-slate-500">Tento záznam neobsahuje poznámky ani obrázky.</p>}
          {review.drawingCount > 0 && <p className="text-xs text-slate-500">Uloženo kreseb: {review.drawingCount}. Zobrazení původních kreseb v tomto archivu zatím není dostupné.</p>}
        </>}
      </div>}
    </div>}
    {zoom !== null && review && <ImageZoomModal images={review.screenshots} initialIndex={zoom} onClose={() => setZoom(null)} />}
  </section>;
}
