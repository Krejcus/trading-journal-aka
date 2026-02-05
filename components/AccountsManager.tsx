import React, { useState, useMemo, useCallback } from 'react';
import { Account, Trade, BusinessPayout, User } from '../types';
import {
  Activity,
  Plus,
  Trash2,
  Check,
  X,
  Archive,
  DollarSign,
  HandCoins,
  Trophy,
  Crown,
  PartyPopper,
  Skull,
  Settings2,
  Link,
  TrendingUp,
  LayoutGrid,
  Calendar
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import PayoutModal from './PayoutModal';

interface AccountsManagerProps {
  accounts: Account[];
  activeAccountId: string;
  setActiveAccountId: (id: string) => void;
  onUpdate: (accounts: Account[]) => void;
  onDelete: (id: string) => void;
  theme: 'dark' | 'light' | 'oled';
  trades: Trade[];
  onUpdateTrades: (trades: Trade[]) => void;
  onAddExpense?: (expense: any) => void;
  onUpdatePayouts: (payouts: BusinessPayout[]) => void;
  payouts: BusinessPayout[];
  user: User;
}

// Sparkline Helper Component
const AccountSparkline = ({ trades, initialBalance, color, theme }: { trades: Trade[], initialBalance: number, theme: string, color: string }) => {
  const points = useMemo(() => {
    let balance = initialBalance;
    const data = [{ x: 0, y: balance }];
    const sortedTrades = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const recentTrades = sortedTrades.slice(-20);
    recentTrades.forEach((t, i) => {
      balance += t.pnl;
      data.push({ x: i + 1, y: balance });
    });
    return data;
  }, [trades, initialBalance]);

  if (points.length < 2) return null;

  const min = Math.min(...points.map(p => p.y));
  const max = Math.max(...points.map(p => p.y));
  const range = max - min || 1;
  const height = 40;
  const width = 120;

  const svgPath = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const normalizedY = ((p.y - min) / range);
    const y = height - (normalizedY * height);
    return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
  }).join(' ');

  const strokeColor = color === 'emerald' ? '#10b981' : color === 'rose' ? '#f43f5e' : '#3b82f6';

  return (
    <div className="absolute right-0 bottom-0 opacity-20 pointer-events-none z-0">
      <svg width={width} height={height} className="overflow-visible">
        <path d={svgPath} fill="none" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <linearGradient id={`grad-${color}-${Math.random()}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.5" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
        </linearGradient>
        <path d={`${svgPath} L ${width},${height} L 0,${height} Z`} fill={`url(#grad-${color}-${Math.random()})`} stroke="none" />
      </svg>
    </div>
  );
};

const AccountsManager: React.FC<AccountsManagerProps> = ({
  accounts,
  activeAccountId,
  setActiveAccountId,
  onUpdate,
  onDelete,
  theme,
  trades,
  onUpdatePayouts,
  payouts,
  user,
  onAddExpense
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [payoutTargetAccountId, setPayoutTargetAccountId] = useState<string | null>(null);
  const [passConfirmTarget, setPassConfirmTarget] = useState<Account | null>(null);
  const [failConfirmTarget, setFailConfirmTarget] = useState<Account | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [newAccount, setNewAccount] = useState<Partial<Account>>({
    name: '',
    initialBalance: 10000,
    challengeCost: 0,
    profitSplit: 90,
    type: 'Funded',
    phase: 'Challenge',
    status: 'Active',
    currency: 'USD',
    instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
  });

  const [editFormData, setEditFormData] = useState<Partial<Account>>({});

  const portfolioStats = useMemo(() => {
    const totalChallengeCosts = accounts.reduce((sum, acc) => sum + (acc.challengeCost || 0), 0);
    const totalNetPayouts = payouts.filter(p => p.status === 'Received').reduce((sum, p) => sum + p.amount, 0);
    const totalTradesPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const netCashflow = totalNetPayouts - totalChallengeCosts;

    const challenges = accounts.filter(a => a.type === 'Funded');
    const challengeCount = challenges.length;
    const passedChallenges = accounts.filter(a => a.type === 'Funded' && a.phase === 'Funded').length;
    const passRate = challengeCount > 0 ? (passedChallenges / challengeCount) * 100 : 0;

    return {
      totalChallengeCosts,
      totalNetPayouts,
      totalTradesPnL,
      netCashflow,
      challengeCount,
      passRate,
      activeCount: accounts.filter(a => a.status === 'Active').length,
      inactiveCount: accounts.filter(a => a.status === 'Inactive').length
    };
  }, [accounts, trades, payouts]);

  const groupedAccounts = useMemo(() => {
    const list = showInactive ? accounts.filter(a => a.status === 'Inactive') : accounts.filter(a => a.status === 'Active');
    // Masters are accounts without parentAccountId, OR accounts whose parent is NOT in the current visible list
    const masters = list.filter(a => !a.parentAccountId || !list.some(potentialParent => potentialParent.id === a.parentAccountId));

    masters.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return masters.map(master => {
      const slaves = list.filter(a => a.parentAccountId === master.id);
      return { master, slaves };
    });
  }, [accounts, showInactive]);

  const handleAddAccount = () => {
    if (!newAccount.name) return;
    const account: Account = {
      id: `acc_${Date.now()}`,
      name: newAccount.name!,
      initialBalance: Number(newAccount.initialBalance),
      challengeCost: Number(newAccount.challengeCost) || 0,
      totalWithdrawals: 0,
      totalGrossWithdrawals: 0,
      profitSplit: Number(newAccount.profitSplit) || 90,
      phase: newAccount.phase as any || 'Challenge',
      accumulatedChallengePnL: 0,
      type: newAccount.type as any,
      status: 'Active',
      currency: 'USD',
      propThreshold: 150,
      instrumentFees: newAccount.instrumentFees || { 'NQ': 2.8, 'MNQ': 0.74 },
      createdAt: Date.now()
    };
    onUpdate([...accounts, account]);

    if (account.challengeCost > 0 && onAddExpense) {
      onAddExpense({
        id: `exp_${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        label: `Nákup účtu: ${account.name}`,
        amount: account.challengeCost,
        category: 'Challenges'
      });
    }

    setIsAdding(false);
    setNewAccount({
      name: '',
      initialBalance: 10000,
      challengeCost: 0,
      profitSplit: 90,
      type: 'Funded',
      phase: 'Challenge',
      status: 'Active',
      instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
    });
  };

  const handleSavePayout = (payout: BusinessPayout) => {
    const exists = payouts.find(p => p.id === payout.id);
    if (exists) {
      onUpdatePayouts(payouts.map(p => p.id === payout.id ? payout : p));
    } else {
      onUpdatePayouts([...payouts, payout]);
    }
  };

  const executePass = useCallback(() => {
    if (!passConfirmTarget) return;
    const accTrades = trades.filter(t => t.accountId === passConfirmTarget.id);
    const currentPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);

    const archivedAccount: Account = {
      ...passConfirmTarget,
      isArchived: true,
      archivedAt: Date.now(),
      status: 'Inactive',
      accumulatedChallengePnL: currentPnL,
      result: 'Passed'
    };

    const newFundedAccount: Account = {
      ...passConfirmTarget,
      id: crypto.randomUUID(),
      phase: 'Funded',
      initialBalance: passConfirmTarget.initialBalance,
      challengeCost: 0,
      createdAt: Date.now(),
      status: 'Active',
      isArchived: false,
      accumulatedChallengePnL: 0,
      totalGrossWithdrawals: 0,
      totalWithdrawals: 0
    };

    const updated = accounts.map(a => a.id === passConfirmTarget.id ? archivedAccount : a);
    updated.push(newFundedAccount);

    const withUpdatedSlaves = updated.map(a =>
      a.parentAccountId === passConfirmTarget.id ? { ...a, parentAccountId: newFundedAccount.id } as Account : a
    );

    onUpdate(withUpdatedSlaves);
    setActiveAccountId(newFundedAccount.id);
    setPassConfirmTarget(null);
  }, [passConfirmTarget, accounts, trades, onUpdate, setActiveAccountId]);

  const executeFail = useCallback(() => {
    if (!failConfirmTarget) return;
    const updated = accounts.map(a =>
      a.id === failConfirmTarget.id ? {
        ...a,
        status: 'Inactive',
        isArchived: true,
        archivedAt: Date.now(),
        result: 'Failed'
      } as Account : a
    );
    onUpdate(updated);
    setFailConfirmTarget(null);
  }, [failConfirmTarget, accounts, onUpdate]);

  const toggleAccountStatus = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const updated = accounts.map(a =>
      a.id === id ? { ...a, status: a.status === 'Active' ? 'Inactive' : 'Active' } as Account : a
    );
    onUpdate(updated);
  };

  const startEditing = (e: React.MouseEvent, acc: Account) => {
    e.stopPropagation();
    setEditingAccount(acc);
    setEditFormData({ ...acc });
  };

  const saveEdit = () => {
    if (!editFormData.name || !editingAccount) return;
    const updated = accounts.map(a => a.id === editingAccount.id ? { ...a, ...editFormData } as Account : a);
    onUpdate(updated);
    setEditingAccount(null);
  };

  const executeDelete = () => {
    if (accountToDelete) {
      onDelete(accountToDelete.id);
      setAccountToDelete(null);
    }
  };

  const getAccountIcon = (type: string, status: string, phase?: string, size: number = 18, result?: 'Passed' | 'Failed') => {
    if (result === 'Passed') return <Trophy className="text-emerald-500" size={size} />;
    if (result === 'Failed') return <Skull className="text-rose-500" size={size} />;
    if (status === 'Inactive') return <Skull className="text-slate-600" size={size} />;
    if (phase === 'Challenge') return <Trophy className="text-amber-500" size={size} />;
    if (phase === 'Funded') return <Crown className="text-purple-500" size={size} />;
    return <Activity className="text-emerald-500" size={size} />;
  };

  const inputClass = `w-full px-4 py-2.5 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${theme !== 'light' ? 'bg-slate-900 border-white/10 text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'}`;

  const renderAccountCard = (acc: Account, isSlave = false) => {
    const accTrades = trades.filter(t => t.accountId === acc.id);
    const totalPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);
    const accPayouts = payouts.filter(p => p.accountId === acc.id && p.status === 'Received');
    const grossWithdrawals = accPayouts.reduce((sum, p) => sum + (p.grossAmount || p.amount), 0);
    const accumulatedChallengePnL = acc.accumulatedChallengePnL || 0;
    const isChallenge = (acc.phase || 'Challenge') === 'Challenge';
    const currentPlatformBalance = acc.initialBalance + totalPnL - accumulatedChallengePnL - grossWithdrawals;
    const performanceColor = totalPnL >= 0 ? 'emerald' : 'rose';

    const cardPadding = isSlave ? 'p-4' : 'p-6';
    const cardHeight = isSlave ? 'min-h-[240px]' : 'min-h-[320px]';

    return (
      <div
        key={acc.id}
        onClick={() => acc.status === 'Active' && setActiveAccountId(acc.id)}
        className={`group relative ${cardPadding} ${cardHeight} rounded-[24px] border transition-all duration-500 cursor-pointer overflow-hidden backdrop-blur-sm flex flex-col justify-between
          ${activeAccountId === acc.id
            ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_30px_rgba(59,130,246,0.15)] ring-1 ring-blue-500/20'
            : (theme !== 'light' ? 'bg-slate-900/40 border-white/5 hover:border-white/10 hover:bg-slate-900/60' : 'bg-white border-slate-200 hover:border-blue-300')} 
          ${acc.status === 'Inactive' ? 'opacity-60 grayscale-[0.8]' : ''}`}
      >
        <div className="relative z-20 flex-1 flex flex-col">
          <AccountSparkline trades={accTrades} initialBalance={acc.initialBalance} color={performanceColor} theme={theme} />

          <div className={`flex justify-between items-start ${isSlave ? 'mb-4' : 'mb-6'} gap-2`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`${isSlave ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} ${theme !== 'light' ? 'bg-white/5 shadow-inner' : 'bg-slate-100'} flex-shrink-0`}>
                {getAccountIcon(acc.type, acc.status, acc.phase, isSlave ? 14 : 18, acc.result)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className={`font-black uppercase tracking-tight truncate ${isSlave ? 'text-xs' : 'text-sm'} ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{acc.name}</h3>
                  {isSlave && <span className="px-1.5 py-0.5 rounded-md bg-blue-500/10 text-[8px] font-black text-blue-500 uppercase flex items-center gap-1 flex-shrink-0"><Link size={8} /> Copy</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap overflow-hidden text-[8px] font-black uppercase tracking-widest text-slate-500">
                  <span className={`${acc.phase === 'Funded' ? 'text-purple-500' : 'text-amber-500'}`}>{acc.phase || 'Challenge'}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-1 transition-opacity">
              {acc.status === 'Active' && !isChallenge && (
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPayoutTargetAccountId(acc.id); }}
                  className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-all"
                  title="Provést výplatu"
                >
                  <HandCoins size={isSlave ? 14 : 16} />
                </button>
              )}
              <button onClick={(e) => startEditing(e, acc)} className="p-2 text-slate-500 hover:text-blue-500 transition-all"><Settings2 size={isSlave ? 14 : 16} /></button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <span className="text-[8px] uppercase font-black text-slate-500 tracking-wider">Balance</span>
              <p className={`${isSlave ? 'text-xl' : 'text-2xl'} font-black font-mono tracking-tighter ${currentPlatformBalance >= acc.initialBalance ? 'text-emerald-500' : 'text-rose-500'}`}>
                ${currentPlatformBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="flex flex-col items-end space-y-1">
              <span className="text-[8px] uppercase font-black text-slate-500 tracking-wider">Net PnL</span>
              <span className={`${isSlave ? 'text-base' : 'text-lg'} font-black font-mono ${totalPnL - accumulatedChallengePnL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                {totalPnL - accumulatedChallengePnL >= 0 ? '+' : ''}${(totalPnL - accumulatedChallengePnL).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          <div className={`${isSlave ? 'mt-3 pt-3' : 'mt-4 pt-4'} border-t border-white/5`}>
            {isChallenge && acc.status === 'Active' ? (
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[8px] font-black uppercase text-blue-500">Cíl Profitu</span>
                    <span className="text-[8px] font-black text-slate-500">{(totalPnL / (acc.initialBalance * ((acc.profitTarget || 10) / 100)) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500" style={{ width: `${Math.min(Math.max((totalPnL / (acc.initialBalance * ((acc.profitTarget || 10) / 100)) * 100), 0), 100)}%` }} />
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPassConfirmTarget(acc); }} className="p-2 bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-white rounded-xl transition-all border border-emerald-500/20 transform active:scale-90" title="Pass"><Check size={14} /></button>
                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFailConfirmTarget(acc); }} className="p-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20 transform active:scale-90" title="Fail"><Skull size={14} /></button>
                </div>
              </div>
            ) : !isChallenge && acc.status === 'Active' ? (
              <div className="h-[28px]">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[8px] font-black uppercase text-emerald-500">Profit Split</span>
                  <span className="text-[8px] font-black text-slate-500">{acc.profitSplit || 90}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[8px] font-black uppercase text-slate-600">Výplata</span>
                  <span className="text-[8px] font-black text-emerald-500 uppercase">Aktivní</span>
                </div>
              </div>
            ) : <div className="h-[28px]" />}
          </div>
        </div>

        <div className={`flex justify-between items-center ${isSlave ? 'mt-2' : 'mt-5'} pt-3 border-t border-white/5 opacity-0 group-hover:opacity-100 transition-all duration-500 h-[24px]`}>
          <div className="flex gap-2">
            <button onClick={(e) => toggleAccountStatus(e, acc.id)} className={`text-[8px] font-black uppercase tracking-wider flex items-center gap-1 transition-all ${acc.status === 'Active' ? 'text-slate-500 hover:text-amber-500' : 'text-emerald-500 hover:text-emerald-400'}`}>
              {acc.status === 'Active' ? <><Archive size={10} /> Archivovat</> : <><Check size={10} /> Obnovit</>}
            </button>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setAccountToDelete(acc); }} className="text-[8px] font-black uppercase text-slate-600 hover:text-rose-500 transition-all flex items-center gap-1"><Trash2 size={10} /> Smazat</button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <section className={`px-6 py-4 rounded-[24px] border flex flex-col lg:flex-row justify-between items-center gap-6 ${theme !== 'light' ? 'bg-slate-950/40 border-white/5' : 'bg-white border-slate-200 shadow-sm'}`}>
        <div className="flex gap-8 items-center">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${theme !== 'light' ? 'bg-rose-500/10 text-rose-500' : 'bg-rose-50 text-rose-500'}`}><TrendingUp size={16} /></div>
            <div>
              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Náklady</p>
              <p className="text-sm font-black font-mono text-rose-500">-${portfolioStats.totalChallengeCosts.toLocaleString()}</p>
            </div>
          </div>
          <div className="w-px h-8 bg-white/5" />
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${theme !== 'light' ? 'bg-blue-500/10 text-blue-500' : 'bg-blue-50 text-blue-500'}`}><Activity size={16} /></div>
            <div>
              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Trade PnL</p>
              <p className={`text-sm font-black font-mono ${portfolioStats.totalTradesPnL >= 0 ? 'text-slate-200' : 'text-rose-500'}`}>{portfolioStats.totalTradesPnL >= 0 ? '+' : ''}${portfolioStats.totalTradesPnL.toLocaleString()}</p>
            </div>
          </div>
          <div className="w-px h-8 bg-white/5" />
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${theme !== 'light' ? 'bg-amber-500/10 text-amber-500' : 'bg-amber-50 text-amber-500'}`}><Trophy size={16} /></div>
            <div>
              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Pass Rate</p>
              <p className="text-sm font-black font-mono text-amber-500">{portfolioStats.passRate.toFixed(0)}%</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6 pl-6 lg:border-l border-white/5">
          <div className="text-right">
            <p className="text-[9px] font-black uppercase text-emerald-500 tracking-widest mb-0.5">Výplaty (Net)</p>
            <p className="text-sm font-black font-mono text-emerald-500">+${portfolioStats.totalNetPayouts.toLocaleString()}</p>
          </div>
          <div className={`px-5 py-2 rounded-xl border flex items-center gap-3 ${portfolioStats.netCashflow >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-rose-500/5 border-rose-500/20'}`}>
            <div>
              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Net Cashflow</p>
              <p className={`text-lg font-black font-mono ${portfolioStats.netCashflow >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>{portfolioStats.netCashflow >= 0 ? '+' : ''}${portfolioStats.netCashflow.toLocaleString()}</p>
            </div>
          </div>
        </div>
      </section>

      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button onClick={() => setShowInactive(false)} className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!showInactive ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Aktivní ({portfolioStats.activeCount})</button>
          <button onClick={() => setShowInactive(true)} className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${showInactive ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Archiv ({portfolioStats.inactiveCount})</button>
        </div>
        {!isAdding && !showInactive && <button onClick={() => setIsAdding(true)} className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-600/20 active:scale-95 transition-all"><Plus size={16} /> Vložit Kapitál</button>}
      </div>

      {isAdding && (
        <div className={`p-8 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200 shadow-xl'}`}>
          <div className="flex items-center gap-3 mb-6"><div className="p-2 bg-blue-600/10 text-blue-500 rounded-xl"><Activity size={20} /></div><h3 className="text-lg font-black italic uppercase">Nový obchodní účet</h3></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Název účtu</label><input type="text" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} className={inputClass} placeholder="Např. MyFunded 100k" /></div>
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Fáze</label><select value={newAccount.phase} onChange={e => setNewAccount({ ...newAccount, phase: e.target.value as any })} className={inputClass}><option value="Challenge">Challenge</option><option value="Funded">Funded</option></select></div>
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Počáteční Balance ($)</label><input type="number" value={newAccount.initialBalance} onChange={e => setNewAccount({ ...newAccount, initialBalance: Number(e.target.value) })} className={inputClass} /></div>
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-rose-500 tracking-widest">Cena Pořízení ($)</label><input type="number" value={newAccount.challengeCost} onChange={e => setNewAccount({ ...newAccount, challengeCost: Number(e.target.value) })} className={`${inputClass} border-rose-500/20`} /></div>
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-emerald-500 tracking-widest">Profit Split (%)</label><input type="number" value={newAccount.profitSplit} onChange={e => setNewAccount({ ...newAccount, profitSplit: Number(e.target.value) })} className={inputClass} /></div>
          </div>
          <div className="flex justify-end gap-3"><button onClick={() => setIsAdding(false)} className="px-6 py-2.5 rounded-xl font-black uppercase text-[10px] text-slate-500 tracking-widest hover:text-slate-300">Zrušit</button><button onClick={handleAddAccount} className="px-8 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg active:scale-95 transition-all">Aktivovat</button></div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6 items-start">
        {groupedAccounts.map((group) => (
          <div key={group.master.id} className="flex flex-col gap-3">
            {renderAccountCard(group.master)}
            {group.slaves.map(slave => <div key={slave.id} className="pl-4 relative before:absolute before:left-0 before:top-[-12px] before:bottom-6 before:w-px before:bg-slate-700/30 before:border-l before:border-dashed before:border-slate-600/50 after:absolute after:left-0 after:top-6 after:w-4 after:h-px after:border-t after:border-dashed after:border-slate-600/50">{renderAccountCard(slave, true)}</div>)}
          </div>
        ))}
      </div>

      <PayoutModal isOpen={!!payoutTargetAccountId} onClose={() => setPayoutTargetAccountId(null)} onSave={handleSavePayout} accounts={accounts} initialAccountId={payoutTargetAccountId || undefined} theme={theme} user={user} />

      {editingAccount && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md" onClick={() => setEditingAccount(null)}>
          <div className={`max-w-xl w-full p-8 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200 shadow-2xl'}`} onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-8"><div className="flex items-center gap-3"><div className="p-3 bg-blue-500/10 text-blue-500 rounded-2xl"><Settings2 size={24} /></div><h3 className="text-xl font-black italic uppercase">Nastavení Účtu</h3></div><button onClick={() => setEditingAccount(null)} className="text-slate-500 hover:text-white"><X size={24} /></button></div>
            <div className="grid grid-cols-2 gap-6 mb-8">
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Název účtu</label><input type="text" value={editFormData.name || ''} onChange={e => setEditFormData({ ...editFormData, name: e.target.value })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Počáteční Balance</label><input type="number" value={editFormData.initialBalance || ''} onChange={e => setEditFormData({ ...editFormData, initialBalance: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Cena Pořízení</label><input type="number" value={editFormData.challengeCost || 0} onChange={e => setEditFormData({ ...editFormData, challengeCost: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Profit Split (%)</label><input type="number" value={editFormData.profitSplit || 90} onChange={e => setEditFormData({ ...editFormData, profitSplit: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Fáze Účtu</label>
                <select value={editFormData.phase || 'Challenge'} onChange={e => setEditFormData({ ...editFormData, phase: e.target.value as any })} className={inputClass}><option value="Challenge">Challenge</option><option value="Funded">Funded</option></select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Master Účet (Link)</label>
                <select value={editFormData.parentAccountId || ''} onChange={e => setEditFormData({ ...editFormData, parentAccountId: e.target.value || undefined })} className={inputClass}><option value="">-- Žádný --</option>{accounts.filter(a => a.id !== editingAccount.id && !a.parentAccountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </div>
            </div>
            <div className="flex gap-4"><button onClick={() => setEditingAccount(null)} className="flex-1 py-4 font-black uppercase text-[10px] text-slate-500 bg-white/5 rounded-2xl">Zrušit</button><button onClick={saveEdit} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase text-[10px] shadow-lg shadow-blue-600/20 active:scale-95 transition-all">Uložit Změny</button></div>
          </div>
        </div>
      )}

      {passConfirmTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md" onClick={() => setPassConfirmTarget(null)}>
          <div className="max-w-md w-full p-8 rounded-[32px] bg-slate-900 border border-white/10 text-center space-y-6" onClick={e => e.stopPropagation()}>
            <div className="p-4 bg-blue-500/10 text-blue-500 rounded-full inline-block"><PartyPopper size={32} /></div>
            <h3 className="text-xl font-black italic uppercase">Challenge Splněna!</h3>
            <p className="text-slate-500 text-sm">Povýšit účet <span className="text-blue-500 font-bold">{passConfirmTarget.name}</span> na Funded?</p>
            <div className="flex gap-4"><button onClick={() => setPassConfirmTarget(null)} className="flex-1 py-3 text-[10px] font-black uppercase text-slate-500 bg-white/5 rounded-xl">Zrušit</button><button onClick={executePass} className="flex-1 py-3 text-[10px] font-black uppercase bg-blue-600 text-white rounded-xl">Potvrdit</button></div>
          </div>
        </div>
      )}

      {failConfirmTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md" onClick={() => setFailConfirmTarget(null)}>
          <div className="max-w-md w-full p-8 rounded-[32px] bg-slate-900 border border-white/10 text-center space-y-6" onClick={e => e.stopPropagation()}>
            <div className="p-4 bg-rose-500/10 text-rose-500 rounded-full inline-block"><Skull size={32} /></div>
            <h3 className="text-xl font-black italic uppercase text-rose-500">Účet Spálen</h3>
            <p className="text-slate-500 text-sm">Opravdu chcete archivovat účet <span className="text-rose-500 font-bold">{failConfirmTarget.name}</span> jako neúspěšný?</p>
            <div className="flex gap-4"><button onClick={() => setFailConfirmTarget(null)} className="flex-1 py-3 text-[10px] font-black uppercase text-slate-500 bg-white/5 rounded-xl">Zrušit</button><button onClick={executeFail} className="flex-1 py-3 text-[10px] font-black uppercase bg-rose-600 text-white rounded-xl">Potvrdit</button></div>
          </div>
        </div>
      )}

      <ConfirmationModal isOpen={!!accountToDelete} onClose={() => setAccountToDelete(null)} onConfirm={executeDelete} title="Smazat Účet" message={`Opravdu chcete smazat účet "${accountToDelete?.name}"?`} theme={theme} />
    </div>
  );
};

export default AccountsManager;
