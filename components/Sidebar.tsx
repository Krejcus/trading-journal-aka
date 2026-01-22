
import React, { useState } from 'react';
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
  onNavigate?: (page: string) => void;
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
  onOpenProfile,
  onNavigate
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
    ${isDark ? 'bg-black/40' : 'bg-white/80'} 
    border-r border-white/5 backdrop-blur-[32px]
    flex flex-col shadow-[20px_0_50px_rgba(0,0,0,0.1)]
  `;

  const navItemClass = (isActive: boolean) => `
    w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 border relative group overflow-hidden
    ${isActive
      ? (isDark
        ? 'bg-white/10 border-white/20 text-white shadow-[0_0_20px_rgba(255,255,255,0.1)] shadow-inner'
        : 'bg-slate-900/10 border-slate-900/20 text-slate-900 shadow-[0_4px_12px_rgba(15,23,42,0.08)]')
      : 'bg-transparent border-transparent theme-text-secondary lg:hover:bg-white/5 lg:hover:text-[var(--text-primary)] lg:hover:translate-x-1 active:scale-95'
    }
    ${isCollapsed ? 'justify-center px-0 mx-auto w-12 h-12' : 'px-5 mx-2'}
  `;

  const handleNavClick = (pageId: string) => {
    if (onNavigate) {
      onNavigate(pageId);
    } else {
      setActivePage(pageId);
      setIsOpen(false);
    }
  };

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

          {/* BRANDING SECTION - AURORA HALO STYLE */}
          <div className="relative pt-4 pb-6">
            {/* Background Aurora Effect */}
            {!isCollapsed && isDark && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-cyan-500/10 blur-[60px] rounded-full animate-pulse pointer-events-none"></div>
            )}

            <div
              className={`relative flex flex-col items-center gap-2 transition-all duration-500 group cursor-default ${isCollapsed ? 'py-1' : 'py-2'}`}
            >
              {/* Logo with Hover Glow */}
              <div className={`
                relative shrink-0 flex items-center justify-center transition-all duration-500
                ${isCollapsed ? 'w-10 h-10' : 'w-24 h-24'}
              `}>
                <img
                  src="/logos/at_logo_light_clean.png"
                  alt="Alpha Trade Logo"
                  className={`
                    w-full h-full object-contain transition-all duration-500 
                    group-hover:scale-110
                    ${isDark
                      ? 'drop-shadow-[0_0_20px_rgba(34,211,238,0.3)] group-hover:drop-shadow-[0_0_35px_rgba(34,211,238,0.6)]'
                      : 'group-hover:drop-shadow-[0_0_25px_rgba(34,211,238,0.4)]'
                    }
                  `}
                />
              </div>

              {/* Typography */}
              {!isCollapsed && (
                <div className="flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-700">
                  <h1 className={`
                    uppercase leading-none whitespace-nowrap transition-all duration-500 font-extralight text-[18px] tracking-[0.5em]
                    ${isDark ? 'text-white' : 'text-slate-900'}
                  `}>
                    ALPHA <span className="text-cyan-500 font-normal">TRADE</span>
                  </h1>
                </div>
              )}
            </div>

            <button onClick={() => setIsOpen(false)} className="lg:hidden absolute top-6 right-6 p-2 hover:bg-white/10 rounded-full text-slate-400"><X size={20} /></button>
          </div>

          {/* ZAPSAT OBCHOD - EMERALD GLASS STYLE */}
          <div className={`px-4 mb-4 transition-all ${isCollapsed ? 'lg:px-0' : ''}`}>
            <button
              onClick={onAddTrade}
              title={isCollapsed ? "Zapsat obchod" : ""}
              className={`flex items-center justify-center gap-3 transition-all duration-300 border backdrop-blur-md active:scale-95 group
                bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] lg:hover:bg-emerald-500/20 lg:hover:border-emerald-500/50
                ${isCollapsed ? 'w-12 h-12 rounded-2xl mx-auto' : 'w-[calc(100%-16px)] mx-2 py-2.5 rounded-[20px]'}
              `}
            >
              <Plus size={isCollapsed ? 22 : 18} strokeWidth={3} className="group-hover:rotate-90 transition-transform duration-500" />
              {!isCollapsed && <span className="font-black text-[11px] uppercase tracking-[0.2em] animate-in fade-in duration-500">Zapsat obchod</span>}
            </button>
          </div>
        </div>

        {/* Navigation - Scrollable Area */}
        <nav className="flex-1 px-2 space-y-2 overflow-y-auto custom-scrollbar no-scrollbar py-2">
          {!isCollapsed && (
            <p
              className="px-6 text-[9px] font-black uppercase text-slate-500 mb-3 mt-4 tracking-[0.3em] animate-in fade-in duration-500 cursor-pointer hover:text-white transition-colors"
            >
              Analytika
            </p>
          )}
          {isCollapsed && <div className="h-px bg-[var(--border-subtle)] mx-6 my-4" />}

          {mainItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={navItemClass(isActive)}
                title={isCollapsed ? item.label : ""}
              >
                <Icon size={isCollapsed ? 20 : 16} className={isActive ? (isDark ? 'text-white' : 'text-slate-900') : 'text-current'} />
                {!isCollapsed && <span className="animate-in fade-in duration-500 whitespace-nowrap">{item.label}</span>}
                {isActive && !isCollapsed && (
                  <div className={`absolute right-4 w-1 h-3 rounded-full ${isDark ? 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'bg-slate-900 shadow-[0_0_8px_rgba(15,23,42,0.3)]'}`}></div>
                )}
                {/* Subtle highlight sheen */}
                <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 -translate-x-full group-hover:translate-x-full transition-all duration-1000"></div>
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
                onClick={() => handleNavClick(item.id)}
                className={navItemClass(isActive)}
                title={isCollapsed ? item.label : ""}
              >
                <Icon size={isCollapsed ? 20 : 16} className={isActive ? (isDark ? 'text-white' : 'text-slate-900') : 'text-current'} />
                {!isCollapsed && <span className="animate-in fade-in duration-500 whitespace-nowrap">{item.label}</span>}
                {isActive && !isCollapsed && (
                  <div className={`absolute right-4 w-1 h-3 rounded-full ${isDark ? 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'bg-slate-900 shadow-[0_0_8px_rgba(15,23,42,0.3)]'}`}></div>
                )}
                {/* Subtle highlight sheen */}
                <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 -translate-x-full group-hover:translate-x-full transition-all duration-1000"></div>
              </button>
            );
          })}
        </nav>

        {/* User Profile - Fixed at the Bottom - CLICKABLE */}
        <div className={`p-4 mt-auto border-t transition-colors ${isDark ? 'border-white/5' : 'border-slate-200'} ${isCollapsed ? 'lg:p-2' : ''}`}>
          <div
            onClick={onOpenProfile}
            className={`
              flex items-center justify-between gap-3 p-4 rounded-[24px] transition-all relative overflow-hidden group cursor-pointer 
              ${isDark ? 'bg-white/[0.03] border border-white/10 hover:bg-white/[0.05] hover:border-white/20' : 'bg-slate-50 border border-slate-200 hover:bg-slate-100'} 
              lg:hover:shadow-2xl active:scale-95
            `}
          >
            <div className="flex items-center gap-4 min-w-0 relative z-10">
              <div className="w-10 h-10 rounded-2xl border border-white/10 overflow-hidden flex-shrink-0 shadow-[0_8px_16px_rgba(0,0,0,0.2)]">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-400 flex items-center justify-center">
                    <UserIcon size={18} />
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="min-w-0 animate-in fade-in duration-500">
                  <p className="text-[10px] font-black uppercase truncate tracking-wider">{user.name}</p>
                  <p className="text-[8px] font-bold uppercase text-emerald-500 tracking-[0.2em] mt-0.5 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                    Online • Profile
                  </p>
                </div>
              )}
            </div>
            {!isCollapsed && (
              <button
                onClick={(e) => { e.stopPropagation(); onLogout(); }}
                className="p-2 text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all animate-in fade-in duration-500 relative z-10"
                title="Odhlásit se"
              >
                <LogOut size={16} />
              </button>
            )}
            {/* Subtle profile glow */}
            <div className="absolute -inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
