
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Filter, RotateCcw, Calendar, Clock, Wallet, TrendingUp, Target, ShieldCheck, Monitor, Zap, AlertOctagon, LayoutGrid, Check, X } from 'lucide-react';
import { TradeFilters, Account, Trade, DashboardMode } from '../types';

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
  setDashboardMode
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const sectionLabelClass = "flex items-center gap-2 text-[9px] font-black uppercase text-slate-500 tracking-widest mb-3";

  const getGlassBtnClass = (isActive: boolean, type: 'neutral' | 'win' | 'loss' | 'status-valid' | 'status-invalid' | 'status-missed' = 'neutral') => {
    const base = "transition-all duration-300 border backdrop-blur-md relative overflow-hidden text-[10px] font-black uppercase tracking-wider h-11 flex items-center justify-center";
    if (!isActive) return `${base} bg-white/5 border-white/5 text-slate-500 hover:bg-white/10 hover:text-slate-300`;
    switch (type) {
      case 'win': return `${base} bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.15)]`;
      case 'loss': return `${base} bg-rose-500/10 border-rose-500/30 text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.15)]`;
      case 'status-valid': return `${base} bg-emerald-600 text-white border-emerald-500 shadow-lg`;
      case 'status-invalid': return `${base} bg-rose-600 text-white border-rose-500 shadow-lg`;
      case 'status-missed': return `${base} bg-blue-600 text-white border-blue-500 shadow-lg`;
      default: return `${base} bg-white/10 border-white/20 text-white shadow-[0_0_10px_rgba(255,255,255,0.05)]`;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 p-2.5 rounded-xl text-sm font-bold transition-all relative border ${isOpen
          ? 'bg-white/10 border-white/20 text-white backdrop-blur-md'
          : 'bg-transparent border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200'
          }`}
        title="Filtrovat data & Nástroje"
      >
        <Filter size={18} />
        {activeFilterCount > 0 && (
          <span className="absolute -top-1 -right-0.5 text-[10px] font-black text-indigo-500 drop-shadow-sm animate-in fade-in zoom-in duration-300">
            {activeFilterCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          {/* Overlay pro mobilní zařízení pro snazší zavření klepnutím mimo */}
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[90] sm:hidden" onClick={() => setIsOpen(false)} />

          <div className="fixed inset-x-4 top-20 sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-3 w-auto sm:w-[340px] md:w-[500px] max-w-[500px] rounded-[32px] overflow-hidden shadow-[0_20px_60px_-10px_rgba(0,0,0,0.8)] border border-white/10 animate-in zoom-in-95 fade-in duration-200 z-[100] backdrop-blur-2xl bg-[#020617]/90 sm:origin-top-right">
            <div className="p-5 border-b border-white/5 bg-white/5 flex justify-between items-center">
              <h4 className="font-black text-[10px] uppercase tracking-[0.2em] flex items-center gap-2 text-slate-300">
                <Filter size={12} className="text-indigo-500" /> Analytický Filtr
              </h4>
              <div className="flex gap-2">
                <button onClick={resetFilters} className="p-2.5 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-colors">
                  <RotateCcw size={16} />
                </button>
                <button onClick={() => setIsOpen(false)} className="p-2.5 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-colors">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-8 max-h-[70vh] sm:max-h-[75vh] overflow-y-auto custom-scrollbar no-scrollbar">
              {dashboardMode && setDashboardMode && (
                <div>
                  <div className={sectionLabelClass}><Monitor size={12} /> Režim Zobrazení</div>
                  <div className="flex p-1 rounded-2xl bg-white/5 border border-white/5 relative">
                    {/* Sliding Highlight */}
                    <div className={`absolute inset-y-1 w-1/3 rounded-xl transition-all duration-300 ${dashboardMode === 'funded' ? 'translate-x-0 bg-emerald-500/20 border border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.2)]' :
                      dashboardMode === 'combined' ? 'translate-x-[100%] bg-orange-500/20 border border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.2)]' :
                        'translate-x-[200%] bg-blue-500/20 border border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                      }`} />

                    <button
                      onClick={() => setDashboardMode('funded')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'funded' ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Funded
                    </button>
                    <button
                      onClick={() => setDashboardMode('combined')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'combined' ? 'text-orange-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Vše
                    </button>
                    <button
                      onClick={() => setDashboardMode('challenge')}
                      className={`flex-1 relative z-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${dashboardMode === 'challenge' ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Challenge
                    </button>
                  </div>
                </div>
              )}
              {setIsDashboardEditing && (
                <div className="p-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/20">
                  <div className={sectionLabelClass}><Zap size={12} className="text-indigo-500" /> Tactical Tools</div>
                  <button onClick={() => { setIsDashboardEditing(!isDashboardEditing); setIsOpen(false); }} className={`w-full py-4 rounded-xl flex items-center justify-center gap-3 transition-all ${isDashboardEditing ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-300 border border-white/5 hover:bg-white/10'}`}>
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
                      <button key={tag} onClick={() => setFilters(f => ({ ...f, htfConfluences: toggleItem(f.htfConfluences, tag) }))} className={`px-4 py-2.5 rounded-xl border text-[9px] font-black uppercase transition-all ${filters.htfConfluences.includes(tag) ? 'bg-blue-600 border-blue-500 text-white shadow-lg' : 'bg-white/5 border-white/5 text-slate-500'}`}>{tag}</button>
                    ))}
                  </div>
                </div>
              )}
              {availableTags.ltf.length > 0 && (
                <div>
                  <div className={sectionLabelClass}><Zap size={12} /> LTF Triggery</div>
                  <div className="flex flex-wrap gap-2">
                    {availableTags.ltf.map(tag => (
                      <button key={tag} onClick={() => setFilters(f => ({ ...f, ltfConfluences: toggleItem(f.ltfConfluences, tag) }))} className={`px-4 py-2.5 rounded-xl border text-[9px] font-black uppercase transition-all ${filters.ltfConfluences.includes(tag) ? 'bg-amber-600 border-amber-500 text-white shadow-lg' : 'bg-white/5 border-white/5 text-slate-500'}`}>{tag}</button>
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
                  <div className={sectionLabelClass}><Clock size={12} /> Hodiny (8-19)</div>
                  <div className="grid grid-cols-4 gap-2">
                    {[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(hour => (
                      <button key={hour} onClick={() => setFilters(f => ({ ...f, hours: toggleItem(f.hours, hour) }))} className={`aspect-square rounded-xl text-[9px] font-black flex items-center justify-center ${getGlassBtnClass(filters.hours.includes(hour))}`}>{hour}</button>
                    ))}
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
            <div className="p-5 border-t border-white/5 bg-white/5 text-center backdrop-blur-md flex flex-col gap-2">
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
