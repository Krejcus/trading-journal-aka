import React, { useState, useEffect } from 'react';
import { TradeForm } from './components/TradeForm';
import { Input, Button } from './components/UI';
import { supabase } from '../lib/supabase';
import { useTheme } from './components/ThemeContext';
import { Sun, Moon, Maximize2, Minimize2 } from 'lucide-react';
import { readActivePosition } from '../lib/positionReader';

export function Sidebar() {
    const [isOpen, setIsOpen] = useState(false);
    const [isWide, setIsWide] = useState(false);
    // Auto-load: klik na logo s pozicí na grafu → otevři + signál pro TradeForm (read + screen).
    const [autoLoadSignal, setAutoLoadSignal] = useState(0);
    const [noBoxAlert, setNoBoxAlert] = useState(false);
    const [checkingBox, setCheckingBox] = useState(false);
    // Režim Live/Backtest — řízen z headeru, persistuje v chrome.storage (čte ho i TradeForm).
    const [mode, setMode] = useState<'normal' | 'backtest'>('normal');
    useEffect(() => {
        try { chrome.storage?.local?.get(['ab_mode'], (r: any) => { if (r?.ab_mode === 'backtest' || r?.ab_mode === 'normal') setMode(r.ab_mode); }); } catch { /* storage nedostupné */ }
    }, []);
    const changeMode = (m: 'normal' | 'backtest') => {
        setMode(m);
        try { chrome.storage?.local?.set({ ab_mode: m }); } catch { /* ignore */ }
    };
    const [session, setSession] = useState<any>(null);
    const [isLoadingAuth, setIsLoadingAuth] = useState(true);
    const { theme, toggleTheme } = useTheme();

    // Login state
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const [loginError, setLoginError] = useState('');

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setIsLoadingAuth(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setIsLoadingAuth(false);
        });

        return () => subscription.unsubscribe();
    }, []);

    const handleLogin = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        setIsLoggingIn(true);
        setLoginError('');

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            setLoginError("Špatný email nebo heslo.");
        }
        setIsLoggingIn(false);
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    // Smart klik na logo: když je na grafu pozice (box) → otevři + auto-vyplň + screen.
    // Když pozice není → hláška „nakresli pozici" + možnost otevřít přesto (prázdný panel).
    const handleLogoClick = async () => {
        if (isOpen) { setIsOpen(false); return; }
        if (!session) { setIsOpen(true); return; } // nepřihlášený → otevři (login)
        setCheckingBox(true);
        const r = await readActivePosition();
        setCheckingBox(false);
        if (r.ok) {
            setIsOpen(true);
            setAutoLoadSignal(s => s + 1);
        } else {
            setNoBoxAlert(true);
        }
    };

    return (
        <>
            <button
                onClick={handleLogoClick}
                title="Klik: načti pozici + screen a otevři (nebo otevři prázdný)"
                className="fixed right-[3px] top-[215px] w-[38px] h-[38px] bg-transparent border-none rounded flex items-center justify-center cursor-pointer z-[2000001] transition-all hover:bg-black/5 overflow-visible focus:outline-none"
            >
                <img
                    src={chrome.runtime.getURL('icons/at_logo_light_clean.png')}
                    alt="AlphaTrade"
                    className={`w-7 h-7 object-contain opacity-70 hover:opacity-100 transition-opacity drop-shadow-md ${checkingBox ? 'animate-pulse' : ''}`}
                />
            </button>

            <div
                id="alpha-bridge-sidebar"
                className={`fixed top-[15px] right-[48px] h-[calc(100vh-30px)] flex flex-col z-[2000000] overflow-x-hidden overflow-y-hidden transition-all duration-300 ease-out will-change-transform ${isOpen ? 'visible opacity-100 translate-x-0 scale-100 pointer-events-auto' : 'invisible opacity-0 translate-x-[120%] scale-95 pointer-events-none'} ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}
                style={Object.assign(
                    {
                        width: isWide ? '740px' : '380px',
                        borderRadius: '24px',
                        backdropFilter: 'blur(24px) saturate(180%)',
                        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                    },
                    theme === 'dark' ? {
                        background: 'rgba(15, 23, 42, 0.85)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 0 rgba(255, 255, 255, 0.1)'
                    } : {
                        background: 'rgba(255, 255, 255, 0.85)',
                        border: '1px solid rgba(0, 0, 0, 0.08)',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.1), inset 0 1px 0 0 rgba(255, 255, 255, 0.5)'
                    }
                )}
            >
                <div className={`pt-5 px-5 pb-3 border-b flex justify-between items-center gap-2 ${theme === 'dark' ? 'border-white/5 bg-white/[0.02]' : 'border-black/5 bg-black/[0.02]'}`}>
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="w-9 h-9 flex items-center justify-center shrink-0 transition-all duration-300 hover:scale-105">
                            <img
                                src={chrome.runtime.getURL('icons/at_logo_light_clean.png')}
                                alt="Alpha Trade Logo"
                                className={`w-full h-full object-contain filter transition-all duration-300 ${theme === 'dark' ? 'drop-shadow-[0_0_12px_rgba(34,211,238,0.4)]' : 'drop-shadow-[0_0_8px_rgba(8,145,178,0.15)] brightness-[0.85] contrast-[1.1]'}`}
                            />
                        </div>
                        {session && (
                            <div className={`flex p-0.5 rounded-lg ${theme === 'dark' ? 'bg-slate-800/80 border border-slate-700/50' : 'bg-slate-100 border border-slate-200'}`}>
                                {([['normal', 'Live'], ['backtest', 'Backtest']] as const).map(([m, label]) => {
                                    const active = mode === m;
                                    const activeCls = m === 'backtest'
                                        ? 'bg-violet-600 text-white shadow-sm'
                                        : (theme === 'dark' ? 'bg-slate-700 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm');
                                    return (
                                        <button key={m} type="button" onClick={() => changeMode(m)}
                                            className={`px-2.5 py-1 rounded-[8px] text-[10px] font-black uppercase tracking-wider transition-all ${active ? activeCls : (theme === 'dark' ? 'text-slate-400' : 'text-slate-500')}`}>
                                            {m === 'backtest' ? `🧪 ${label}` : label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                        {session && (
                            <button
                                onClick={handleLogout}
                                title="Odhlásit se"
                                className={`bg-transparent border-none text-[11px] font-bold cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-red-400 hover:text-red-300' : 'text-red-500 hover:text-red-600'}`}
                            >
                                Odhlásit
                            </button>
                        )}
                        <button
                            onClick={() => setIsWide(!isWide)}
                            className={`bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-400 hover:text-blue-400' : 'text-slate-500 hover:text-blue-600'}`}
                            title={isWide ? 'Zúžit okno' : 'Rozšířit okno'}
                        >
                            {isWide ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                        </button>
                        <button
                            onClick={toggleTheme}
                            className={`bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-400 hover:text-blue-400' : 'text-slate-500 hover:text-blue-600'}`}
                            title={theme === 'dark' ? 'Přepnout na světlý motiv' : 'Přepnout na tmavý motiv'}
                        >
                            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                        </button>
                        <button
                            onClick={() => setIsOpen(false)}
                            className={`bg-transparent border-none text-2xl cursor-pointer p-0 flex items-center justify-center leading-none transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            &times;
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-hidden p-0 flex">
                    <div className={`flex-1 overflow-y-auto overflow-x-hidden p-6 scrollbar-thin scrollbar-track-transparent ${theme === 'dark' ? 'scrollbar-thumb-slate-700' : 'scrollbar-thumb-slate-300'}`}>
                        {isLoadingAuth ? (
                            <div className="flex justify-center items-center h-full text-xs font-bold text-slate-400">Načítám relaci...</div>
                        ) : !session ? (
                            <div className="w-full flex flex-col justify-center h-full pt-10">
                                <div className="text-center mb-8">
                                    <h2 className={`text-lg font-extrabold mb-2 uppercase tracking-wide ${theme === 'dark' ? 'text-blue-400' : 'text-blue-600'}`}>Vítejte u Alpha Bridge</h2>
                                    <p className={`text-xs font-bold ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Přihlašte se údaji z AlphaTrade</p>
                                </div>
                                <form onSubmit={handleLogin} onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') handleLogin();
                                }} className="flex flex-col gap-4">
                                    <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="vas@email.cz" />
                                    <Input label="Heslo" type="password" value={password} onChange={setPassword} placeholder="••••••••" />

                                    {loginError && <p className="text-red-400 text-xs font-bold text-center m-0 mt-2">{loginError}</p>}

                                    <Button onClick={() => { }} disabled={isLoggingIn} className="mt-4">
                                        {isLoggingIn ? 'Přihlašuji...' : 'PŘIHLÁSIT SE'}
                                    </Button>
                                </form>
                            </div>
                        ) : (
                            <TradeForm isWide={isWide} autoLoadSignal={autoLoadSignal} mode={mode} active={isOpen} />
                        )}
                    </div>
                </div>
            </div>

            {noBoxAlert && (
                <div className="fixed inset-0 z-[2000002] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={() => setNoBoxAlert(false)}>
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className={`w-[300px] mx-4 p-5 rounded-2xl border ${theme === 'dark' ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'}`}
                        style={{ boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)' }}
                    >
                        <p className="text-sm font-black mb-1">Na grafu není pozice</p>
                        <p className={`text-xs ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Nakresli Long/Short box na grafu — obchod se pak vyplní a vyfotí sám. Nebo otevři prázdný panel (session, ruční zápis).</p>
                        <div className="flex gap-2 mt-4">
                            <button
                                onClick={() => setNoBoxAlert(false)}
                                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${theme === 'dark' ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                                Zrušit
                            </button>
                            <button
                                onClick={() => { setNoBoxAlert(false); setIsOpen(true); }}
                                className="flex-1 py-2 rounded-xl text-xs font-black text-white bg-blue-600 hover:bg-blue-500 transition-all"
                            >
                                Otevřít přesto
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
