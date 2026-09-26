import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, GripVertical, Pause, Play, StepForward } from 'lucide-react';

export type TradeReplaySpeed = 0.5 | 1 | 2 | 4;
export interface TradeReplayGoTo { id: string; label: string; hint: string }

const SPEEDS: TradeReplaySpeed[] = [0.5, 1, 2, 4];
const speedLabel = (speed: TradeReplaySpeed) => `${String(speed).replace('.', ',')}x`;

/**
 * Přehrávání obchodu v detailu. Vzhled 1:1 s Bar Replay panelem ve fullscreenu
 * a backtestu (AlphaTradeChartWorkspace) — jen Go To skáče na události obchodu
 * a krok je vždy jedna svíčka, protože graf v detailu má jeden timeframe.
 */
export default function TradeReplayBar({ isDark, playing, atEnd, speed, goTo, onPlayPause, onStep, onSpeed, onGoTo }: {
  isDark: boolean;
  playing: boolean;
  atEnd: boolean;
  speed: TradeReplaySpeed;
  goTo: readonly TradeReplayGoTo[];
  onPlayPause: () => void;
  onStep: () => void;
  onSpeed: (speed: TradeReplaySpeed) => void;
  onGoTo: (id: string) => void;
}) {
  // Otevřené je vždy nejvýš jedno menu; klik mimo lištu ho zavře.
  const [menu, setMenu] = useState<'goto' | 'speed' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!barRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [menu]);
  const toggle = (id: 'goto' | 'speed') => setMenu(current => current === id ? null : id);

  const topButton = `h-8 inline-flex items-center gap-1.5 px-2 rounded-md text-[9px] font-bold transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`;
  const menuPanel = `trade-menu-up absolute bottom-10 z-[700] overflow-hidden rounded-lg border py-1 shadow-2xl ${isDark ? 'border-white/10 bg-[#101720] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`;
  const menuItem = `flex h-9 w-full items-center justify-between gap-3 px-3 text-left text-[11px] font-bold transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`;

  return (
    <div ref={barRef}
      className={`absolute bottom-3 left-1/2 z-30 flex h-10 -translate-x-1/2 items-center gap-0.5 rounded-lg border p-1 shadow-xl backdrop-blur-md ${isDark ? 'border-white/10 bg-[#101720]/95 text-slate-300 shadow-black/40' : 'border-slate-200 bg-white/95 text-slate-700 shadow-slate-900/10'}`}
      role="toolbar"
      aria-label="Přehrávání obchodu"
    >
      <span className={`flex h-8 w-5 shrink-0 items-center justify-center rounded ${isDark ? 'text-slate-600' : 'text-slate-300'}`} aria-hidden="true"><GripVertical size={14} /></span>
      <button type="button" className={`${topButton} px-2`} onClick={onPlayPause}
        title={playing ? 'Pozastavit' : atEnd ? 'Přehrát obchod od začátku' : 'Přehrát'} aria-label={playing ? 'Pozastavit přehrávání' : 'Přehrát obchod'}>
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <button type="button" className={`${topButton} px-2`} onClick={onStep} title="O jednu svíčku dopředu" aria-label="Krok o jednu svíčku">
        <StepForward size={15} />
      </button>
      <span className="relative">
        <button type="button" className={`${topButton} gap-1 px-2`} onClick={() => toggle('goto')} aria-expanded={menu === 'goto'} title="Skočit na událost obchodu">
          <ChevronRight size={14} className={`transition-transform duration-200 ${menu === 'goto' ? '-rotate-90' : ''}`} />
          <span className="whitespace-nowrap text-[10px] font-bold">Go To</span>
        </button>
        {menu === 'goto' && (
          <div className={`${menuPanel} left-0 w-[210px]`} role="menu">
            {goTo.map(target => (
              <button key={target.id} type="button" role="menuitem" onClick={() => { setMenu(null); onGoTo(target.id); }} className={menuItem}>
                <span>{target.label}</span>
                <span className="text-[10px] font-medium tabular-nums text-slate-500">{target.hint}</span>
              </button>
            ))}
          </div>
        )}
      </span>
      <span className="relative">
        <button type="button" className={`${topButton} gap-1 px-2 text-[10px]`} onClick={() => toggle('speed')}
          aria-expanded={menu === 'speed'} aria-label="Rychlost přehrávání" title="Rychlost přehrávání">
          <span className="tabular-nums">{speedLabel(speed)}</span>
          <ChevronDown size={13} className={`transition-transform duration-200 ${menu === 'speed' ? 'rotate-180' : ''}`} />
        </button>
        {menu === 'speed' && (
          <div className={`${menuPanel} right-0 w-[112px]`} role="menu" aria-label="Rychlost přehrávání">
            {SPEEDS.map(value => (
              <button key={value} type="button" role="menuitemradio" aria-checked={value === speed}
                onClick={() => { setMenu(null); onSpeed(value); }} className={menuItem}>
                <span className="tabular-nums">{speedLabel(value)}</span>
                {value === speed && <Check size={13} strokeWidth={3} className="text-emerald-500" />}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
