import React, { useEffect, useRef, useState } from 'react';
import {
    LayoutDashboard,
    History,
    Settings,
    X,
    PlusCircle,
    BarChart2,
    Wallet,
    BookOpen,
    User as UserIcon,
    ChevronLeft,
    ChevronRight,
    ClipboardCheck,
    Globe,
    Briefcase,
    Bot,
    Lock,
    FlaskConical,
    Radio,
    Layers,
    Microscope,
    RadioTower,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { User } from '../types';
import { t } from '../services/translations';
import { isLocked } from '../utils/featureGating';

interface SidebarProps {
    activePage: string;
    setActivePage: (page: any) => void;
    isOpen: boolean;
    setIsOpen: (isOpen: boolean) => void;
    isCollapsed: boolean;
    setIsCollapsed: (isCollapsed: boolean) => void;
    /** Desktop režim bez sidebaru: menu je mimo obrazovku a vyjede u levého okraje. */
    hidden?: boolean;
    /** Přepne režim bez sidebaru (⌘B). */
    onToggleHidden?: () => void;
    theme: 'dark' | 'light' | 'oled';
    /** Otevře hodnocení obchodů z Tradovate (fronta „k revizi“). */
    onReview: () => void;
    /** Počet obchodů čekajících na hodnocení. */
    reviewCount?: number;
    user: User;
    onLogout: () => void;
    onOpenProfile: () => void;
    onNavigate?: (page: string) => void;
    onLiveIntent?: () => void;
    onLockedFeature?: (featureId: string) => void;
    /** Počet importovaných obchodů k doplnění — malý glass badge u Historie. */
    enrichCount?: number;
    /** Aktuální dashboard mód — Sidebar řeší backtest vstup/výstup a skrytí nav. */
    dashboardMode?: string;
    /** Přepnout mezi backtest a live světem. */
    onToggleBacktest?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
    activePage,
    setActivePage,
    isOpen,
    setIsOpen,
    isCollapsed,
    setIsCollapsed,
    hidden = false,
    onToggleHidden,
    theme,
    onReview,
    reviewCount = 0,
    user,
    onOpenProfile,
    onNavigate,
    onLiveIntent,
    onLockedFeature,
    enrichCount = 0,
    dashboardMode,
    onToggleBacktest,
}) => {
    const isBacktest = dashboardMode === 'backtesting';
    const lang = user.language || 'cs';
    const [isHovered, setIsHovered] = useState(false);
    const [isClicked, setIsClicked] = useState(false);
    // Hover na world-togglu: ukazuje aktuální svět, po najetí morphne na cílový.
    const [worldHover, setWorldHover] = useState(false);

    // Core logic: Sidebar is expanded if either pinned (!isCollapsed) OR hovered (but NOT if we just clicked an item)
    // Professional behavior: Click -> Collapse immediately -> Re-expand on fresh hover
    // Nad jazýčkem schovat/připnout se sidebar nerozbaluje (jinak by jazýček uskočil kurzoru).
    const [tabHover, setTabHover] = useState(false);
    const isExpanded = !isCollapsed || (isHovered && !isClicked && !tabHover) || isOpen;

    // Režim bez sidebaru: najetí k levému okraji ho vysune přes obsah, odjetí schová.
    // Krátké zpoždění, ať menu nevyskakuje při pouhém přejetí myší přes okraj.
    const [peek, setPeek] = useState(false);
    const peekTimer = useRef<number | undefined>(undefined);
    const schedulePeek = (next: boolean, delay: number) => {
        window.clearTimeout(peekTimer.current);
        peekTimer.current = window.setTimeout(() => setPeek(next), delay);
    };
    useEffect(() => { if (!hidden) { window.clearTimeout(peekTimer.current); setPeek(false); } }, [hidden]);
    useEffect(() => () => window.clearTimeout(peekTimer.current), []);
    const offscreen = hidden && !peek && !isOpen;
    // Vysunuté menu je hned celé rozbalené (s popisky), ne jen ikony.
    const showExpanded = isExpanded || (hidden && peek);

    const mainItems = [
        { id: 'dashboard', label: t('dashboard', lang), icon: LayoutDashboard },
        { id: 'history', label: t('history', lang) || 'Historie', icon: History },
        { id: 'lab', label: 'Lab', icon: Microscope },
        { id: 'journal', label: t('journal', lang), icon: BookOpen },
        { id: 'business', label: t('business', lang), icon: Briefcase },
        { id: 'ai', label: 'AI Coach', icon: Bot },
    ];

    const secondaryItems = [
        { id: 'live', label: 'LIVE', icon: RadioTower },
        { id: 'network', label: t('network', lang), icon: Globe },
        // V backtestu nemáš účty — místo nich "Session" (název + velikost).
        { id: 'accounts', label: isBacktest ? 'Session' : t('accounts', lang), icon: isBacktest ? Layers : Wallet },
        { id: 'settings', label: t('settings', lang), icon: Settings },
    ];

    // V backtest módu skryjeme nav, co k backtestu nepatří (Business hub, Síť).
    const visibleMain = isBacktest ? mainItems.filter(i => i.id !== 'business') : mainItems;
    const visibleSecondary = isBacktest ? secondaryItems.filter(i => i.id !== 'network' && i.id !== 'live') : secondaryItems;

    const isDark = theme !== 'light';

    // Base classes preserved from original (minus the width which is now animated)
    // Aside = jen průhledný poziční kontejner (žádné sklo). Sklo má teď vnitřní
    // plovoucí obdélník (floating-glass-header). p-3 = odsazení ostrůvků od kraje.
    const sidebarBaseClasses = `
    fixed inset-y-0 left-0 z-[60]
    bg-transparent
    flex flex-col justify-center
    p-3 gap-2
    lg:translate-x-0 lg:fixed lg:top-0 lg:h-screen
  `;

    const navItemClass = (isActive: boolean) => `
    flex items-center gap-3 rounded-lg text-[11px] font-semibold transition-all duration-300 relative group overflow-hidden h-10 liquid-glass-lens
    ${isActive
            ? (isDark
                ? 'glass-lens-active-dark text-white'
                : 'glass-lens-active-light text-slate-800')
            : (isDark
                ? 'glass-lens-dark theme-text-secondary hover:text-white hover:scale-[0.98] active:scale-95'
                : 'glass-lens-light theme-text-secondary hover:text-slate-950 hover:scale-[0.98] active:scale-95')
        }
  `;

    const handleNavClick = (pageId: string) => {
        // Locked feature pro non-owner role → otevřít info modal místo navigace
        if (isLocked(pageId, user.role)) {
            if (onLockedFeature) onLockedFeature(pageId);
            return;
        }
        // Force collapse on click for "pro" feel
        setIsClicked(true);
        if (hidden) schedulePeek(false, 0);

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

            {/* Režim bez sidebaru: neviditelný proužek u levého okraje, najetí menu vysune. */}
            {hidden && (
                <div
                    aria-hidden="true"
                    className="sidebar-reveal-edge hidden lg:block fixed left-0 top-0 bottom-0 w-6 z-[61]"
                    onMouseEnter={() => schedulePeek(true, 80)}
                    onMouseLeave={() => { if (!peek) schedulePeek(false, 0); }}
                />
            )}
            <motion.aside
                initial={false}
                animate={{
                    width: showExpanded ? 240 : 88,
                    x: isOpen ? 0 : (window.innerWidth < 1024 ? -240 : offscreen ? -260 : 0),
                    opacity: offscreen ? 0 : 1,
                    scale: offscreen ? 0.94 : 1,
                }}
                // Vysunutí: pružina s lehkým dojezdem; schování: krátké a čisté.
                transition={hidden
                    ? (offscreen
                        ? { x: { duration: 0.22, ease: [0.4, 0, 1, 1] }, opacity: { duration: 0.18 }, scale: { duration: 0.22 }, width: { duration: 0.2 } }
                        : { x: { type: 'spring', stiffness: 420, damping: 32, mass: 0.9 }, scale: { type: 'spring', stiffness: 380, damping: 26 }, opacity: { duration: 0.16 }, width: { type: 'spring', stiffness: 420, damping: 36 } })
                    : { type: "spring", stiffness: 300, damping: 30 }}
                style={{ transformOrigin: 'left center' }}
                className={`${sidebarBaseClasses} ${hidden && peek ? 'sidebar-peek' : ''}`}
                inert={offscreen}
                onMouseEnter={() => { setIsHovered(true); if (hidden) schedulePeek(true, 0); }}
                onMouseLeave={() => {
                    setIsHovered(false);
                    setIsClicked(false); // Reset click state on leave so it can re-expand on next hover
                    if (hidden) schedulePeek(false, 260);
                }}
            >
                {/* Plovoucí glass panel — čistá navigace (logo je v headeru) */}
                <div className="relative flex flex-col max-h-full min-h-0">
                {/* Kolečko na okraji sidebaru: schovat / připnout menu, po chvíli ukáže ⌘B. */}
                {onToggleHidden && (
                    <button
                        type="button"
                        onClick={() => { setIsClicked(true); onToggleHidden(); }}
                        aria-label={hidden ? 'Připnout menu (⌘B)' : 'Schovat menu (⌘B)'}
                        className={`sidebar-edge-tab hidden lg:grid ${isDark ? 'is-dark' : ''}`}
                        // Jen brání rozbalení; už rozbalený sidebar nechá být, ať kolečko neuteče kurzoru.
                        onPointerEnter={() => setTabHover(!isExpanded)}
                        onPointerLeave={() => setTabHover(false)}
                    >
                        {hidden ? <ChevronRight size={12} strokeWidth={2.4} /> : <ChevronLeft size={12} strokeWidth={2.4} />}
                        <span className="sidebar-edge-tip" aria-hidden="true">
                            {hidden ? 'Připnout menu' : 'Schovat menu'}<kbd>⌘B</kbd>
                        </span>
                    </button>
                )}
                <div className="sidebar-glass floating-glass-header rounded-lg flex flex-col max-h-full min-h-0 overflow-hidden relative">
                    {hidden && <span className="sidebar-sheen" aria-hidden="true" />}

                    {/* Mobilní zavírací tlačítko */}
                    <button onClick={() => setIsOpen(false)} className="lg:hidden absolute top-3 right-3 z-20 p-2 hover:bg-white/10 rounded-lg text-slate-400"><X size={18} /></button>

                    {/* HODNOTIT - EMERALD GLASS STYLE */}
                    <div className="px-2 pt-4 mb-2 h-10 flex items-center shrink-0">
                        <button
                            onClick={() => {
                                setIsClicked(true);
                                onReview();
                            }}
                            title={!showExpanded ? (reviewCount ? `Hodnotit (${reviewCount})` : 'Hodnotit') : ''}
                            className={`flex items-center justify-center gap-3 transition-all duration-300 border liquid-glass-lens hover:scale-[0.98] active:scale-95 group h-10 relative z-10
                ${isDark
                                ? 'bg-transparent border-emerald-500/25 text-emerald-400 shadow-[inset_0_1.5px_1.5px_rgba(0,0,0,0.05),inset_0_-1.5px_1.5px_rgba(255,255,255,0.2),0_3px_1.5px_-1.5px_rgba(16,185,129,0.15),0_0_1px_2px_inset_rgba(255,255,255,0.1)] hover:border-emerald-500/55 hover:text-emerald-300'
                                : 'bg-transparent border-emerald-500/40 text-emerald-700 shadow-[inset_0_1.5px_1.5px_rgba(0,0,0,0.03),inset_0_-1.5px_1.5px_rgba(255,255,255,0.6),0_3px_1.5px_-1.5px_rgba(16,185,129,0.08),0_0_1px_2px_inset_rgba(255,255,255,0.15)] hover:border-emerald-500/70 hover:text-emerald-800'
                            }
                ${!showExpanded ? 'w-10 rounded-lg mx-auto' : 'w-full rounded-lg px-6'}
              `}
                        >
                            <span className="relative">
                                <ClipboardCheck size={18} strokeWidth={2.4} className="group-hover:scale-110 transition-transform duration-300" />
                                {reviewCount > 0 && !showExpanded && <span className="absolute -top-2 -right-2.5 min-w-[15px] h-[15px] px-1 rounded-full bg-emerald-500 text-white text-[8.5px] font-black flex items-center justify-center tabular-nums">{reviewCount}</span>}
                            </span>
                            <AnimatePresence>
                                {showExpanded && (
                                    <motion.span
                                        initial={{ opacity: 0, x: -10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: -10 }}
                                        className="font-semibold text-[11px] whitespace-nowrap"
                                    >
                                        Hodnotit
                                        {reviewCount > 0 && <span className="ml-2 inline-flex min-w-[18px] h-[18px] px-1.5 items-center justify-center rounded-full bg-emerald-500 text-white text-[9.5px] tracking-normal tabular-nums">{reviewCount}</span>}
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </button>
                    </div>

                {/* Navigation - Scrollable Area */}
                <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto custom-scrollbar no-scrollbar py-1 relative z-10">
                    {[...visibleMain, ...visibleSecondary].map((item, idx) => {
                        const Icon = item.icon;
                        const isActive = activePage === item.id;
                        const locked = isLocked(item.id, user.role);
                        // Visual separator between main and secondary groups
                        const isFirstSecondary = idx === visibleMain.length;
                        return (
                            <React.Fragment key={item.id}>
                                {isFirstSecondary && <div className="h-2" />}
                                <button
                                    onClick={() => handleNavClick(item.id)}
                                    onPointerEnter={item.id === 'live' && !locked && !isActive && onLiveIntent ? () => onLiveIntent() : undefined}
                                    onFocus={item.id === 'live' && !locked && !isActive && onLiveIntent ? () => onLiveIntent() : undefined}
                                    onPointerDown={item.id === 'live' && !locked && !isActive && onLiveIntent ? () => onLiveIntent() : undefined}
                                    className={`${navItemClass(isActive)} ${!showExpanded ? 'justify-center w-10 mx-auto rounded-lg' : 'w-[calc(100%_-_1rem)] px-6 mx-2 rounded-lg'} ${locked ? 'opacity-40 hover:opacity-60' : ''}`}
                                    title={!showExpanded ? item.label + (locked ? ' (uzamčeno)' : '') : ''}
                                >
                                    <span className="relative shrink-0 flex">
                                        <Icon size={16} className={`shrink-0 ${isActive ? (isDark ? 'text-white' : 'text-[var(--text-primary)]') : 'text-current'}`} />
                                        {item.id === 'history' && enrichCount > 0 && (
                                            <span className="absolute -top-2 -right-2 min-w-[14px] h-[14px] px-0.5 rounded-full border border-amber-500/60 text-amber-500 text-[8px] font-black flex items-center justify-center bg-[var(--bg-page)]">{enrichCount}</span>
                                        )}
                                    </span>
                                    <AnimatePresence>
                                        {showExpanded && (
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
                                    {locked && showExpanded && (
                                        <Lock size={11} className="absolute right-4 text-amber-400/70" />
                                    )}
                                    {locked && !showExpanded && (
                                        <Lock size={9} className="absolute -top-0.5 -right-0.5 text-amber-400/70 bg-[var(--bg-page)] rounded-full p-0.5" />
                                    )}

                                </button>
                            </React.Fragment>
                        );
                    })}

                    {/* Backtest / Live přepínač světa — single-line jako ostatní položky */}
                    {onToggleBacktest && (
                        <>
                            <div className={`h-px mx-3 my-1.5 ${isDark ? 'bg-white/10' : 'bg-slate-200/70'}`} />
                            {(() => {
                                // Aktuální svět vs. cíl přepnutí. Tlačítko klidově ukazuje
                                // aktuální stav, po najetí morphne na cílový (barva+ikona+text).
                                const showBacktest = worldHover ? !isBacktest : isBacktest;
                                return (
                                    <button
                                        onClick={onToggleBacktest}
                                        onMouseEnter={() => setWorldHover(true)}
                                        onMouseLeave={() => setWorldHover(false)}
                                        className={`flex items-center gap-3 rounded-lg text-[11px] font-semibold transition-all duration-300 h-10 border ${!showExpanded ? 'justify-center w-10 mx-auto' : 'w-[calc(100%_-_1rem)] px-6 mx-2'} ${
                                            showBacktest
                                                ? 'bg-violet-500/10 border-violet-500/40 text-violet-500 hover:bg-violet-500/20'
                                                : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/20'
                                        }`}
                                        title={!showExpanded ? (isBacktest ? 'Přepnout na Live' : 'Přepnout na Backtest') : ''}
                                    >
                                        {/* Ikona — crossfade mezi stavy (box 16px, stack absolute) */}
                                        <span className="shrink-0 relative w-4 h-4 flex items-center justify-center">
                                            <FlaskConical size={16} className={`absolute transition-opacity duration-300 ${showBacktest ? 'opacity-100' : 'opacity-0'}`} />
                                            <Radio size={16} className={`absolute transition-opacity duration-300 ${showBacktest ? 'opacity-0' : 'opacity-100'}`} />
                                        </span>
                                        <AnimatePresence>
                                            {showExpanded && (
                                                <motion.span
                                                    initial={{ opacity: 0, x: -10 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    exit={{ opacity: 0, x: -10 }}
                                                    className="whitespace-nowrap relative overflow-hidden"
                                                >
                                                    <AnimatePresence mode="wait" initial={false}>
                                                        <motion.span
                                                            key={showBacktest ? 'bt' : 'live'}
                                                            initial={{ clipPath: 'inset(0 100% 0 0)' }}
                                                            animate={{ clipPath: 'inset(0 0% 0 0)' }}
                                                            exit={{ clipPath: 'inset(0 0 0 100%)' }}
                                                            transition={{ duration: 0.22, ease: 'easeInOut' }}
                                                            className="block"
                                                        >
                                                            {showBacktest ? 'Backtest' : 'Live'}
                                                        </motion.span>
                                                    </AnimatePresence>
                                                </motion.span>
                                            )}
                                        </AnimatePresence>
                                    </button>
                                );
                            })()}
                        </>
                    )}
                </nav>

                {/* User Profile - Fixed at the Bottom - CLICKABLE */}
                <div className={`px-2 py-4 border-t transition-colors relative z-10 ${isDark ? 'border-white/5' : 'border-slate-200/50'}`}>
                    <div
                        onClick={onOpenProfile}
                        className={`
              flex items-center transition-all relative overflow-hidden group cursor-pointer liquid-glass-lens hover:scale-[0.98] active:scale-95 
              ${isDark ? 'glass-lens-dark' : 'glass-lens-light'} 
              ${!showExpanded ? 'w-12 h-12 rounded-lg justify-center mx-auto' : 'h-14 rounded-lg justify-between px-4 gap-3'}
            `}
                    >
                        <div className={`flex items-center min-w-0 relative z-10 ${!showExpanded ? 'justify-center' : 'gap-4 w-full'}`}>
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
                                {showExpanded && (
                                    <motion.div
                                        initial={{ opacity: 0, width: 0 }}
                                        animate={{ opacity: 1, width: 'auto' }}
                                        exit={{ opacity: 0, width: 0 }}
                                        className="min-w-0"
                                    >
                                        <p className="text-[11px] font-semibold truncate">{user.name}</p>
                                        <p className="mt-0.5 whitespace-nowrap text-[11px] font-medium text-[var(--text-muted)]">Profil a účet</p>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Subtle profile glow */}
                        <div className="absolute -inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                    </div>
                </div>
                {/* /Sjednocený plovoucí glass obdélník */}
                </div>
                </div>
            </motion.aside>
            {/* SVG Filters for Liquid Glass Refraction Effect */}
            <svg width="0" height="0" className="absolute pointer-events-none" style={{ position: 'absolute', width: 0, height: 0 }}>
                <defs>
                    {/* Base Panel Filter - subtle distortion */}
                    <filter id="liquid-glass-prism-base" x="-10%" y="-10%" width="120%" height="120%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.005 0.005" numOctaves="2" result="noise" seed="1" />
                        <feDisplacementMap in="SourceGraphic" in2="noise" scale="18" xChannelSelector="R" yChannelSelector="G" />
                    </filter>
                    {/* Lens/Button Filter - magnifying/refraction glass effect */}
                    <filter id="liquid-glass-prism-lens" x="-20%" y="-20%" width="140%" height="140%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.015 0.015" numOctaves="1" result="noise" seed="2" />
                        <feDisplacementMap in="SourceGraphic" in2="noise" scale="25" xChannelSelector="R" yChannelSelector="G" />
                    </filter>
                </defs>
            </svg>
        </>
    );
};

export default Sidebar;
