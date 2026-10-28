import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Star, X } from 'lucide-react';
import {
  CUSTOM_TIMEFRAME_LIMITS,
  isMarketTimeframe,
  parseMarketTimeframe,
  timeframeMinutes,
  type MarketTimeframe,
} from '../services/marketData';
import { useKeepInViewport } from '../hooks/useKeepInViewport';

export interface TimeframeOption {
  value: MarketTimeframe;
  label: string;
  title: string;
  group: 'Minuty' | 'Hodiny' | 'Dny' | 'Vlastní';
}

export const MARKET_TIMEFRAME_OPTIONS: TimeframeOption[] = [
  { value: '1m', label: '1m', title: '1 minuta', group: 'Minuty' },
  { value: '5m', label: '5m', title: '5 minut', group: 'Minuty' },
  { value: '15m', label: '15m', title: '15 minut', group: 'Minuty' },
  { value: '30m', label: '30m', title: '30 minut', group: 'Minuty' },
  { value: '1h', label: '1h', title: '1 hodina', group: 'Hodiny' },
  { value: '4h', label: '4h', title: '4 hodiny', group: 'Hodiny' },
  { value: '1d', label: 'D', title: '1 den', group: 'Dny' },
  { value: 'W', label: 'W', title: '1 týden', group: 'Dny' },
  { value: 'M', label: 'M', title: '1 měsíc', group: 'Dny' },
];

const STORAGE_KEY = 'alphatrade:chart-timeframe-favorites';
const CUSTOM_STORAGE_KEY = 'alphatrade:chart-timeframe-custom';
const FAVORITES_EVENT = 'alphatrade:chart-timeframe-favorites-change';
const DEFAULT_FAVORITES: MarketTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MAX_CUSTOM = 12;
const BUILTIN_VALUES = new Set<string>(MARKET_TIMEFRAME_OPTIONS.map(option => option.value));

const czechCount = (count: number, one: string, few: string, many: string) =>
  `${count} ${count === 1 ? one : count >= 2 && count <= 4 ? few : many}`;

/** Popisek vlastního timeframe (`7m` → „7 minut“, `2h` → „2 hodiny“). */
export function customTimeframeOption(value: MarketTimeframe): TimeframeOption | null {
  const parsed = parseMarketTimeframe(value);
  if (!parsed || (parsed.unit !== 'm' && parsed.unit !== 'h')) return null;
  return {
    value,
    label: value,
    title: parsed.unit === 'm'
      ? czechCount(parsed.count, 'minuta', 'minuty', 'minut')
      : czechCount(parsed.count, 'hodina', 'hodiny', 'hodin'),
    group: 'Vlastní',
  };
}

const byDuration = (left: MarketTimeframe, right: MarketTimeframe) => timeframeMinutes(left) - timeframeMinutes(right);

const readStoredList = (key: string): unknown[] | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) || 'null');
    return Array.isArray(stored) ? stored : null;
  } catch {
    return null;
  }
};

/** Vlastní timeframy (jen platné, bez pevných, bez duplicit, seřazené podle délky). */
export const readCustomTimeframes = (): MarketTimeframe[] => {
  const stored = readStoredList(CUSTOM_STORAGE_KEY) ?? [];
  return [...new Set(stored.filter((value): value is MarketTimeframe =>
    isMarketTimeframe(value) && !BUILTIN_VALUES.has(value) && customTimeframeOption(value) !== null))]
    .sort(byDuration)
    .slice(0, MAX_CUSTOM);
};

const readFavorites = (): MarketTimeframe[] => {
  const stored = readStoredList(STORAGE_KEY);
  if (!stored) return DEFAULT_FAVORITES;
  return stored.filter(isMarketTimeframe);
};

const writeStored = (key: string, value: unknown) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* soukromý režim */ }
};

