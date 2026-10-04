import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import type { JournalSyncReport } from '../services/journalImportSync';

export default function JournalImportStatus({ report, running, error, onRetry, onAccounts, compact = false }: {
  report: JournalSyncReport | null; running: boolean; error: boolean; onRetry?: () => void; onAccounts?: () => void;
  /** Malá ikona v liště Historie: ukáže se jen při problému, zpráva je v rozbalovací bublině. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!running && !error && !report?.connections.length) return null;
  const connections = report?.connections ?? [];
  const unavailable = error || connections.some(row => ['unavailable', 'unsupported', 'stale'].includes(row.state));
  const processing = connections.some(row => row.state === 'processing');
  const empty = connections.some(row => row.state === 'empty');
  const pending = connections.reduce((sum, row) => sum + row.pending, 0);
  const unassigned = connections.reduce((sum, row) => sum + row.unassigned, 0);
  const conflict = connections.some(row => row.reason?.startsWith('journal-legacy-'));
  const partition = connections.some(row => row.reason === 'journal-import-partition-required');
  const message = running ? 'Zpracovávám uložené obchodní záznamy…'
    : conflict ? 'Původ některých starších obchodů není jednoznačný. Automatický převod čeká na vyřešení.'
    : partition ? 'Tato historie přesahuje rozsah současného importu. Zpracování není dokončené.'
    : unavailable ? 'Historie není plně aktualizovaná. Zobrazené výsledky mohou pocházet z dřívějšího načtení.'
    : processing ? 'Zpracovávám historii po dávkách. Zobrazené výsledky pocházejí z posledního dokončeného načtení.'
    : empty ? 'Pro část připojení zatím nemáme zaznamenané události. Počet provedených kopií z nich nelze ověřit.'
    : pending || unassigned ? `Čekající pozice: ${pending}. Nepřiřazená plnění: ${unassigned}. Nejsou zahrnutá v potvrzených výsledcích.`
    : 'Uložené obchodní záznamy jsou zpracované.';
  const busy = running || (processing && !unavailable);
  const warn = unavailable || empty || pending > 0 || unassigned > 0 || conflict || partition;
  const icon = busy ? <Loader2 size={15} className="animate-spin text-slate-500" /> : warn ? <AlertCircle size={15} className="text-amber-500" /> : null;
  const actions = <>
    {onAccounts && (pending > 0 || unassigned > 0) && <button type="button" onClick={onAccounts} className="font-bold text-indigo-400">Zkontrolovat účty</button>}
    {onRetry && <button type="button" onClick={onRetry} disabled={running} aria-label="Obnovit historii obchodů" className="rounded-md p-2 text-slate-500 hover:text-[var(--text-primary)] disabled:opacity-40"><RefreshCw size={14} /></button>}
  </>;

  if (compact) {
    // Vše zpracované = nic neukazovat; jinak jen ikona, text až po kliknutí.
    if (!busy && !warn) return null;
    return <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label="Stav načtení historie" title={message}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${warn ? 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15' : 'border-[var(--border-subtle)] bg-[var(--bg-card)]'}`}>
        {icon}
      </button>
      {open && <div role="status" className="theme-card absolute right-0 z-30 mt-2 w-72 rounded-lg p-3 text-xs text-[var(--text-primary)] shadow-lg backdrop-blur-2xl">
        <p className="leading-relaxed">{message}</p>
        <div className="mt-2 flex items-center justify-end gap-2">{actions}</div>
      </div>}
    </div>;
  }

  return <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-primary)]" role="status">
    {icon}
    <span className="min-w-0 flex-1">{message}</span>
    {actions}
  </div>;
}
