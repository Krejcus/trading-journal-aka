import React, { useSyncExternalStore } from 'react';
import { LiveOpenPnlValue, LiveTvMark, TV_LIVE_PNL_TITLE } from '../LiveOpenPnlValue';
import { tradeCardTvLegs } from '../../lib/tvLivePnl';
import type { JournalLiveTarget, JournalLiveView } from '../../lib/journalLivePosition';
import type { JournalLivePositionStore } from '../../lib/journalLivePositionStore';
import { formatReadAge } from '../../lib/liveReadFreshness';

/**
 * Štítek živé pozice v grafu deníku dneška — jen zobrazení. Data plní
 * `DayLivePositionRunner`; štítek jen čte úložiště a mění výběr účtu.
 * Neověřený nebo neúplný stav řekne slovy a nic nekreslí (INV-UI-01/03).
 * Jediné místo deníku s cenou z TradingView (`LiveOpenPnlValue`, INV-UI-04).
 */

const wholeUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const priceFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pointsFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const signedUsd = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${wholeUsd.format(Math.abs(value))}`;
const usdTone = (value: number) => (value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-[var(--text-secondary)]');
const signedPoints = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${pointsFmt.format(Math.abs(value))} b`;
const orderTypeLabel = (type: string | null) => {
  const key = (type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key === 'limit' ? 'Limit' : key === 'stop' ? 'Stop' : key === 'stoplimit' ? 'Stop Limit' : (type ?? '');
};
const parseTarget = (value: string): JournalLiveTarget => (value === 'group' ? 'group' : Number(value));

export default function DayLivePositionChip({ store, compact = false }: { store: JournalLivePositionStore; compact?: boolean }) {
  const view = useSyncExternalStore(store.subscribe, store.getView, store.getView);
  const model = view.model;
  if (view.options.length === 0) return null;
  // Bez pozice a bez čekajícího vstupu není co ukázat (výběr účtu taky ne).
  if (view.verified && !model) return null;
  const issueText = issueLabel(view);

  const shell = `pointer-events-auto absolute z-30 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-[var(--glass-border,var(--border-subtle))] px-2.5 py-1.5 text-[12px] shadow-lg ${compact ? 'left-2 bottom-8' : 'left-3 bottom-9'}`;
  const fill: React.CSSProperties = { background: 'var(--menu-bg, var(--bg-card))' };

  if (issueText || !model) {
    return (
      <div className={shell} style={fill} role="status" data-live-position={view.issue ?? 'unknown'}>
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" aria-hidden />
        <span className="font-semibold text-[var(--text-secondary)]">{issueText ?? 'Pozice neověřené'}</span>
        {view.options.length > 2 && <TargetSelect view={view} store={store} />}
      </div>
    );
  }

  const long = model.direction === 1;
  const stopPoints = model.ladder.stop != null && model.entry != null ? (model.ladder.stop - model.entry) * model.direction : null;
  const targetPoints = model.ladder.target != null && model.entry != null ? (model.ladder.target - model.entry) * model.direction : null;
  return (
    <div className={shell} style={fill} role="status" data-live-position={model.kind}>
      <span className={`inline-flex items-center gap-1.5 font-bold ${long ? 'text-blue-400' : 'text-amber-400'}`}>
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
        {model.kind === 'position'
          ? `${long ? 'Long' : 'Short'} ${model.quantity}`
          : `${long ? 'Buy' : 'Sell'} ${orderTypeLabel(model.entryType)} ${model.quantity}`}
      </span>
      <span className="tabular-nums text-[var(--text-secondary)]">
        {model.symbol}{model.entry != null ? ` @ ${priceFmt.format(model.entry)}` : ''}
        {view.scopeLabel ? ` · ${view.scopeLabel}` : ''}
      </span>
      {model.kind === 'position' ? (
        model.openPnl != null ? (
          <LiveOpenPnlValue anchor={model.openPnl} legs={tradeCardTvLegs(model)}>
            {(value, live) => (
              <span className={`inline-flex items-center gap-1 font-mono text-[13px] font-bold tabular-nums ${usdTone(value)}`} title={live ? TV_LIVE_PNL_TITLE : undefined}>
                {signedUsd(value)}{live ? <LiveTvMark /> : null}
              </span>
            )}
          </LiveOpenPnlValue>
        ) : <span className="font-mono text-[var(--text-muted)]">P&L —</span>
      ) : (
        <span className="text-[var(--text-muted)]">čeká na fill</span>
      )}
      {!model.verified && <span className="text-[var(--text-muted)]">SL/TP neověřeno</span>}
      {view.copierOff && <span className="text-[var(--text-muted)]">kopírka vypnutá</span>}
      {(stopPoints != null || targetPoints != null) && (
        <span className="tabular-nums">
          {stopPoints != null && <span className="text-rose-400">SL {signedPoints(stopPoints)}</span>}
          {stopPoints != null && targetPoints != null && <span className="text-[var(--text-muted)]"> · </span>}
          {targetPoints != null && <span className="text-emerald-400">TP {signedPoints(targetPoints)}</span>}
        </span>
      )}
      {view.options.length > 2 && <TargetSelect view={view} store={store} />}
    </div>
  );
}

function issueLabel(view: JournalLiveView): string | null {
  const age = view.readAgeMs != null ? ` · čtení před ${formatReadAge(view.readAgeMs)}` : '';
  switch (view.issue) {
    case 'stale': return `Pozice neověřené${age}`;
    case 'missing-account': return 'Pozice neověřené · účet skupiny chybí v datech';
    case 'orders-stale': return 'Příkazy neověřené';
    case 'settling': return 'Kopie dobíhá…';
    case 'divergent': return view.copierOff ? 'Kopírka vypnutá · účty se liší, vyber účet' : 'Účty skupiny se liší · viz LIVE';
    default: return null;
  }
}

function TargetSelect({ view, store }: { view: JournalLiveView; store: JournalLivePositionStore }) {
  return (
    <select
      aria-label="Účet živé pozice"
      value={String(view.target)}
      onChange={event => store.setTarget(parseTarget(event.target.value))}
      className="h-6 max-w-[160px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-1.5 text-[11.5px] text-[var(--text-primary)] outline-none"
    >
      {view.options.map(option => <option key={String(option.id)} value={String(option.id)}>{option.label}</option>)}
    </select>
  );
}
