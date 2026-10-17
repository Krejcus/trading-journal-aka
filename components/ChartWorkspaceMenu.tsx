import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FolderOpen, History, RotateCcw, Save, Upload } from 'lucide-react';
import { useKeepInViewport } from '../hooks/useKeepInViewport';

/**
 * Menu „Workspace“ v horní liště fullscreen grafu — jako u TradingView je
 * správa rozložení v jednom menu místo šesti tlačítek, aby se lišta vešla.
 */
export default function ChartWorkspaceMenu({ isDark, buttonClassName, onSave, onLoad, onReset, onExport, onImport, onRecover }: {
  isDark: boolean;
  buttonClassName: string;
  onSave: () => void;
  onLoad: () => void;
  onReset: () => void;
  onExport: () => void;
  onImport: () => void;
  onRecover: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popupRef, open);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const item = `flex h-9 w-full items-center gap-2.5 px-3 text-left text-[11px] font-bold transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`;
  const hint = 'ml-auto text-[10px] font-medium text-slate-500';
  const divider = `my-1 h-px ${isDark ? 'bg-white/10' : 'bg-slate-100'}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`${buttonClassName} ${open ? (isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950') : ''}`}
        onClick={() => setOpen(current => !current)}
        title="Workspace — uložit, načíst, export a import rozložení"
        aria-label="Menu workspace"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderOpen size={14} />
        <span className="hidden lg:inline">Workspace</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          ref={popupRef}
          role="menu"
          data-toolbar-popup
          data-chart-overlay-menu
          className={`absolute right-0 top-9 z-[600] w-[250px] overflow-hidden rounded-lg border py-1 shadow-2xl ${isDark ? 'border-white/10 bg-[#1e222d] text-slate-200' : 'border-slate-200 bg-white text-slate-800'}`}
        >
          <button type="button" role="menuitem" className={item} onClick={run(onSave)}><Save size={14} /> Uložit rozložení</button>
          <button type="button" role="menuitem" className={item} onClick={run(onLoad)}><FolderOpen size={14} /> Načíst uložené</button>
          <button type="button" role="menuitem" className={item} onClick={run(onReset)}><RotateCcw size={14} /> Obnovit výchozí</button>
          <div className={divider} />
          <button type="button" role="menuitem" className={item} onClick={run(onExport)}><Download size={14} /> Exportovat<span className={hint}>soubor .json</span></button>
          <button type="button" role="menuitem" className={item} onClick={run(onImport)}><Upload size={14} /> Importovat<span className={hint}>soubor .json</span></button>
          <div className={divider} />
          <button type="button" role="menuitem" className={item} onClick={run(onRecover)} title="Vrátit workspace před posledním načtením nebo importem">
            <History size={14} /> Předchozí workspace
          </button>
        </div>
      )}
    </div>
  );
}
