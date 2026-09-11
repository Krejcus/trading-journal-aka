import React, { useState } from 'react';
import { useCopierDisarmNotice } from '../hooks/useCopierDisarmNotice';
import { AlertTriangle } from 'lucide-react';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';
import { buildLiveStatusStrip, type LiveStatusTone } from '../services/liveStatusStrip';
import { formatSnapshotRepairError } from '../lib/copierBlockerMessages';

const DOT: Record<LiveStatusTone, string> = {
  muted: 'bg-slate-400/70',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-rose-500',
};

const TEXT: Record<LiveStatusTone, string> = {
  muted: 'text-[var(--text-secondary)]',
  ok: 'text-emerald-600',
  warn: 'text-amber-600',
  danger: 'text-rose-600',
};

/**
 * Jediný stavový řádek LIVE. Nahrazuje kartu stavu workeru i kartu snímků:
 * zdravý stav je tichý, jediné tlačítko je bezpečná obnova TradingView, když
 * vypadlo CDP. Vše ostatní (lastError, historie odzbrojení, časy) je v Událostech.
 */
export default function LiveStatusStrip({ status, available, pending, transport, snapshotHealth, onRepairSnapshots, accountLabel, quiet = false, hideDisarmNotice = false }: {
  status: CopierControllerStatus | null;
  available: boolean;
  pending: boolean;
  transport: 'local' | 'relay' | null;
  snapshotHealth?: CopierSnapshotHealth | null;
  onRepairSnapshots?: () => Promise<void> | void;
  accountLabel?: (accountId: number) => string;
  /**
   * Dashboard režim: nic, dokud není co udělat. Vykreslí se jen chip snímků
   * s tlačítkem obnovy (CDP offline) nebo bezpečnostní věta po automatickém
   * vypnutí; plná lišta patří do Událostí.
   */
  quiet?: boolean;
  /** Only suppress the duplicate when another visible panel carries the incident. */
  hideDisarmNotice?: boolean;
}) {
  const model = buildLiveStatusStrip({ status, available, pending, transport, snapshotHealth });
  const recentDisarm = useCopierDisarmNotice(status?.lastDisarm?.at);
  const notice = hideDisarmNotice || !recentDisarm ? null : model.notice;
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const repair = model.repairSnapshots && onRepairSnapshots;
  if (quiet && !repair && !notice) return null;
  const chips = quiet ? model.chips.filter(chip => chip.id === 'snapshots' && model.repairSnapshots) : model.chips;
  return (
    <section aria-label="Aktuální stav kopírky" data-live-status-strip={quiet ? 'quiet' : 'true'} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
        {chips.map(chip => (
          <span key={chip.id} data-chip={chip.id} data-tone={chip.tone} title={chip.title} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[chip.tone]}`} />
            <span className="text-[var(--text-secondary)]">{chip.label}</span>
            <b className={TEXT[chip.tone]}>{chip.value}</b>
          </span>
        ))}
        {repair ? (
          <button
            type="button"
            disabled={repairBusy}
            onClick={() => {
              setRepairBusy(true);
              setRepairError(null);
              void Promise.resolve(onRepairSnapshots()).catch(error => {
                setRepairError(formatSnapshotRepairError(error, accountLabel ?? (id => String(id))));
              }).finally(() => setRepairBusy(false));
            }}
            className="ml-auto rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-black text-amber-700 transition hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50 dark:text-amber-300"
          >
            {repairBusy ? 'Spouštím…' : 'Obnovit TradingView'}
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-rose-600">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      ) : null}
      {repairError ? <p className="mt-1.5 text-[11px] font-bold text-rose-600">{repairError}</p> : null}
    </section>
  );
}
