import React from 'react';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

export default function LiveRuntimeStatus({ status, available, pending, transport, compact = false }: {
  status: CopierControllerStatus | null;
  available: boolean;
  pending: boolean;
  transport: 'local' | 'relay' | null;
  /** Telefon: jeden řádek s tečkami místo tří popisků. */
  compact?: boolean;
}) {
  const current = available ? status : null;
  const error = current?.lastError;
  const disconnected = current?.connected === false;
  const problem = pending ? null : !current
    ? 'Stav workeru není ověřený. Zkontroluj, že Mac worker běží a má dostupné spojení.'
    : disconnected ? 'Spojení workeru s Tradovate je přerušené. Před zapnutím musí worker obnovit spojení a ověřit účty.'
      : error ? 'Worker hlásí problém. Před dalším zapnutím zkontroluj technický detail.'
        : current.reconciliationRequired ? 'Worker ještě potřebuje ověřit stav účtů u brokera.' : null;
  const copier = !current ? 'Neověřeno'
    : current.killSwitch ? 'Nouzově zastavená'
      : current.dayLockUntil > Date.now() ? 'Zámek dne'
        : !current.armed ? 'Vypnutá'
          : current.pause && current.pause.until > Date.now() ? 'Pauza'
            : current.shadowMode ? 'Pouze sledování' : 'Zapnutá';
  if (compact) {
    const dot = (ok: boolean | null): string => ok == null ? 'bg-[var(--text-muted)]' : ok ? 'bg-emerald-500' : 'bg-rose-500';
    const copierOk: boolean | null = !current ? null : current.killSwitch || current.dayLockUntil > Date.now() ? false : current.armed;
    return <section aria-label="Aktuální stav kopírky" data-live-runtime-compact="true" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5"><i className={`h-2 w-2 rounded-full ${dot(pending ? null : !!current)}`} />Worker{current ? <span className="text-[var(--text-muted)]"> · {transport === 'local' ? 'Mac' : 'cloud'}</span> : null}</span>
        <span className="inline-flex items-center gap-1.5"><i className={`h-2 w-2 rounded-full ${dot(!current ? null : current.connected)}`} />Broker</span>
        <span className="inline-flex items-center gap-1.5"><i className={`h-2 w-2 rounded-full ${dot(copierOk)}`} />Kopírka <b className="text-[var(--text-primary)]">{copier}</b></span>
      </div>
      {problem ? <p role="status" className="mt-1.5 text-[11px] font-semibold text-amber-600">{problem}</p> : null}
      {error ? <details className="mt-1.5 text-[11px] text-[var(--text-secondary)]"><summary className="cursor-pointer">Technický detail</summary><p className="mt-1 break-words">{error}</p></details> : null}
    </section>;
  }
  return <section aria-label="Aktuální stav kopírky" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
      <span>Worker <b>{pending ? 'Načítání…' : current ? 'Dostupný' : 'Neověřeno'}</b>{current && <span className="text-[var(--text-secondary)]"> · {transport === 'local' ? 'tento Mac' : 'cloud'}</span>}</span>
      <span>Broker stream <b>{!current ? 'Neověřeno' : current.connected ? 'Připojený' : 'Odpojený'}</b></span>
      <span>Kopírka <b>{copier}</b></span>
    </div>
    {problem ? <p role="status" className="mt-2 text-xs font-semibold text-amber-600">{problem}</p> : null}
    {error ? <details className="mt-2 text-[11px] text-[var(--text-secondary)]"><summary className="cursor-pointer">Technický detail</summary><p className="mt-1 break-words">{error}</p></details> : null}
  </section>;
}
