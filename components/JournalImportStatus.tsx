import React from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import type { JournalSyncReport } from '../services/journalImportSync';

export default function JournalImportStatus({ report, running, error, onRetry, onAccounts }: {
  report: JournalSyncReport | null; running: boolean; error: boolean; onRetry?: () => void; onAccounts?: () => void;
}) {
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
  return <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-primary)]" role="status">
    {running || (processing && !unavailable) ? <Loader2 size={15} className="animate-spin text-slate-500" /> : unavailable || empty || pending || unassigned ? <AlertCircle size={15} className="text-amber-500" /> : null}
    <span className="min-w-0 flex-1">{message}</span>
    {onAccounts && (pending > 0 || unassigned > 0) && <button type="button" onClick={onAccounts} className="font-bold text-indigo-400">Zkontrolovat účty</button>}
    {onRetry && <button type="button" onClick={onRetry} disabled={running} aria-label="Obnovit historii obchodů" className="rounded-md p-2 text-slate-500 hover:text-[var(--text-primary)] disabled:opacity-40"><RefreshCw size={14} /></button>}
  </div>;
}
