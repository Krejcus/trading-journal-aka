import React from 'react';
import { Power, RefreshCw } from 'lucide-react';
import { useCopierPowerDisplay } from '../hooks/useCopierPowerDisplay';

export const CopierConnectionSwitch = ({ connected, statusPending, runtimeReady, transition, connectBlocked, onToggle, powerDisplayKey = '' }: {
  powerDisplayKey?: string;
  connected: boolean;
  statusPending: boolean;
  runtimeReady: boolean;
  transition: 'connecting' | 'disconnecting' | null;
  connectBlocked: boolean;
  onToggle: () => void;
}) => {
  const display = useCopierPowerDisplay(powerDisplayKey, connected, statusPending);
  const displayedConnected = display.connected === true;
  const retaining = statusPending && display.connected != null;
  const busy = transition != null;
  const disabled = statusPending || !runtimeReady || busy || (!connected && connectBlocked);
  const busyLabel = transition === 'connecting' ? 'ZAPÍNÁM…' : 'VYPÍNÁM…';
  const title = statusPending
    ? (display.warning ? 'Stav není aktuální. Spojení se nepodařilo obnovit.' : 'Poslední potvrzený stav. Aktualizace probíhá na pozadí.')
    : !runtimeReady
      ? 'Execution runtime není pro tuto skupinu dostupný.'
      : !connected && connectBlocked
        ? 'Zapnutí blokuje kill switch, denní zámek, cooldown nebo pauza pravidel dne.'
        : connected ? 'Kliknutím bezpečně vypnout copier.' : 'Kliknutím zapnout copier naostro.';

  // No prior confirmation: never invent OFF. Retention only changes presentation.
  if (statusPending && display.connected == null) {
    return (
      <span
        role="status"
        title={title}
        className="flex h-7 w-[108px] items-center justify-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-secondary)]"
      >
        <RefreshCw size={12} className="animate-spin" />
        Neověřeno
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start" data-copier-power-display={retaining ? 'retained' : 'current'}>
    <button
      type="button"
      role="switch"
      aria-checked={displayedConnected}
      aria-label={displayedConnected ? 'Vypnout kopírovací skupinu' : 'Zapnout kopírovací skupinu'}
      title={title}
      disabled={disabled}
      onClick={event => {
        event.stopPropagation();
        if (!disabled) onToggle();
      }}
      className={`group flex h-11 w-[108px] items-center justify-center text-[9px] font-black uppercase tracking-[0.08em] disabled:cursor-not-allowed ${retaining && !display.warning ? '' : 'disabled:opacity-45'}`}
    >
      <span className={`relative flex h-7 w-full items-center justify-center overflow-hidden rounded-md border px-2 transition-all duration-300 ${displayedConnected
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500 group-enabled:group-hover:border-rose-500/40 group-enabled:group-hover:bg-rose-500/10 group-enabled:group-hover:text-rose-500'
        : 'border-rose-500/40 bg-rose-500/10 text-rose-500 group-enabled:group-hover:border-emerald-500/40 group-enabled:group-hover:bg-emerald-500/10 group-enabled:group-hover:text-emerald-500'}`}>
        {busy ? (
          <span className="flex items-center gap-2">
            <RefreshCw size={12} className="animate-spin" />
            {busyLabel}
          </span>
        ) : (
          <>
            <span className={`absolute right-2 h-1.5 w-1.5 rounded-full bg-emerald-500 transition-opacity duration-200 ${displayedConnected ? 'opacity-100 group-enabled:group-hover:opacity-0' : 'opacity-0 group-enabled:group-hover:opacity-100'}`}>
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400" />
            </span>
            <Power size={12} className="absolute left-2.5 transition-transform duration-300 group-enabled:group-hover:rotate-90" />
            <span className="absolute left-7 right-4 overflow-hidden text-center">
              <span className="block transition-all duration-300 ease-in-out group-enabled:group-hover:-translate-y-full group-enabled:group-hover:opacity-0">
                {displayedConnected ? 'ZAPNUTÁ' : 'VYPNUTÁ'}
              </span>
              <span className="absolute inset-0 translate-y-full opacity-0 transition-all duration-300 ease-in-out group-enabled:group-hover:translate-y-0 group-enabled:group-hover:opacity-100">
                {displayedConnected ? 'VYPNOUT' : 'ZAPNOUT'}
              </span>
            </span>
          </>
        )}
      </span>
    </button>
    {display.warning ? <span role="status" className="text-[10px] font-semibold text-amber-600">Stav není aktuální</span> : null}
    </span>
  );
};
