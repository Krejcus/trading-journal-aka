import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Star, X } from 'lucide-react';

const FAVORITES_KEY = 'alphatrade:chart-color-favorites';
const DEFAULT_FAVORITES = ['#00e676', '#d500f9'];

const PALETTE = [
  ['#ffffff', '#e0e3eb', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#161a25', '#000000'],
  ['#f23645', '#ff9800', '#ffcc00', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'],
  ['#fccbcd', '#ffe0b2', '#fff0b2', '#c8e6c9', '#b2dfdb', '#b2ebf2', '#bbdefb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
  ['#faa1a6', '#ffcc80', '#ffe082', '#a5d6a7', '#80cbc4', '#80deea', '#90caf9', '#b39ddb', '#ce93d8', '#f48fb1'],
  ['#f77c84', '#ffb74d', '#ffd54f', '#81c784', '#4db6ac', '#4dd0e1', '#64b5f6', '#9575cd', '#ba68c8', '#f06292'],
  ['#f7525f', '#ffa726', '#ffca28', '#66bb6a', '#26a69a', '#26c6da', '#42a5f5', '#7e57c2', '#ab47bc', '#ec407a'],
  ['#b22833', '#c77700', '#c79f00', '#357a38', '#056656', '#00838f', '#1e53b7', '#4527a0', '#6a1b9a', '#ad1457'],
  ['#801922', '#8f5600', '#8f7200', '#255727', '#03483d', '#005d66', '#153b82', '#311b70', '#4a136d', '#7b0e3e'],
];

const normalizeHex = (value: string): string => {
  const match = value.trim().match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return match ? `#${match[1].toLowerCase()}` : '#2962ff';
};

const readFavorites = (): string[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || 'null');
    if (Array.isArray(parsed)) return parsed.filter(item => typeof item === 'string').map(normalizeHex).slice(0, 8);
  } catch { /* private storage */ }
  return DEFAULT_FAVORITES;
};

export const colorWithAlpha = (color: string, opacity: number): string => {
  const alpha = Math.round(Math.max(0, Math.min(100, opacity)) / 100 * 255).toString(16).padStart(2, '0');
  return `${normalizeHex(color)}${alpha}`;
};

export const splitColorAlpha = (value: string): { color: string; opacity: number } => {
  const normalized = value.trim();
  const match = normalized.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i);
  if (!match) return { color: normalizeHex(value), opacity: 100 };
  return { color: `#${match[1].toLowerCase()}`, opacity: Math.round(Number.parseInt(match[2], 16) / 255 * 100) };
};

interface TradingViewColorPickerProps {
  value: string;
  opacity?: number;
  onChange: (color: string, opacity: number) => void;
  label: string;
  compact?: boolean;
}

