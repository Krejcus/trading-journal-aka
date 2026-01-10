
import React from 'react';
import {
  LayoutDashboard,
  History,
  BarChart3,
  Settings,
  X,
  PlusCircle,
  BarChart2,
  Wallet,
  BookOpen,
  LogOut,
  User as UserIcon,
  ChevronLeft,
  ChevronRight,
  Zap,
  Plus,
  Globe,
  Briefcase
} from 'lucide-react';
import { User } from '../types';

interface SidebarProps {
  activePage: string;
  setActivePage: (page: any) => void;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  isCollapsed: boolean;
  setIsCollapsed: (isCollapsed: boolean) => void;
  theme: 'dark' | 'light' | 'oled';
  onAddTrade: () => void;
  user: User;
  onLogout: () => void;
  onOpenProfile: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  setActivePage,
  isOpen,
  setIsOpen,
  isCollapsed,
  setIsCollapsed,
  theme,
  onAddTrade,
  user,
  onLogout,
  onOpenProfile
}) => {
  const mainItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'history', label: 'Historie', icon: History },
    { id: 'journal', label: 'Deník & Rituály', icon: BookOpen },
    { id: 'business', label: 'Business Hub', icon: Briefcase },
  ];

  const secondaryItems = [
    { id: 'network', label: 'Network', icon: Globe },
    { id: 'accounts', label: 'Účty', icon: Wallet },
    { id: 'settings', label: 'Nastavení', icon: Settings },
  ];

  const isDark = theme !== 'light';

  const sidebarClasses = `
    fixed inset-y-0 left-0 z-[60] transform transition-all duration-500 ease-in-out
    ${isOpen ? 'translate-x-0' : '-translate-x-full'} 
    lg:translate-x-0 lg:fixed lg:top-0 lg:h-screen
    ${isCollapsed ? 'lg:w-24' : 'lg:w-72'}
    bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] backdrop-blur-2xl
    flex flex-col
  `;

  const navItemClass = (isActive: boolean) => `
    w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 border relative group
    ${isActive
      ? 'bg-blue-600/10 border-blue-600/30 text-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.05)] backdrop-blur-md'
      : 'bg-transparent border-transparent theme-text-secondary hover:bg-[var(--text-primary)]/5 hover:text-[var(--text-primary)]'
    }
    ${isCollapsed ? 'justify-center px-0 mx-auto w-12 h-12' : 'px-5 mx-2'}
  `;

  return (
    <>
      {/* Mobile Overlay */}
      {isOpen && <div className="fixed inset-0 z-[50] bg-black/60 backdrop-blur-md lg:hidden" onClick={() => setIsOpen(false)} />}

      <aside className={sidebarClasses}>
        {/* Header - Logo & Toggle */}
        <div className="flex-shrink-0 relative">
          {/* Collapse Toggle Button (Desktop Only) */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="hidden lg:flex absolute -right-3 top-10 z-[70] w-6 h-6 items-center justify-center rounded-full border shadow-2xl transition-all hover:scale-110 active:scale-90 theme-card theme-border theme-text-secondary"
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </button>

          <div className={`p-8 flex items-center justify-between ${isCollapsed ? 'lg:p-6 lg:justify-center' : ''}`}>
            <div className="flex items-center gap-4 overflow-hidden">
              <div className="p-2.5 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.1)] flex-shrink-0">
                <BarChart2 className="text-indigo-400 w-6 h-6" />
              </div>
              {!isCollapsed && (
                <div className="animate-in fade-in slide-in-from-left-4 duration-500">
                  <h1 className="font-black text-xl tracking-tighter italic uppercase leading-none">AlphaTrade</h1>
                  <p className="text-[8px] font-black theme-text-secondary uppercase tracking-[0.3em] mt-1">Terminal Hub</p>
                </div>
              )}
            </div>
            <button onClick={() => setIsOpen(false)} className="lg:hidden p-2 hover:bg-[var(--text-primary)]/10 rounded-full text-slate-400"><X size={24} /></button>
          </div>

          {/* ZAPSAT OBCHOD - EMERALD GLASS STYLE */}
          <div className={`px-4 mb-8 transition-all ${isCollapsed ? 'lg:px-0' : ''}`}>
            <button
              onClick={onAddTrade}
              title={isCollapsed ? "Zapsat obchod" : ""}
              className={`flex items-center justify-center gap-3 transition-all duration-300 border backdrop-blur-md active:scale-95 group
                bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] hover:bg-emerald-500/20 hover:border-emerald-500/50
                ${isCollapsed ? 'w-12 h-12 rounded-2xl mx-auto' : 'w-[calc(100%-16px)] mx-2 py-4 rounded-[20px]'}
              `}
            >
              <Plus size={isCollapsed ? 22 : 18} strokeWidth={3} className="group-hover:rotate-90 transition-transform duration-500" />
              {!isCollapsed && <span className="font-black text-[11px] uppercase tracking-[0.2em] animate-in fade-in duration-500">Zapsat obchod</span>}
            </button>
          </div>
        </div>

        {/* Navigation - Scrollable Area */}
        <nav className="flex-1 px-2 space-y-2 overflow-y-auto custom-scrollbar no-scrollbar py-2">
          {!isCollapsed && <p className="px-6 text-[9px] font-black uppercase text-slate-500 mb-3 mt-4 tracking-[0.3em] animate-in fade-in duration-500">Analytika</p>}
          {isCollapsed && <div className="h-px bg-[var(--border-subtle)] mx-6 my-4" />}

          {mainItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { setActivePage(item.id); setIsOpen(false); }}
                className={navItemClass(isActive)}
                title={isCollapsed ? item.label : ""}
              >
                <Icon size={isCollapsed ? 20 : 16} className={isActive ? 'text-blue-500' : 'text-current'} />
                {!isCollapsed && <span className="animate-in fade-in duration-500 whitespace-nowrap">{item.label}</span>}
                {isActive && !isCollapsed && <div className="absolute right-4 w-1.5 h-1.5 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>}
              </button>
            );
          })}

          {!isCollapsed && <p className="px-6 text-[9px] font-black uppercase text-slate-500 mb-3 mt-10 tracking-[0.3em] animate-in fade-in duration-500">Konfigurace</p>}
          {isCollapsed && <div className="h-px bg-[var(--border-subtle)] mx-6 my-8" />}

          {secondaryItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { setActivePage(item.id); setIsOpen(false); }}
                className={navItemClass(isActive)}
                title={isCollapsed ? item.label : ""}
              >
                <Icon size={isCollapsed ? 20 : 16} className={isActive ? 'text-blue-500' : 'text-current'} />
                {!isCollapsed && <span className="animate-in fade-in duration-500 whitespace-nowrap">{item.label}</span>}
                {isActive && !isCollapsed && <div className="absolute right-4 w-1.5 h-1.5 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>}
              </button>
            );
          })}
        </nav>

        {/* User Profile - Fixed at the Bottom - CLICKABLE */}
        <div className={`p-4 mt-auto border-t transition-colors ${isDark ? 'border-white/5' : 'border-slate-200'} ${isCollapsed ? 'lg:p-2' : ''}`}>
          <div
            onClick={onOpenProfile}
            className="flex items-center justify-between gap-3 p-4 rounded-[24px] transition-all relative overflow-hidden group cursor-pointer theme-card theme-border hover:shadow-lg"
          >
            <div className="flex items-center gap-4 min-w-0 relative z-10">
              <div className="w-10 h-10 rounded-2xl border border-[var(--border-subtle)] overflow-hidden flex-shrink-0 shadow-inner">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                    <UserIcon size={18} />
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="min-w-0 animate-in fade-in duration-500">
                  <p className="text-[10px] font-black uppercase truncate">{user.name}</p>
                  <p className="text-[8px] font-bold uppercase text-emerald-500 tracking-widest mt-0.5">Online • Profile</p>
                </div>
              )}
            </div>
            {!isCollapsed && (
              <button
                onClick={(e) => { e.stopPropagation(); onLogout(); }}
                className="p-2 text-slate-600 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all animate-in fade-in duration-500 relative z-10"
                title="Odhlásit se"
              >
                <LogOut size={16} />
              </button>
            )}
            {/* Subtle profile glow */}
            <div className="absolute -bottom-4 -left-4 w-12 h-12 bg-indigo-500/10 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
