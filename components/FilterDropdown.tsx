
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Filter, RotateCcw, Calendar, Clock, Wallet, TrendingUp, Target, ShieldCheck, Monitor, Zap, AlertOctagon, LayoutGrid, Check, X, Layers, ChevronDown } from 'lucide-react';
import { TradeFilters, Account, Trade, DashboardMode, PnLDisplayMode } from '../types';

interface FilterDropdownProps {
  filters: TradeFilters;
  setFilters: React.Dispatch<React.SetStateAction<TradeFilters>>;
  accounts: Account[];
  trades: Trade[];
  theme: 'dark' | 'light' | 'oled';
  isDashboardEditing?: boolean;
  setIsDashboardEditing?: (val: boolean) => void;
  isMobileEditing?: boolean;
  setIsMobileEditing?: (val: boolean) => void;
  dashboardMode?: DashboardMode;
  setDashboardMode?: (mode: DashboardMode) => void;
  viewMode: 'individual' | 'combined';
  setViewMode: (mode: 'individual' | 'combined') => void;
  pnlDisplayMode?: PnLDisplayMode;
  setPnlDisplayMode?: (mode: PnLDisplayMode) => void;
  historyLayoutMode?: 'grid' | 'table';
  setHistoryLayoutMode?: (mode: 'grid' | 'table') => void;
  grouped?: boolean;
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
  isMobileEditing,
  setIsMobileEditing,
  dashboardMode,
  setDashboardMode,
  viewMode,
  setViewMode,
  pnlDisplayMode,
  setPnlDisplayMode,
  historyLayoutMode,
  setHistoryLayoutMode,
  grouped = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggleSection = (id: string) => setOpenSections(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
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

  const renderCollapsible = (
    id: string,
    Icon: React.ComponentType<{ size?: number; className?: string }>,
    label: string,
    badge: string | number | null,
    content: React.ReactNode
  ) => {
    const open = openSections.has(id);
    return (
      <motion.div variants={itemVariants}>
        <button
          onClick={() => toggleSection(id)}
          className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-lg border transition-all ${open
            ? (isDark ? 'bg-white/10 border-white/20' : 'bg-white border-slate-300 shadow-sm')
            : (isDark ? 'bg-white/5 border-white/5 hover:border-white/10' : 'bg-slate-100 border-slate-200 hover:border-slate-300')}`}
        >
          <Icon size={10} className={badge ? (isDark ? 'text-indigo-400' : 'text-indigo-500') : 'text-slate-500'} />
          <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">{label}</span>
          {badge ? (
            <span className="min-w-[15px] h-[15px] px-1 rounded-full text-[7px] font-black text-white flex items-center justify-center bg-indigo-500">{badge}</span>
          ) : null}
          <ChevronDown size={10} className={`ml-auto text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="pt-2">{content}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  };

  const getGlassBtnClass = (isActive: boolean, type: 'neutral' | 'win' | 'loss' | 'status-valid' | 'status-invalid' | 'status-missed' = 'neutral') => {
    const base = "transition-all duration-300 border backdrop-blur-md relative overflow-hidden text-[8px] font-black uppercase tracking-wider h-7 flex items-center justify-center rounded-lg px-1.5";
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
        type: "spring" as const,
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
              ? 'bg-theme-page-90 border-white/10 shadow-[0_-20px_50px_-12px_rgba(0,0,0,0.5)] sm:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)]'
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
                    <motion.div
                      animate={{ x: (dashboardMode === 'funded' ? 0 : dashboardMode === 'combined' ? 100 : dashboardMode === 'challenge' ? 200 : dashboardMode === 'backtesting' ? 300 : 400) + '%' }}
                      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                      className={`absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/5)] rounded-lg border ${
                        dashboardMode === 'funded' ? (isDark ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-emerald-500 shadow-sm') :
                        dashboardMode === 'combined' ? (isDark ? 'bg-orange-500/20 border-orange-500/40' : 'bg-orange-500 shadow-sm') :
                        dashboardMode === 'backtesting' ? (isDark ? 'bg-violet-500/20 border-violet-500/40' : 'bg-violet-500 shadow-sm') :
                        dashboardMode === 'archive' ? (isDark ? 'bg-slate-500/20 border-slate-500/40' : 'bg-slate-500 shadow-sm') :
                        (isDark ? 'bg-blue-500/20 border-blue-500/40' : 'bg-blue-500 shadow-sm')
                      } ${!isDark ? 'text-white' : ''}`}
                    />
                    {['funded', 'combined', 'challenge', 'backtesting', 'archive'].map((m) => (
                      <button
                        key={m}
                        onClick={() => setDashboardMode(m as DashboardMode)}
                        className={`flex-1 relative z-10 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors ${
                          dashboardMode === m
                            ? (isDark
                              ? m === 'funded' ? 'text-emerald-400' : m === 'combined' ? 'text-orange-400' : m === 'backtesting' ? 'text-violet-400' : m === 'archive' ? 'text-slate-300' : 'text-blue-400'
                              : 'text-white')
                            : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-900')}`}
                      >
                        {m === 'combined' ? 'Vše' : m === 'backtesting' ? 'BT' : m === 'archive' ? 'Archiv' : m}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <motion.div variants={itemVariants}>
                  <div className={sectionLabelClass}><Layers size={10} /> Seskupení</div>
                  <div className={`flex p-0.5 rounded-xl border relative ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'}`}>
                    <motion.div
                      animate={{ x: (viewMode === 'individual' ? 0 : 100) + '%' }}
                      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                      className={`absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/2)] rounded-lg border ${isDark ? 'bg-white/10 border-white/10' : 'bg-white shadow-sm font-black'}`}
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
                      <motion.div
                        animate={{ x: (pnlDisplayMode === 'usd' ? 0 : pnlDisplayMode === 'percent' ? 100 : 200) + '%' }}
                        transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                        className={`absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-lg border ${isDark ? 'bg-white/10 border-white/10' : 'bg-white shadow-sm font-black'}`}
                      />
                      {[{ id: 'usd', label: '$' }, { id: 'percent', label: '%' }, { id: 'rr', label: 'R' }].map(p => (
                        <button
                          key={p.id}
                          onClick={() => setPnlDisplayMode(p.id as any)}
                          className={`flex-1 relative z-10 py-1.5 rounded-lg text-[8px] font-black tracking-widest transition-colors ${pnlDisplayMode === p.id ? (isDark ? 'text-white' : 'text-slate-900') : (isDark ? 'text-slate-500 hover:text-slate-400' : 'text-slate-500 hover:text-slate-900')}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}

                {/* Zobrazení (Mřížka/Tabulka) přesunuto do kebab menu v TradeHistory toolbaru. */}
              </div>

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

              <div className="grid grid-cols-3 gap-2 items-start">
                {renderCollapsible('exekuce', ShieldCheck, 'Exekuce', filters.executionStatuses.length || null, (
                  <div className="grid grid-cols-1 gap-1.5">
                    {[
                      { id: 'Valid', label: 'Validní', type: 'status-valid' },
                      { id: 'Invalid', label: 'Nevalidní', type: 'status-invalid' },
                      { id: 'Missed', label: 'Zmešk.', type: 'status-missed' }
                    ].map(s => (
                      <button key={s.id} onClick={() => setFilters(f => ({ ...f, executionStatuses: toggleItem(f.executionStatuses, s.id as any) }))} className={getGlassBtnClass(filters.executionStatuses.includes(s.id as any), s.type as any)}>{s.label}</button>
                    ))}
                  </div>
                ))}
                {renderCollapsible('smer', TrendingUp, 'Směr', filters.directions.length || null, (
                  <div className="grid grid-cols-1 gap-1.5">
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Long') }))} className={getGlassBtnClass(filters.directions.includes('Long'), 'win')}>Long</button>
                    <button onClick={() => setFilters(f => ({ ...f, directions: toggleItem(f.directions, 'Short') }))} className={getGlassBtnClass(filters.directions.includes('Short'), 'loss')}>Short</button>
                  </div>
                ))}
                {renderCollapsible('vysledek', Target, 'Výsledek', filters.outcomes.length || null, (
                  <div className="grid grid-cols-1 gap-1.5">
                    {[{ id: 'Win', label: 'Win', type: 'win' }, { id: 'Loss', label: 'Loss', type: 'loss' }, { id: 'BE', label: 'BE', type: 'neutral' }].map(o => (
                      <button key={o.id} onClick={() => setFilters(f => ({ ...f, outcomes: toggleItem(f.outcomes, o.id as any) }))} className={getGlassBtnClass(filters.outcomes.includes(o.id as any), o.type as any)}>{o.label}</button>
                    ))}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 items-start">
                {(() => {
                  const tagGroups = [
                    { id: 'htf', label: 'HTF', icon: Monitor, tags: availableTags.htf, selected: filters.htfConfluences, key: 'htfConfluences', iconColor: 'text-indigo-400', activeClass: 'bg-indigo-600 border-indigo-500 text-white' },
                    { id: 'ltf', label: 'LTF', icon: Zap, tags: availableTags.ltf, selected: filters.ltfConfluences, key: 'ltfConfluences', iconColor: 'text-amber-400', activeClass: 'bg-amber-600 border-amber-500 text-white' },
                    { id: 'mistakes', label: 'Chyby', icon: AlertOctagon, tags: availableTags.mistakes, selected: filters.mistakes, key: 'mistakes', iconColor: 'text-rose-400', activeClass: 'bg-rose-600 border-rose-500 text-white' },
                  ].filter(g => g.tags.length > 0);
                  if (tagGroups.length === 0) return null;
                  const totalSelected = tagGroups.reduce((sum, g) => sum + g.selected.length, 0);
                  return renderCollapsible('konfluence', Layers, 'Konfluence', totalSelected || null, (
                    <div className="space-y-2.5">
                      {tagGroups.map(g => (
                        <div key={g.id}>
                          <div className="flex items-center gap-1.5 mb-1.5 text-[8px] font-black uppercase tracking-widest text-slate-500">
                            <g.icon size={9} className={g.selected.length > 0 ? g.iconColor : 'text-slate-500'} /> {g.label}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {g.tags.map(tag => (
                              <button
                                key={tag}
                                onClick={() => setFilters(f => ({ ...f, [g.key]: toggleItem((f as any)[g.key], tag) }))}
                                className={`px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase transition-all ${g.selected.includes(tag)
                                  ? g.activeClass
                                  : (isDark ? 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-500')}`}
                              >
                                {tag}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ));
                })()}

                {(() => {
                  const daysActive = filters.days.length > 0 && filters.days.length < 5;
                  const hoursActive = hourRange[0] !== 0 || hourRange[1] !== 23;
                  const badge = (daysActive ? 1 : 0) + (hoursActive ? 1 : 0);
                  return renderCollapsible('cas', Clock, 'Dny & Hodiny', badge || null, (
                    <div className="space-y-3">
                      <div>
                        <div className="mb-1.5 flex items-center gap-1.5 text-[8px] font-black uppercase tracking-widest text-slate-500"><Calendar size={9} /> Dny</div>
                        <div className="grid grid-cols-5 gap-1">
                          {TRADING_DAYS.map(day => (
                            <button key={day} onClick={() => setFilters(f => ({ ...f, days: toggleItem(f.days, day) }))} className={`aspect-square rounded-lg text-[8px] font-black flex items-center justify-center ${getGlassBtnClass(filters.days.includes(day))}`}>{day}</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1.5 flex items-center gap-1.5 text-[8px] font-black uppercase tracking-widest text-slate-500"><Clock size={9} /> Hodiny</div>
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
                      </div>
                    </div>
                  ));
                })()}
              </div>

              <motion.div variants={itemVariants}>
                <div className={sectionLabelClass}><Wallet size={10} /> Portfolia & Účty</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {accounts.filter(a => {
                    // V "Vše" / "Archiv" módu chceme i Inactive (archivované/spálené) účty.
                    // V ostatních módech jen Active.
                    if (dashboardMode === 'archive') return a.status === 'Inactive';
                    if (dashboardMode === 'combined') return true;
                    return a.status === 'Active';
                  }).map(acc => (
                    <button key={acc.id} onClick={() => setFilters(f => ({ ...f, accounts: toggleItem(f.accounts, acc.id) }))} className={`w-full py-2.5 px-3 flex items-center justify-between rounded-xl ${getGlassBtnClass(filters.accounts.includes(acc.id))}`}>
                      <span className={`truncate ${acc.status === 'Inactive' ? 'opacity-60' : ''}`}>
                        {acc.name}
                        {acc.status === 'Inactive' && <span className="ml-1.5 text-[8px] text-rose-400">·spálený</span>}
                      </span>
                      {filters.accounts.includes(acc.id) && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </motion.div>


            </div>

            <div className={`px-4 py-3 border-t backdrop-blur-md flex items-center justify-between relative z-10 ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
              <span className={`text-[8px] font-black uppercase tracking-widest ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{activeFilterCount} aktivních</span>
              <div className="flex items-center gap-2">
                {/* Desktop: edit grid layout */}
                {setIsDashboardEditing && (
                  <button
                    onClick={() => { setIsDashboardEditing(!isDashboardEditing); setIsOpen(false); }}
                    className={`hidden md:flex items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all active:scale-95 border ${
                      isDashboardEditing
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                        : (isDark
                          ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300'
                          : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-sm')
                    }`}
                  >
                    {isDashboardEditing ? <Check size={12} /> : <LayoutGrid size={12} />}
                    {isDashboardEditing ? 'Uložit' : 'Upravit'}
                  </button>
                )}
                {/* Mobile: edit widget list */}
                {setIsMobileEditing && (
                  <button
                    onClick={() => { setIsMobileEditing(!isMobileEditing); setIsOpen(false); }}
                    className={`flex md:hidden items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all active:scale-95 border ${
                      isMobileEditing
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                        : (isDark
                          ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300'
                          : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-sm')
                    }`}
                  >
                    {isMobileEditing ? <Check size={12} /> : <LayoutGrid size={12} />}
                    {isMobileEditing ? 'Uložit' : 'Upravit'}
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-black text-[9px] uppercase tracking-widest transition-all active:scale-95"
                >
                  Hotovo
                </button>
              </div>
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
        className={grouped ? (
          `p-2.5 rounded-xl border transition-all duration-200 relative ${
            isOpen
              ? (isDark ? 'bg-white/15 border-white/20 text-white shadow-inner' : 'bg-slate-200 border-slate-300 text-slate-950 shadow-inner')
              : (isDark ? 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-400 hover:text-white shadow-inner' : 'bg-white border-slate-200/80 hover:bg-slate-50 text-slate-700 shadow-xs')
          }`
        ) : (
          `p-2.5 rounded-xl border transition-all duration-200 relative ${
            isOpen
              ? (isDark ? 'bg-white/15 border-white/25 text-white backdrop-blur-md shadow-[0_0_15px_rgba(255,255,255,0.05)]' : 'bg-white/80 border-slate-300 text-slate-900 shadow-sm backdrop-blur-sm')
              : (isDark ? 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-400 hover:text-white' : 'bg-white/40 border-black/5 hover:bg-white/60 text-slate-700 shadow-sm backdrop-blur-sm')
          }`
        )}
        title="Filtrovat data & Nástroje"
      >
        <Filter size={20} />
        {activeFilterCount > 0 && (
          <span className={`absolute -top-1 -right-1 text-[8px] font-black flex items-center justify-center w-4.5 h-4.5 rounded-full ${isDark ? 'bg-indigo-500 text-white' : 'bg-indigo-600 text-white shadow-sm'}`}>
            {activeFilterCount}
          </span>
        )}
      </button>

      {createPortal(dropdownContent, document.body)}

    </div>
  );
};

export default FilterDropdown;
