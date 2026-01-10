
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
import {
    Trade,
    Account,
    BusinessExpense,
    BusinessPayout,
    PlaybookItem,
    BusinessGoal,
    BusinessResource,
    BusinessSettings
} from '../types';

interface BusinessHubProps {
    theme: 'dark' | 'light' | 'oled';
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
    theme, trades, accounts, expenses, payouts, playbook, goals, resources, settings,
    onUpdateExpenses, onUpdatePayouts, onUpdatePlaybook, onUpdateGoals, onUpdateResources, onUpdateSettings, onUpdateAccounts
}) => {
    const [activeTab, setActiveTab] = useState<'financials' | 'cíle'>('financials');
    const [isAddingExpense, setIsAddingExpense] = useState(false);
    const [newExpense, setNewExpense] = useState<Partial<BusinessExpense>>({
        label: '',
        category: 'Software',
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
    const isDark = theme !== 'light';

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
            category: (newExpense.category as any) || 'Software',
            amount: Number(newExpense.amount),
            date: newExpense.date || new Date().toISOString().split('T')[0],
            recurring: newExpense.recurring as any
        };
        onUpdateExpenses([...expenses, exp]);
        setIsAddingExpense(false);
        setNewExpense({ label: '', category: 'Software', amount: 0, date: new Date().toISOString().split('T')[0], recurring: 'monthly' });
    };

    // --- Financial Calculations ---
    const totalPnL = useMemo(() => trades.reduce((sum, t) => sum + t.pnl, 0), [trades]);
    const totalExpenses = useMemo(() => expenses.reduce((sum, e) => sum + e.amount, 0), [expenses]);
    const totalPayouts = useMemo(() => payouts.reduce((sum, p) => sum + (p.status === 'Received' ? p.amount : 0), 0), [payouts]);

    // Realized Business Metrics (Based on Payouts, not trade PnL)
    const realizedTaxReserve = useMemo(() => (totalPayouts > 0 ? (totalPayouts * (settings.taxRatePct / 100)) : 0), [totalPayouts, settings.taxRatePct]);
    const netBusinessCash = useMemo(() => totalPayouts - totalExpenses - realizedTaxReserve, [totalPayouts, totalExpenses, realizedTaxReserve]);

    // OpEx Summaries
    const monthlyRecurringOpEx = useMemo(() => {
        return expenses.reduce((sum, e) => {
            if (e.recurring === 'monthly') return sum + e.amount;
            if (e.recurring === 'yearly') return sum + (e.amount / 12);
            return sum;
        }, 0);
    }, [expenses]);

    const yearlyRecurringOpEx = useMemo(() => {
        return expenses.reduce((sum, e) => {
            if (e.recurring === 'yearly') return sum + e.amount;
            if (e.recurring === 'monthly') return sum + (e.amount * 12);
            return sum;
        }, 0);
    }, [expenses]);

    const accountProfitableDays = useMemo(() => {
        const stats: Record<string, number> = {};
        accounts.forEach(acc => {
            const accTrades = trades.filter(t => t.accountId === acc.id);
            const days: Record<string, number> = {};
            accTrades.forEach(t => {
                const d = t.date.split('T')[0];
                days[d] = (days[d] || 0) + t.pnl;
            });
            const threshold = acc.propThreshold || settings.defaultPropThreshold;
            stats[acc.id] = Object.values(days).filter(pnl => pnl >= threshold).length;
        });
        return stats;
    }, [trades, accounts, settings.defaultPropThreshold]);

    // --- Render Helpers ---
    const cardClass = `p-6 rounded-[24px] lg:rounded-[32px] border transition-all ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)] backdrop-blur-xl' : 'bg-white/80 border-slate-200 shadow-sm'}`;
    const inputClass = `w-full px-4 py-3 rounded-xl border bg-transparent text-sm font-bold outline-none transition-all ${isDark ? 'border-[var(--border-subtle)] focus:border-blue-500 text-white' : 'border-slate-200 focus:border-blue-500 text-slate-900'}`;

    return (
        <div className="space-y-8 pb-32 max-w-[1400px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div>
                    <h2 className={`text-4xl lg:text-6xl font-black tracking-tighter italic ${isDark ? 'text-white' : 'text-slate-900'}`}>BUSINESS HUB</h2>
                    <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">Corporate Grade Trading Management • HQ</p>
                </div>

                <div className={`flex p-1.5 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                    {(['financials', 'cíle'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
            </div>

            {activeTab === 'financials' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-500">
                    {/* Main Financial Stats */}
                    <div className="lg:col-span-8 space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className={cardClass + " border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.1)]"}>
                                <div className="flex justify-between items-start mb-4">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Net Business Cash</span>
                                    <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-lg"><Wallet size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter ${netBusinessCash >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    ${netBusinessCash.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </div>
                                <p className="text-[9px] font-bold text-slate-500 mt-2 uppercase tracking-tight">Realized Profit after Tax & OpEx</p>
                            </div>

                            <div className={cardClass}>
                                <div className="flex justify-between items-start mb-4">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Realized Tax Reserve ({settings.taxRatePct}%)</span>
                                    <div className="p-2 bg-amber-500/10 text-amber-500 rounded-lg"><PieChartIcon size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                    ${realizedTaxReserve.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Realized Revenue</span>
                                    <div className="p-2 bg-blue-500/10 text-blue-500 rounded-lg"><DollarSign size={16} /></div>
                                </div>
                                <div className={`text-3xl font-black tracking-tighter text-blue-500`}>
                                    ${totalPayouts.toLocaleString()}
                                </div>
                                <p className="text-[9px] font-bold text-slate-500 mt-2 uppercase tracking-tight">Total Payouts Received</p>
                            </div>
                        </div>

                        {/* Expenses Tracker */}
                        <div className={cardClass}>
                            <div className="flex justify-between items-center mb-8">
                                <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                                    <Layers size={16} className="text-blue-500" /> Operating Expenses
                                </h3>
                                <div className="flex items-center gap-4">
                                    <div className={`hidden md:flex items-center gap-6 px-4 py-2 rounded-xl border ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                        <div>
                                            <p className="text-[8px] font-black text-slate-500 uppercase">Monthly Burn</p>
                                            <p className={`text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>${monthlyRecurringOpEx.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                                        </div>
                                        <div className={`w-[1px] h-4 ${isDark ? 'bg-[var(--border-subtle)]' : 'bg-slate-200'}`}></div>
                                        <div>
                                            <p className="text-[8px] font-black text-slate-500 uppercase">Yearly Projection</p>
                                            <p className={`text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>${yearlyRecurringOpEx.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setIsAddingExpense(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase transition-all hover:bg-blue-500"
                                    >
                                        <Plus size={14} /> Přidat náklad
                                    </button>
                                </div>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className={`border-b ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Label</th>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Category</th>
                                            <th className="pb-4 text-[10px] font-black uppercase text-slate-500">Amount</th>
                                            <th className="pb-4"></th>
                                        </tr>
                                    </thead>
                                    <tbody className={`divide-y ${isDark ? 'divide-[var(--border-subtle)]' : 'divide-slate-50'}`}>
                                        {expenses.length === 0 ? (
                                            <tr>
                                                <td colSpan={4} className="py-8 text-center text-slate-500 text-xs font-bold font-mono">No expenses logged yet.</td>
                                            </tr>
                                        ) : (
                                            expenses.map(exp => (
                                                <tr key={exp.id}>
                                                    <td className={`py-4 text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{exp.label}</td>
                                                    <td className="py-4 text-[10px] font-bold text-slate-500 uppercase">{exp.category}</td>
                                                    <td className={`py-4 text-xs font-mono font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>${exp.amount}</td>
                                                    <td className="py-4 text-right">
                                                        <button onClick={() => onUpdateExpenses(expenses.filter(e => e.id !== exp.id))} className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all"><Trash2 size={14} /></button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    {/* Sidebar Financials */}
                    <div className="lg:col-span-4 space-y-6">
                        <div className={cardClass}>
                            <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2 mb-6">
                                <ShieldCheck size={16} className="text-emerald-500" /> Prop Firm Status
                            </h3>
                            <div className="space-y-4">
                                {accounts.filter(acc => acc.type === 'Funded').map(acc => (
                                    <div key={acc.id} className={`p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                                        <div className="flex justify-between items-center mb-3">
                                            <span className="text-[10px] font-black text-white uppercase">{acc.name}</span>
                                            <span className="px-2 py-0.5 bg-blue-500/10 text-blue-500 text-[8px] font-black rounded uppercase tracking-widest">
                                                {accountProfitableDays[acc.id]} / 5 days
                                            </span>
                                        </div>
                                        <div className={`h-1.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-[var(--bg-input)]' : 'bg-slate-200'}`}>
                                            <div
                                                className="h-full bg-blue-500 transition-all duration-1000"
                                                style={{ width: `${Math.min(100, (accountProfitableDays[acc.id] / 5) * 100)}%` }}
                                            ></div>
                                        </div>
                                        <div className="mt-3 flex justify-between items-center">
                                            <span className="text-[8px] font-bold text-slate-500 uppercase">Min Profit per day</span>
                                            <span className={`text-[9px] font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>${acc.propThreshold || settings.defaultPropThreshold}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Add Expense Modal */}
                    {isAddingExpense && (
                        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
                            <div className={`w-full max-w-md p-8 rounded-[32px] border shadow-2xl ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="text-xl font-black italic tracking-tight">ADD BUSINESS EXPENSE</h3>
                                    <button onClick={() => setIsAddingExpense(false)} className="p-2 text-slate-500 hover:text-white transition-all"><X size={20} /></button>
                                </div>

                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Expense Label</label>
                                        <input
                                            type="text" value={newExpense.label}
                                            onChange={(e) => setNewExpense({ ...newExpense, label: e.target.value })}
                                            className={inputClass} placeholder="e.g. TradingView Subscription"
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Amount ($)</label>
                                            <input
                                                type="number" value={newExpense.amount}
                                                onChange={(e) => setNewExpense({ ...newExpense, amount: Number(e.target.value) })}
                                                className={inputClass}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Category</label>
                                            <select
                                                value={newExpense.category}
                                                onChange={(e) => setNewExpense({ ...newExpense, category: e.target.value as any })}
                                                className={inputClass}
                                            >
                                                <option value="Software">Software</option>
                                                <option value="Education">Education</option>
                                                <option value="Hardware">Hardware</option>
                                                <option value="Taxes">Taxes</option>
                                                <option value="Other">Other</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Frequency</label>
                                            <select
                                                value={newExpense.recurring}
                                                onChange={(e) => setNewExpense({ ...newExpense, recurring: e.target.value as any })}
                                                className={inputClass}
                                            >
                                                <option value="monthly">Monthly</option>
                                                <option value="yearly">Yearly</option>
                                                <option value="once">Once</option>
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Date</label>
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
                                        Save Expense
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'cíle' && (
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
                                            onClick={() => onUpdateGoals(goals.filter(g => g.id !== goal.id))}
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
                                                    {goal.current.toLocaleString()} <span className="text-slate-600">/</span> {goal.target.toLocaleString()}
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
                                                                +{log.amount.toLocaleString()}
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

                    {/* Overall Summary Row */}
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

            {/* Add Goal Modal */}
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
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Type</label>
                                    <select
                                        value={newGoal.type}
                                        onChange={(e) => setNewGoal({ ...newGoal, type: e.target.value as any })}
                                        className={inputClass}
                                    >
                                        <option value="Monthly">Monthly</option>
                                        <option value="Yearly">Yearly</option>
                                        <option value="Count">Počet</option>
                                        <option value="Other">Ostatní</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Category</label>
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
        </div>
    );
};

export default BusinessHub;
