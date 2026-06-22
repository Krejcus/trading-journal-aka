import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutDashboard, History, BookOpen, Bot, Plus, MoreHorizontal, Globe, Wallet, Settings, X, Briefcase, Lock, FlaskConical, Radio, Layers } from 'lucide-react';
import type { UserRole } from '../types';
import { isLocked } from '../utils/featureGating';

interface BottomNavProps {
  activePage: string;
  onNavigate: (page: string) => void;
  onAddTrade: () => void;
  theme: 'dark' | 'light' | 'oled';
  userRole?: UserRole;
  onLockedFeature?: (featureId: string) => void;
  /** Počet importovaných obchodů k doplnění — malý glass badge u Historie. */
  enrichCount?: number;
  /** Aktuální mód dashboardu — 'backtesting' zrcadlí sidebar (skryje Byznys/Síť, Účty→Session). */
  dashboardMode?: string;
  /** Přepnutí live ↔ backtest svět (spustí World Shift přechod). */
  onToggleBacktest?: () => void;
}

const BottomNav: React.FC<BottomNavProps> = ({ activePage, onNavigate, onAddTrade, theme, userRole, onLockedFeature, enrichCount = 0, dashboardMode, onToggleBacktest }) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const isDark = theme !== 'light';
  const isBacktest = dashboardMode === 'backtesting';

  const mainItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'history', label: 'Historie', icon: History },
    { id: 'journal', label: 'Deník', icon: BookOpen },
    { id: 'ai', label: 'AI', icon: Bot },
  ];

  const moreItems = (isBacktest
    ? [
        { id: 'accounts', label: 'Session', icon: Layers },
        { id: 'settings', label: 'Nastavení', icon: Settings },
      ]
    : [
        { id: 'business', label: 'Byznys', icon: Briefcase },
        { id: 'network', label: 'Síť', icon: Globe },
        { id: 'accounts', label: 'Účty', icon: Wallet },
        { id: 'settings', label: 'Nastavení', icon: Settings },
      ]);

  const handleNavigate = (page: string) => {
    // Locked feature pro non-owner → otevřít info modal
    if (isLocked(page, userRole)) {
      if (onLockedFeature) onLockedFeature(page);
      setMoreOpen(false);
      return;
    }
    onNavigate(page);
    setMoreOpen(false);
  };

  return (
    <>
      {/* More menu overlay */}
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm lg:hidden"
              onClick={() => setMoreOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className={`fixed bottom-24 right-4 z-[80] lg:hidden rounded-2xl border shadow-2xl overflow-hidden ${isDark ? 'bg-black/80 border-white/10 backdrop-blur-2xl' : 'bg-white border-slate-200'}`}
            >
              {/* Přepínač live ↔ backtest svět */}
              {onToggleBacktest && (
                <>
                  <button
                    onClick={() => { onToggleBacktest(); setMoreOpen(false); }}
                    className={`flex items-center gap-3 w-full px-5 py-4 text-sm font-black uppercase tracking-wider transition-colors ${
                      isBacktest
                        ? 'text-emerald-500 hover:bg-emerald-500/10'
                        : 'text-violet-500 hover:bg-violet-500/10'
                    }`}
                  >
                    {isBacktest ? <Radio size={18} /> : <FlaskConical size={18} />}
                    <span className="flex-1 text-left">{isBacktest ? 'Zpět na Live' : 'Backtest'}</span>
                  </button>
                  <div className={`h-px mx-3 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                </>
              )}
              {moreItems.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                const locked = isLocked(item.id, userRole);
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavigate(item.id)}
                    className={`flex items-center gap-3 w-full px-5 py-4 text-sm font-bold uppercase tracking-wider transition-colors ${locked ? 'opacity-50' : ''} ${
                      isActive && !locked
                        ? isDark ? 'text-white bg-white/10' : 'text-slate-900 bg-slate-100'
                        : isDark ? 'text-slate-400 hover:text-white hover:bg-white/5' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                  >
                    <Icon size={18} />
                    <span className="flex-1 text-left">{item.label}</span>
                    {locked && <Lock size={12} className="text-amber-400/80" />}
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bottom Navigation Bar — plovoucí liquid glass pruh (stejné sklo jako desktop header) */}
      <nav
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
        className="fixed left-3 right-3 z-[60] lg:hidden rounded-2xl floating-glass-header glass-bar-clear"
      >
        <div className="relative z-10 flex items-center justify-around px-2">
          {mainItems.slice(0, 2).map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            const locked = isLocked(item.id, userRole);
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`flex flex-col items-center gap-1 py-3 px-4 min-w-[56px] transition-all active:scale-90 ${locked ? 'opacity-40' : ''} ${isActive && !locked ? (isDark ? 'text-white' : 'text-slate-900') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}
              >
                <div className="relative p-1.5 rounded-xl transition-colors">
                  <Icon size={20} strokeWidth={isActive ? 2 : 1.8} />
                  {locked && <Lock size={9} className="absolute -top-0.5 -right-0.5 text-amber-400/80 bg-[var(--bg-page)] rounded-full p-0.5" />}
                  {item.id === 'history' && enrichCount > 0 && (
                    <span className="absolute -top-1.5 -left-1.5 min-w-[15px] h-[15px] px-1 rounded-full border border-amber-500/60 text-amber-500 text-[8px] font-black flex items-center justify-center">{enrichCount}</span>
                  )}
                </div>
                <span className={`text-[9px] font-bold uppercase tracking-wider ${isActive ? 'opacity-100' : 'opacity-60'}`}>{item.label}</span>
              </button>
            );
          })}

          {/* FAB - Zapsat obchod */}
          <button
            onClick={onAddTrade}
            className="flex flex-col items-center gap-1 py-2 px-2 -mt-4"
          >
            <div className={`w-11 h-11 rounded-2xl border-2 border-emerald-500 flex items-center justify-center active:scale-90 transition-transform ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
              <Plus size={20} strokeWidth={2} className="text-emerald-400" />
            </div>
            <span className={`text-[9px] font-bold uppercase tracking-wider mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Zapsat</span>
          </button>

          {mainItems.slice(2, 4).map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            const locked = isLocked(item.id, userRole);
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`flex flex-col items-center gap-1 py-3 px-4 min-w-[56px] transition-all active:scale-90 ${locked ? 'opacity-40' : ''} ${isActive && !locked ? (isDark ? 'text-white' : 'text-slate-900') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}
              >
                <div className="relative p-1.5 rounded-xl transition-colors">
                  <Icon size={20} strokeWidth={isActive ? 2 : 1.8} />
                  {locked && <Lock size={9} className="absolute -top-0.5 -right-0.5 text-amber-400/80 bg-[var(--bg-page)] rounded-full p-0.5" />}
                </div>
                <span className={`text-[9px] font-bold uppercase tracking-wider ${isActive ? 'opacity-100' : 'opacity-60'}`}>{item.label}</span>
              </button>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className={`flex flex-col items-center gap-1 py-3 px-4 min-w-[56px] transition-all active:scale-90 ${
              moreItems.some(i => i.id === activePage) || moreOpen
                ? (isDark ? 'text-white' : 'text-slate-900')
                : (isDark ? 'text-slate-500' : 'text-slate-400')
            }`}
          >
            <div className={`relative p-1.5 rounded-xl transition-colors ${(moreItems.some(i => i.id === activePage) || moreOpen) ? (isDark ? 'bg-white/10' : 'bg-slate-100') : ''}`}>
              {moreOpen ? <X size={20} strokeWidth={2} /> : <MoreHorizontal size={20} strokeWidth={1.8} />}
            </div>
            <span className="text-[9px] font-bold uppercase tracking-wider opacity-60">Více</span>
          </button>
        </div>
      </nav>
    </>
  );
};

export default BottomNav;
