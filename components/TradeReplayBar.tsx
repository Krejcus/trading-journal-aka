import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, GripVertical, Pause, Play, StepForward } from 'lucide-react';

export type TradeReplaySpeed = 1 | 2 | 4;
export interface TradeReplayGoTo { id: string; label: string; hint: string }

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
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const topButton = `h-8 inline-flex items-center gap-1.5 px-2 rounded-md text-[9px] font-bold transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`;
  const select = `h-8 rounded-md border-0 px-2 text-[10px] font-bold outline-none ${isDark ? 'bg-transparent text-slate-300 hover:bg-white/5' : 'bg-transparent text-slate-700 hover:bg-slate-100'}`;

  return (
    <div
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
      <span ref={menuRef} className="relative">
        <button type="button" className={`${topButton} gap-1 px-2`} onClick={() => setMenu(value => !value)} aria-expanded={menu} title="Skočit na událost obchodu">
          <ChevronRight size={14} />
          <span className="whitespace-nowrap text-[10px] font-bold">Go To</span>
        </button>
        {menu && (
          <div className={`absolute bottom-10 left-0 z-[700] w-[210px] overflow-hidden rounded-lg border py-1 shadow-2xl ${isDark ? 'border-white/10 bg-[#101720] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}>
            {goTo.map(target => (
              <button key={target.id} type="button" onClick={() => { setMenu(false); onGoTo(target.id); }}
                className={`flex h-9 w-full items-center justify-between gap-3 px-3 text-left text-[11px] font-bold ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}>
                <span>{target.label}</span>
                <span className="text-[10px] font-medium tabular-nums text-slate-500">{target.hint}</span>
              </button>
            ))}
          </div>
        )}
      </span>
      <select value={speed} onChange={event => onSpeed(Number(event.target.value) as TradeReplaySpeed)} className={select} aria-label="Rychlost přehrávání" title="Rychlost přehrávání">
        {([1, 2, 4] as const).map(value => <option key={value} value={value}>{value}x</option>)}
      </select>
    </div>
  );
}