export const ChartTimeframePicker: React.FC<{
  value: MarketTimeframe;
  onChange: (timeframe: MarketTimeframe) => void;
  isDark: boolean;
  compact?: boolean;
}> = ({ value, onChange, isDark, compact = false }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popupRef, open);
  const [favorites, setFavorites] = useState<MarketTimeframe[]>(readFavorites);
  const [customs, setCustoms] = useState<MarketTimeframe[]>(readCustomTimeframes);
  const [draftCount, setDraftCount] = useState('');
  const [draftUnit, setDraftUnit] = useState<'m' | 'h'>('m');

  const allOptions = useMemo(
    () => [...MARKET_TIMEFRAME_OPTIONS, ...customs.flatMap(custom => customTimeframeOption(custom) ?? [])],
    [customs],
  );
  // Vybraný timeframe, který v nabídce není (např. z uloženého rozložení), se ukáže taky.
  const selectedOption = allOptions.find(option => option.value === value) ?? customTimeframeOption(value);
  const favoriteOptions = useMemo(
    () => allOptions.filter(option => favorites.includes(option.value)).sort((a, b) => byDuration(a.value, b.value)),
    [allOptions, favorites],
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
    const sync = () => { setFavorites(readFavorites()); setCustoms(readCustomTimeframes()); };
    window.addEventListener(FAVORITES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FAVORITES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const saveFavorites = (next: MarketTimeframe[]) => {
    writeStored(STORAGE_KEY, next);
    setFavorites(next);
    window.dispatchEvent(new Event(FAVORITES_EVENT));
  };

  const toggleFavorite = (timeframe: MarketTimeframe) => {
    saveFavorites(favorites.includes(timeframe)
      ? favorites.filter(item => item !== timeframe)
      : [...favorites, timeframe].sort(byDuration));
  };

  const draftNumber = Number.parseInt(draftCount, 10);
  // 60 min = 1h, 120 min = 2h… — jeden timeframe, ne dva stejné pod jiným názvem.
  const draftValue = draftUnit === 'm' && draftNumber % 60 === 0 && draftNumber / 60 <= CUSTOM_TIMEFRAME_LIMITS.h.max
    ? `${draftNumber / 60}h` : `${draftNumber}${draftUnit}`;
  const draftValid = /^\d+$/.test(draftCount.trim()) && isMarketTimeframe(draftValue);
  const limits = CUSTOM_TIMEFRAME_LIMITS[draftUnit];

  const addCustom = () => {
    if (!draftValid) return;
    const timeframe = draftValue as MarketTimeframe;
    if (!BUILTIN_VALUES.has(timeframe) && !customs.includes(timeframe)) {
      const next = [...customs, timeframe].sort(byDuration).slice(0, MAX_CUSTOM);
      writeStored(CUSTOM_STORAGE_KEY, next);
      setCustoms(next);
    }
    // Nový timeframe rovnou do lišty oblíbených (hvězdičkou jde odebrat).
    if (!favorites.includes(timeframe)) saveFavorites([...favorites, timeframe].sort(byDuration));
    else window.dispatchEvent(new Event(FAVORITES_EVENT));
    setDraftCount('');
    onChange(timeframe);
    setOpen(false);
  };

  const removeCustom = (timeframe: MarketTimeframe) => {
    const next = customs.filter(item => item !== timeframe);
    writeStored(CUSTOM_STORAGE_KEY, next);
    setCustoms(next);
    saveFavorites(favorites.filter(item => item !== timeframe));
  };

  const selectedIsFavorite = favoriteOptions.some(option => option.value === value);
  const groups: Array<TimeframeOption['group']> = ['Minuty', 'Hodiny', 'Dny', 'Vlastní'];
  const idleText = isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950';
  const activeText = isDark ? 'bg-[#2a2e39] text-white' : 'bg-slate-100 text-slate-950';
  const inputClass = isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500' : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400';

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
        {!selectedIsFavorite && selectedOption?.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div ref={popupRef} data-toolbar-popup className={`absolute top-9 left-0 w-[260px] max-h-[470px] overflow-y-auto rounded-lg border py-1 shadow-2xl ${isDark ? 'bg-[#1e222d] border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-800'}`}>
          <div className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Timeframe</div>
          {groups.map(group => {
            const options = allOptions.filter(option => option.group === group);
            return (
              <div key={group}>
                <div className={`px-3 py-1.5 text-[9px] font-bold ${isDark ? 'bg-white/[0.035] text-slate-500' : 'bg-slate-50 text-slate-500'}`}>{group}</div>
                {options.map(option => {
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
                      {group === 'Vlastní' && (
                        <button
                          type="button"
                          onClick={() => removeCustom(option.value)}
                          className="w-7 h-9 inline-flex items-center justify-center text-slate-500 opacity-60 group-hover:opacity-100 hover:text-rose-400"
                          aria-label={`Smazat vlastní timeframe ${option.title}`}
                        >
                          <X size={13} />
                        </button>
                      )}
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
                {group === 'Vlastní' && (
                  <form
                    className="flex items-center gap-1.5 px-3 py-2"
                    onSubmit={event => { event.preventDefault(); addCustom(); }}
                    data-testid="chart-timeframe-custom-form"
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={3}
                      value={draftCount}
                      onChange={event => setDraftCount(event.target.value.replace(/\D/g, ''))}
                      placeholder={`${limits.min}–${limits.max}`}
                      className={`w-16 h-8 rounded-md border px-2 text-[11px] font-bold outline-none focus:border-blue-500 ${inputClass}`}
                      aria-label="Počet minut nebo hodin"
                    />
                    <div className={`flex h-8 rounded-md border p-0.5 ${isDark ? 'border-white/10' : 'border-slate-200'}`} role="group" aria-label="Jednotka">
                      {(['m', 'h'] as const).map(unit => (
                        <button
                          key={unit}
                          type="button"
                          onClick={() => setDraftUnit(unit)}
                          className={`px-2 rounded text-[10px] font-bold ${draftUnit === unit ? activeText : idleText}`}
                          aria-pressed={draftUnit === unit}
                        >
                          {unit === 'm' ? 'min' : 'hod'}
                        </button>
                      ))}
                    </div>
                    <button
                      type="submit"
                      disabled={!draftValid}
                      className={`ml-auto h-8 px-2 inline-flex items-center gap-1 rounded-md text-[10px] font-bold ${draftValid ? 'bg-blue-600 text-white hover:bg-blue-500' : isDark ? 'bg-white/5 text-slate-600' : 'bg-slate-100 text-slate-400'}`}
                      aria-label="Přidat vlastní timeframe"
                    >
                      <Plus size={12} />
                      Přidat
                    </button>
                  </form>
                )}
                {group === 'Vlastní' && draftCount.trim() !== '' && !draftValid && (
                  <div className="px-3 pb-2 text-[10px] text-amber-500">
                    {draftUnit === 'm' ? `Minuty ${limits.min}–${limits.max}` : `Hodiny ${limits.min}–${limits.max}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChartTimeframePicker;
