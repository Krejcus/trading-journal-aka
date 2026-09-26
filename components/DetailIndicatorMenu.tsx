import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, SlidersHorizontal } from 'lucide-react';
import type { DetailIndicatorToggles } from '../services/chartIndicatorSettings';

const ITEMS: Array<{ id: keyof DetailIndicatorToggles; label: string; hint: string; history?: boolean }> = [
  { id: 'levels', label: 'Levely', hint: 'PDH, PDL, PWH, PWL, seance', history: true },
  { id: 'vwap', label: 'VWAP', hint: 'VWAP, pásma, předchozí VWAP', history: true },
  { id: 'fvg', label: 'FVG', hint: 'Fair Value Gaps' },
  { id: 'structure', label: 'Struktura', hint: 'BOS / CHoCH' },
];

/**
 * Jedno tlačítko v liště detailu: co se zapne, platí pro všechny obchody.
 * Styly (barvy, tloušťky) se berou z backtestu — tady se jen zapíná.
 */
export default function DetailIndicatorMenu({ isDark, value, onChange, historyLoading, className }: {
  isDark: boolean;
  value: DetailIndicatorToggles;
  onChange: (next: DetailIndicatorToggles) => void;
  /** Levely a VWAP čekají na dotažení starší historie. */
  historyLoading: boolean;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const active = ITEMS.filter(item => value[item.id]).length;

  return (
    <span ref={rootRef} className="relative">
      <button type="button" className={`${className} ${open || active ? (isDark ? 'text-white' : 'text-slate-950') : ''}`}
        onClick={() => setOpen(current => !current)} aria-expanded={open} title="Indikátory v grafu — platí pro všechny obchody">
        <SlidersHorizontal size={13} /> <span className="hidden sm:inline">Indikátory</span>
        {active > 0 && <span className={`rounded px-1 text-[9.5px] tabular-nums ${isDark ? 'bg-white/10' : 'bg-slate-100'}`}>{active}</span>}
      </button>
      {open && (
        <div className={`absolute right-0 top-9 z-[60] w-[230px] overflow-hidden rounded-lg border py-1 shadow-2xl ${isDark ? 'border-white/10 bg-[#101720] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}
          role="menu" aria-label="Indikátory v grafu">
          {ITEMS.map(item => {
            const checked = value[item.id];
            return (
              <button key={item.id} type="button" role="menuitemcheckbox" aria-checked={checked}
                onClick={() => onChange({ ...value, [item.id]: !checked })}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked
                  ? 'border-emerald-500 bg-emerald-500 text-white' : isDark ? 'border-white/20' : 'border-slate-300'}`}>
                  {checked && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-bold">{item.label}</span>
                  <span className="block truncate text-[10px] font-medium text-slate-500">{item.hint}</span>
                </span>
                {checked && item.history && historyLoading && <Loader2 size={12} className="animate-spin text-slate-500" aria-label="Načítám historii" />}
              </button>
            );
          })}
          <p className={`mx-3 mt-1 border-t pt-2 pb-1 text-[10px] leading-snug text-slate-500 ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
            Platí pro všechny obchody. Barvy a styly se nastavují v backtestu.
          </p>
        </div>
      )}
    </span>
  );
}
