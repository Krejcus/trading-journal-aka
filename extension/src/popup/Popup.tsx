import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { LogOut, CheckCircle2, AlertCircle, TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface DayStats {
    total: number;
    wins: number;
    losses: number;
    be: number;
    pnl: number;
    lastInstrument: string | null;
    lastPnl: number | null;
}

function getTodayUtcRange(): { start: string; end: string } {
    // Skutečné UTC hranice LOKÁLNÍ půlnoci — dřív se na lokální Y/M/D lepilo literální „Z",
    // což v CZ (UTC+1/+2) posunulo okno o 1–2 h: obchod z 00:30 lokálně vypadl z „Dneška".
    const now = new Date();
    const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endLocal   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { start: startLocal.toISOString(), end: endLocal.toISOString() };
}

export function Popup() {
    const [session, setSession]   = useState<any>(null);
    const [email, setEmail]       = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading]   = useState(false);
    const [message, setMessage]   = useState('');
    const [stats, setStats]       = useState<DayStats | null>(null);
    const [statsLoading, setStatsLoading] = useState(false);

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            if (session) loadTodayStats();
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
            setSession(sess);
            if (sess) loadTodayStats();
            else setStats(null);
        });

        return () => subscription.unsubscribe();
    }, []);

    const loadTodayStats = async () => {
        setStatsLoading(true);
        try {
            const { data: { session: authSess } } = await supabase.auth.getSession();
            if (!authSess) { setStatsLoading(false); return; }
            const { start, end } = getTodayUtcRange();
            const { data, error } = await supabase
                .from('trades')
                .select('pnl, instrument, data, date')
                .eq('user_id', authSess.user.id) // defense-in-depth vedle RLS (konzistentní se zbytkem kódu)
                .gte('date', start)
                .lte('date', end)
                .order('date', { ascending: false });

            if (error || !data) { setStatsLoading(false); return; }

            const s: DayStats = { total: 0, wins: 0, losses: 0, be: 0, pnl: 0, lastInstrument: null, lastPnl: null };
            for (const t of data) {
                s.total++;
                s.pnl += t.pnl ?? 0;
                const outcome = t.data?.outcome ?? (t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BE');
                if (outcome === 'WIN')       s.wins++;
                else if (outcome === 'LOSS') s.losses++;
                else                         s.be++;
                if (s.lastInstrument === null) {
                    s.lastInstrument = t.instrument ?? t.data?.instrument ?? null;
                    s.lastPnl = t.pnl ?? null;
                }
            }
            s.pnl = parseFloat(s.pnl.toFixed(2));
            setStats(s);
        } catch { /* ignore */ } finally {
            setStatsLoading(false);
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage('');
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        setMessage(error ? error.message : 'Úspěšně přihlášeno!');
        setLoading(false);
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        setStats(null);
    };

    const pnlPositive = (stats?.pnl ?? 0) >= 0;

    return (
        <div className="w-[340px] p-6 font-sans bg-slate-900 border border-slate-800 text-slate-200">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-slate-800 border border-blue-500/20 p-1.5 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.15)]">
                    <img
                        src={chrome.runtime?.getURL ? chrome.runtime.getURL('icons/at_logo_light_clean.png') : '/icons/at_logo_light_clean.png'}
                        alt="Alpha Trade Logo"
                        className="w-full h-full object-contain"
                    />
                </div>
                <h1 className="text-blue-400 tracking-widest text-lg m-0 font-bold uppercase">Alpha Bridge</h1>
            </div>

            {!session ? (
                /* ── Login form ──────────────────────────────────────────────── */
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
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                        />
                        <input
                            type="password"
                            placeholder="Heslo"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full p-3.5 bg-blue-600 text-white border-0 rounded-xl font-bold text-sm uppercase tracking-wider cursor-pointer transition-all duration-200 mt-2 hover:bg-blue-500 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500/50"
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
                /* ── Logged in ───────────────────────────────────────────────── */
                <div className="flex flex-col gap-4">
                    {/* User info */}
                    <div className="bg-slate-800/50 px-4 py-3 rounded-xl border border-slate-700/50">
                        <p className="text-[10px] text-slate-400 m-0 mb-0.5 font-semibold uppercase tracking-wider">Přihlášen jako</p>
                        <p className="text-sm text-white font-medium m-0 break-all">{session.user.email}</p>
                    </div>

                    {/* Connection status */}
                    <p className="text-sm text-emerald-400 font-semibold m-0 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                        Spojení aktivní
                    </p>

                    {/* Today's stats */}
                    <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-400 flex items-center gap-1.5">
                                <Activity size={11} />
                                Dnes
                            </span>
                            <button
                                onClick={loadTodayStats}
                                disabled={statsLoading}
                                className="text-[10px] text-slate-500 hover:text-blue-400 transition-colors font-semibold flex items-center gap-1"
                                title="Obnovit"
                            >
                                {statsLoading ? (
                                    <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-blue-400 rounded-full" />
                                ) : '↻ obnovit'}
                            </button>
                        </div>

                        {statsLoading ? (
                            <div className="px-4 py-4 text-center text-xs text-slate-500 animate-pulse">Načítám...</div>
                        ) : !stats || stats.total === 0 ? (
                            <div className="px-4 py-4 text-center text-xs text-slate-500">Dnes žádné obchody</div>
                        ) : (
                            <div className="px-4 py-3">
                                {/* Main P&L */}
                                <div className="flex items-baseline gap-2 mb-3">
                                    <span className={`text-2xl font-black tabular-nums ${pnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {pnlPositive ? '+' : ''}{stats.pnl < 0 ? '-' : ''}${Math.abs(stats.pnl).toFixed(0)}
                                    </span>
                                    {pnlPositive
                                        ? <TrendingUp size={18} className="text-emerald-500" />
                                        : <TrendingDown size={18} className="text-rose-500" />
                                    }
                                    <span className="text-xs text-slate-400 ml-auto">{stats.total} obch.</span>
                                </div>

                                {/* W/L/BE badges */}
                                <div className="flex gap-1.5">
                                    {stats.wins > 0 && (
                                        <span className="px-2 py-1 bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 rounded-lg text-[10px] font-bold">
                                            ✓ {stats.wins}W
                                        </span>
                                    )}
                                    {stats.losses > 0 && (
                                        <span className="px-2 py-1 bg-rose-500/15 border border-rose-500/25 text-rose-400 rounded-lg text-[10px] font-bold">
                                            ✗ {stats.losses}L
                                        </span>
                                    )}
                                    {stats.be > 0 && (
                                        <span className="px-2 py-1 bg-yellow-500/15 border border-yellow-500/25 text-yellow-400 rounded-lg text-[10px] font-bold">
                                            ◯ {stats.be}BE
                                        </span>
                                    )}
                                    {stats.total > 0 && (
                                        <span className="ml-auto px-2 py-1 bg-slate-700/60 border border-slate-600/50 text-slate-300 rounded-lg text-[10px] font-bold">
                                            {Math.round(stats.wins / stats.total * 100)}% WR
                                        </span>
                                    )}
                                </div>

                                {/* Last trade */}
                                {stats.lastInstrument && stats.lastPnl !== null && (
                                    <div className="mt-2.5 pt-2.5 border-t border-slate-700/50 flex items-center justify-between">
                                        <span className="text-[10px] text-slate-500">Poslední: <span className="text-slate-300 font-semibold">{stats.lastInstrument}</span></span>
                                        <span className={`text-[10px] font-bold tabular-nums ${stats.lastPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {stats.lastPnl >= 0 ? '+' : ''}${stats.lastPnl.toFixed(0)}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Logout */}
                    <button
                        onClick={handleLogout}
                        className="w-full p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 font-bold text-sm tracking-wide cursor-pointer flex items-center justify-center gap-2 transition-all hover:bg-rose-500/20 hover:border-rose-500/50 focus:outline-none"
                    >
                        <LogOut size={16} />
                        Odhlásit se
                    </button>

                    <p className="text-xs text-slate-500 text-center m-0 font-medium">
                        Přejděte na TradingView pro zadávání obchodů.
                    </p>
                </div>
            )}
        </div>
    );
}
