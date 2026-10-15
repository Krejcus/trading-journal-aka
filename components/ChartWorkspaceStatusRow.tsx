import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { wallClockToUnix, zonedClockParts } from '../services/replayGoTo';

/**
 * Spodní řádek pod grafy jako v TradingView: rychlé rozsahy vlevo, „Go to“
 * datum a hodiny v pásmu grafu vpravo. Rozsahy jsou vnitrodenní — graf obchodu
 * má načtené jedno denní okno dat, delší rozsahy (5D, 1M…) by nic neukázaly.
 */

export interface ChartWorkspaceRange {
  id: string;
  label: string;
  /** Délka okna v sekundách od poslední svíčky; null = všechna načtená data. */
  seconds: number | null;
}

export const CHART_WORKSPACE_RANGES: readonly ChartWorkspaceRange[] = [
  { id: '30m', label: '30m', seconds: 30 * 60 },
  { id: '1h', label: '1H', seconds: 60 * 60 },
  { id: '4h', label: '4H', seconds: 4 * 60 * 60 },
  { id: 'all', label: 'Vše', seconds: null },
];

const pad = (value: number) => String(value).padStart(2, '0');

const ZonedClock: React.FC<{ timeZone: string }> = ({ timeZone }) => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const parts = zonedClockParts(now, timeZone);
  return <span className="tabular-nums">{pad(parts.hour)}:{pad(parts.minute)}:{pad(parts.second)}</span>;
};

export const ChartWorkspaceStatusRow: React.FC<{
  onRange: (range: ChartWorkspaceRange) => void;
  onGoToTime: (unixSeconds: number) => void;
  /** Čas, kterým se předvyplní „Go to“ (poslední svíčka aktivního grafu). */
  defaultGoToTime: () => number | null;
  timeZone: string;
  timeZoneLabel: string;
  isDark: boolean;
}> = ({ onRange, onGoToTime, defaultGoToTime, timeZone, timeZoneLabel, isDark }) => {
  const [goToOpen, setGoToOpen] = useState(false);
  const [goToValue, setGoToValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!goToOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setGoToOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setGoToOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [goToOpen]);

  const openGoTo = () => {
    const seed = defaultGoToTime() ?? Math.floor(Date.now() / 1_000);
    const parts = zonedClockParts(seed, timeZone);
    setGoToValue(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`);
    setGoToOpen(true);
  };
  const parsed = (() => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(goToValue);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    const unix = wallClockToUnix(year, month, day, hour, minute, timeZone);
    return Number.isFinite(unix) ? unix : null;
  })();

  const button = `h-6 rounded px-2 text-[10px] font-bold ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`;
  const divider = `mx-1 h-4 w-px ${isDark ? 'bg-white/10' : 'bg-slate-200'}`;

  return (
    <div
      ref={rootRef}
      data-snapshot-hide
      className={`flex h-7 items-center gap-0.5 border-t px-1.5 ${isDark ? 'border-white/10 bg-[#0b1017] text-slate-400' : 'border-slate-200 bg-white text-slate-500'}`}
      role="toolbar"
      aria-label="Rozsah a čas grafu"
    >
      {CHART_WORKSPACE_RANGES.map(range => (
        <button
          key={range.id}
          type="button"
          className={button}
          onClick={() => onRange(range)}
          title={range.seconds === null ? 'Zobrazit všechna načtená data' : `Zobrazit posledních ${range.label}`}
        >{range.label}</button>
      ))}
      <span className={divider} />
      <div className="relative">
        <button
          type="button"
          className={`${button} grid w-7 place-items-center px-0`}
          onClick={() => (goToOpen ? setGoToOpen(false) : openGoTo())}
          title="Přejít na datum a čas"
          aria-label="Přejít na datum a čas"
          aria-expanded={goToOpen}
        ><CalendarClock size={13} /></button>
        {goToOpen && (
          <form
            className={`absolute bottom-8 left-0 z-[700] flex w-[230px] flex-col gap-2 rounded-lg border p-3 shadow-2xl ${isDark ? 'border-white/10 bg-[#1e222d] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}
            onSubmit={event => {
              event.preventDefault();
              if (parsed === null) return;
              onGoToTime(parsed);
              setGoToOpen(false);
            }}
          >
            <span className="text-[9px] font-black uppercase tracking-[0.13em] text-slate-500">Přejít na</span>
            <input
              type="datetime-local"
              value={goToValue}
              onChange={event => setGoToValue(event.target.value)}
              className={`h-8 rounded-md border px-2 text-[11px] font-semibold outline-none ${isDark ? 'border-white/10 bg-white/5 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
              aria-label={`Datum a čas (${timeZoneLabel})`}
              autoFocus
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-medium text-slate-500">Pásmo grafu: {timeZoneLabel}</span>
              <button
                type="submit"
                disabled={parsed === null}
                className="h-7 rounded-md bg-[#2962ff] px-3 text-[10px] font-bold text-white disabled:opacity-40"
              >Přejít</button>
            </div>
          </form>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2 pr-1 text-[10px] font-semibold">
        <ZonedClock timeZone={timeZone} />
        <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{timeZoneLabel}</span>
      </div>
    </div>
  );
};

export default ChartWorkspaceStatusRow;
