
import React, { useState, useMemo } from 'react';
import {
    Briefcase,
    DollarSign,
    Target,
    Layers,
    Settings,
    Plus,
    Trash2,
    TrendingUp,
    TrendingDown,
    PlusCircle,
    ChevronRight,
    Info,
    ChevronDown,
    LayoutGrid,
    Zap,
    PieChart as PieChartIcon,
    ShieldCheck,
    Calendar,
    Wallet,
    Maximize2,
    X,
    Trophy
} from 'lucide-react';
import PayoutModal from './PayoutModal';
import ConfirmationModal from './ConfirmationModal';
import {
    Trade,
    Account,
    BusinessExpense,
    BusinessPayout,
    PlaybookItem,
    BusinessGoal,
    BusinessResource,
    BusinessSettings,
    User
} from '../types';
import { currencyService, ExchangeRates } from '../services/currencyService';
import { t } from '../services/translations';

interface BusinessHubProps {
    theme: 'dark' | 'light' | 'oled';
    user: User;
    exchangeRates: ExchangeRates | null;
    trades: Trade[];
    accounts: Account[];
    expenses: BusinessExpense[];
    payouts: BusinessPayout[];
    playbook: PlaybookItem[];
    goals: BusinessGoal[];
    resources: BusinessResource[];
    settings: BusinessSettings;
    onUpdateExpenses: (expenses: BusinessExpense[]) => void;
    onUpdatePayouts: (payouts: BusinessPayout[]) => void;
    onUpdatePlaybook: (items: PlaybookItem[]) => void;
    onUpdateGoals: (goals: BusinessGoal[]) => void;
    onUpdateResources: (resources: BusinessResource[]) => void;
    onUpdateSettings: (settings: BusinessSettings) => void;
    onUpdateAccounts: (accounts: Account[]) => void;
}

