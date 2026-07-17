import React, { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface Account {
    id: string;
    name: string;
    type?: string;
    phase?: string;
    parentAccountId?: string;
    parent_account_id?: string; // Fallback for DB casing
    copyMultiplier?: number;
}
import { useTheme } from './ThemeContext';

const isBacktestAcc = (a: any) => a?.type === 'Backtest' || a?.meta?.type === 'Backtest';

export function AccountList({ onSelectionChange, onAccountsLoaded, mode = 'normal' }: { onSelectionChange: (selectedIds: string[]) => void; onAccountsLoaded?: (accs: Account[]) => void; mode?: 'normal' | 'backtest' }) {
    const { theme } = useTheme();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // Které master-skupiny jsou rozbalené (default vše sbalené → kompaktní seznam).
    const [expandedMasters, setExpandedMasters] = useState<Set<string>>(new Set());
    const toggleExpand = (id: string) => setExpandedMasters(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    useEffect(() => {
        async function loadAccounts() {
            try {
                // Race getSession against a 5s timeout — prevents indefinite "Načítám účty..." spinner
                // when chrome.storage.local has a corrupted token or supabase client is stuck.
                const sessionPromise = supabase.auth.getSession();
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('session-timeout')), 5000)
                );
                const { data: { session } } = await Promise.race([sessionPromise, timeoutPromise]) as any;
                if (!session) {
                    setIsLoading(false);
                    return;
                }

                // Query all to ensure we don't hit "column not found" errors
                console.log('[AlphaBridge AccountList] 🔑 Session user ID:', session.user.id);

                const { data, error } = await supabase
                    .from('accounts')
                    .select('*')
                    .eq('status', 'Active')
                    .eq('user_id', session.user.id);

                if (error) {
                    throw error;
                }

                console.log('[AlphaBridge AccountList] 📊 Loaded accounts from database:', data?.map(a => ({ id: a.id, name: a.name, phase: a.phase })));

                const formattedAccounts = (data || []).map(acc => ({
                    ...acc,
                    ...acc.meta,
                    parentAccountId: acc.meta?.parentAccountId || acc.meta?.parent_account_id || acc.parentAccountId
                }));

                setAccounts(formattedAccounts as Account[]);
                onAccountsLoaded?.(formattedAccounts as Account[]);

            } catch (err) {
                console.error("Failed to load accounts:", err);
            } finally {
                setIsLoading(false);
            }
        }
        loadAccounts();
    }, [onAccountsLoaded]);

    // Default výběr: backtest → všechny backtest účty; normal → celé master skupiny
    // (master + jeho kopie), ať je fan-out armovaný kompletní. Orphan kopie (bez masteru
    // ve výběru) zůstávají nezaškrtnuté.
    useEffect(() => {
        if (isLoading) return;
        const visible = accounts.filter(a => mode === 'backtest' ? isBacktestAcc(a) : !isBacktestAcc(a));
        let defaults: string[];
        if (mode === 'backtest') {
            defaults = visible.map(a => a.id);
        } else {
            const masterAccs = visible.filter(a => !a.parentAccountId);
            const masterIds = new Set(masterAccs.map(a => a.id));
            defaults = [
                ...masterAccs.map(a => a.id),
                ...visible.filter(c => c.parentAccountId && masterIds.has(c.parentAccountId)).map(c => c.id),
            ];
        }
        setSelectedIds(defaults);
        onSelectionChange(defaults);
    }, [mode, accounts, isLoading, onSelectionChange]);

    const handleToggle = (id: string, isMaster: boolean) => {
        setSelectedIds(prev => {
            let newSelection = [...prev];

            if (newSelection.includes(id)) {
                newSelection = newSelection.filter(item => item !== id);
                // If unchecking master, ideally uncheck copies too
                if (isMaster) {
                    const copies = accounts.filter(a => a.parentAccountId === id).map(a => a.id);
                    newSelection = newSelection.filter(item => !copies.includes(item));
                }
            } else {
                newSelection.push(id);
                // If checking master, auto-check copies
                if (isMaster) {
                    const copies = accounts.filter(a => a.parentAccountId === id).map(a => a.id);
                    copies.forEach(copyId => {
                        if (!newSelection.includes(copyId)) newSelection.push(copyId);
                    });
                }
            }

            onSelectionChange(newSelection);
            return newSelection;
        });
    };

    if (isLoading) return <div className={`text-xs italic p-3 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Načítám účty...</div>;
    if (accounts.length === 0) return <div className={`text-xs p-3 font-bold border rounded-xl ${theme === 'dark' ? 'text-red-400 border-red-500/20 bg-red-500/10' : 'text-red-600 border-red-200 bg-red-50'}`}>Nejste přihlášen, nebo nemáte aktivované účty. Pročistěte cache Chrome rozšíření a zkuste to znovu.</div>;

    // Viditelné účty dle módu: backtest → jen Backtest účty; normal → bez nich.
    const visibleAccounts = accounts.filter(a => mode === 'backtest' ? isBacktestAcc(a) : !isBacktestAcc(a));
    if (visibleAccounts.length === 0) return <div className={`text-xs p-3 font-bold border rounded-xl ${theme === 'dark' ? 'text-amber-400 border-amber-500/20 bg-amber-500/10' : 'text-amber-600 border-amber-200 bg-amber-50'}`}>{mode === 'backtest' ? 'Nemáš žádný účet typu Backtest. Vytvoř ho v AlphaTrade (Účty → typ Backtest).' : 'Žádné živé účty.'}</div>;

    const masters = visibleAccounts.filter(a => !a.parentAccountId);
    const copies = visibleAccounts.filter(a => !!a.parentAccountId);

    // Odznak risk multiplikátoru — jen u účtů s ≠1× (1× = vizuální šum, vynecháváme).
    const multBadge = (a: Account) => {
        const m = Math.round(Number(a.copyMultiplier) || 1);
        if (m <= 1) return null;
        return (
            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded leading-none ${theme === 'dark' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'bg-indigo-100 text-indigo-700 border border-indigo-200'}`}>
                {m}×
            </span>
        );
    };

    return (
        <div className="flex flex-col mb-4">
            <label className={`block text-xs uppercase font-bold tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Účty k propsání</label>
            <div className={`border rounded-xl max-h-[120px] overflow-y-auto w-full custom-scroll ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50' : 'bg-white/80 border-slate-300/50'}`}>

                {masters.map(master => {
                    const myCopies = copies.filter(c => c.parentAccountId === master.id);
                    const isTrueMaster = myCopies.length > 0;
                    const isExpanded = expandedMasters.has(master.id);
                    const groupIds = [master.id, ...myCopies.map(c => c.id)];
                    const groupSize = groupIds.length;
                    const selectedInGroup = groupIds.filter(id => selectedIds.includes(id)).length;
                    const allSelected = selectedInGroup === groupSize;
                    return (
                        <div key={master.id} className={`mb-1 ${isTrueMaster ? (theme === 'dark' ? 'bg-slate-900/40 border border-slate-700/30 rounded-lg overflow-hidden' : 'bg-slate-100/50 border border-slate-200 rounded-lg overflow-hidden') : ''}`}>

                            <div className={`flex items-center gap-2.5 p-2 bg-transparent justify-between transition-colors ${theme === 'dark' ? 'hover:bg-cyan-500/10' : 'hover:bg-cyan-500/10'}`}>
                                {/* Levá zóna = výběr (celé skupiny u masteru) */}
                                <div className="flex items-center gap-2.5 relative cursor-pointer flex-1 min-w-0" onClick={() => handleToggle(master.id, isTrueMaster)}>
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.includes(master.id)}
                                        onChange={() => { }}
                                        className={`w-3.5 h-3.5 cursor-pointer accent-cyan-500 shrink-0`}
                                    />
                                    <span className={`text-sm font-bold truncate ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}>{master.name}</span>
                                    {multBadge(master)}
                                </div>
                                {/* Pravá zóna = počet + rozbalení (jen u skupin s kopiemi) */}
                                {isTrueMaster && (
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); toggleExpand(master.id); }}
                                        className="flex items-center gap-1.5 shrink-0 pl-2 group/exp"
                                        title={isExpanded ? 'Sbalit' : 'Rozbalit účty'}
                                    >
                                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded leading-none tabular-nums ${allSelected ? (theme === 'dark' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-cyan-100 text-cyan-700') : (theme === 'dark' ? 'bg-slate-600/30 text-slate-400' : 'bg-slate-200 text-slate-600')}`}>
                                            {selectedInGroup}/{groupSize}
                                        </span>
                                        <ChevronRight size={14} className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''} ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`} />
                                    </button>
                                )}
                            </div>

                            {isTrueMaster && isExpanded && myCopies.map(copy => (
                                <div
                                    key={copy.id}
                                    className={`flex items-center gap-2.5 p-2 pl-9 bg-transparent justify-between cursor-pointer transition-colors border-t relative ${theme === 'dark' ? 'hover:bg-purple-500/10 border-slate-700/30' : 'hover:bg-purple-500/10 border-slate-200'}`}
                                    onClick={() => handleToggle(copy.id, false)}
                                >
                                    <div className={`w-[8px] h-[8px] border-l-[1.5px] border-b-[1.5px] absolute left-3.5 -translate-y-[4px] ${theme === 'dark' ? 'border-slate-600' : 'border-slate-300'}`}></div>
                                    <div className="flex items-center gap-2.5 relative">
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.includes(copy.id)}
                                            onChange={() => { }}
                                            className="w-3 h-3 cursor-pointer accent-cyan-500 relative z-10"
                                        />
                                        <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>{copy.name}</span>
                                        {multBadge(copy)}
                                    </div>
                                    <span className={`text-[9px] font-bold px-1 py-0.5 rounded border uppercase ${theme === 'dark' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-purple-100 text-purple-700 border-purple-200'}`}>Copy</span>
                                </div>
                            ))}

                        </div>
                    );
                })}

                {/* Orphans */}
                {copies.filter(c => !masters.find(m => m.id === c.parentAccountId)).map(orphan => (
                    <div
                        key={orphan.id}
                        className={`flex items-center gap-2.5 p-2 bg-transparent justify-between border-b cursor-pointer transition-colors ${theme === 'dark' ? 'border-slate-700/30 hover:bg-cyan-500/10' : 'border-slate-200 hover:bg-cyan-500/10'}`}
                        onClick={() => handleToggle(orphan.id, false)}
                    >
                        <div className="flex items-center gap-2.5 relative">
                            <input
                                type="checkbox"
                                checked={selectedIds.includes(orphan.id)}
                                onChange={() => { }}
                                className="w-3.5 h-3.5 cursor-pointer accent-cyan-500"
                            />
                            <span className={`text-sm font-semibold ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}>{orphan.name}</span>
                            {multBadge(orphan)}
                        </div>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${theme === 'dark' ? 'bg-slate-500/10 text-slate-400 border-slate-500/20' : 'bg-slate-200 text-slate-600 border-slate-300'}`}>Orphan</span>
                    </div>
                ))}

            </div>
        </div>
    );
}
