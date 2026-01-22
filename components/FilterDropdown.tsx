
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Filter, RotateCcw, Calendar, Clock, Wallet, TrendingUp, Target, ShieldCheck, Monitor, Zap, AlertOctagon, LayoutGrid, Check, X, Layers } from 'lucide-react';
import { TradeFilters, Account, Trade, DashboardMode, PnLDisplayMode } from '../types';

interface FilterDropdownProps {
  filters: TradeFilters;
  setFilters: React.Dispatch<React.SetStateAction<TradeFilters>>;
  accounts: Account[];
  trades: Trade[];
  theme: 'dark' | 'light' | 'oled';
  isDashboardEditing?: boolean;
  setIsDashboardEditing?: (val: boolean) => void;
  dashboardMode?: DashboardMode;
  setDashboardMode?: (mode: DashboardMode) => void;
  viewMode: 'individual' | 'combined';
  setViewMode: (mode: 'individual' | 'combined') => void;
  pnlDisplayMode?: PnLDisplayMode;
  setPnlDisplayMode?: (mode: PnLDisplayMode) => void;
}

const TRADING_DAYS = ['Po', 'Út', 'St', 'Čt', 'Pá'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const FilterDropdown: React.FC<FilterDropdownProps> = ({
  filters,
  setFilters,
  accounts,
  trades,
  theme,
  isDashboardEditing,
  setIsDashboardEditing,
  dashboardMode,
  setDashboardMode,
  viewMode,
  setViewMode,
  pnlDisplayMode,
  setPnlDisplayMode
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isDark = theme !== 'light';

  // Hour range state (derived from filters.hours)
  const hourMin = Math.min(...filters.hours.filter(h => h >= 0 && h <= 23));
  const hourMax = Math.max(...filters.hours.filter(h => h >= 0 && h <= 23));
  const [hourRange, setHourRange] = useState<[number, number]>([isFinite(hourMin) ? hourMin : 8, isFinite(hourMax) ? hourMax : 19]);

  const availableTags = useMemo(() => {
    const htf = new Set<string>();
    const ltf = new Set<string>();
    const mistakes = new Set<string>();
    trades.forEach(t => {
      t.htfConfluence?.forEach(c => htf.add(c));
      t.ltfConfluence?.forEach(c => ltf.add(c));
      t.mistakes?.forEach(m => mistakes.add(m));
    });
    return {
      htf: Array.from(htf).sort(),
      ltf: Array.from(ltf).sort(),
      mistakes: Array.from(mistakes).sort()
    };
  }, [trades]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const toggleItem = <T,>(list: T[], item: T): T[] => {
    return list.includes(item) ? list.filter(i => i !== item) : [...list, item];
  };

  const resetFilters = () => {
    setFilters({
      days: [...TRADING_DAYS],
      hours: [...HOURS],
      accounts: accounts.map(a => a.id),
      directions: ['Long', 'Short'],
      outcomes: ['Win', 'Loss', 'BE'],
      period: 'all',
      signals: [],
      executionStatuses: ['Valid'],
      htfConfluences: [],
      ltfConfluences: [],
      mistakes: []
    });
  };

  const activeFilterCount = (
    (TRADING_DAYS.length - filters.days.length) +
    (HOURS.length - filters.hours.length) +
    (accounts.length - filters.accounts.length) +
    (2 - filters.directions.length) +
    (3 - filters.outcomes.length) +
    (filters.period !== 'all' ? 1 : 0) +
    filters.htfConfluences.length +
    filters.ltfConfluences.length +
    filters.mistakes.length
  );

  const sectionLabelClass = `flex items-center gap-2 text-[9px] font-black uppercase tracking-widest mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`;

  const getGlassBtnClass = (isActive: boolean, type: 'neutral' | 'win' | 'loss' | 'status-valid' | 'status-invalid' | 'status-missed' = 'neutral') => {
    const base = "transition-all duration-300 border backdrop-blur-md relative overflow-hidden text-[10px] font-black uppercase tracking-wider h-11 flex items-center justify-center";
    if (!isActive) {
      // INACTIVE: Transparent with subtle border
      return isDark
        ? `${base} bg-transparent border-white/10 text-slate-500 hover:bg-white/5 hover:text-slate-300`
        : `${base} bg-transparent border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-600`;
    }
    // Special types keep their colors
    switch (type) {
      case 'win': return isDark
        ? `${base} bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]`
        : `${base} bg-emerald-500 border-emerald-500 text-white shadow-lg shadow-emerald-500/20`;
      case 'loss': return isDark
        ? `${base} bg-rose-500/20 border-rose-500/50 text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.2)]`
        : `${base} bg-rose-500 border-rose-500 text-white shadow-lg shadow-rose-500/20`;
      case 'status-valid': return `${base} bg-emerald-600 text-white border-emerald-500 shadow-lg`;
      case 'status-invalid': return `${base} bg-rose-600 text-white border-rose-500 shadow-lg`;
      case 'status-missed': return `${base} bg-blue-600 text-white border-blue-500 shadow-lg`;
      default:
        // ACTIVE (neutral): Green
        return isDark
          ? `${base} bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.15)]`
          : `${base} bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/20`;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 p-2.5 rounded-xl text-sm font-bold transition-all relative border ${isOpen
          ? (isDark ? 'bg-white/10 border-white/20 text-white backdrop-blur-md' : 'bg-slate-900 border-slate-800 text-white shadow-lg')
          : (isDark ? 'bg-transparent border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200' : 'bg-transparent border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900')
          }`}
        title="Filtrovat data & Nástroje"
      >
        <Filter size={18} />
        {activeFilterCount > 0 && (
          <span className={`absolute -top-1 -right-0.5 text-[10px] font-black drop-shadow-sm animate-in fade-in zoom-in duration-300 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>
            {activeFilterCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          {/* Overlay pro mobilní zařízení pro snazší zavření klepnutím mimo */}
          <div className={`fixed inset-0 backdrop-blur-sm z-[90] sm:hidden ${isDark ? 'bg-black/40' : 'bg-slate-900/20'}`} onClick={() => setIsOpen(false)} />

          <div className={`fixed inset-x-4 top-20 sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-3 w-auto sm:w-[340px] md:w-[500px] max-w-[500px] rounded-[32px] overflow-hidden border animate-in zoom-in-95 fade-in duration-200 z-[100] backdrop-blur-2xl sm:origin-top-right ${isDark ? 'bg-[#020617]/95 border-white/10 shadow-[0_20px_60px_-10px_rgba(0,0,0,0.8)]' : 'bg-white/95 border-slate-200 shadow-[0_20px_60px_-10px_rgba(0,0,0,0.15)]'}`}>
            <div className={`p-5 border-b flex justify-between items-center ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
              <h4 className={`font-black text-[10px] uppercase tracking-[0.2em] flex items-center gap-2 ${isDark ? 'text-slate-300' : 'text-slate-900'}`}>
                <Filter size={12} className="text-indigo-500" /> Analytický Filtr
              </h4>
              <div className="flex gap-2">
                <button onClick={resetFilters} className={`p-2.5 rounded-xl transition-colors ${isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-900'}`}>
                  <RotateCcw size={16} />
                </button>
                <button onClick={() => setIsOpen(false)} className={`p-2.5 rounded-xl transition-colors ${isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-900'}`}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-8 max-h-[70vh] sm:max-h-[75vh] overflow-y-auto custom-scrollbar no-scrollbar">
              {dashboardMode && setDashboardMode && (
                <div>
                  <div className={sectionLabelClass}><Monitor size={12} /> Režim Zobrazení</div>
                  <div className={`flex p-1 rounded-2xl border relative ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                    {/* Sliding Highlight */}
                    <div className={`absolute inset-y-1 w-1/3 rounded-xl transition-all duration-300 ${dashboardMode === 'funded' ? `translate-x-0 ${isDark ? 'bg-emerald-500/20 border border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'}` :
                      dashboardMode === 'combined' ? `translate-x-[100%] ${isDark ? 'bg-orange-500/20 border border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.2)]' : 'bg-orange-500 text-white shadow-lg shadow-orange-500/20'}` :
                        `translate-x-[200%] ${isDark ? 'bg-blue-500/20 border border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]' : 'bg-blue-500 text-white shadow-lg shadow-blue-500/20'}`
                      }`} />

                    <button
                      onClick={() => setDashboardMode('funded')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'funded' ? (isDark ? 'text-emerald-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      Funded
                    </button>
                    <button
                      onClick={() => setDashboardMode('combined')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'combined' ? (isDark ? 'text-orange-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      Vše
                    </button>
                    <button
                      onClick={() => setDashboardMode('challenge')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'challenge' ? (isDark ? 'text-blue-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      Challenge
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div className={sectionLabelClass}><Layers size={12} /> Seskupování</div>
                <div className={`flex p-1 rounded-xl border relative max-w-[240px] ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                  {/* Sliding Highlight */}
                  <div className={`absolute inset-y-1 w-1/2 rounded-lg transition-all duration-300 ${viewMode === 'individual' ? `translate-x-0 ${isDark ? 'bg-white/10 border border-white/20' : 'bg-white shadow-sm'}` :
                    `translate-x-[100%] ${isDark ? 'bg-white/10 border border-white/20' : 'bg-white shadow-sm'}`
                    }`} />

                  <button
                    onClick={() => setViewMode('individual')}
                    className={`flex-1 relative z-10 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors ${viewMode === 'individual' ? (isDark ? 'text-white' : 'text-slate-900') : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Indiv.
                  </button>
                  <button
                    onClick={() => setViewMode('combined')}
                    className={`flex-1 relative z-10 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors ${viewMode === 'combined' ? (isDark ? 'text-white' : 'text-slate-900') : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    Kombin.
                  </button>
                </div>
              </div>

              {/* PnL Display Mode Switcher */}
              {pnlDisplayMode && setPnlDisplayMode && (
                <div>
                  <div className={sectionLabelClass}><TrendingUp size={12} /> Formát P&L</div>
                  <div className={`flex p-1 rounded-xl border relative max-w-[280px] ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                    {/* Sliding Highlight */}
                    <div className={`absolute inset-y-1 w-1/3 rounded-lg transition-all duration-300 ${pnlDisplayMode === 'usd' ? `translate-x-0 ${isDark ? 'bg-emerald-500/20 border border-emerald-500/40' : 'bg-emerald-500 text-white shadow-md'}` :
                      pnlDisplayMode === 'percent' ? `translate-x-[100%] ${isDark ? 'bg-blue-500/20 border border-blue-500/40' : 'bg-blue-500 text-white shadow-md'}` :
                        `translate-x-[200%] ${isDark ? 'bg-amber-500/20 border border-amber-500/40' : 'bg-amber-500 text-white shadow-md'}`
                      }`} />

                    <button
                      onClick={() => setPnlDisplayMode('usd')}
                      className={`flex-1 relative z-10 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-colors ${pnlDisplayMode === 'usd' ? (isDark ? 'text-emerald-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      $ USD
                    </button>
                    <button
                      onClick={() => setPnlDisplayMode('percent')}
                      className={`flex-1 relative z-10 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-colors ${pnlDisplayMode === 'percent' ? (isDark ? 'text-blue-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      % Účtu
                    </button>
                    <button
                      onClick={() => setPnlDisplayMode('rr')}
                      className={`flex-1 relative z-10 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-colors ${pnlDisplayMode === 'rr' ? (isDark ? 'text-amber-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                    >
                      R:R
                    </button>
                  </div>
                </div>
              )}
              {setIsDashboardEditing && (
                <div className={`p-4 rounded-2xl border ${isDark ? 'bg-indigo-500/5 border-indigo-500/20' : 'bg-indigo-50 border-indigo-100'}`}>
                  <div className={sectionLabelClass}><Zap size={12} className="text-indigo-500" /> Tactical Tools</div>
                  <button onClick={() => { setIsDashboardEditing(!isDashboardEditing); setIsOpen(false); }} className={`w-full py-4 rounded-xl flex items-center justify-center gap-3 transition-all ${isDashboardEditing ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : (isDark ? 'bg-white/5 text-slate-300 border border-white/5 hover:bg-white/10' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 shadow-sm')}`}>
                    {isDashboardEditing ? <Check size={16} /> : <LayoutGrid size={16} />}
                    <span className="text-[10px] font-black uppercase tracking-widest">{isDashboardEditing ? 'Uložit rozložení' : 'Upravit dashboard'}</span>
                  </button>
                </div>
              )}
              <div>
                <div className={sectionLabelClass}><ShieldCheck size={12} /> Integrita exekuce</div>
                <div className="flex flex-col sm:flex-row gap-2">
                  {[
                    { id: 'Valid', label: 'Validní', type: 'status-valid' },
                    { id: 'Invalid', label: 'Nevalidní', type: 'status-invalid' },
                    { id: 'Missed', label: 'Zmeškané', type: 'status-missed' }
                  ].map(s => (
                    <button key={s.id} onClick={() => setFilters(f => ({ ...f, executionStatuses: toggleItem(f.executionStatuses, s.id as any) }))} className={`flex-1 ${getGlassBtnClass(filters.executionStatuses.includes(s.id as any), s.type as any)} rounded-xl`}>{s.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className={sectionLabelClass}><Calendar size={12} /> Horizont</div>
                <div className="flex flex-wrap gap-2">
                  {[{ id: 'all', label: 'Vše' }, { id: 'week', label: '7 Dní' }, { id: 'month', label: '30 Dní' }, { id: 'quarter', label: '90 Dní' }, { id: 'year', label: 'Rok' }].map(p => (
                    <button key={p.id} onClick={() => setFilters(f => ({ ...f, period: p.id as any }))} className={`flex-1 min-w-[80px] rounded-xl ${getGlassBtnClass(filters.period === p.id)}`}>{p.label}</button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <div className={sectionLabelClass}><TrendingUp size={12} /> Směr</div>
                  <div className="flex gap-2">
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Long') }))} className={`flex-1 py-4 rounded-2xl ${getGlassBtnClass(filters.directions.includes('Long'), 'win')}`}>Long</button>
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Short') }))} className={`flex-1 py-4 rounded-2xl ${getGlassBtnClass(filters.directions.includes('Short'), 'loss')}`}>Short</button>
                  </div>
                </div>
                <div>
                  <div className={sectionLabelClass}><Target size={12} /> Výsledek</div>
                  <div className="flex gap-2">
                    {[{ id: 'Win', label: 'Win', type: 'win' }, { id: 'Loss', label: 'Loss', type: 'loss' }, { id: 'BE', label: 'BE', type: 'neutral' }].map(o => (
                      <button key={o.id} onClick={() => setFilters(f => ({ ...f, outcomes: toggleItem(f.outcomes, o.id as any) }))} className={`flex-1 py-4 rounded-2xl ${getGlassBtnClass(filters.outcomes.includes(o.id as any), o.type as any)}`}>{o.label}</button>
                    ))}
                  </div>
                </div>
              </div>
              {availableTags.htf.length > 0 && (
                <div>
                  <div className={sectionLabelClass}><Monitor size={12} /> HTF Kontext</div>
                  <div className="flex flex-wrap gap-2">
                    {availableTags.htf.map(tag => (
                      <button key={tag} onClick={() => setFilters(f => ({ ...f, htfConfluences: toggleItem(f.htfConfluences, tag) }))} className={`px-4 py-2.5 rounded-xl border text-[9px] font-black uppercase transition-all ${filters.htfConfluences.includes(tag) ? 'bg-blue-600 border-blue-500 text-white shadow-lg' : (isDark ? 'bg-white/5 border-white/5 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-500 hover:bg-slate-200')}`}>{tag}</button>
                    ))}
                  </div>
                </div>
              )}
              {availableTags.ltf.length > 0 && (
                <div>
                  <div className={sectionLabelClass}><Zap size={12} /> LTF Triggery</div>
                  <div className="flex flex-wrap gap-2">
                    {availableTags.ltf.map(tag => (
                      <button key={tag} onClick={() => setFilters(f => ({ ...f, ltfConfluences: toggleItem(f.ltfConfluences, tag) }))} className={`px-4 py-2.5 rounded-xl border text-[9px] font-black uppercase transition-all ${filters.ltfConfluences.includes(tag) ? 'bg-amber-600 border-amber-500 text-white shadow-lg' : (isDark ? 'bg-white/5 border-white/5 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-500 hover:bg-slate-200')}`}>{tag}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
                <div>
                  <div className={sectionLabelClass}><Calendar size={12} /> Dny</div>
                  <div className="grid grid-cols-5 gap-2">
                    {TRADING_DAYS.map(day => (
                      <button key={day} onClick={() => setFilters(f => ({ ...f, days: toggleItem(f.days, day) }))} className={`aspect-square rounded-xl text-[10px] font-black flex items-center justify-center ${getGlassBtnClass(filters.days.includes(day))}`}>{day}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className={sectionLabelClass}><Clock size={12} /> Hodiny</div>
                  <div className="space-y-4">
                    <div className="flex justify-between text-xs font-bold">
                      <span className={isDark ? 'text-emerald-400' : 'text-emerald-600'}>{hourRange[0]}:00</span>
                      <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>-</span>
                      <span className={isDark ? 'text-emerald-400' : 'text-emerald-600'}>{hourRange[1]}:00</span>
                    </div>
                    <div className="relative h-6 flex items-center">
                      {/* Track */}
                      <div className={`absolute inset-x-0 h-1.5 rounded-full ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                      {/* Active range */}
                      <div
                        className="absolute h-1.5 rounded-full bg-emerald-500"
                        style={{
                          left: `${(hourRange[0] / 23) * 100}%`,
                          right: `${100 - (hourRange[1] / 23) * 100}%`
                        }}
                      />
                      {/* Min thumb */}
                      <input
                        type="range"
                        min={0}
                        max={23}
                        value={hourRange[0]}
                        onChange={(e) => {
                          const val = Math.min(Number(e.target.value), hourRange[1] - 1);
                          setHourRange([val, hourRange[1]]);
                          const newHours = Array.from({ length: hourRange[1] - val + 1 }, (_, i) => val + i);
                          setFilters(f => ({ ...f, hours: newHours }));
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                      />
                      {/* Max thumb */}
                      <input
                        type="range"
                        min={0}
                        max={23}
                        value={hourRange[1]}
                        onChange={(e) => {
                          const val = Math.max(Number(e.target.value), hourRange[0] + 1);
                          setHourRange([hourRange[0], val]);
                          const newHours = Array.from({ length: val - hourRange[0] + 1 }, (_, i) => hourRange[0] + i);
                          setFilters(f => ({ ...f, hours: newHours }));
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
                      />
                      {/* Visual thumbs */}
                      <div
                        className="absolute w-5 h-5 rounded-full bg-emerald-500 border-2 border-white shadow-lg pointer-events-none"
                        style={{ left: `calc(${(hourRange[0] / 23) * 100}% - 10px)` }}
                      />
                      <div
                        className="absolute w-5 h-5 rounded-full bg-emerald-500 border-2 border-white shadow-lg pointer-events-none"
                        style={{ left: `calc(${(hourRange[1] / 23) * 100}% - 10px)` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <div className={sectionLabelClass}><Wallet size={12} /> Portfolia</div>
                <div className="flex flex-col gap-2">
                  {accounts.map(acc => (
                    <button key={acc.id} onClick={() => setFilters(f => ({ ...f, accounts: toggleItem(f.accounts, acc.id) }))} className={`w-full py-4 rounded-2xl ${getGlassBtnClass(filters.accounts.includes(acc.id))} justify-start px-6`}>{acc.name}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className={`p-5 border-t text-center backdrop-blur-md flex flex-col gap-2 ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Live View Updated • {activeFilterCount} aktivních filtrů</p>
              <button onClick={() => setIsOpen(false)} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest sm:hidden">Použít filtry</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
export default FilterDropdown;
