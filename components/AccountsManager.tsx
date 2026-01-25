import React, { useState, useMemo, useCallback } from 'react';
import { Account, Trade } from '../types';
import {
  Plus,
  Trash2,
  Edit3,
  Check,
  X,
  Shield,
  Zap,
  Save,
  AlertCircle,
  Archive,
  Activity,
  DollarSign,
  HandCoins,
  Trophy,
  Crown,
  RotateCcw,
  CheckCircle2,
  PartyPopper,
  Rocket,
  Skull,
  Target,
  Signal,
  Link,
  ChevronRight,
  TrendingUp,
  Settings2,
  ChevronDown
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';

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
  onAddPayout?: (payout: any) => void;
}

// Sparkline Helper Component
const AccountSparkline = ({ trades, initialBalance, theme, color }: { trades: Trade[], initialBalance: number, theme: string, color: string }) => {
  const points = useMemo(() => {
    let balance = initialBalance;
    const data = [{ x: 0, y: balance }];

    // Sort trades by timestamp to build proper equity curve
    const sortedTrades = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Limit to last 20 trades for cleaner sparkline
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

  // Normalize points
  const svgPath = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const normalizedY = ((p.y - min) / range);
    const y = height - (normalizedY * height); // Invert Y
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
  onUpdateTrades,
  onAddExpense,
  onAddPayout
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [payoutTarget, setPayoutTarget] = useState<Account | null>(null);
  const [passConfirmTarget, setPassConfirmTarget] = useState<Account | null>(null);
  const [failConfirmTarget, setFailConfirmTarget] = useState<Account | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [payoutGross, setPayoutGross] = useState<string>('');

  const [newAccount, setNewAccount] = useState<Partial<Account>>({
    name: '',
    initialBalance: 10000,
    challengeCost: 0,
    totalWithdrawals: 0,
    totalGrossWithdrawals: 0,
    profitSplit: 90,
    type: 'Funded',
    phase: 'Challenge',
    status: 'Active',
    currency: 'USD',
    propThreshold: 150,
    instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
  });

  const [editFormData, setEditFormData] = useState<Partial<Account>>({});

  const portfolioStats = useMemo(() => {
    const totalChallengeCosts = accounts.reduce((sum, acc) => sum + (acc.challengeCost || 0), 0);
    const totalNetPayouts = accounts.reduce((sum, acc) => sum + (acc.totalWithdrawals || 0), 0);
    const totalTradesPnL = trades.reduce((sum, t) => sum + t.pnl, 0);

    const netCashflow = totalNetPayouts - totalChallengeCosts;

    // Challenge metrics
    const challenges = accounts.filter(a => a.type === 'Funded');
    const challengeCount = challenges.length;
    const passedChallenges = accounts.filter(a => a.type === 'Funded' && a.phase === 'Funded').length;
    const burntChallenges = accounts.filter(a => a.status === 'Inactive' && a.phase === 'Challenge').length;
    const passRate = challengeCount > 0 ? (passedChallenges / challengeCount) * 100 : 0;

    return {
      totalChallengeCosts,
      totalNetPayouts,
      totalTradesPnL,
      netCashflow,
      challengeCount,
      passRate,
      burntChallenges,
      activeCount: accounts.filter(a => a.status === 'Active').length,
      inactiveCount: accounts.filter(a => a.status === 'Inactive').length
    };
  }, [accounts, trades]);

  // Grouping Logic
  const groupedAccounts = useMemo(() => {
    const list = showInactive ? accounts.filter(a => a.status === 'Inactive') : accounts.filter(a => a.status === 'Active');
    const masters = list.filter(a => !a.parentAccountId);

    // Sort masters by created date desc
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
      totalWithdrawals: Number(newAccount.totalWithdrawals) || 0,
      totalGrossWithdrawals: Number(newAccount.totalGrossWithdrawals) || 0,
      profitSplit: Number(newAccount.profitSplit) || 90,
      phase: newAccount.phase as any || 'Challenge',
      accumulatedChallengePnL: 0,
      type: newAccount.type as any,
      status: 'Active',
      currency: 'USD',
      propThreshold: Number(newAccount.propThreshold) || 150,
      instrumentFees: newAccount.instrumentFees || { 'NQ': 2.8, 'MNQ': 0.74 },
      createdAt: Date.now()
    };
    onUpdate([...accounts, account]);

    // Sync to Business Hub as expense if cost > 0
    if (account.challengeCost && account.challengeCost > 0 && onAddExpense) {
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
      totalWithdrawals: 0,
      totalGrossWithdrawals: 0,
      profitSplit: 90,
      type: 'Funded',
      phase: 'Challenge',
      status: 'Active',
      instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
    });
  };

  const handleRecordPayout = () => {
    if (!payoutTarget || !payoutGross) return;
    const grossAmount = Number(payoutGross);
    const split = payoutTarget.profitSplit || 90;
    const netAmount = grossAmount * (split / 100);

    const updated = accounts.map(a =>
      a.id === payoutTarget.id ? {
        ...a,
        totalGrossWithdrawals: (a.totalGrossWithdrawals || 0) + grossAmount,
        totalWithdrawals: (a.totalWithdrawals || 0) + netAmount
      } as Account : a
    );

    onUpdate(updated);

    // Sync to Business Hub as received payout
    if (onAddPayout) {
      onAddPayout({
        id: `payout_${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        amount: netAmount,
        accountId: payoutTarget.id,
        status: 'Received',
        notes: `Automatická výplata z účtu: ${payoutTarget.name}`
      });
    }

    setPayoutTarget(null);
    setPayoutGross('');
  };

  const executePass = useCallback(() => {
    if (!passConfirmTarget) return;
    const accTrades = trades.filter(t => t.accountId === passConfirmTarget.id);
    const currentPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);

    // 1. Archive the current Challenge account
    const archivedAccount: Account = {
      ...passConfirmTarget,
      isArchived: true,
      archivedAt: Date.now(),
      status: 'Inactive', // Hide from active list
      accumulatedChallengePnL: currentPnL,
      result: 'Passed'
    };

    // 2. Create the new Funded account
    const newFundedAccount: Account = {
      ...passConfirmTarget,
      id: crypto.randomUUID(),
      phase: 'Funded',
      initialBalance: passConfirmTarget.initialBalance,
      challengeCost: 0, // Reset cost for funded phase if preferred, or keep it
      createdAt: Date.now(),
      status: 'Active',
      isArchived: false,
      accumulatedChallengePnL: 0, // Reset for new phase
      totalGrossWithdrawals: 0,
      totalWithdrawals: 0
    };

    const updated = accounts.map(a => a.id === passConfirmTarget.id ? archivedAccount : a);
    updated.push(newFundedAccount);

    // Also update any slave accounts that were following the old ID
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
    return <Zap className="text-emerald-500" size={size} />;
  };

  const inputClass = `w-full px-4 py-2.5 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${theme !== 'light' ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
    }`;

  // Helper to render a single account card
  const renderAccountCard = (acc: Account, isSlave = false) => {
    const accTrades = trades.filter(t => t.accountId === acc.id);
    const totalPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossWithdrawals = acc.totalGrossWithdrawals || 0;
    const accumulatedChallengePnL = acc.accumulatedChallengePnL || 0;
    const isChallenge = (acc.phase || 'Challenge') === 'Challenge';
    const currentPlatformBalance = acc.initialBalance + totalPnL - accumulatedChallengePnL - grossWithdrawals;

    // Sparkline Color Logic
    const performanceColor = totalPnL >= 0 ? 'emerald' : 'rose';

    const cardHeight = isSlave ? 'min-h-[240px]' : 'min-h-[320px]';
    const cardPadding = isSlave ? 'p-4' : 'p-6';

    return (
      <div
        key={acc.id}
        onClick={() => acc.status === 'Active' && setActiveAccountId(acc.id)}
        className={`group relative ${cardPadding} ${cardHeight} rounded-[24px] border transition-all duration-500 cursor-pointer overflow-hidden backdrop-blur-sm flex flex-col justify-between
          ${activeAccountId === acc.id
            ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_30px_rgba(59,130,246,0.15)] ring-1 ring-blue-500/20'
            : (theme !== 'light' ? 'bg-slate-900/40 border-white/5 hover:border-white/10 hover:bg-slate-900/60' : 'bg-white/80 border-slate-200 hover:border-blue-300')} 
          ${acc.status === 'Inactive' ? 'opacity-60 grayscale-[0.8]' : ''}`}
      >
        <div className="relative z-20 flex-1 flex flex-col">
          {/* Background Sparkline */}
          <AccountSparkline trades={accTrades} initialBalance={acc.initialBalance} theme={theme} color={performanceColor} />

          {/* Header Actions */}
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
                <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap overflow-hidden text-[8px] font-black uppercase tracking-widest">
                  <span className={`${acc.phase === 'Funded' ? 'text-purple-500' : 'text-amber-500'}`}>
                    {acc.phase || 'Challenge'}
                  </span>
                  {acc.isArchived && acc.result && (
                    <>
                      <span className="text-slate-700 text-[8px]">•</span>
                      <span className={`text-[8px] uppercase font-black tracking-widest ${acc.result === 'Passed' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {acc.result === 'Passed' ? 'PASSED' : 'FAILED'}
                      </span>
                    </>
                  )}
                  {!isSlave && <><span className="text-slate-700 text-[8px]">•</span>
                    <span className="text-[9px] uppercase font-black text-slate-500 tracking-tighter">{acc.type}</span></>}
                </div>
              </div>
            </div>

            <div className="flex gap-1 transition-opacity flex-shrink-0">
              {acc.status === 'Active' && !isChallenge && (
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPayoutTarget(acc); }}
                  className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-all"
                  title="Provést výplatu"
                >
                  <HandCoins size={isSlave ? 14 : 16} />
                </button>
              )}
              <button onClick={(e) => startEditing(e, acc)} className="p-2 text-slate-500 hover:text-blue-500 transition-all"><Settings2 size={isSlave ? 14 : 16} /></button>
            </div>
          </div>

          {/* Metrics Grid */}
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

          {/* Progress / Status Bottom Section (Always rendered to lock height) */}
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
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPassConfirmTarget(acc); }}
                    className="p-2 bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-white rounded-xl transition-all border border-emerald-500/20 transform active:scale-90"
                    title="Pass"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFailConfirmTarget(acc); }}
                    className="p-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20 transform active:scale-90"
                    title="Fail"
                  >
                    <Skull size={14} />
                  </button>
                </div>
              </div>
            ) : !isChallenge && acc.status === 'Active' ? (
              <div className="h-[28px]"> {/* Fixed height matching progress area */}
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[8px] font-black uppercase text-emerald-500">Profit Split</span>
                  <span className="text-[8px] font-black text-slate-500">{acc.profitSplit || 90}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[8px] font-black uppercase text-slate-600">Výplata</span>
                  <span className="text-[8px] font-black text-emerald-500 uppercase">Aktivní</span>
                </div>
              </div>
            ) : (
              <div className="h-[28px]" /> /* Spacer for invisible status */
            )}
          </div>
        </div>

        {/* Card Actions Footer - Absolute bottom, only visible on hover */}
        <div className={`flex justify-between items-center ${isSlave ? 'mt-2 pt-2' : 'mt-5 pt-3'} border-t border-white/5 opacity-0 group-hover:opacity-100 transition-all duration-500 h-[24px]`}>
          <div className="flex gap-2">
            <button
              onClick={(e) => toggleAccountStatus(e, acc.id)}
              className={`text-[8px] font-black uppercase tracking-wider flex items-center gap-1 transition-all ${acc.status === 'Active' ? 'text-slate-500 hover:text-amber-500' : 'text-emerald-500 hover:text-emerald-400'}`}
            >
              {acc.status === 'Active' ? <><Archive size={10} /> Archivovat</> : <><Zap size={10} /> Obnovit</>}
            </button>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); setAccountToDelete(acc); }}
            className="text-[8px] font-black uppercase text-slate-600 hover:text-rose-500 transition-all flex items-center gap-1"
          >
            <Trash2 size={10} /> Smazat
          </button>
        </div>
      </div>
    );
  };


  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">

      {/* 1. COMPACT HEADER - Consolidated Metrics */}
      <section className={`px-6 py-4 rounded-[24px] border flex flex-col lg:flex-row justify-between items-center gap-6 ${theme !== 'light' ? 'bg-slate-950/40 border-white/5' : 'bg-white border-slate-200'}`}>
        {/* Left Stats */}
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
              <p className={`text-sm font-black font-mono ${portfolioStats.totalTradesPnL >= 0 ? 'text-slate-200' : 'text-rose-500'}`}>
                {portfolioStats.totalTradesPnL >= 0 ? '+' : ''}${portfolioStats.totalTradesPnL.toLocaleString()}
              </p>
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

        {/* Right Stats - Cashflow */}
        <div className="flex items-center gap-6 pl-6 lg:border-l border-white/5">
          <div className="text-right">
            <p className="text-[9px] font-black uppercase text-emerald-500 tracking-widest mb-0.5">Výplaty (Net)</p>
            <p className="text-sm font-black font-mono text-emerald-500">+${portfolioStats.totalNetPayouts.toLocaleString()}</p>
          </div>

          <div className={`px-5 py-2 rounded-xl border flex items-center gap-3 ${portfolioStats.netCashflow >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-rose-500/5 border-rose-500/20'}`}>
            <div>
              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Net Cashflow</p>
              <p className={`text-lg font-black font-mono ${portfolioStats.netCashflow >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                {portfolioStats.netCashflow >= 0 ? '+' : ''}${portfolioStats.netCashflow.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 2. ACTIONS & FILTERS */}
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setShowInactive(false)}
            className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!showInactive ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Aktivní ({portfolioStats.activeCount})
          </button>
          <button
            onClick={() => setShowInactive(true)}
            className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${showInactive ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Archiv / Spálené ({portfolioStats.inactiveCount})
          </button>
        </div>
        {!isAdding && !showInactive && (
          <button onClick={() => setIsAdding(true)} className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-600/20 active:scale-95 transition-all">
            <Plus size={16} /> Vložit Kapitál
          </button>
        )}
      </div>

      {/* 3. NEW ACCOUNT FORM */}
      {isAdding && (
        <div className={`p-8 rounded-[32px] border animate-in slide-in-from-top-4 duration-500 ${theme !== 'light' ? 'bg-slate-900/60 border-white/10' : 'bg-white border-slate-200'}`}>
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-600/10 text-blue-500 rounded-xl"><Activity size={20} /></div>
            <h3 className="text-lg font-black italic">NOVÝ OBCHODNÍ ÚČET</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
            <div className="space-y-1.5">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Název účtu</label>
              <input type="text" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} className={inputClass} placeholder="Např. MyFunded 100k" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Fáze</label>
              <select value={newAccount.phase} onChange={e => setNewAccount({ ...newAccount, phase: e.target.value as any })} className={inputClass}>
                <option value="Challenge">Challenge (Fáze 1/2)</option>
                <option value="Funded">Funded (Live Výplaty)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Počáteční Balance ($)</label>
              <input type="number" value={newAccount.initialBalance} onChange={e => setNewAccount({ ...newAccount, initialBalance: Number(e.target.value) })} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[9px] uppercase font-black text-rose-500 tracking-widest">Cena Pořízení ($)</label>
              <input type="number" value={newAccount.challengeCost} onChange={e => setNewAccount({ ...newAccount, challengeCost: Number(e.target.value) })} className={`${inputClass} border-rose-500/20`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[9px] uppercase font-black text-blue-500 tracking-widest">Master Účet (Kopírování)</label>
              <select
                value={newAccount.parentAccountId || ''}
                onChange={e => setNewAccount({ ...newAccount, parentAccountId: e.target.value || undefined })}
                className={`${inputClass} border-blue-500/20`}
              >
                <option value="">-- Samostatný účet --</option>
                {accounts.filter(a => !a.parentAccountId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={`p-6 rounded-2xl border mb-8 ${theme !== 'light' ? 'bg-slate-950/40 border-emerald-500/10' : 'bg-emerald-50/30 border-emerald-200'}`}>
            <h4 className="text-[10px] uppercase font-black text-emerald-500 tracking-widest mb-4 flex items-center gap-2">
              <DollarSign size={14} /> Fee Engine (Poplatky za kontrakt RT)
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
              {['NQ', 'MNQ'].map(inst => (
                <div key={inst} className="space-y-1.5">
                  <label className="text-[8px] uppercase font-black text-slate-500 tracking-wider pl-1">{inst}</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 font-bold">$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={newAccount.instrumentFees?.[inst] ?? (inst === 'NQ' ? 2.8 : inst === 'MNQ' ? 0.74 : 0)}
                      onChange={e => setNewAccount({
                        ...newAccount,
                        instrumentFees: {
                          ...(newAccount.instrumentFees || { 'NQ': 2.8, 'MNQ': 0.74 }),
                          [inst]: Number(e.target.value)
                        }
                      })}
                      className={`w-full pl-6 pr-2 py-2 rounded-xl text-xs font-mono outline-none border transition-all
                        ${theme !== 'light' ? 'bg-slate-950 border-white/5 text-white focus:border-emerald-500/50' : 'bg-white border-slate-200'}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button onClick={() => setIsAdding(false)} className="px-6 py-2.5 rounded-xl font-black uppercase text-[10px] text-slate-500 tracking-widest hover:text-slate-300">Zrušit</button>
            <button onClick={handleAddAccount} className="px-8 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg active:scale-95 transition-all">Aktivovat</button>
          </div>
        </div>
      )}

      {/* 4. ACCOUNTS LIST (MASTER-SLAVE COLUMNS) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6 items-start">
        {groupedAccounts.map((group) => (
          <div key={group.master.id} className="flex flex-col gap-3">
            {/* Master Card */}
            {renderAccountCard(group.master)}

            {/* Slaves Stacked Below Master */}
            {group.slaves.length > 0 && (
              <div className="flex flex-col gap-3 pl-4 relative">
                {/* Vertical Connector Line */}
                <div className="absolute left-0 top-[-12px] bottom-6 w-px bg-slate-700/30 border-l border-dashed border-slate-600/50"></div>

                {group.slaves.map(slave => (
                  <div key={slave.id} className="relative">
                    {/* Horizontal Connector */}
                    <div className="absolute left-[-16px] top-6 w-4 h-px border-t border-dashed border-slate-600/50"></div>
                    {renderAccountCard(slave, true)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* MODALS - TRANSLATED */}

      {/* EDIT ACCOUNT MODAL */}
      {editingAccount && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-300" onClick={() => setEditingAccount(null)}>
          <div
            className={`max-w-2xl w-full p-8 rounded-[32px] border shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)] overflow-hidden relative backdrop-blur-2xl transition-all duration-300
              ${theme !== 'light'
                ? 'bg-gradient-to-br from-slate-900/80 to-slate-900/40 border-white/10 shadow-[inner_0_0_12px_rgba(255,255,255,0.05)]'
                : 'bg-white/80 border-white/40 shadow-xl'}`}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex justify-between items-center mb-8 relative z-10">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-blue-500/10 text-blue-500 rounded-2xl"><Settings2 size={24} /></div>
                <div>
                  <h3 className="text-xl font-black italic uppercase tracking-tight">Nastavení Účtu</h3>
                  <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">{editingAccount.name}</p>
                </div>
              </div>
              <button
                onClick={() => setEditingAccount(null)}
                className="p-2 hover:bg-white/5 rounded-xl text-slate-500 hover:text-white transition-all"
              >
                <X size={24} />
              </button>
            </div>

            {/* Form Content */}
            <div className="grid grid-cols-2 gap-6 relative z-10 transition-all duration-300">
              {/* Row 1: Name & Initial Balance */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest pl-1">Název účtu</label>
                <input
                  type="text"
                  value={editFormData.name || ''}
                  onChange={e => setEditFormData({ ...editFormData, name: e.target.value })}
                  className={`w-full px-4 py-3 rounded-2xl border outline-none font-medium transition-all
                    ${theme !== 'light'
                      ? 'bg-white/5 border-white/10 text-white focus:bg-white/10 focus:border-blue-500/50'
                      : 'bg-slate-50 border-slate-200 text-slate-900 focus:ring-2 focus:ring-blue-500/20'}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest pl-1">Počáteční Balance</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    value={editFormData.initialBalance || ''}
                    onChange={e => setEditFormData({ ...editFormData, initialBalance: Number(e.target.value) })}
                    className={`w-full pl-8 pr-4 py-3 rounded-2xl border outline-none font-mono font-bold transition-all
                      ${theme !== 'light'
                        ? 'bg-white/5 border-white/10 text-white focus:bg-white/10 focus:border-blue-500/50'
                        : 'bg-slate-50 border-slate-200 text-slate-900 focus:ring-2 focus:ring-blue-500/20'}`}
                  />
                </div>
              </div>

              {/* Row 2: Challenge Cost & Master Account */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest pl-1">Cena Pořízení</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    value={editFormData.challengeCost || 0}
                    onChange={e => setEditFormData({ ...editFormData, challengeCost: Number(e.target.value) })}
                    className={`w-full pl-8 pr-4 py-3 rounded-2xl border outline-none font-mono font-medium transition-all
                      ${theme !== 'light'
                        ? 'bg-rose-500/5 border-rose-500/20 text-rose-200 focus:bg-rose-500/10 focus:border-rose-500/50'
                        : 'bg-rose-50 border-rose-200 text-rose-700'}`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-blue-400 tracking-widest pl-1">Master Účet (Link)</label>
                <select
                  value={editFormData.parentAccountId || ''}
                  onChange={e => setEditFormData({ ...editFormData, parentAccountId: e.target.value || undefined })}
                  className={`w-full px-4 py-3 rounded-2xl border outline-none font-medium transition-all appearance-none cursor-pointer
                    ${theme !== 'light'
                      ? 'bg-blue-500/5 border-blue-500/20 text-blue-200 focus:bg-blue-500/10 focus:border-blue-500/50'
                      : 'bg-blue-50 border-blue-200 text-blue-700'}`}
                >
                  <option value="" className="bg-slate-900">-- Žádný (Samostatný) --</option>
                  {accounts.filter(a => a.id !== editingAccount.id && !a.parentAccountId).map(a => (
                    <option key={a.id} value={a.id} className="bg-slate-900">{a.name}</option>
                  ))}
                </select>
              </div>

              {/* Row 3: Phase & Profit Target/Split */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-slate-400 tracking-widest pl-1">Fáze Účtu</label>
                <select
                  value={editFormData.phase || 'Challenge'}
                  onChange={e => setEditFormData({ ...editFormData, phase: e.target.value as any })}
                  className={`w-full px-4 py-3 rounded-2xl border outline-none font-medium transition-all appearance-none cursor-pointer
                    ${theme !== 'light'
                      ? 'bg-white/5 border-white/10 text-white focus:bg-white/10 focus:border-blue-500/50'
                      : 'bg-slate-50 border-slate-200 text-slate-900 focus:ring-2 focus:ring-blue-500/20'}`}
                >
                  <option value="Challenge" className="bg-slate-900">Challenge</option>
                  <option value="Funded" className="bg-slate-900">Funded/Live</option>
                </select>
              </div>
              <div className="space-y-2">
                {editFormData.phase === 'Challenge' ? (
                  <>
                    <label className="text-[10px] uppercase font-black text-blue-400 tracking-widest pl-1">Cíl Profitu (%)</label>
                    <div className="relative">
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">%</span>
                      <input
                        type="number"
                        value={editFormData.profitTarget || 10}
                        onChange={e => setEditFormData({ ...editFormData, profitTarget: Number(e.target.value) })}
                        className={`w-full px-4 py-3 rounded-2xl border outline-none font-medium transition-all
                          ${theme !== 'light'
                            ? 'bg-blue-500/5 border-blue-500/10 text-blue-200 focus:bg-blue-500/10 focus:border-blue-500/50'
                            : 'bg-blue-50 border-blue-200 text-blue-700'}`}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <label className="text-[10px] uppercase font-black text-emerald-400 tracking-widest pl-1">Profit Split (%)</label>
                    <div className="relative">
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">%</span>
                      <input
                        type="number"
                        value={editFormData.profitSplit || 90}
                        onChange={e => setEditFormData({ ...editFormData, profitSplit: Number(e.target.value) })}
                        className={`w-full px-4 py-3 rounded-2xl border outline-none font-medium transition-all
                          ${theme !== 'light'
                            ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-200 focus:bg-emerald-500/10 focus:border-emerald-500/50'
                            : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Fee Engine Section */}
            <div className={`mt-6 p-5 rounded-2xl border mb-6 ${theme !== 'light' ? 'bg-slate-950/20 border-emerald-500/10' : 'bg-emerald-50/20 border-emerald-100'}`}>
              <h4 className="text-[10px] uppercase font-black text-emerald-500 tracking-widest mb-4 flex items-center gap-2">
                <DollarSign size={14} /> Fee Engine
              </h4>
              <div className="grid grid-cols-4 md:grid-cols-7 gap-3">
                {['NQ', 'MNQ'].map(inst => (
                  <div key={inst} className="space-y-1">
                    <label className="text-[8px] uppercase font-black text-slate-500 tracking-tighter pl-1">{inst}</label>
                    <div className="relative">
                      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-500">$</span>
                      <input
                        type="number"
                        step="0.01"
                        value={editFormData.instrumentFees?.[inst] ?? 0}
                        onChange={e => setEditFormData({
                          ...editFormData,
                          instrumentFees: {
                            ...(editFormData.instrumentFees || {}),
                            [inst]: Number(e.target.value)
                          }
                        })}
                        className={`w-full pl-4 pr-1 py-2 rounded-xl text-[10px] font-mono outline-none border transition-all
                          ${theme !== 'light' ? 'bg-slate-950 border-white/5 text-white focus:border-emerald-500/50' : 'bg-white border-slate-200'}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-4 pt-6 border-t border-white/5 relative z-10">
              <button
                onClick={() => setEditingAccount(null)}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest text-slate-500 hover:text-white transition-all bg-white/5 hover:bg-white/10 rounded-2xl"
              >
                Zrušit
              </button>
              <button
                onClick={saveEdit}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-blue-600 hover:bg-blue-500 text-white rounded-2xl shadow-lg shadow-blue-600/20 active:scale-95 transition-all"
              >
                Uložit Změny
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PASS CONFIRM */}
      {
        passConfirmTarget && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={(e) => { e.stopPropagation(); setPassConfirmTarget(null); }}>
            <div className={`max-w-md w-full p-8 rounded-[32px] border shadow-2xl ${theme !== 'light' ? 'bg-slate-900 border-white/10' : 'bg-white border-blue-200'}`} onClick={e => e.stopPropagation()}>
              <div className="text-center space-y-6">
                <div className="inline-block p-4 bg-blue-500/10 text-blue-500 rounded-full animate-bounce"><PartyPopper size={32} /></div>
                <div>
                  <h3 className="text-xl font-black italic mb-2">CHALLENGE SPLNĚNA!</h3>
                  <p className="text-slate-500 text-sm">Povýšit účet <span className="text-blue-500 font-bold">{passConfirmTarget.name}</span> na Funded? Profit bude zafixován.</p>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setPassConfirmTarget(null)} className="flex-1 py-3 text-xs font-black uppercase tracking-widest text-slate-500 bg-slate-800 rounded-xl">Zrušit</button>
                  <button onClick={executePass} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-blue-600 text-white rounded-xl shadow-lg shadow-blue-600/20">Potvrdit</button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {/* PAYOUT MODAL */}
      {
        payoutTarget && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={() => setPayoutTarget(null)}>
            <div className={`max-w-md w-full p-8 rounded-[32px] border shadow-2xl ${theme !== 'light' ? 'bg-slate-900 border-white/10' : 'bg-white border-emerald-200'}`} onClick={e => e.stopPropagation()}>
              <div className="text-center space-y-6">
                <div className="inline-block p-4 bg-emerald-500/10 text-emerald-500 rounded-full"><HandCoins size={32} /></div>
                <div>
                  <h3 className="text-xl font-black italic mb-2">VÝPLATA ZISKU</h3>
                  <p className="text-slate-500 text-sm">Účet: <span className="font-bold text-white">{payoutTarget.name}</span></p>
                </div>

                <div className="bg-slate-800/50 p-4 rounded-xl text-left space-y-2">
                  <label className="text-[9px] uppercase font-black text-slate-500">Částka k výběru (Gross $)</label>
                  <div className="relative">
                    <DollarSign size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="number" autoFocus value={payoutGross} onChange={e => setPayoutGross(e.target.value)} placeholder="0.00" className="w-full bg-slate-950 border border-white/10 rounded-lg py-3 pl-9 text-white font-mono font-bold outline-none focus:border-emerald-500" />
                  </div>
                </div>

                {payoutGross && (
                  <div className="flex justify-between items-end p-4 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                    <span className="text-[10px] font-black uppercase text-emerald-500">Tvůj Podíl (Net)</span>
                    <span className="text-xl font-black font-mono text-emerald-400">+${(Number(payoutGross) * ((payoutTarget.profitSplit || 90) / 100)).toLocaleString()}</span>
                  </div>
                )}

                <div className="flex gap-3">
                  <button onClick={() => { setPayoutTarget(null); setPayoutGross('') }} className="flex-1 py-3 text-xs font-black uppercase tracking-widest text-slate-500 bg-slate-800 rounded-xl">Zrušit</button>
                  <button onClick={handleRecordPayout} disabled={!payoutGross} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-emerald-600 text-white rounded-xl shadow-lg shadow-emerald-600/20 disabled:opacity-50">Uložit</button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      <ConfirmationModal
        isOpen={!!accountToDelete}
        onClose={() => setAccountToDelete(null)}
        onConfirm={executeDelete}
        title="Smazat účet"
        message={`Opravdu chcete trvale odstranit účet "${accountToDelete?.name}" z Alpha Matrixu? Tato akce je nevratná a odstraní všechna s ním spojená data.`}
        theme={theme}
      />

    </div >
  );
};

export default AccountsManager;
