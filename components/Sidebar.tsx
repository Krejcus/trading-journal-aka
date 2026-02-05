import React, { useState } from 'react';
import {
    LayoutDashboard,
    History,
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
    Plus,
    Globe,
    Briefcase
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { User } from '../types';
import { t } from '../services/translations';

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
    const lang = user.language || 'cs';
    const [isHovered, setIsHovered] = useState(false);
    const [isClicked, setIsClicked] = useState(false);

    // Core logic: Sidebar is expanded if either pinned (!isCollapsed) OR hovered (but NOT if we just clicked an item)
    // Professional behavior: Click -> Collapse immediately -> Re-expand on fresh hover
    const isExpanded = !isCollapsed || (isHovered && !isClicked);

    const mainItems = [
        { id: 'dashboard', label: t('dashboard', lang), icon: LayoutDashboard },
        { id: 'history', label: t('history', lang) || 'Historie', icon: History },
        { id: 'journal', label: t('journal', lang), icon: BookOpen },
        { id: 'business', label: t('business', lang), icon: Briefcase },
    ];

    const secondaryItems = [
        { id: 'network', label: t('network', lang), icon: Globe },
        { id: 'accounts', label: t('accounts', lang), icon: Wallet },
        { id: 'settings', label: t('settings', lang), icon: Settings },
    ];

    const isDark = theme !== 'light';

    // Base classes preserved from original (minus the width which is now animated)
    const sidebarBaseClasses = `
    fixed inset-y-0 left-0 z-[60] 
    ${isDark ? 'bg-black/40' : 'bg-[var(--bg-sidebar)]'} 
    border-r border-white/5 backdrop-blur-[32px]
    flex flex-col shadow-[20px_0_50px_rgba(0,0,0,0.1)]
    lg:translate-x-0 lg:fixed lg:top-0 lg:h-screen overflow-hidden
  `;

    const navItemClass = (isActive: boolean) => `
    w-full flex items-center gap-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 border relative group overflow-hidden h-10
    ${isActive
            ? (isDark
                ? 'bg-white/10 border-white/20 text-white shadow-[0_0_20px_rgba(255,255,255,0.1)] shadow-inner'
                : 'bg-[var(--bg-page)] border-[var(--border-active)] text-[var(--text-primary)] shadow-[0_4px_12px_rgba(15,23,42,0.08)]')
            : 'bg-transparent border-transparent theme-text-secondary lg:hover:bg-white/5 lg:hover:text-[var(--text-primary)] active:scale-95'
        }
  `;

    const handleNavClick = (pageId: string) => {
        // Force collapse on click for "pro" feel
        setIsClicked(true);

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

            <motion.aside
                initial={false}
                animate={{
                    width: isExpanded ? 240 : 72,
                    x: isOpen ? 0 : (window.innerWidth < 1024 ? -240 : 0)
                }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className={sidebarBaseClasses}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => {
                    setIsHovered(false);
                    setIsClicked(false); // Reset click state on leave so it can re-expand on next hover
                }}
            >
                {/* Header - Logo & Toggle */}
                <div className="flex-shrink-0 relative">
                    {/* BRANDING SECTION - AURORA HALO STYLE */}
                    <div className="relative pt-6 h-[170px] flex items-center justify-center">
                        {/* Background Aurora Effect */}
                        {isExpanded && isDark && (
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-cyan-500/10 blur-[60px] rounded-full animate-pulse pointer-events-none"></div>
                        )}

                        <div
                            className="relative flex flex-col items-center gap-3 transition-all duration-500 group cursor-default"
                        >
                            {/* Logo with Hover Glow */}
                            <div className="h-[96px] flex items-center justify-center">
                                <motion.div
                                    initial={{ width: isExpanded ? 96 : 64, height: isExpanded ? 96 : 64 }}
                                    animate={{ width: isExpanded ? 96 : 64, height: isExpanded ? 96 : 64 }}
                                    className="relative shrink-0 flex items-center justify-center transition-all duration-500 text-center"
                                >
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
                                </motion.div>
                            </div>

                            {/* Typography */}
                            <div className="h-[24px] flex items-center justify-center">
                                <AnimatePresence>
                                    {isExpanded && (
                                        <motion.div
                                            initial={{ opacity: 0, y: 5 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: 5 }}
                                            className="flex flex-col items-center text-center"
                                        >
                                            <h1 className={`
                        uppercase leading-none whitespace-nowrap transition-all duration-500 font-extralight text-[18px] tracking-[0.5em]
                        ${isDark ? 'text-white' : 'text-[var(--text-primary)]'}
                      `}>
                                                ALPHA <span className="text-cyan-500 font-normal">TRADE</span>
                                            </h1>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>

                        <button onClick={() => setIsOpen(false)} className="lg:hidden absolute top-6 right-6 p-2 hover:bg-white/10 rounded-full text-slate-400"><X size={20} /></button>
                    </div>

                    {/* ZAPSAT OBCHOD - EMERALD GLASS STYLE */}
                    <div className="px-4 mb-4 mt-6 h-10 flex items-center">
                        <button
                            onClick={() => {
                                setIsClicked(true);
                                onAddTrade();
                            }}
                            title={!isExpanded ? "Zapsat obchod" : ""}
                            className={`flex items-center justify-center gap-3 transition-all duration-300 border backdrop-blur-md active:scale-95 group h-10
                bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] lg:hover:bg-emerald-500/20 lg:hover:border-emerald-500/50
                ${!isExpanded ? 'w-10 rounded-2xl mx-auto' : 'w-full rounded-[20px] px-6'}
              `}
                        >
                            <Plus size={18} strokeWidth={3} className="group-hover:rotate-90 transition-transform duration-500" />
                            <AnimatePresence>
                                {isExpanded && (
                                    <motion.span
                                        initial={{ opacity: 0, x: -10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: -10 }}
                                        className="font-black text-[11px] uppercase tracking-[0.2em] whitespace-nowrap"
                                    >
                                        Zapsat obchod
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </button>
                    </div>
                </div>

                {/* Navigation - Scrollable Area */}
                <nav className="flex-1 px-2 space-y-1 overflow-y-auto custom-scrollbar no-scrollbar py-2">
                    {mainItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = activePage === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => handleNavClick(item.id)}
                                className={`${navItemClass(isActive)} ${!isExpanded ? 'justify-center w-10 mx-auto' : 'px-6 mx-2'}`}
                                title={!isExpanded ? item.label : ""}
                            >
                                <Icon size={16} className={`shrink-0 ${isActive ? (isDark ? 'text-white' : 'text-[var(--text-primary)]') : 'text-current'}`} />
                                <AnimatePresence>
                                    {isExpanded && (
                                        <motion.span
                                            initial={{ opacity: 0, x: -10 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -10 }}
                                            className="whitespace-nowrap"
                                        >
                                            {item.label}
                                        </motion.span>
                                    )}
                                </AnimatePresence>
                                {isActive && isExpanded && (
                                    <div className={`absolute right-4 w-1 h-3 rounded-full ${isDark ? 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'bg-[var(--text-primary)] shadow-[0_0_8px_rgba(15,23,42,0.3)]'}`}></div>
                                )}
                            </button>
                        );
                    })}

                    {secondaryItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = activePage === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => handleNavClick(item.id)}
                                className={`${navItemClass(isActive)} ${!isExpanded ? 'justify-center w-10 mx-auto' : 'px-6 mx-2'}`}
                                title={!isExpanded ? item.label : ""}
                            >
                                <Icon size={16} className={`shrink-0 ${isActive ? (isDark ? 'text-white' : 'text-[var(--text-primary)]') : 'text-current'}`} />
                                <AnimatePresence>
                                    {isExpanded && (
                                        <motion.span
                                            initial={{ opacity: 0, x: -10 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -10 }}
                                            className="whitespace-nowrap"
                                        >
                                            {item.label}
                                        </motion.span>
                                    )}
                                </AnimatePresence>
                                {isActive && isExpanded && (
                                    <div className={`absolute right-4 w-1 h-3 rounded-full ${isDark ? 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'bg-[var(--text-primary)] shadow-[0_0_8px_rgba(15,23,42,0.3)]'}`}></div>
                                )}
                            </button>
                        );
                    })}
                </nav>

                {/* User Profile - Fixed at the Bottom - CLICKABLE */}
                <div className="px-3 py-4 mt-auto border-t border-white/5 transition-colors">
                    <div
                        onClick={onOpenProfile}
                        className={`
              flex items-center transition-all relative overflow-hidden group cursor-pointer 
              ${isDark ? 'bg-white/[0.03] border border-white/10 hover:bg-white/[0.05] hover:border-white/20' : 'bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:bg-[var(--bg-page)]'} 
              lg:hover:shadow-2xl active:scale-95 
              ${!isExpanded ? 'w-12 h-12 rounded-full justify-center mx-auto' : 'h-14 rounded-[24px] justify-between px-4 gap-3'}
            `}
                    >
                        <div className={`flex items-center min-w-0 relative z-10 ${!isExpanded ? 'justify-center' : 'gap-4 w-full'}`}>
                            <div className="w-10 h-10 rounded-full border border-white/20 overflow-hidden flex-shrink-0 shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                                {user.avatar ? (
                                    <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-400 flex items-center justify-center">
                                        <UserIcon size={18} />
                                    </div>
                                )}
                            </div>
                            <AnimatePresence>
                                {isExpanded && (
                                    <motion.div
                                        initial={{ opacity: 0, width: 0 }}
                                        animate={{ opacity: 1, width: 'auto' }}
                                        exit={{ opacity: 0, width: 0 }}
                                        className="min-w-0"
                                    >
                                        <p className="text-[10px] font-black uppercase truncate tracking-wider">{user.name}</p>
                                        <p className="text-[8px] font-bold uppercase text-emerald-500 tracking-[0.2em] mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
                                            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                                            {t('online_profile', lang)}
                                        </p>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        <AnimatePresence>
                            {isExpanded && (
                                <motion.button
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    onClick={(e) => { e.stopPropagation(); onLogout(); }}
                                    className="p-2 text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all relative z-10"
                                    title="Odhlásit se"
                                >
                                    <LogOut size={16} />
                                </motion.button>
                            )}
                        </AnimatePresence>
                        {/* Subtle profile glow */}
                        <div className="absolute -inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                    </div>
                </div>
            </motion.aside>
        </>
    );
};

export default Sidebar;
