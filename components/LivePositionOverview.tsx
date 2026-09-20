import React from 'react';
import type { MobileLevel, MobilePosition } from '../lib/liveMobilePresentation';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const mobileMoney = (value: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${usd.format(value)}`;
export const mobilePnlColor = (value: number | null) => value == null || value === 0 ? 'text-[var(--text-secondary)]' : value > 0 ? 'text-emerald-500' : 'text-rose-500';
const Level = ({ label, value, group, verified }: { label: string; value: MobileLevel; group: boolean; verified: boolean }) => (
  <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] px-2.5 py-2">
    <div className="text-[9px] font-bold text-[var(--text-secondary)]">{label}</div>
    <div className="font-mono text-sm font-bold text-[var(--text-primary)]">{!verified ? 'Neověřeno' : value.price == null ? value.coverage > 0 ? 'Více úrovní' : '—' : number.format(value.price)}</div>
    {value.distance != null ? <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]" title="Přibližná vzdálenost; cena odvozena z otevřeného P&L">≈ {number.format(value.distance)} b od ceny</div> : null}
    <div className={`mt-0.5 text-[10px] font-bold tabular-nums ${mobilePnlColor(value.pnl)}`}>P&amp;L {group ? 'skupiny' : `při ${label}`} {mobileMoney(value.pnl)}</div>
  </div>
);
export default function LivePositionOverview({ position, group = false, status }: { position: MobilePosition; group?: boolean; status?: React.ReactNode }) {
  return <section className="rounded-xl border border-[var(--border-subtle)] p-3" aria-label={group ? 'Pozice skupiny' : 'Otevřená pozice'}>
    <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5">
      <b className={`text-xs ${position.quantity > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{position.quantity > 0 ? 'LONG' : 'SHORT'} · {number.format(Math.abs(position.quantity))} {futuresSymbolRoot(position.symbol)}{group ? ' celkem' : ''}</b>
      <b className={`text-xl font-black tabular-nums ${mobilePnlColor(position.openPnl)}`}>{mobileMoney(position.openPnl)}</b>
    </div>
    <div className="my-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
      <span>Vstup <b className="ml-1 text-[var(--text-primary)]">{position.entry == null ? '—' : number.format(position.entry)}</b></span>
      <span title="Cena odvozená z otevřeného P&L, nejde o samostatnou kotaci">≈ Cena <b className="ml-1 text-[var(--text-primary)]">{position.mark == null ? '—' : number.format(position.mark)}</b></span>
    </div>
    {status ? <div className="mb-2 flex flex-wrap">{status}</div> : null}
    <div className="grid grid-cols-2 gap-2"><Level label="SL" value={position.stop} group={group} verified={position.ordersVerified} /><Level label="TP" value={position.target} group={group} verified={position.ordersVerified} /></div>
    <p className="mt-1.5 text-center text-[9px] text-[var(--text-muted)]">P&amp;L od vstupu, před poplatky{!position.stop.exact || !position.target.exact ? ' · neúplné krytí v detailu účtu' : ''}</p>
  </section>;
}