const BusinessHub: React.FC<BusinessHubProps> = ({
    theme, user, exchangeRates, trades, accounts, expenses, payouts, playbook, goals, resources, settings,
    onUpdateExpenses, onUpdatePayouts, onUpdatePlaybook, onUpdateGoals, onUpdateResources, onUpdateSettings, onUpdateAccounts
}) => {
    const [activeTab, setActiveTab] = useState<'financials' | 'goals'>('financials');
    const [isAddingExpense, setIsAddingExpense] = useState(false);
    const [newExpense, setNewExpense] = useState<Partial<BusinessExpense>>({
        label: '',
        category: 'Challenges',
        amount: 0,
        date: new Date().toISOString().split('T')[0],
        recurring: 'monthly'
    });
    const [isAddingGoal, setIsAddingGoal] = useState(false);
    const [newGoal, setNewGoal] = useState<Partial<BusinessGoal>>({
        type: 'Monthly',
        metric: 'PnL',
        label: '',
        target: 0,
        current: 0,
        category: 'Financial',
        deadline: new Date().toISOString().split('T')[0]
    });
    const [updatingGoalId, setUpdatingGoalId] = useState<string | null>(null);
    const [incrementValue, setIncrementValue] = useState<number>(0);

    const [payoutViewMode, setPayoutViewMode] = useState<'list' | 'grid'>('list');
    const [isAddingPayout, setIsAddingPayout] = useState(false);
    const [editingPayout, setEditingPayout] = useState<BusinessPayout | null>(null);

    const [itemToDelete, setItemToDelete] = useState<{ id: string, type: 'expense' | 'payout' | 'goal' | 'playbook' | 'resource' } | null>(null);

    const isDark = theme !== 'light';
    const lang = user.language || 'cs';
    const targetCurrency = user.currency || 'USD';

    // Helper for formatting currency based on user preference
    const formatValue = (usdAmount: number) => {
        if (!exchangeRates) return currencyService.format(usdAmount, 'USD');
        const converted = currencyService.convert(usdAmount, targetCurrency, exchangeRates);
        return currencyService.format(converted, targetCurrency);
    };

    const handleAddGoal = () => {
        if (!newGoal.label || !newGoal.target) return;
        const goal: BusinessGoal = {
            id: `goal_${Date.now()}`,
            type: (newGoal.type as any) || 'Monthly',
            metric: (newGoal.metric as any) || 'PnL',
            label: newGoal.label,
            target: Number(newGoal.target),
            current: Number(newGoal.current) || 0,
            category: (newGoal.category as any) || 'Financial',
            deadline: newGoal.deadline || new Date().toISOString().split('T')[0]
        };
        onUpdateGoals([...goals, goal]);
        setIsAddingGoal(false);
        setNewGoal({ type: 'Monthly', metric: 'PnL', label: '', target: 0, current: 0, category: 'Financial', deadline: new Date().toISOString().split('T')[0] });
    };

    const getGoalColor = (category: string) => {
        switch (category) {
            case 'Financial': return 'text-emerald-500';
            case 'Psychology': return 'text-purple-500';
            case 'Technical': return 'text-blue-500';
            default: return 'text-slate-500';
        }
    };

    const getGoalBgColor = (category: string) => {
        switch (category) {
            case 'Financial': return 'bg-emerald-500/10';
            case 'Psychology': return 'bg-purple-500/10';
            case 'Technical': return 'bg-blue-500/10';
            default: return 'bg-slate-500/10';
        }
    };

    const getDaysRemaining = (deadline: string) => {
        const diff = new Date(deadline).getTime() - new Date().getTime();
        return Math.ceil(diff / (1000 * 60 * 60 * 24));
    };

    const handleUpdateGoalProgress = (goalId: string, amount: number) => {
        const newGoals = goals.map(g => {
            if (g.id === goalId) {
                const logs = g.logs || [];
                return {
                    ...g,
                    current: g.current + amount,
                    logs: [...logs, { date: new Date().toISOString(), amount }]
                };
            }
            return g;
        });
        onUpdateGoals(newGoals);
        setUpdatingGoalId(null);
        setIncrementValue(0);
    };

    const handleAddExpense = () => {
        if (!newExpense.label || !newExpense.amount) return;
        const exp: BusinessExpense = {
            id: `exp_${Date.now()}`,
            label: newExpense.label,
            category: (newExpense.category as any) || 'Other',
            amount: Number(newExpense.amount),
            date: newExpense.date || new Date().toISOString().split('T')[0],
            recurring: newExpense.recurring as any
        };
        onUpdateExpenses([...expenses, exp]);
        setIsAddingExpense(false);
        setNewExpense({ label: '', category: 'Challenges', amount: 0, date: new Date().toISOString().split('T')[0], recurring: 'monthly' });
    };

    const handleTogglePayoutStatus = (payoutId: string) => {
        const newPayouts = payouts.map(p => {
            if (p.id === payoutId) {
                return { ...p, status: p.status === 'Received' ? 'Pending' : 'Received' as any };
            }
            return p;
        });
        onUpdatePayouts(newPayouts);
    };

    const handleSavePayout = (payout: BusinessPayout) => {
        const exists = payouts.find(p => p.id === payout.id);
        if (exists) {
            onUpdatePayouts(payouts.map(p => p.id === payout.id ? payout : p));
        } else {
            onUpdatePayouts([...payouts, payout]);
        }
    };

    const handlePayoutImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Moved to PayoutModal
    };

    // --- Financial Calculations (All in USD base) ---
    const totalPnL = useMemo(() => trades.reduce((sum, t) => sum + t.pnl, 0), [trades]);
    const totalExpenses = useMemo(() => expenses.reduce((sum, e) => sum + e.amount, 0), [expenses]);

    // Calculate total net payouts from the payouts history
    const totalPayouts = useMemo(() =>
        payouts.filter(p => p.status === 'Received').reduce((sum, p) => sum + p.amount, 0),
        [payouts]);

    const unifiedPayouts = useMemo(() => {
        return [...payouts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [payouts]);

    const realizedTaxReserveValue = useMemo(() => (totalPayouts > 0 ? (totalPayouts * (settings.taxRatePct / 100)) : 0), [totalPayouts, settings.taxRatePct]);
    const netBusinessCashValue = useMemo(() => totalPayouts - totalExpenses - realizedTaxReserveValue, [totalPayouts, totalExpenses, realizedTaxReserveValue]);

    const monthlyRecurringOpExValue = useMemo(() => {
        return expenses.reduce((sum, e) => {
            if (e.recurring === 'monthly') return sum + e.amount;
            if (e.recurring === 'yearly') return sum + (e.amount / 12);
            return sum;
        }, 0);
    }, [expenses]);

    const yearlyRecurringOpExValue = useMemo(() => {
        return expenses.reduce((sum, e) => {
            if (e.recurring === 'yearly') return sum + e.amount;
            if (e.recurring === 'monthly') return sum + (e.amount * 12);
            return sum;
        }, 0);
    }, [expenses]);

    // --- Render Helpers ---
    const cardClass = `p-6 rounded-[24px] lg:rounded-[32px] border transition-all ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)] backdrop-blur-xl' : 'bg-white/80 border-slate-200 shadow-sm'}`;
    const inputClass = `w-full px-4 py-3 rounded-xl border bg-transparent text-sm font-bold outline-none transition-all ${isDark ? 'border-[var(--border-subtle)] focus:border-blue-500 text-white' : 'border-slate-200 focus:border-blue-500 text-slate-900'}`;

    return (
        <div className="space-y-8 pb-32 max-w-[1400px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div>
                    <h2 className={`text-4xl lg:text-6xl font-black tracking-tighter italic ${isDark ? 'text-white' : 'text-slate-900'}`}>{t('business_hub', lang)}</h2>
                    <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">{t('hq_desc', lang)}</p>
                </div>

                <div className={`flex p-1.5 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                    {[
                        { id: 'financials', label: t('finance', lang) },
                        { id: 'goals', label: t('goals', lang) }
                    ].map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as any)}
                            className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {activeTab === 'financials' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-500">
                    <div className="lg:col-span-12 space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className={cardClass + " border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.1)]"}>
                                <div className="flex justify-between items-start mb-4">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{t('net_cash', lang)}</span>
                                    <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-lg"><Wallet size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter ${netBusinessCashValue >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {formatValue(netBusinessCashValue)}
                                </div>
                                <p className="text-[9px] font-bold text-slate-500 mt-2 uppercase tracking-tight">Realizovaný zisk po zdanění a nákladech (OpEx)</p>
                            </div>

                            <div className={cardClass}>
                                <div className="flex justify-between items-start mb-4">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{t('tax_reserve', lang)} ({settings.taxRatePct}%)</span>
                                    <div className="p-2 bg-amber-500/10 text-amber-500 rounded-lg"><PieChartIcon size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                    {formatValue(realizedTaxReserveValue)}
                                </div>
                                <div className="mt-4 flex items-center gap-2">
                                    <input
                                        type="range" min="0" max="50" value={settings.taxRatePct}
                                        onChange={(e) => onUpdateSettings({ ...settings, taxRatePct: parseInt(e.target.value) })}
                                        className={`flex-1 accent-blue-600 h-1 rounded-lg appearance-none cursor-pointer ${isDark ? 'bg-[var(--bg-input)]' : 'bg-slate-200'}`}
                                    />
                                </div>
                            </div>

                            <div className={cardClass}>
                                <div className="flex justify-between items-start mb-4">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{t('realized_income', lang)}</span>
                                    <div className="p-2 bg-blue-500/10 text-blue-500 rounded-lg"><DollarSign size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter text-blue-500`}>
                                    {formatValue(totalPayouts)}
                                </div>
                                <p className="text-[9px] font-bold text-slate-500 mt-2 uppercase tracking-tight">Celkové obdržené výplaty</p>
                            </div>
                        </div>

                        <div className={cardClass}>
                            <div className="flex justify-between items-center mb-8">
                                <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                                    <Layers size={16} className="text-blue-500" /> {t('operating_expenses', lang)}
                                </h3>
                                <div className="flex items-center gap-4">
                                    <div className={`hidden md:flex items-center gap-6 px-4 py-2 rounded-xl border ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                        <div>
                                            <p className="text-[8px] font-black text-slate-500 uppercase">{t('monthly_burn', lang)}</p>
                                            <p className={`text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{formatValue(monthlyRecurringOpExValue)}</p>
                                        </div>
                                        <div className={`w-[1px] h-4 ${isDark ? 'bg-[var(--border-subtle)]' : 'bg-slate-200'}`}></div>
                                        <div>
                                            <p className="text-[8px] font-black text-slate-500 uppercase">{t('yearly_projection', lang)}</p>
                                            <p className={`text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{formatValue(yearlyRecurringOpExValue)}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setIsAddingExpense(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase transition-all hover:bg-blue-500"
                                    >
                                        <Plus size={14} /> {t('add_expense', lang)}
                                    </button>
                                </div>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className={`border-b ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Datum</th>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Popis</th>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Kategorie</th>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Částka</th>
                                            <th className="pb-4"></th>
                                        </tr>
                                    </thead>
                                    <tbody className={`divide-y ${isDark ? 'divide-[var(--border-subtle)]' : 'divide-slate-50'}`}>
                                        {expenses.length === 0 ? (
                                            <tr>
                                                <td colSpan={5} className="py-8 text-center text-slate-500 text-xs font-bold font-mono">Zatím nebyly zaznamenány žádné náklady.</td>
                                            </tr>
                                        ) : (
                                            [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(exp => (
                                                <tr key={exp.id}>
                                                    <td className="py-4 text-[10px] font-bold text-slate-400 font-mono italic">{exp.date}</td>
                                                    <td className={`py-4 text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{exp.label}</td>
                                                    <td className="py-4 text-[10px] font-bold text-slate-500 uppercase">{exp.category}</td>
                                                    <td className={`py-4 text-xs font-mono font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{formatValue(exp.amount)}</td>
                                                    <td className="py-4 text-right">
                                                        <button onClick={() => setItemToDelete({ id: exp.id, type: 'expense' })} className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all"><Trash2 size={14} /></button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className={cardClass}>
                            <div className="flex justify-between items-center mb-8">
                                <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                                    <DollarSign size={16} className="text-emerald-500" /> {t('payout_history', lang)}
                                </h3>
                                <div className="flex items-center gap-4">
                                    <div className={`flex p-1 rounded-xl border ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                        <button
                                            onClick={() => setPayoutViewMode('list')}
                                            className={`p-1.5 rounded-lg transition-all ${payoutViewMode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                        >
                                            <Calendar size={14} />
                                        </button>
                                        <button
                                            onClick={() => setPayoutViewMode('grid')}
                                            className={`p-1.5 rounded-lg transition-all ${payoutViewMode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                        >
                                            <LayoutGrid size={14} />
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => setIsAddingPayout(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl text-[10px] font-black uppercase transition-all hover:bg-emerald-500"
                                    >
                                        <Plus size={14} /> {t('add_payout', lang) || 'Přidat výplatu'}
                                    </button>
                                </div>
                            </div>

                            <PayoutModal
                                isOpen={isAddingPayout || !!editingPayout}
                                onClose={() => { setIsAddingPayout(false); setEditingPayout(null); }}
                                onSave={handleSavePayout}
                                accounts={accounts}
                                payout={editingPayout}
                                theme={theme}
                                user={user}
                            />

                            {payoutViewMode === 'list' ? (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left">
                                        <thead>
                                            <tr className={`border-b ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                                                <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Datum</th>
                                                <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Účet</th>
                                                <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Částka</th>
                                                <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Status</th>
                                                <th className="pb-4"></th>
                                            </tr>
                                        </thead>
                                        <tbody className={`divide-y ${isDark ? 'divide-[var(--border-subtle)]' : 'divide-slate-50'}`}>
                                            {unifiedPayouts.length === 0 ? (
                                                <tr>
                                                    <td colSpan={5} className="py-8 text-center text-slate-500 text-xs font-bold font-mono">Zatím nebyly zaznamenány žádné výplaty.</td>
                                                </tr>
                                            ) : (
                                                unifiedPayouts.map(p => {
                                                    const acc = accounts.find(a => a.id === p.accountId);
                                                    const isLegacy = p.id.toString().startsWith('legacy_');
                                                    return (
                                                        <tr
                                                            key={p.id}
                                                            className={!isLegacy ? "cursor-pointer hover:bg-white/[0.02] transition-colors" : ""}
                                                            onClick={() => !isLegacy && setEditingPayout(p)}
                                                        >
                                                            <td className="py-4 text-[10px] font-bold text-slate-400 font-mono italic">{p.date}</td>
                                                            <td className={`py-4 text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{acc?.name || 'Neznámý'}</td>
                                                            <td className={`py-4 text-xs font-mono font-black text-emerald-500`}>{formatValue(p.amount)}</td>
                                                            <td className="py-4">
                                                                <div className="flex items-center gap-3">
                                                                    {isLegacy ? (
                                                                        <span className="px-3 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-500/60">ARCHIVOVÁNO</span>
                                                                    ) : (
                                                                        <button
                                                                            onClick={(e) => { e.stopPropagation(); handleTogglePayoutStatus(p.id); }}
                                                                            className={`px-3 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all ${p.status === 'Received' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}
                                                                        >
                                                                            {p.status === 'Received' ? 'OBDRŽENO' : 'ČEKÁ SE'}
                                                                        </button>
                                                                    )}
                                                                    {p.image && (
                                                                        <div className="w-6 h-6 rounded-md bg-emerald-500/20 flex items-center justify-center text-emerald-500">
                                                                            <Trophy size={12} />
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="py-4 text-right">
                                                                {!isLegacy && (
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); setItemToDelete({ id: p.id, type: 'payout' }); }}
                                                                        className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all"
                                                                    >
                                                                        <Trash2 size={14} />
                                                                    </button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 animate-in fade-in duration-500">
                                    {unifiedPayouts.length === 0 ? (
                                        <div className="col-span-full py-20 text-center opacity-30">
                                            <LayoutGrid size={48} className="mx-auto text-slate-700 mb-4" />
                                            <p className="text-slate-500 font-bold uppercase tracking-widest text-xs">Zatím nebyly zaznamenány žádné výplaty.</p>
                                        </div>
                                    ) : (
                                        unifiedPayouts.map(p => {
                                            const acc = accounts.find(a => a.id === p.accountId);
                                            const isLegacy = p.id.toString().startsWith('legacy_');
                                            return (
                                                <div
                                                    key={p.id}
                                                    onClick={() => !isLegacy && setEditingPayout(p)}
                                                    className={`aspect-square rounded-2xl border overflow-hidden relative group transition-all ${!isLegacy ? 'cursor-pointer hover:border-blue-500/50 hover:shadow-2xl hover:shadow-blue-500/10' : ''} ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50'}`}
                                                >
                                                    {p.image ? (
                                                        <img src={p.image} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt="Payout proof" />
                                                    ) : (
                                                        <div className="w-full h-full flex flex-col items-center justify-center p-4">
                                                            <DollarSign size={24} className="text-emerald-500/40 mb-2" />
                                                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Bez fotky</span>
                                                        </div>
                                                    )}
                                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                                                        <p className="text-[8px] font-black text-white/60 uppercase">{p.date}</p>
                                                        <p className="text-[11px] font-black text-emerald-400 font-mono tracking-tighter">{formatValue(p.amount)}</p>
                                                        <p className="text-[7px] font-black text-white uppercase truncate">{acc?.name || 'Neznámý'}</p>
                                                    </div>
                                                    {isLegacy && (
                                                        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md text-[6px] font-black text-white/50 uppercase tracking-widest border border-white/5">ARCHIV</div>
                                                    )}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'goals' && (
                <div className="animate-in fade-in duration-500 space-y-8">
                    <div className="flex justify-between items-center">
                        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                            <Target size={16} className="text-blue-500" /> Strategické Cíle
                        </h3>
                        <button
                            onClick={() => setIsAddingGoal(true)}
                            className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-2xl text-[10px] font-black uppercase transition-all hover:bg-blue-500 shadow-lg shadow-blue-600/20"
                        >
                            <Plus size={16} /> Nový Cíl
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {goals.length === 0 ? (
                            <div className={cardClass + " col-span-full py-20 text-center opacity-30"}>
                                <Target size={48} className="mx-auto text-slate-700 mb-4" />
                                <p className="text-slate-500 font-bold uppercase tracking-widest text-xs">Zatím nebyly nastaveny žádné cíle.</p>
                            </div>
                        ) : (
                            goals.map((goal) => {
                                const progress = Math.min(100, (goal.current / goal.target) * 100);
                                const radius = 32;
                                const circumference = 2 * Math.PI * radius;
                                const strokeDashoffset = circumference - (progress / 100) * circumference;
                                const colorClass = getGoalColor(goal.category);
                                const bgColorClass = getGoalBgColor(goal.category);

                                return (
                                    <div key={goal.id} className={cardClass + ` relative group overflow-hidden pb-2 ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                                        <button
                                            onClick={() => setItemToDelete({ id: goal.id, type: 'goal' })}
                                            className="absolute top-4 right-4 p-2 bg-rose-500/10 text-rose-500 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500 hover:text-white z-10"
                                        >
                                            <Trash2 size={12} />
                                        </button>

                                        <div className="flex items-center gap-6 mb-4">
                                            <div className="relative w-16 h-16 flex-shrink-0">
                                                <svg className="w-full h-full transform -rotate-90">
                                                    <circle
                                                        cx="32" cy="32" r="28"
                                                        stroke="currentColor" strokeWidth="6" fill="transparent"
                                                        className={isDark ? 'text-[var(--bg-input)]' : 'text-slate-100'}
                                                    />
                                                    <circle
                                                        cx="32" cy="32" r="28"
                                                        stroke="currentColor" strokeWidth="6" fill="transparent"
                                                        strokeDasharray={2 * Math.PI * 28}
                                                        strokeDashoffset={(2 * Math.PI * 28) - (progress / 100) * (2 * Math.PI * 28)}
                                                        className={`${colorClass} transition-all duration-1000 ease-out`}
                                                        strokeLinecap="round"
                                                    />
                                                </svg>
                                                <div className="absolute inset-0 flex items-center justify-center">
                                                    <span className={`text-[10px] font-black tracking-tighter ${colorClass}`}>{Math.round(progress)}%</span>
                                                </div>
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={`px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-widest ${bgColorClass} ${colorClass}`}>
                                                        {goal.type}
                                                    </span>
                                                    <span className="text-[7px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                                                        {goal.deadline ? (() => {
                                                            const days = getDaysRemaining(goal.deadline);
                                                            return days > 0 ? `${days} dní zbývá` : 'Termín vypršel';
                                                        })() : goal.category}
                                                    </span>
                                                </div>
                                                <h4 className={`text-xs font-black uppercase truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{goal.label}</h4>
                                                <p className="text-[10px] font-mono font-black text-slate-400 mt-1">
                                                    {goal.metric === 'PnL' ? formatValue(goal.current) : goal.current.toLocaleString()}
                                                    <span className="text-slate-600 ml-1">/</span>
                                                    {goal.metric === 'PnL' ? formatValue(goal.target) : goal.target.toLocaleString()}
                                                </p>
                                            </div>

                                            <div className="flex-shrink-0">
                                                <button
                                                    onClick={() => setUpdatingGoalId(updatingGoalId === goal.id ? null : goal.id)}
                                                    className={`p-2 rounded-xl transition-all ${updatingGoalId === goal.id ? 'bg-blue-600 text-white' : (isDark ? 'bg-[var(--bg-page)] border border-[var(--border-subtle)] text-slate-400 hover:text-white' : 'bg-slate-50 border border-slate-200 text-slate-400')}`}
                                                >
                                                    <Plus size={18} />
                                                </button>
                                            </div>
                                        </div>

                                        {updatingGoalId === goal.id && (
                                            <div className={`mt-2 p-4 rounded-2xl border animate-in slide-in-from-top-2 duration-300 ${isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="number"
                                                        value={incrementValue || ''}
                                                        onChange={(e) => setIncrementValue(Number(e.target.value))}
                                                        className={`flex-1 rounded-xl px-4 py-2 text-xs font-mono font-black outline-none focus:ring-1 focus:ring-blue-500/50 ${isDark ? 'bg-[var(--bg-page)] border border-[var(--border-subtle)] text-white' : 'bg-white border border-slate-200 text-slate-900'}`}
                                                        placeholder="Zadej částku..."
                                                        autoFocus
                                                    />
                                                    <button
                                                        onClick={() => handleUpdateGoalProgress(goal.id, incrementValue)}
                                                        className="px-4 py-2 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase transition-all hover:bg-blue-500 active:scale-95"
                                                    >
                                                        Přidat
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {goal.logs && goal.logs.length > 0 && (
                                            <div className={`mt-4 pt-4 border-t ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                                                <div className="flex items-center justify-between mb-2 px-1">
                                                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Historie záznamů</span>
                                                    <span className="text-[8px] font-bold text-slate-600 uppercase">{goal.logs.length} zápisů</span>
                                                </div>
                                                <div className="max-h-[100px] overflow-y-auto space-y-1.5 pr-2 custom-scrollbar">
                                                    {[...goal.logs].reverse().map((log, idx) => (
                                                        <div key={idx} className={`flex items-center justify-between text-[9px] py-1.5 px-3 rounded-lg ${isDark ? 'bg-[var(--bg-page)]/40' : 'bg-slate-50'}`}>
                                                            <span className="font-mono text-slate-400">
                                                                {new Date(log.date).toLocaleDateString()}
                                                            </span>
                                                            <span className={`font-black ${colorClass}`}>
                                                                +{goal.metric === 'PnL' ? formatValue(log.amount) : log.amount.toLocaleString()}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className={cardClass + " p-8"}>
                        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                            <div className="flex items-center gap-6">
                                <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center shadow-2xl shadow-blue-600/40">
                                    <Trophy size={32} className="text-white" />
                                </div>
                                <div>
                                    <h4 className={`text-lg font-black uppercase tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>Strategické Zaměření</h4>
                                    <p className="text-xs text-slate-400 max-w-[400px] leading-relaxed">
                                        Sledujete {goals.length} klíčových OKR.
                                        {goals.length > 0 && ` Vaše průměrné plnění je ${Math.round(goals.reduce((acc, g) => acc + (g.current / g.target), 0) / (goals.length || 1) * 100)}%.`}
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-4">
                                <div className={`px-6 py-3 rounded-2xl border text-center min-w-[120px] ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                    <p className="text-[8px] font-black text-slate-500 uppercase mb-1">Celkem Cílů</p>
                                    <p className={`text-xl font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{goals.length}</p>
                                </div>
                                <div className={`px-6 py-3 rounded-2xl border text-center min-w-[120px] ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                    <p className="text-[8px] font-black text-slate-500 uppercase mb-1">Splněno</p>
                                    <p className={`text-xl font-black ${isDark ? 'text-emerald-500' : 'text-emerald-600'}`}>{goals.filter(g => g.current >= g.target).length}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isAddingExpense && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
                    <div className={`w-full max-w-md p-8 rounded-[32px] border shadow-2xl ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-xl font-black italic tracking-tight">PŘIDAT NÁKLAD</h3>
                            <button onClick={() => setIsAddingExpense(false)} className="p-2 text-slate-500 hover:text-white transition-all"><X size={20} /></button>
                        </div>

                        <div className="space-y-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Popis nákladu</label>
                                <input
                                    type="text" value={newExpense.label}
                                    onChange={(e) => setNewExpense({ ...newExpense, label: e.target.value })}
                                    className={inputClass} placeholder="např. Předplatné TradingView"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Částka (USD)</label>
                                    <input
                                        type="number" value={newExpense.amount}
                                        onChange={(e) => setNewExpense({ ...newExpense, amount: Number(e.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Kategorie</label>
                                    <select
                                        value={newExpense.category}
                                        onChange={(e) => setNewExpense({ ...newExpense, category: e.target.value as any })}
                                        className={inputClass}
                                    >
                                        <option value="Software">Software</option>
                                        <option value="Education">Vzdělávání</option>
                                        <option value="Hardware">Hardware</option>
                                        <option value="Taxes">Daně</option>
                                        <option value="Challenges">Challenges</option>
                                        <option value="Other">Ostatní</option>
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Frekvence</label>
                                    <select
                                        value={newExpense.recurring}
                                        onChange={(e) => setNewExpense({ ...newExpense, recurring: e.target.value as any })}
                                        className={inputClass}
                                    >
                                        <option value="monthly">Měsíčně</option>
                                        <option value="yearly">Ročně</option>
                                        <option value="once">Jednorázově</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Datum</label>
                                    <input
                                        type="date" value={newExpense.date}
                                        onChange={(e) => setNewExpense({ ...newExpense, date: e.target.value })}
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <button
                                onClick={handleAddExpense}
                                className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest transition-all shadow-lg shadow-blue-600/20 active:scale-[0.98]"
                            >
                                Uložit náklad
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isAddingGoal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
                    <div className={`w-full max-w-md p-8 rounded-[32px] border shadow-2xl ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-xl font-black italic tracking-tight">NOVÝ CÍL</h3>
                            <button onClick={() => setIsAddingGoal(false)} className="p-2 text-slate-500 hover:text-white transition-all"><X size={20} /></button>
                        </div>

                        <div className="space-y-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Název Cíle</label>
                                <input
                                    type="text" value={newGoal.label}
                                    onChange={(e) => setNewGoal({ ...newGoal, label: e.target.value })}
                                    className={inputClass} placeholder="např. Měsíční PnL Cíl"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Typ</label>
                                    <select
                                        value={newGoal.type}
                                        onChange={(e) => setNewGoal({ ...newGoal, type: e.target.value as any })}
                                        className={inputClass}
                                    >
                                        <option value="Monthly">Měsíční</option>
                                        <option value="Yearly">Roční</option>
                                        <option value="Count">Počet</option>
                                        <option value="Other">Ostatní</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Kategorie</label>
                                    <select
                                        value={newGoal.category}
                                        onChange={(e) => setNewGoal({ ...newGoal, category: e.target.value as any })}
                                        className={inputClass}
                                    >
                                        <option value="Financial">Finanční</option>
                                        <option value="Psychology">Psychologie</option>
                                        <option value="Technical">Technické</option>
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Cílová Hodnota</label>
                                    <input
                                        type="number" value={newGoal.target}
                                        onChange={(e) => setNewGoal({ ...newGoal, target: Number(e.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Termín</label>
                                    <input
                                        type="date" value={newGoal.deadline}
                                        onChange={(e) => setNewGoal({ ...newGoal, deadline: e.target.value })}
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <button
                                onClick={handleAddGoal}
                                className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest transition-all shadow-lg shadow-blue-600/20 active:scale-[0.98]"
                            >
                                Nastavit Cíl
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Confirmation Modal */}
            <ConfirmationModal
                isOpen={!!itemToDelete}
                onClose={() => setItemToDelete(null)}
                onConfirm={() => {
                    if (!itemToDelete) return;
                    if (itemToDelete.type === 'expense') onUpdateExpenses(expenses.filter(x => x.id !== itemToDelete.id));
                    if (itemToDelete.type === 'payout') onUpdatePayouts(payouts.filter(x => x.id !== itemToDelete.id));
                    if (itemToDelete.type === 'goal') onUpdateGoals(goals.filter(x => x.id !== itemToDelete.id));
                    if (itemToDelete.type === 'playbook') onUpdatePlaybook(playbook.filter(x => x.id !== itemToDelete.id));
                    if (itemToDelete.type === 'resource') onUpdateResources(resources.filter(x => x.id !== itemToDelete.id));
                }}
                title={
                    itemToDelete?.type === 'expense' ? 'Smazat výdaj' :
                        itemToDelete?.type === 'payout' ? 'Smazat výplatu' :
                            itemToDelete?.type === 'goal' ? 'Smazat cíl' :
                                itemToDelete?.type === 'playbook' ? 'Smazat položku' : 'Smazat zdroj'
                }
                message="Opravdu chcete tuto položku trvale odstranit? Tato akce je nevratná."
                theme={theme}
            />
        </div>
    );
};

export default BusinessHub;
