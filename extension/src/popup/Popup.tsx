import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { LogOut, CheckCircle2, AlertCircle } from 'lucide-react';

export function Popup() {
    const [session, setSession] = useState<any>(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        // Check current session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
        });

        // Listen for changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
        });

        return () => subscription.unsubscribe();
    }, []);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage('');

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            setMessage(error.message);
        } else {
            setMessage('Úspěšně přihlášeno!');
        }
        setLoading(false);
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    return (
        <div className="w-[340px] p-6 font-sans bg-slate-900 border border-slate-800 text-slate-200">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-slate-800 border border-cyan-500/20 p-1.5 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(8,145,178,0.2)]">
                    <img
                        src={chrome.runtime?.getURL ? chrome.runtime.getURL('icons/at_logo_light_clean.png') : '/icons/at_logo_light_clean.png'}
                        alt="Alpha Trade Logo"
                        className="w-full h-full object-contain"
                    />
                </div>
                <h1 className="text-cyan-400 tracking-widest text-lg m-0 font-bold uppercase">Alpha Bridge</h1>
            </div>

            {!session ? (
                <form onSubmit={handleLogin} className="flex flex-col gap-4">
                    <p className="text-slate-400 text-sm m-0 leading-relaxed">
                        Přihlaste se ke svému AlphaTrade účtu pro propojení TradingView.
                    </p>

                    <div className="flex flex-col gap-3 mt-2">
                        <input
                            type="email"
                            placeholder="Email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20"
                        />
                        <input
                            type="password"
                            placeholder="Heslo"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full p-3.5 bg-cyan-600 text-white border-0 rounded-xl font-bold text-sm uppercase tracking-wider cursor-pointer transition-all duration-200 mt-2 hover:bg-cyan-500 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                    >
                        {loading ? 'Přihlašuji...' : 'Přihlásit se'}
                    </button>

                    {message && (
                        <p className={`text-sm m-0 text-center font-medium flex items-center justify-center gap-1.5 ${message.includes('Úspěšně') ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {message.includes('Úspěšně') ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                            {message}
                        </p>
                    )}
                </form>
            ) : (
                <div className="flex flex-col gap-5">
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                        <p className="text-xs text-slate-400 m-0 mb-1 font-semibold uppercase tracking-wider">Přihlášen jako</p>
                        <p className="text-sm text-white font-medium m-0 break-all">{session.user.email}</p>
                    </div>

                    <p className="text-sm text-emerald-400 font-semibold m-0 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                        Spojení aktivní
                    </p>

                    <button
                        onClick={handleLogout}
                        className="w-full p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 font-bold text-sm tracking-wide cursor-pointer flex items-center justify-center gap-2 transition-all hover:bg-rose-500/20 hover:border-rose-500/50 focus:outline-none"
                    >
                        <LogOut size={16} />
                        Odhlásit se
                    </button>

                    <p className="text-xs text-slate-500 text-center m-0 mt-2 font-medium">
                        Přejděte na TradingView pro zadávání obchodů.
                    </p>
                </div>
            )}
        </div>
    );
}
