import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronUp, Flag, MousePointerClick, Shuffle } from 'lucide-react';
import type { ReplayStartPreset } from '../services/chartReplay';
import { wallClockToUnix, zonedClockParts } from '../services/replayGoTo';

/**
 * Rozbalovací menu Bar Replay panelu ve stylu TradingView: výběr startu
 * (svíčka / datum / první dostupná / náhodná) a volby s popiskem (rychlost,
 * interval kroku). Panel jde přetáhnout kamkoli, proto se menu otevírá nahoru
 * jen tehdy, když se nad panel vejde — u panelu nahoře padá dolů.
 */

const menuSurface = (isDark: boolean) => isDark
  ? 'bg-[#1e222d] border-white/10 text-slate-200'
  : 'bg-white border-slate-200 text-slate-800';
const rowHover = (isDark: boolean) => isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50';

/** Zavření kliknutím mimo a Esc; vrací, jestli se menu vejde nad tlačítko. */
const useReplayMenu = (open: boolean, setOpen: (open: boolean) => void) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [openUp, setOpenUp] = useState(true);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Esc zavře jen menu, ne fullscreen graf pod ním.
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open, setOpen]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current?.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    if (root) setOpenUp(root.top - menuHeight - 8 >= 0);
  }, [open]);

  return { rootRef, menuRef, openUp };
};

const menuPosition = (openUp: boolean) => openUp ? 'bottom-10' : 'top-10';

export interface ReplayChoiceOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
}

export const ReplayChoiceMenu = <T extends string | number>({
  value,
  options,
  heading,
  onChange,
  isDark,
  buttonClassName,
  ariaLabel,
  title,
}: {
  value: T;
  options: readonly ReplayChoiceOption<T>[];
  heading: string;
  onChange: (value: T) => void;
  isDark: boolean;
  buttonClassName: string;
  ariaLabel: string;
  title: string;
}) => {
  const [open, setOpen] = useState(false);
  const { rootRef, menuRef, openUp } = useReplayMenu(open, setOpen);
  const current = options.find(option => option.value === value);

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        className={`${buttonClassName} px-2 ${open ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
        onClick={() => setOpen(!open)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
      >
        <span className="text-[10px] font-bold tabular-nums">{current?.label ?? String(value)}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={heading}
          className={`absolute ${menuPosition(openUp)} left-1/2 z-[700] w-[200px] -translate-x-1/2 overflow-hidden rounded-lg border py-1 shadow-2xl ${menuSurface(isDark)}`}
        >
          <div className="px-3 pb-1 pt-1.5 text-[9px] font-black uppercase tracking-[0.13em] text-slate-500">{heading}</div>
          {options.map(option => {
            const selected = option.value === value;
            return (
              <button
                key={String(option.value)}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => { onChange(option.value); setOpen(false); }}
                className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] font-bold ${selected ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : rowHover(isDark)}`}
              >
                <span className="w-3 shrink-0">{selected && <Check size={12} />}</span>
                <span className="tabular-nums">{option.label}</span>
                {option.description && (
                  <span className="ml-auto text-[10px] font-medium text-slate-500">{option.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** `datetime-local` hodnota pro čas v pásmu grafu (ne v pásmu prohlížeče). */
const zonedDateTimeLocalValue = (unixSeconds: number, timeZone: string): string => {
  const parts = zonedClockParts(unixSeconds, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
};

const parseZonedDateTimeLocal = (value: string, timeZone: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const unix = wallClockToUnix(year, month, day, hour, minute, timeZone);
  return Number.isFinite(unix) ? unix : null;
};

export const ReplayStartMenu: React.FC<{
  /** Zpět do výběru svíčky nůžkami. */
  onSelectBar: () => void;
  onSelectDate: (unixSeconds: number) => void;
  onSelectPreset: (preset: ReplayStartPreset) => void;
  /** Backtest hlídá zpracované obchody — tam jde start vybrat jen svíčkou. */
  allowJumps: boolean;
  /** V režimu výběru svítí tlačítko jako aktivní, stejně jako v TradingView. */
  selecting: boolean;
  cursorTime: number | null;
  timeZone: string;
  timeZoneLabel: string;
  isDark: boolean;
  buttonClassName: string;
}> = ({ onSelectBar, onSelectDate, onSelectPreset, allowJumps, selecting, cursorTime, timeZone, timeZoneLabel, isDark, buttonClassName }) => {
  const [open, setOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const { rootRef, menuRef, openUp } = useReplayMenu(open, setOpen);
  const parsedDate = parseZonedDateTimeLocal(dateValue, timeZone);

  const close = () => { setOpen(false); setDateOpen(false); };
  const openDate = () => {
    // Výchozí datum je den zpátky od kurzoru — typicky „zopakuj si včerejšek“.
    const seed = (cursorTime ?? Math.floor(Date.now() / 1_000)) - 86_400;
    setDateValue(zonedDateTimeLocalValue(seed, timeZone));
    setDateOpen(true);
  };
  const submitDate = () => {
    if (parsedDate === null) return;
    onSelectDate(parsedDate);
    close();
  };
  const row = `flex h-9 w-full items-center gap-2.5 px-3 text-left text-[11px] font-bold disabled:opacity-40 ${rowHover(isDark)}`;
  const inputStyle = isDark ? 'bg-white/5 border-white/10 text-slate-100' : 'bg-white border-slate-200 text-slate-900';

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        className={`${buttonClassName} gap-1 px-2 ${selecting || open ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="Vybrat start replaye"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Vybrat start replaye — svíčka, datum, první dostupná nebo náhodná"
      >
        <CalendarDays size={14} />
        <span className="hidden whitespace-nowrap text-[10px] font-bold sm:inline">Start</span>
        {open && !openUp ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Start replaye"
          className={`absolute ${menuPosition(openUp)} left-0 z-[700] w-[240px] overflow-hidden rounded-lg border py-1 shadow-2xl ${menuSurface(isDark)}`}
        >
          <button type="button" role="menuitem" className={row} onClick={() => { close(); onSelectBar(); }}>
            <MousePointerClick size={14} /> Vybrat svíčku v grafu
          </button>
          {allowJumps && (
            <>
              <button type="button" role="menuitem" className={row} onClick={openDate} aria-expanded={dateOpen}>
                <CalendarDays size={14} /> Datum…
              </button>
              {dateOpen && (
                <form
                  className="flex flex-col gap-2 px-3 pb-2 pt-1"
                  onSubmit={event => { event.preventDefault(); submitDate(); }}
                >
                  <input
                    type="datetime-local"
                    value={dateValue}
                    onChange={event => setDateValue(event.target.value)}
                    className={`h-8 rounded-md border px-2 text-[11px] font-semibold outline-none ${inputStyle}`}
                    aria-label={`Datum a čas startu (${timeZoneLabel})`}
                    autoFocus
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-medium text-slate-500">Pásmo grafu: {timeZoneLabel}</span>
                    <button
                      type="submit"
                      disabled={parsedDate === null}
                      className="h-7 rounded-md bg-[#2962ff] px-3 text-[10px] font-bold text-white disabled:opacity-40"
                    >Spustit</button>
                  </div>
                </form>
              )}
              <button type="button" role="menuitem" className={row} onClick={() => { close(); onSelectPreset('first'); }}>
                <Flag size={14} /> První dostupná svíčka
              </button>
              <button type="button" role="menuitem" className={row} onClick={() => { close(); onSelectPreset('random'); }}>
                <Shuffle size={14} /> Náhodná svíčka
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
