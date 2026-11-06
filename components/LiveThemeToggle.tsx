import React, { useEffect, useRef, useState } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import {
  LIVE_SCREEN_THEME_OPTIONS,
  setLiveScreenThemePreference,
  type LiveScreenThemePreference,
} from '../services/liveScreenTheme';

/** Přepínač motivu obrazovky LIVE v horní liště grafu (nezávislý na aplikaci). */
const LiveThemeToggle: React.FC<{
  isDark: boolean;
  preference: LiveScreenThemePreference;
}> = ({ isDark, preference }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const Icon = isDark ? Moon : Sun;
  const title = `Motiv LIVE: ${LIVE_SCREEN_THEME_OPTIONS.find(option => option.id === preference)?.title ?? 'Podle aplikace'}`;
  return <div ref={rootRef} className="relative z-[80] shrink-0">
    <button
      type="button"
      onClick={() => setOpen(value => !value)}
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      className={`relative grid h-8 w-8 place-items-center rounded-md ${isDark ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}
    >
      <Icon size={15} />
      {preference !== 'app' && <i className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />}
    </button>
    {open && <div
      role="menu"
      aria-label="Motiv LIVE"
      className={`absolute right-0 top-9 w-[200px] overflow-hidden rounded-xl border py-1 shadow-2xl ${isDark ? 'bg-[#111821] border-white/10' : 'bg-white border-slate-200'}`}
    >
      <div className={`px-3 pb-1 pt-1.5 text-[9px] font-black uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Motiv LIVE</div>
      {LIVE_SCREEN_THEME_OPTIONS.map(option => <button
        key={option.id}
        type="button"
        role="menuitemradio"
        aria-checked={preference === option.id}
        onClick={() => { setLiveScreenThemePreference(option.id); setOpen(false); }}
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-bold ${isDark ? 'text-slate-200 hover:bg-white/5' : 'text-slate-700 hover:bg-slate-50'}`}
      >
        {option.title}
        {preference === option.id && <Check size={13} className="text-blue-500" />}
      </button>)}
      <div className={`border-t px-3 py-2 text-[9.5px] font-semibold leading-snug ${isDark ? 'border-white/10 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
        Platí pro celou obrazovku LIVE, motiv aplikace se nemění.
      </div>
    </div>}
  </div>;
};

export default LiveThemeToggle;
