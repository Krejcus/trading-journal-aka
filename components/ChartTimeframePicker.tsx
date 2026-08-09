import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';
import type { MarketTimeframe } from '../services/marketData';

export interface TimeframeOption {
  value: MarketTimeframe;
  label: string;
  title: string;
  group: 'Minuty' | 'Hodiny' | 'Dny';
}

export const MARKET_TIMEFRAME_OPTIONS: TimeframeOption[] = [
  { value: '1m', label: '1m', title: '1 minuta', group: 'Minuty' },
  { value: '5m', label: '5m', title: '5 minut', group: 'Minuty' },
  { value: '15m', label: '15m', title: '15 minut', group: 'Minuty' },
  { value: '30m', label: '30m', title: '30 minut', group: 'Minuty' },
  { value: '1h', label: '1h', title: '1 hodina', group: 'Hodiny' },
  { value: '4h', label: '4h', title: '4 hodiny', group: 'Hodiny' },
  { value: '1d', label: 'D', title: '1 den', group: 'Dny' },
];

const STORAGE_KEY = 'alphatrade:chart-timeframe-favorites';
const FAVORITES_EVENT = 'alphatrade:chart-timeframe-favorites-change';
const DEFAULT_FAVORITES: MarketTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const validTimeframes = new Set(MARKET_TIMEFRAME_OPTIONS.map(option => option.value));

const readFavorites = (): MarketTimeframe[] => {
  if (typeof window === 'undefined') return DEFAULT_FAVORITES;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(stored)) return DEFAULT_FAVORITES;
    const valid = stored.filter((value): value is MarketTimeframe => validTimeframes.has(value));
    return valid;
  } catch {
    return DEFAULT_FAVORITES;
  }
};

export const ChartTimeframePicker: React.FC<{
  value: MarketTimeframe;
  onChange: (timeframe: MarketTimeframe) => void;
  isDark: boolean;
  compact?: boolean;
}> = ({ value, onChange, isDark, compact = false }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState<MarketTimeframe[]>(readFavorites);
  const favoriteOptions = useMemo(
    () => MARKET_TIMEFRAME_OPTIONS.filter(option => favorites.includes(option.value)),
    [favorites],
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    return () => window.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    const syncFavorites = () => setFavorites(readFavorites());
    window.addEventListener(FAVORITES_EVENT, syncFavorites);
    window.addEventListener('storage', syncFavorites);
    return () => {
      window.removeEventListener(FAVORITES_EVENT, syncFavorites);
      window.removeEventListener('storage', syncFavorites);
    };
  }, []);

  const toggleFavorite = (timeframe: MarketTimeframe) => {
    const next = favorites.includes(timeframe)
      ? favorites.filter(item => item !== timeframe)
      : MARKET_TIMEFRAME_OPTIONS.filter(option => [...favorites, timeframe].includes(option.value)).map(option => option.value);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setFavorites(next);
    window.dispatchEvent(new Event(FAVORITES_EVENT));
  };

  const selectedIsFavorite = favorites.includes(value);
  const groups: Array<TimeframeOption['group']> = ['Minuty', 'Hodiny', 'Dny'];
  const idleText = isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950';
  const activeText = isDark ? 'bg-[#2a2e39] text-white' : 'bg-slate-100 text-slate-950';

  return (
    <div ref={rootRef} className="relative z-[110] flex items-center shrink-0" data-testid="chart-timeframe-picker">
      {favoriteOptions.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`${compact ? 'min-w-7 px-1' : 'min-w-8 px-1.5'} h-8 rounded-md text-[10px] font-bold transition-colors ${value === option.value ? activeText : idleText}`}
          aria-label={option.title}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className={`h-8 min-w-7 px-1.5 inline-flex items-center justify-center gap-1 rounded-md text-[10px] font-bold transition-colors ${open || !selectedIsFavorite ? activeText : idleText}`}
        aria-label="Vybrat timeframe"
        aria-expanded={open}
      >
        {!selectedIsFavorite && MARKET_TIMEFRAME_OPTIONS.find(option => option.value === value)?.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className={`absolute top-9 left-0 w-[260px] max-h-[430px] overflow-y-auto rounded-lg border py-1 shadow-2xl ${isDark ? 'bg-[#1e222d] border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-800'}`}>
          <div className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Timeframe</div>
          {groups.map(group => (
            <div key={group}>
              <div className={`px-3 py-1.5 text-[9px] font-bold ${isDark ? 'bg-white/[0.035] text-slate-500' : 'bg-slate-50 text-slate-500'}`}>{group}</div>
              {MARKET_TIMEFRAME_OPTIONS.filter(option => option.group === group).map(option => {
                const favorite = favorites.includes(option.value);
                const selected = value === option.value;
                return (
                  <div key={option.value} className={`group flex items-center ${selected ? isDark ? 'bg-white/[0.07]' : 'bg-blue-50' : ''}`}>
                    <button
                      type="button"
                      onClick={() => { onChange(option.value); setOpen(false); }}
                      className={`flex-1 h-9 px-3 flex items-center gap-2 text-left text-[10px] font-bold ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}
                    >
                      <span className="w-8">{option.label}</span>
                      <span className="font-medium text-slate-500">{option.title}</span>
                      {selected && <Check size={13} className="ml-auto text-blue-500" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(option.value)}
                      className={`w-9 h-9 inline-flex items-center justify-center ${favorite ? 'text-amber-400' : 'text-slate-500 opacity-60 group-hover:opacity-100'}`}
                      aria-label={favorite ? `Odebrat ${option.title} z oblíbených` : `Přidat ${option.title} do oblíbených`}
                      aria-pressed={favorite}
                    >
                      <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChartTimeframePicker;
