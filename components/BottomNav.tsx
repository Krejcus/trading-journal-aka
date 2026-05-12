import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutDashboard, History, BookOpen, Briefcase, Plus, MoreHorizontal, Globe, Wallet, Settings, X } from 'lucide-react';

interface BottomNavProps {
  activePage: string;
  onNavigate: (page: string) => void;
  onAddTrade: () => void;
  theme: 'dark' | 'light' | 'oled';
}

const BottomNav: React.FC<BottomNavProps> = ({ activePage, onNavigate, onAddTrade, theme }) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const isDark = theme !== 'light';

  const mainItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'history', label: 'Historie', icon: History },
    { id: 'journal', label: 'Deník', icon: BookOpen },
    { id: 'business', label: 'Byznys', icon: Briefcase },
  ];

  const moreItems = [
    { id: 'network', label: 'Síť', icon: Globe },
    { id: 'accounts', label: 'Účty', icon: Wallet },
    { id: 'settings', label: 'Nastavení', icon: Settings },
  ];

  const handleNavigate = (page: string) => {
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
              {moreItems.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavigate(item.id)}
                    className={`flex items-center gap-3 w-full px-5 py-4 text-sm font-bold uppercase tracking-wider transition-colors ${
                      isActive
                        ? isDark ? 'text-white bg-white/10' : 'text-slate-900 bg-slate-100'
                        : isDark ? 'text-slate-400 hover:text-white hover:bg-white/5' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                  >
                    <Icon size={18} />
                    {item.label}
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bottom Navigation Bar */}
      <nav className={`fixed bottom-0 left-0 right-0 z-[60] lg:hidden border-t ${isDark ? 'bg-black/80 border-white/10 backdrop-blur-2xl' : 'bg-white/90 border-slate-200 backdrop-blur-xl'}`}>
        <div className="flex items-center justify-around px-2 pb-safe">
          {mainItems.slice(0, 2).map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`flex flex-col items-center gap-1 py-3 px-4 min-w-[56px] transition-all active:scale-90 ${isActive ? (isDark ? 'text-white' : 'text-slate-900') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}
              >
                <div className="relative p-1.5 rounded-xl transition-colors">
                  <Icon size={20} strokeWidth={isActive ? 2 : 1.8} />
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
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`flex flex-col items-center gap-1 py-3 px-4 min-w-[56px] transition-all active:scale-90 ${isActive ? (isDark ? 'text-white' : 'text-slate-900') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}
              >
                <div className="relative p-1.5 rounded-xl transition-colors">
                  <Icon size={20} strokeWidth={isActive ? 2 : 1.8} />
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