const TradingViewColorPicker: React.FC<TradingViewColorPickerProps> = ({ value, opacity, onChange, label, compact = false }) => {
  const parsed = splitColorAlpha(value);
  const color = parsed.color;
  const activeOpacity = opacity ?? parsed.opacity;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const customColorRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => typeof window === 'undefined' ? DEFAULT_FAVORITES : readFavorites());
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = 256;
    const height = 350;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - width + rect.width)),
      top: rect.bottom + height <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || (target instanceof Element && target.closest('[data-tv-color-picker]'))) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);

  const saveFavorites = (next: string[]) => {
    setFavorites(next);
    try { window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* private storage */ }
  };
  const addFavorite = () => {
    const next = [color, ...favorites.filter(item => item !== color)].slice(0, 8);
    saveFavorites(next);
  };

  return <>
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(current => !current)}
      className={`relative cursor-pointer rounded-md border bg-white p-1 ${compact ? 'h-7 w-8' : 'h-9 w-11'} ${open ? 'border-[#2962ff] ring-1 ring-[#2962ff]' : 'border-slate-300 hover:border-slate-400'}`}
    >
      <span className="block h-full w-full rounded-sm" style={{ backgroundColor: colorWithAlpha(color, activeOpacity), backgroundImage: 'linear-gradient(45deg,#d5d7dc 25%,transparent 25%),linear-gradient(-45deg,#d5d7dc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d5d7dc 75%),linear-gradient(-45deg,transparent 75%,#d5d7dc 75%)', backgroundSize: '8px 8px', backgroundPosition: '0 0,0 4px,4px -4px,-4px 0' }}>
        <span className="block h-full w-full rounded-sm" style={{ backgroundColor: colorWithAlpha(color, activeOpacity) }} />
      </span>
    </button>
    {open && createPortal(
      <div
        role="dialog"
        aria-label={`${label} – výběr barvy`}
        data-tv-color-picker="true"
        data-chart-settings-dialog="true"
        onWheelCapture={event => event.stopPropagation()}
        className="fixed z-[700] w-[256px] rounded-md border border-slate-300 bg-white p-2 shadow-2xl"
        style={{ left: position.left, top: position.top }}
      >
        <div className="grid grid-cols-10 gap-1">
          {PALETTE.flat().map((swatch, index) => <button
            key={`${swatch}-${index}`}
            type="button"
            aria-label={`Barva ${swatch}`}
            onClick={() => onChange(swatch, activeOpacity)}
            className={`h-5 w-5 rounded-[3px] border ${color === swatch ? 'border-slate-950 ring-1 ring-white outline outline-1 outline-slate-700' : 'border-black/5'}`}
            style={{ backgroundColor: swatch }}
          />)}
        </div>
        <div className="my-2 border-t border-slate-200" />
        <div className="flex min-h-7 items-center gap-1.5">
          {favorites.map(favorite => <div key={favorite} className="group relative">
            <button type="button" aria-label={`Oblíbená barva ${favorite}`} onClick={() => onChange(favorite, activeOpacity)} className="h-6 w-6 rounded border border-black/10" style={{ backgroundColor: favorite }} />
            <button type="button" aria-label={`Odebrat oblíbenou barvu ${favorite}`} onClick={() => saveFavorites(favorites.filter(item => item !== favorite))} className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-white group-hover:flex"><X size={10} /></button>
          </div>)}
          <button type="button" aria-label="Přidat aktuální barvu do oblíbených" onClick={addFavorite} className="flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-50"><Star size={12} /></button>
          <button type="button" aria-label="Vybrat vlastní barvu" onClick={() => customColorRef.current?.click()} className="flex h-6 w-6 items-center justify-center rounded text-slate-700 hover:bg-slate-100"><Plus size={15} /></button>
          <input ref={customColorRef} type="color" value={color} onChange={event => onChange(event.target.value, activeOpacity)} className="sr-only" tabIndex={-1} />
        </div>
        <div className="mt-2 text-[11px] text-slate-500">Opacity</div>
        <div className="mt-1 flex items-center gap-2">
          <div className="relative h-4 flex-1">
            <div className="absolute inset-x-0 h-2 overflow-hidden rounded-sm" style={{ top: '50%', transform: 'translateY(-50%)', backgroundImage: 'linear-gradient(45deg,#d5d7dc 25%,transparent 25%),linear-gradient(-45deg,#d5d7dc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d5d7dc 75%),linear-gradient(-45deg,transparent 75%,#d5d7dc 75%)', backgroundSize: '8px 8px', backgroundPosition: '0 0,0 4px,4px -4px,-4px 0' }}>
              <div className="absolute inset-0" style={{ background: `linear-gradient(to right, transparent, ${color})` }} />
            </div>
            <input aria-label="Opacity %" type="range" min="0" max="100" value={activeOpacity} onChange={event => onChange(color, Number(event.target.value))} className="absolute inset-0 h-4 w-full cursor-pointer opacity-0" />
            <div className="pointer-events-none absolute h-3.5 w-3.5 rounded-full border-2 border-slate-900 bg-white shadow" style={{ left: `${activeOpacity}%`, top: '50%', transform: 'translate(-50%, -50%)' }} />
          </div>
          <label className="relative h-8 w-14">
            <input aria-label="Opacity hodnota" type="number" min="0" max="100" value={activeOpacity} onChange={event => onChange(color, Math.max(0, Math.min(100, Number(event.target.value))))} className="h-8 w-full rounded-md border border-slate-300 pl-1.5 pr-4 text-right text-xs outline-none focus:border-[#2962ff]" />
            <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </label>
        </div>
      </div>,
      document.body,
    )}
  </>;
};

export default TradingViewColorPicker;
