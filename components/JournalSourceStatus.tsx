import React, { useEffect, useId, useState } from 'react';
import { ChevronDown, Database, Loader2, RefreshCw } from 'lucide-react';
import { storageService } from '../services/storageService';
import type { JournalConnectionSources, JournalSourceConnection, JournalSourceStatus as Source } from '../services/journalSourceStatus';

const labels: Record<Source['type'], string> = {
  order: 'Příkazy', fill: 'Plnění', orderversion: 'Změny příkazů · SL / TP', command: 'Požadované změny',
  commandreport: 'Potvrzení změn', executionreport: 'Provedení příkazů', fillfee: 'Poplatky',
  fillpair: 'Párování plnění', contract: 'Kontrakty', cashbalancelog: 'Pohyby zůstatku',
};
const date = (at: number) => new Date(at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const status = (source: Source) => !source.metadata ? 'Bez záznamu'
  : source.metadata.kind === 'unavailable' ? 'Čtení selhalo'
  : source.metadata.scope === 'available-list' ? 'Načtený seznam'
  : source.metadata.scope === 'known-parents' ? 'Načtená dávka' : 'Načteno · rozsah neurčen';
const loadStoredSources = (ids: readonly string[], signal?: AbortSignal) => storageService.getJournalSourceStatus(ids, signal);

export default function JournalSourceStatus({ connections, loadSources = loadStoredSources }: {
  connections: readonly JournalSourceConnection[];
  loadSources?: (ids: readonly string[], signal?: AbortSignal) => Promise<JournalConnectionSources[]>;
}) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; refresh: number; rows?: JournalConnectionSources[]; error?: boolean } | null>(null);
  const contentId = useId();
  const key = JSON.stringify(connections.map(row => row.connectionId).sort());
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null);
    void loadSources(JSON.parse(key) as string[], controller.signal).then(rows => {
      if (!controller.signal.aborted) setResult({ key, refresh, rows });
    }).catch(() => { if (!controller.signal.aborted) setResult({ key, refresh, error: true }); });
    return () => controller.abort();
  }, [key, loadSources, open, refresh]);
  if (!connections.length) return null;
  const current = result?.key === key && result.refresh === refresh ? result : null;
  return <section className="mb-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]">
    <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => { setResult(null); setOpen(value => !value); }} className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs">
      <Database size={15} className="text-[var(--text-secondary)]" /><span className="font-bold">Podklady historie</span>
      <span className="ml-auto text-[var(--text-secondary)]">Připojení: {connections.length}</span>
      <ChevronDown size={15} className={`text-[var(--text-secondary)] transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div id={contentId} className="border-t border-[var(--border-subtle)] px-4 py-3 text-xs">
      <div className="mb-3 flex items-start gap-3">
        <p className="flex-1 leading-relaxed text-[var(--text-secondary)]">Poslední uložené pokusy o dočtení historie, společné pro účty daného připojení. Načtený seznam ani dávka nepotvrzují úplnou historii. Starší posuny SL/TP mohou chybět.</p>
        <button type="button" aria-label="Obnovit přehled podkladů" title="Znovu načíst uložený přehled" disabled={!current} onClick={() => setRefresh(value => value + 1)} className="rounded-md p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"><RefreshCw size={14} /></button>
      </div>
      {!current ? <p role="status" className="flex items-center gap-2 py-2 text-[var(--text-secondary)]"><Loader2 size={14} className="animate-spin" />Načítám uložený přehled…</p>
        : current.error ? <p role="alert" className="py-2 text-amber-600">Přehled se nepodařilo načíst. Dostupnost podkladů teď nelze ověřit. Zkuste přehled obnovit.</p>
        : current.rows?.map((connection, index) => <div key={connection.connectionId} className={index ? 'mt-5' : ''}>
          <div className="mb-2 flex flex-wrap items-center gap-2 font-bold"><span>Připojení {index + 1}</span><span className="rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">{connection.environment.toUpperCase()}</span>
            <span className="font-normal text-[var(--text-secondary)]">Propojené účty: {connections.find(row => row.connectionId === connection.connectionId)?.accountCount ?? 0}</span>
          </div>
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left">
            <thead className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><tr><th className="py-2 font-bold">Podklad</th><th className="py-2 font-bold">Poslední pokus</th><th className="py-2 font-bold">Rozsah načtení</th><th className="py-2 text-right font-bold">Čas čtení</th></tr></thead>
            <tbody>{connection.sources.map(source => <tr key={source.type} className="border-b border-[var(--border-subtle)] last:border-0">
              <td className="py-2.5 pr-3 font-medium">{labels[source.type]}</td>
              <td className={`py-2.5 pr-3 ${source.metadata?.kind === 'unavailable' ? 'text-amber-600' : 'text-[var(--text-secondary)]'}`}>{status(source)}</td>
              <td className="py-2.5 pr-3 text-[var(--text-secondary)]">{source.metadata?.kind === 'observed'
                ? <><span>Nalezeno {source.metadata.scanned} · nově uloženo {source.metadata.recorded}</span>
                  {source.metadata.scope === 'known-parents' && <span className="block text-[10px]">Odkazy v dávce: {source.metadata.requested} · zbývá v průchodu: {source.metadata.remaining}</span>}
                  {!!source.metadata.contended && <span className="block text-[10px]">Během čtení změněno: {source.metadata.contended}</span>}</>
                : '—'}</td>
              <td className="whitespace-nowrap py-2.5 text-right font-mono text-[11px] text-[var(--text-secondary)]">{source.metadata ? date(source.metadata.completedAt) : '—'}</td>
            </tr>)}</tbody>
          </table></div>
        </div>)}
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">Bez záznamu znamená, že chybí výsledek tohoto dočítání; průběžně zachycené události mohou být uložené. Časy pocházejí ze záznamu čtení.</p>
    </div>}
  </section>;
}
