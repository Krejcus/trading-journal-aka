import React, { useRef } from 'react';
import { AlertCircle, Check, ClipboardPaste, ImageOff, Loader2 } from 'lucide-react';
import type { Trade } from '../types';
import { isCombinedTrade } from '../lib/tradeHistoryPresentation';

export type ScreenshotAttachStatus =
  | { status: 'uploading' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * Snímek přidaný rovnou z karty Historie. Nový snímek jde dopředu, dřívější
 * zůstávají. `needsReview` se záměrně nemění: vložený obrázek není reflexe,
 * takže obchod má dál svítit jako „nezkontrolovaný“, dokud ji uživatel neuloží.
 */
export function withAttachedScreenshot(trade: Trade, url: string): Trade {
  const rest = (trade.screenshots ?? []).filter(shot => shot && shot !== url);
  return { ...trade, screenshot: url, screenshots: [url, ...rest] };
}

/**
 * Obchody, ke kterým se snímek uloží. Sloučená karta je jeden obchod na víc
 * účtech — stejný vstup, stejný graf — takže snímek patří všem jejím řádkům.
 */
export function shotTargetIds(trade: Trade): string[] {
  return isCombinedTrade(trade) ? (trade.combinedTradeIds ?? []).map(String) : [String(trade.id)];
}

/** První obrázek ze schránky — text nebo soubory jiného typu se ignorují. */
export function clipboardImage(data: DataTransfer | null | undefined): File | null {
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

/** Vložení nesmí přebít psaní do pole — tam patří text, ne snímek na kartu. */
export function pasteTargetsEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== 'function') return false;
  return element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') != null;
}

const pasteKey = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl V';

/**
 * Prázdná pravá půlka karty v Historii. Šrafa říká „tady snímek není“ i bez
 * čtení — vedle skutečných grafů se nedá splést s obrázkem, který se jen
 * nenačetl. Vložit jde ⌘V při najetí na kartu, nebo výběrem souboru.
 */
export const HistoryScreenshotSlot: React.FC<{
  light: boolean;
  canAttach: boolean;
  state: ScreenshotAttachStatus | null;
  onPickFile: (file: File) => void;
  /** `detail` = velká plocha v detailu obchodu: bez levé linky, větší písmo. */
  variant?: 'card' | 'detail';
}> = ({ light, canAttach, state, onPickFile, variant = 'card' }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const stripe = light ? 'rgba(15, 23, 42, 0.045)' : 'rgba(255, 255, 255, 0.035)';
  const detail = variant === 'detail';
  const text = detail ? 'text-[12.5px]' : 'text-[10.5px]';

  return (
    <div
      className={`w-full h-full flex flex-col items-center justify-center p-4 ${detail ? 'gap-3.5' : `gap-2.5 border-l ${light ? 'border-slate-100' : 'border-[var(--border-subtle)]'}`}`}
      style={{ backgroundImage: `repeating-linear-gradient(135deg, ${stripe} 0 10px, transparent 10px 20px)` }}
    >
      <span className={`inline-flex items-center gap-2 rounded-full border ${detail ? 'px-4 py-2' : 'px-3 py-1.5'} ${text} font-extrabold whitespace-nowrap shadow-[0_6px_16px_-10px_rgba(15,23,42,0.35)] ${
        light ? 'bg-white border-slate-200 text-slate-600' : 'bg-[var(--bg-card)] border-white/10 text-slate-300'
      }`}>
        <ImageOff size={detail ? 16 : 13} className={light ? 'text-slate-400' : 'text-slate-500'} /> Bez screenshotu
      </span>

      {canAttach ? (
        state?.status === 'uploading' ? (
          <span className={`inline-flex items-center gap-1.5 ${text} font-extrabold text-indigo-500`}>
            <Loader2 size={12} className="animate-spin" /> Ukládám snímek…
          </span>
        ) : state?.status === 'saved' ? (
          <span className={`inline-flex items-center gap-1.5 ${text} font-extrabold text-emerald-500`}>
            <Check size={12} /> Snímek uložen
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={event => { event.stopPropagation(); inputRef.current?.click(); }}
              className={`inline-flex items-center gap-1.5 ${text} font-extrabold text-slate-400 opacity-80 transition hover:underline ${
                detail ? 'hover:opacity-100 hover:text-indigo-500' : 'group-hover:opacity-100 group-hover:text-indigo-500'}`}
              title={detail ? 'Vlož snímek ze schránky, nebo vyber soubor' : 'Najeď na kartu a vlož snímek ze schránky, nebo vyber soubor'}
            >
              <ClipboardPaste size={12} /> Vložit
              <kbd className={`hidden [@media(hover:hover)]:inline rounded border px-1 font-mono text-[9.5px] ${light ? 'border-slate-200 bg-white' : 'border-white/10 bg-white/5'}`}>{pasteKey()}</kbd>
              · nahrát
            </button>
            {state?.status === 'error' ? (
              <span className="inline-flex max-w-[26ch] items-center gap-1 text-center text-[10px] font-bold text-rose-500">
                <AlertCircle size={11} className="flex-none" /> {state.message}
              </span>
            ) : null}
          </>
        )
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onClick={event => event.stopPropagation()}
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPickFile(file);
        }}
      />
    </div>
  );
};
