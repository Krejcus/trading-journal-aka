import React, { useState, useEffect } from 'react';
import { TradeForm } from './components/TradeForm';
import { Input, Button } from './components/UI';
import { supabase } from '../lib/supabase';
import { useTheme } from './components/ThemeContext';
import { Sun, Moon, Maximize2, Minimize2 } from 'lucide-react';

export function Sidebar() {
    const [isOpen, setIsOpen] = useState(false);
    const [isWide, setIsWide] = useState(false);
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

    return (
        <>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="fixed right-[3px] top-[215px] w-[38px] h-[38px] bg-transparent border-none rounded flex items-center justify-center cursor-pointer z-[2000001] transition-all hover:bg-black/5 overflow-visible focus:outline-none"
            >
                <img
                    src={chrome.runtime.getURL('icons/at_logo_light_clean.png')}
                    alt="AlphaTrade"
                    className="w-7 h-7 object-contain opacity-70 hover:opacity-100 transition-opacity drop-shadow-md"
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
                <div className={`pt-6 px-6 pb-4 border-b flex justify-between items-center ${theme === 'dark' ? 'border-white/5 bg-white/[0.02]' : 'border-black/5 bg-black/[0.02]'}`}>
                    <h1 className={`m-0 text-lg font-extrabold tracking-widest flex items-center gap-3 ${theme === 'dark' ? 'text-cyan-400' : 'text-cyan-600'}`}>
                        <div className="w-10 h-10 flex items-center justify-center transition-all duration-300 hover:scale-105">
                            <img
                                src={chrome.runtime.getURL('icons/at_logo_light_clean.png')}
                                alt="Alpha Trade Logo"
                                className={`w-full h-full object-contain filter transition-all duration-300 ${theme === 'dark' ? 'drop-shadow-[0_0_12px_rgba(34,211,238,0.4)]' : 'drop-shadow-[0_0_8px_rgba(8,145,178,0.15)] brightness-[0.85] contrast-[1.1]'}`}
                            />
                        </div>
                        ALPHA BRIDGE
                    </h1>
                    <div className="flex items-center gap-3">
                        {session && (
                            <button
                                onClick={handleLogout}
                                title="Odhlásit se"
                                className={`bg-transparent border-none text-xs font-bold cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-red-400 hover:text-red-300' : 'text-red-500 hover:text-red-600'}`}
                            >
                                Odhlásit
                            </button>
                        )}
                        <button
                            onClick={() => setIsWide(!isWide)}
                            className={`bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-400 hover:text-cyan-400' : 'text-slate-500 hover:text-cyan-600'}`}
                            title={isWide ? 'Zúžit okno' : 'Rozšířit okno'}
                        >
                            {isWide ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                        </button>
                        <button
                            onClick={toggleTheme}
                            className={`bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-400 hover:text-cyan-400' : 'text-slate-500 hover:text-cyan-600'}`}
                            title={theme === 'dark' ? 'Přepnout na světlý motiv' : 'Přepnout na tmavý motiv'}
                        >
                            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
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
                                    <h2 className={`text-lg font-extrabold mb-2 uppercase tracking-wide ${theme === 'dark' ? 'text-cyan-400' : 'text-cyan-600'}`}>Vítejte u Alpha Bridge</h2>
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
                            <TradeForm isWide={isWide} />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
