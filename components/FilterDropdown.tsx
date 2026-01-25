
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
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
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const isDark = theme !== 'light';

  // Hour range state (derived from filters.hours)
  const hourMin = Math.min(...filters.hours.filter(h => h >= 0 && h <= 23));
  const hourMax = Math.max(...filters.hours.filter(h => h >= 0 && h <= 23));
  const [hourRange, setHourRange] = useState<[number, number]>([isFinite(hourMin) ? hourMin : 8, isFinite(hourMax) ? hourMax : 19]);

  // Update button rect whenever opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      setButtonRect(buttonRef.current.getBoundingClientRect());
    }
  }, [isOpen]);

  // Re-measure on window resize
  useEffect(() => {
    const handleResize = () => {
      if (isOpen && buttonRef.current) {
        setButtonRect(buttonRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen]);

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
      if (
        dropdownRef.current && !dropdownRef.current.contains(event.target as Node) &&
        panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
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

  const sectionLabelClass = `flex items-center gap-1.5 text-[8px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`;

  const getGlassBtnClass = (isActive: boolean, type: 'neutral' | 'win' | 'loss' | 'status-valid' | 'status-invalid' | 'status-missed' = 'neutral') => {
    const base = "transition-all duration-300 border backdrop-blur-md relative overflow-hidden text-[9px] font-black uppercase tracking-wider h-8 flex items-center justify-center rounded-xl px-2";
    if (!isActive) {
      return isDark
        ? `${base} bg-white/[0.02] border-white/5 text-slate-500 hover:bg-white/[0.05] hover:text-slate-300`
        : `${base} bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-600`;
    }

    switch (type) {
      case 'win': return isDark
        ? `${base} bg-emerald-500/10 border-emerald-500/30 text-emerald-400`
        : `${base} bg-emerald-500 border-emerald-500 text-white shadow-sm`;
      case 'loss': return isDark
        ? `${base} bg-rose-500/10 border-rose-500/30 text-rose-400`
        : `${base} bg-rose-500 border-rose-500 text-white shadow-sm`;
      case 'status-valid': return `${base} bg-emerald-600 text-white border-emerald-500`;
      case 'status-invalid': return `${base} bg-rose-600 text-white border-rose-500`;
      case 'status-missed': return `${base} bg-blue-600 text-white border-blue-500`;
      default:
        return isDark
          ? `${base} bg-indigo-500/10 border-indigo-500/30 text-indigo-300`
          : `${base} bg-indigo-500 text-white border-indigo-500 shadow-sm`;
    }
  };

  const containerVariants = {
    hidden: { opacity: 0, scale: 0.98, y: -5 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: {
        type: "spring",
        stiffness: 400,
        damping: 35,
        staggerChildren: 0.03
      }
    },
    exit: {
      opacity: 0,
      scale: 0.98,
      y: -5,
      transition: { duration: 0.15 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 5 },
    visible: { opacity: 1, y: 0 }
  };

  const dropdownContent = (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[999] sm:hidden"
            onClick={() => setIsOpen(false)}
          />

          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            style={
              buttonRect && !window.matchMedia('(max-width: 640px)').matches
                ? {
                  position: 'fixed',
                  top: buttonRect.bottom + 8,
                  right: window.innerWidth - buttonRect.right,
                  left: 'auto',
                  bottom: 'auto',
                }
                : undefined
            }
            ref={panelRef}
            className={`fixed inset-x-0 bottom-0 top-auto sm:relative sm:inset-auto w-full sm:w-[320px] md:w-[400px] overflow-hidden border-t sm:border z-[1000] backdrop-blur-3xl rounded-t-[32px] sm:rounded-[24px] max-h-[85vh] sm:max-h-[80vh] flex flex-col ${isDark
              ? 'bg-[#020617]/90 border-white/10 shadow-[0_-20px_50px_-12px_rgba(0,0,0,0.5)] sm:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]'
              : 'bg-white/95 border-slate-200 shadow-[0_-20px_50px_-12px_rgba(0,0,0,0.05)] sm:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.1)]'
              }`}
          >
            <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />

            <div className={`px-4 py-3 border-b flex justify-between items-center relative z-10 shrink-0 ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
              <div className="flex flex-col">
                <h4 className={`font-black text-[9px] uppercase tracking-[0.2em] flex items-center gap-1.5 ${isDark ? 'text-slate-200' : 'text-slate-900'}`}>
                  <Filter size={11} className="text-indigo-500" /> Filtry
                </h4>
              </div>
              <div className="flex gap-1">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={resetFilters}
                  className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-900'}`}
                  title="Obnovit filtry"
                >
                  <RotateCcw size={13} />
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setIsOpen(false)}
                  className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-900'}`}
                >
                  <X size={15} />
                </motion.button>
              </div>
            </div>

            <div className="flex-1 p-4 space-y-5 overflow-y-auto no-scrollbar relative z-10">
              {dashboardMode && setDashboardMode && (
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Monitor size={10} /> Režim</div>
                  <div className={`flex p-0.5 rounded-xl border relative ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                    <div
                      className={`absolute inset-y-0.5 w-[calc(33.33%-2px)] rounded-lg transition-all duration-300 ease-out ${dashboardMode === 'funded' ? `translate-x-0 ${isDark ? 'bg-emerald-500/20 border border-emerald-500/40' : 'bg-emerald-500 text-white shadow-sm'}` :
                        dashboardMode === 'combined' ? `translate-x-[102%] ${isDark ? 'bg-orange-500/20 border border-orange-500/40' : 'bg-orange-500 text-white shadow-sm'}` :
                          `translate-x-[204%] ${isDark ? 'bg-blue-500/20 border border-blue-500/40' : 'bg-blue-500 text-white shadow-sm'}`
                        }`}
                    />
                    {['funded', 'combined', 'challenge'].map((m) => (
                      <button
                        key={m}
                        onClick={() => setDashboardMode(m as DashboardMode)}
                        className={`flex-1 relative z-10 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors ${dashboardMode === m ? (isDark ? (m === 'funded' ? 'text-emerald-400' : m === 'combined' ? 'text-orange-400' : 'text-blue-400') : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                      >
                        {m === 'combined' ? 'Vše' : m}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Layers size={10} /> Seskupení</div>
                  <div className={`flex p-0.5 rounded-xl border relative ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                    <div
                      className={`absolute inset-y-0.5 w-[calc(50%-2px)] rounded-lg transition-all duration-300 ease-out ${viewMode === 'individual' ? `translate-x-0 ${isDark ? 'bg-white/10 border border-white/10' : 'bg-white shadow-sm font-black'}` :
                        `translate-x-[102%] ${isDark ? 'bg-white/10 border border-white/10' : 'bg-white shadow-sm font-black'}`
                        }`}
                    />
                    {[{ id: 'individual', label: 'Indiv.' }, { id: 'combined', label: 'Komb.' }].map(v => (
                      <button
                        key={v.id}
                        onClick={() => setViewMode(v.id as any)}
                        className={`flex-1 relative z-10 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors ${viewMode === v.id ? (isDark ? 'text-white' : 'text-slate-900') : 'text-slate-500 hover:text-slate-400'}`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </motion.div>

                {pnlDisplayMode && setPnlDisplayMode && (
                  <motion.div variants={itemVariants}>
                    <div className={sectionLabelClass}><TrendingUp size={10} /> P&L</div>
                    <div className={`flex p-0.5 rounded-xl border relative ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                      <div
                        className={`absolute inset-y-0.5 w-[calc(33.33%-2px)] rounded-lg transition-all duration-300 ease-out ${pnlDisplayMode === 'usd' ? `translate-x-0 ${isDark ? 'bg-indigo-500/20 border border-indigo-500/30' : 'bg-slate-800 text-white'}` :
                          pnlDisplayMode === 'percent' ? `translate-x-[102%] ${isDark ? 'bg-indigo-500/20 border border-indigo-500/30' : 'bg-slate-800 text-white'}` :
                            `translate-x-[204%] ${isDark ? 'bg-indigo-500/20 border border-indigo-500/30' : 'bg-slate-800 text-white'}`
                          }`}
                      />
                      {[{ id: 'usd', label: '$' }, { id: 'percent', label: '%' }, { id: 'rr', label: 'R' }].map(p => (
                        <button
                          key={p.id}
                          onClick={() => setPnlDisplayMode(p.id as any)}
                          className={`flex-1 relative z-10 py-1.5 rounded-lg text-[8px] font-black tracking-widest transition-colors ${pnlDisplayMode === p.id ? (isDark ? 'text-indigo-400' : 'text-white') : (isDark ? 'text-slate-500 hover:text-slate-400' : 'text-slate-500 hover:text-slate-900')}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </div>

              <motion.div variants={itemVariants}>
                <div className={sectionLabelClass}><ShieldCheck size={10} /> Exekuce</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: 'Valid', label: 'Validní', type: 'status-valid' },
                    { id: 'Invalid', label: 'Nevalidní', type: 'status-invalid' },
                    { id: 'Missed', label: 'Zmešk.', type: 'status-missed' }
                  ].map(s => (
                    <button key={s.id} onClick={() => setFilters(f => ({ ...f, executionStatuses: toggleItem(f.executionStatuses, s.id as any) }))} className={getGlassBtnClass(filters.executionStatuses.includes(s.id as any), s.type as any)}>{s.label}</button>
                  ))}
                </div>
              </motion.div>

              <motion.div variants={itemVariants}>
                <div className={sectionLabelClass}><Calendar size={10} /> Období</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {[
                    { id: 'all', label: 'Vše' },
                    { id: 'week', label: '7D' },
                    { id: 'month', label: '30D' },
                    { id: 'quarter', label: '90D' },
                    { id: 'year', label: 'Rok' }
                  ].map(p => (
                    <button key={p.id} onClick={() => setFilters(f => ({ ...f, period: p.id as any }))} className={getGlassBtnClass(filters.period === p.id)}>{p.label}</button>
                  ))}
                </div>
              </motion.div>

              <div className="grid grid-cols-2 gap-4">
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><TrendingUp size={10} /> Směr</div>
                  <div className="flex gap-1.5">
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Long') }))} className={`flex-1 ${getGlassBtnClass(filters.directions.includes('Long'), 'win')}`}>Long</button>
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Short') }))} className={`flex-1 ${getGlassBtnClass(filters.directions.includes('Short'), 'loss')}`}>Short</button>
                  </div>
                </motion.div>
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Target size={10} /> Výsledek</div>
                  <div className="flex gap-1.5">
                    {[{ id: 'Win', label: 'Win', type: 'win' }, { id: 'Loss', label: 'Loss', type: 'loss' }, { id: 'BE', label: 'BE', type: 'neutral' }].map(o => (
                      <button key={o.id} onClick={() => setFilters(f => ({ ...f, outcomes: toggleItem(f.outcomes, o.id as any) }))} className={`flex-1 ${getGlassBtnClass(filters.outcomes.includes(o.id as any), o.type as any)}`}>{o.label}</button>
                    ))}
                  </div>
                </motion.div>
              </div>

              {availableTags.htf.length > 0 && (
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Monitor size={10} /> HTF</div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTags.htf.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setFilters(f => ({ ...f, htfConfluences: toggleItem(f.htfConfluences, tag) }))}
                        className={`px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase transition-all ${filters.htfConfluences.includes(tag)
                          ? 'bg-indigo-600 border-indigo-500 text-white'
                          : (isDark ? 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-500')}`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {availableTags.ltf.length > 0 && (
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Zap size={10} /> LTF Triggery</div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTags.ltf.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setFilters(f => ({ ...f, ltfConfluences: toggleItem(f.ltfConfluences, tag) }))}
                        className={`px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase transition-all ${filters.ltfConfluences.includes(tag)
                          ? 'bg-amber-600 border-amber-500 text-white'
                          : (isDark ? 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-500')}`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {availableTags.mistakes.length > 0 && (
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><AlertOctagon size={10} /> Chyby</div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableTags.mistakes.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setFilters(f => ({ ...f, mistakes: toggleItem(f.mistakes, tag) }))}
                        className={`px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase transition-all ${filters.mistakes.includes(tag)
                          ? 'bg-rose-600 border-rose-500 text-white'
                          : (isDark ? 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-500')}`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Calendar size={10} /> Dny</div>
                  <div className="grid grid-cols-5 gap-1">
                    {TRADING_DAYS.map(day => (
                      <button key={day} onClick={() => setFilters(f => ({ ...f, days: toggleItem(f.days, day) }))} className={`aspect-square rounded-lg text-[8px] font-black flex items-center justify-center ${getGlassBtnClass(filters.days.includes(day))}`}>{day}</button>
                    ))}
                  </div>
                </motion.div>
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Clock size={10} /> Hodiny</div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[8px] font-black text-slate-500">
                      <span className={isDark ? 'text-indigo-400' : 'text-indigo-600'}>{hourRange[0]}:00</span>
                      <span className={isDark ? 'text-indigo-400' : 'text-indigo-600'}>{hourRange[1]}:00</span>
                    </div>
                    <div className="relative h-4 flex items-center px-1">
                      <div className={`absolute inset-x-1 h-0.5 rounded-full ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                      <div
                        className="absolute h-0.5 rounded-full bg-indigo-500"
                        style={{
                          left: `calc(${(hourRange[0] / 23) * 100}% + 2px)`,
                          right: `calc(${100 - (hourRange[1] / 23) * 100}% + 2px)`
                        }}
                      />
                      <input
                        type="range" min={0} max={23} value={hourRange[0]}
                        onChange={(e) => {
                          const val = Math.min(Number(e.target.value), hourRange[1] - 1);
                          setHourRange([val, hourRange[1]]);
                          const newHours = Array.from({ length: hourRange[1] - val + 1 }, (_, i) => val + i);
                          setFilters(f => ({ ...f, hours: newHours }));
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                      />
                      <input
                        type="range" min={0} max={23} value={hourRange[1]}
                        onChange={(e) => {
                          const val = Math.max(Number(e.target.value), hourRange[0] + 1);
                          setHourRange([hourRange[0], val]);
                          const newHours = Array.from({ length: val - hourRange[0] + 1 }, (_, i) => hourRange[0] + i);
                          setFilters(f => ({ ...f, hours: newHours }));
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
                      />
                      <div className="absolute w-3 h-3 rounded-full bg-white border border-indigo-500 shadow-sm pointer-events-none" style={{ left: `calc(${(hourRange[0] / 23) * 100}% - 6px + 2px)` }} />
                      <div className="absolute w-3 h-3 rounded-full bg-white border border-indigo-500 shadow-sm pointer-events-none" style={{ left: `calc(${(hourRange[1] / 23) * 100}% - 6px + 2px)` }} />
                    </div>
                  </div>
                </motion.div>
              </div>

              <motion.div variants={itemVariants}>
                <div className={sectionLabelClass}><Wallet size={10} /> Portfolia & Účty</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {accounts.map(acc => (
                    <button key={acc.id} onClick={() => setFilters(f => ({ ...f, accounts: toggleItem(f.accounts, acc.id) }))} className={`w-full py-2.5 px-3 flex items-center justify-between rounded-xl ${getGlassBtnClass(filters.accounts.includes(acc.id))}`}>
                      <span className="truncate">{acc.name}</span>
                      {filters.accounts.includes(acc.id) && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </motion.div>

              {setIsDashboardEditing && (
                <motion.div variants={itemVariants} className={`p-3 rounded-2xl border ${isDark ? 'bg-indigo-500/5 border-indigo-500/20' : 'bg-indigo-50 border-indigo-100'}`}>
                  <button onClick={() => { setIsDashboardEditing(!isDashboardEditing); setIsOpen(false); }} className={`w-full py-2.5 rounded-lg flex items-center justify-center gap-2 transition-all ${isDashboardEditing ? 'bg-indigo-600 text-white' : (isDark ? 'bg-white/5 text-slate-400 border border-white/5 hover:text-slate-200' : 'bg-white text-slate-600 border border-slate-200 shadow-sm')}`}>
                    {isDashboardEditing ? <Check size={12} /> : <LayoutGrid size={12} />}
                    <span className="text-[8px] font-black uppercase tracking-widest">{isDashboardEditing ? 'Uložit rozložení' : 'Upravit dashboard'}</span>
                  </button>
                </motion.div>
              )}
            </div>

            <div className={`px-4 py-3 border-t backdrop-blur-md flex items-center justify-between relative z-10 ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
              <span className={`text-[8px] font-black uppercase tracking-widest ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{activeFilterCount} aktivních</span>
              <button
                onClick={() => setIsOpen(false)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-black text-[9px] uppercase tracking-widest transition-all active:scale-95"
              >
                Hotovo
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 p-2 rounded-xl text-xs font-bold transition-all relative border ${isOpen
          ? (isDark ? 'bg-white/10 border-white/20 text-white backdrop-blur-md' : 'bg-slate-900 border-slate-800 text-white shadow-md')
          : (isDark ? 'bg-transparent border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200' : 'bg-transparent border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900')
          }`}
        title="Filtrovat data & Nástroje"
      >
        <Filter size={16} />
        {activeFilterCount > 0 && (
          <span className={`absolute -top-1 -right-0.5 text-[8px] font-black flex items-center justify-center w-3.5 h-3.5 rounded-full ${isDark ? 'bg-indigo-500 text-white' : 'bg-indigo-600 text-white shadow-sm'}`}>
            {activeFilterCount}
          </span>
        )}
      </button>

      {createPortal(dropdownContent, document.body)}

    </div>
  );
};

export default FilterDropdown;
