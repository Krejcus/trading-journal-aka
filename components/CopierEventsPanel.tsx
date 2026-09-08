import React from 'react';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import type { CopierSnapshotHealth } from '../lib/localCopierAgentProtocol';
import { copierCopiesOutcomeText, type CopierDisarmRecord } from '../lib/copierDisarmReason';
import { snapshotHealthMessage } from '../services/liveStatusStrip';

const time = (at: number | null | undefined) => at
  ? new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : '—';
const dateTime = (at: number | null | undefined) => at
  ? new Date(at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

const Row = ({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2 text-[11px]">
    <span className="text-[var(--text-secondary)]">{label}</span>
    <span className={`min-w-0 break-words text-[var(--text-primary)] ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

/**
 * Technický stav kopírky a historie odzbrojení. Sem se přesunulo vše, co
 * dřív leželo v kartách nad skupinami: lastError workeru, časy kontrol
 * snímků a seznam odzbrojení včetně původního technického textu.
 */
export default function CopierEventsPanel({ status, transport, snapshotHealth, disarmHistory }: {
  status: CopierControllerStatus | null;
  transport: 'local' | 'relay' | null;
  snapshotHealth?: CopierSnapshotHealth | null;
  disarmHistory: readonly CopierDisarmRecord[];
}) {
  const history = [...disarmHistory].sort((left, right) => right.at - left.at);
  return (
    <section data-copier-events-panel="true" className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <h3 className="text-sm font-black text-[var(--text-primary)]">KOPÍRKA A WORKER</h3>
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Technický stav workeru, ENTRY/EXIT snímků a historie odzbrojení</p>
      </div>
      <div className="grid gap-px bg-[var(--border-subtle)] lg:grid-cols-2">
        <div className="bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)]">
          <Row label="Worker" value={status ? (transport === 'local' ? 'Dostupný · tento Mac' : 'Dostupný · cloud') : 'Neověřeno'} />
          <Row label="Broker stream" value={!status ? 'Neověřeno' : status.connected ? 'Připojený' : 'Odpojený'} />
          <Row label="Ověření účtů" value={!status ? '—' : status.reconciliationRequired ? 'Čeká na ověření u brokera' : 'Ověřeno'} />
          <Row label="Poslední chyba workeru" value={status?.lastError ?? '—'} mono />
        </div>
        <div className="bg-[var(--bg-card)] divide-y divide-[var(--border-subtle)]">
          <Row label="Snímky" value={snapshotHealth ? snapshotHealthMessage(snapshotHealth) : 'Stav snímků není k dispozici.'} />
          <Row label="Layout" value={snapshotHealth ? `${snapshotHealth.layoutName}${snapshotHealth.chartIdConfigured ? '' : ' · nespárovaný'}` : '—'} />
          <Row label="Poslední kontrola" value={time(snapshotHealth?.lastCheckedAt)} />
          <Row label="Poslední uložený snímek" value={dateTime(snapshotHealth?.lastSuccessAt)} />
        </div>
      </div>
      <div className="border-t border-[var(--border-subtle)] px-4 py-3">
        <p className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Historie odzbrojení ({history.length})</p>
        {history.length === 0 ? (
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">Kopírka se od startu workeru nevypnula.</p>
        ) : (
          <ol className="mt-2 divide-y divide-[var(--border-subtle)]">
            {history.map((record, index) => {
              const manual = record.trigger === 'manual';
              return (
                <li key={`${record.at}-${record.code}-${index}`} className={`py-2 text-[11px] ${manual ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono tabular-nums">{time(record.at)}</span>
                    <span className={manual ? '' : 'font-bold'}>{record.title}</span>
                    <span className="text-[var(--text-secondary)]">· {copierCopiesOutcomeText(record.copiesOutcome)}</span>
                  </div>
                  {!manual ? (
                    <>
                      <p className="mt-0.5 text-[var(--text-secondary)]">Další krok: {record.nextStep}</p>
                      <p className="mt-0.5 break-words font-mono text-[10px] text-[var(--text-secondary)]">{record.detail}</p>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
