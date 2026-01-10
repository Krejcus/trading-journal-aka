
import React, { useState, useMemo, useCallback } from 'react';
import { Account, Trade } from '../types';
import {
  Plus,
  Trash2,
  Edit3,
  Check,
  X,
  Shield,
  Globe,
  Briefcase,
  Zap,
  Save,
  AlertCircle,
  Archive,
  Activity,
  DollarSign,
  HandCoins,
  Scissors,
  Trophy,
  Crown,
  RotateCcw,
  CheckCircle2,
  PartyPopper,
  Rocket,
  Skull
} from 'lucide-react';

interface AccountsManagerProps {
  accounts: Account[];
  activeAccountId: string;
  setActiveAccountId: (id: string) => void;
  onUpdate: (accounts: Account[]) => void;
  onDelete: (id: string) => void;
  theme: 'dark' | 'light';
  trades: Trade[];
}

const AccountsManager: React.FC<AccountsManagerProps> = ({ accounts, activeAccountId, setActiveAccountId, onUpdate, onDelete, theme, trades }) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
    currency: 'USD'
  });

  const [editFormData, setEditFormData] = useState<Partial<Account>>({});

  const portfolioStats = useMemo(() => {
    const totalChallengeCosts = accounts.reduce((sum, acc) => sum + (acc.challengeCost || 0), 0);
    const totalNetPayouts = accounts.reduce((sum, acc) => sum + (acc.totalWithdrawals || 0), 0);
    const totalTradesPnL = trades.reduce((sum, t) => sum + t.pnl, 0);

    const netCashflow = totalNetPayouts - totalChallengeCosts;

    // Challenge metrics
    const challenges = accounts.filter(a => a.phase === 'Challenge' || a.type === 'Funded');
    const challengeCount = challenges.length;
    const passedChallenges = accounts.filter(a => a.phase === 'Funded' || a.type === 'Funded').length;
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

  const activeAccounts = accounts.filter(a => a.status === 'Active');
  const inactiveAccounts = accounts.filter(a => a.status === 'Inactive');

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
      createdAt: Date.now()
    };
    onUpdate([...accounts, account]);
    setIsAdding(false);
    setNewAccount({ name: '', initialBalance: 10000, challengeCost: 0, totalWithdrawals: 0, totalGrossWithdrawals: 0, profitSplit: 90, type: 'Funded', phase: 'Challenge', status: 'Active' });
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
    setPayoutTarget(null);
    setPayoutGross('');
  };

  const executePass = useCallback(() => {
    if (!passConfirmTarget) return;

    const accTrades = trades.filter(t => t.accountId === passConfirmTarget.id);
    const currentPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);

    const updated = accounts.map(a =>
      a.id === passConfirmTarget.id ? {
        ...a,
        phase: 'Funded',
        accumulatedChallengePnL: currentPnL
      } as Account : a
    );
    onUpdate(updated);
    setPassConfirmTarget(null);
  }, [passConfirmTarget, accounts, trades, onUpdate]);

  const executeFail = useCallback(() => {
    if (!failConfirmTarget) return;

    const updated = accounts.map(a =>
      a.id === failConfirmTarget.id ? {
        ...a,
        status: 'Inactive'
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
    setEditingId(acc.id);
    setEditFormData({ ...acc });
  };

  const saveEdit = () => {
    if (!editFormData.name) return;
    const updated = accounts.map(a => a.id === editingId ? { ...a, ...editFormData } as Account : a);
    onUpdate(updated);
    setEditingId(null);
  };

  const executeDelete = () => {
    if (accountToDelete) {
      onDelete(accountToDelete.id);
      setAccountToDelete(null);
    }
  };

  const getAccountIcon = (type: string, status: string, phase?: string) => {
    if (status === 'Inactive') return <Skull className="text-slate-600" size={20} />;
    if (phase === 'Challenge') return <Trophy className="text-amber-500" size={20} />;
    if (phase === 'Funded') return <Crown className="text-purple-500" size={20} />;

    switch (type) {
      case 'Live': return <Zap className="text-emerald-500" size={20} />;
      case 'Funded': return <Shield className="text-purple-500" size={20} />;
      case 'Backtest': return <Globe className="text-blue-500" size={20} />;
      default: return <Briefcase className="text-slate-500" size={20} />;
    }
  };

  const inputClass = `w-full px-4 py-2.5 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${theme === 'dark' ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
    }`;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Portfolio Command Bar */}
      <section className={`p-8 rounded-[40px] border bg-gradient-to-br from-blue-600/5 to-indigo-600/5 ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200 shadow-xl'}`}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
          <div className="space-y-1">
            <h2 className="text-4xl font-black tracking-tighter italic">CASHFLOW COMMAND</h2>
            <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.3em]">Realized Payouts vs. Deployment Costs</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8">
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Challenge Costs</p>
              <p className="text-xl font-black font-mono text-rose-500">-${portfolioStats.totalChallengeCosts.toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Total Trading PnL</p>
              <p className={`text-xl font-black font-mono text-slate-400`}>
                ${portfolioStats.totalTradesPnL.toLocaleString()}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Bought Challenges</p>
              <p className="text-xl font-black font-mono text-white">
                {portfolioStats.challengeCount}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-amber-500 mb-1">Pass Rate</p>
              <p className="text-xl font-black font-mono text-amber-500">
                {portfolioStats.passRate.toFixed(1)}%
              </p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-rose-500 mb-1">Burnt Challenges</p>
              <p className="text-xl font-black font-mono text-rose-500">
                {portfolioStats.burntChallenges}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase text-emerald-500 mb-1">Total Payouts (Net) 💰</p>
              <p className="text-xl font-black font-mono text-emerald-500">
                +${portfolioStats.totalNetPayouts.toLocaleString()}
              </p>
            </div>
            <div className="text-right border-t lg:border-t-0 lg:border-l border-slate-800 pt-4 lg:pt-0 lg:pl-8">
              <p className="text-[9px] font-black uppercase text-blue-500 mb-1">Net Cashflow (Wallet)</p>
              <p className={`text-3xl font-black font-mono tracking-tighter ${portfolioStats.netCashflow >= 0 ? 'text-blue-500' : 'text-rose-600'}`}>
                {portfolioStats.netCashflow >= 0 ? '+' : ''}${portfolioStats.netCashflow.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="flex justify-between items-center">
        <div className="flex gap-4">
          <button
            onClick={() => setShowInactive(false)}
            className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${!showInactive ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Active Terminal ({portfolioStats.activeCount})
          </button>
          <button
            onClick={() => setShowInactive(true)}
            className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${showInactive ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Archive / Burnt ({portfolioStats.inactiveCount})
          </button>
        </div>
        {!isAdding && !showInactive && (
          <button onClick={() => setIsAdding(true)} className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl active:scale-95 transition-all">
            <Plus size={18} /> Deploy Capital
          </button>
        )}
      </div>

      {isAdding && (
        <div className={`p-10 rounded-[40px] border-2 border-dashed animate-in slide-in-from-top-4 duration-500 ${theme === 'dark' ? 'bg-slate-900/50 border-slate-700' : 'bg-white border-slate-200 shadow-2xl'}`}>
          <div className="flex items-center gap-4 mb-8">
            <div className="p-3 bg-blue-600/10 text-blue-500 rounded-2xl"><Activity size={24} /></div>
            <h3 className="text-xl font-black italic">ESTABLISH NEW ACCOUNT</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
            <div className="space-y-2">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Název účtu</label>
              <input type="text" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} className={inputClass} placeholder="Např. MyFunded 100k" />
            </div>
            <div className="space-y-2">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Počáteční Fáze</label>
              <select value={newAccount.phase} onChange={e => setNewAccount({ ...newAccount, phase: e.target.value as any })} className={inputClass}>
                <option value="Challenge">Challenge (Phase 1/2)</option>
                <option value="Funded">Funded (Live Payouts)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Start Balance ($)</label>
              <input type="number" value={newAccount.initialBalance} onChange={e => setNewAccount({ ...newAccount, initialBalance: Number(e.target.value) })} className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest text-rose-500">Cena Pořízení ($)</label>
              <input type="number" value={newAccount.challengeCost} onChange={e => setNewAccount({ ...newAccount, challengeCost: Number(e.target.value) })} className={`${inputClass} border-rose-500/20`} />
            </div>
            <div className="space-y-2">
              <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest text-blue-500">Profit Split (%)</label>
              <input type="number" value={newAccount.profitSplit} onChange={e => setNewAccount({ ...newAccount, profitSplit: Number(e.target.value) })} className={`${inputClass} border-blue-500/20`} placeholder="90" />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setIsAdding(false)} className="px-6 py-2.5 rounded-xl font-black uppercase text-[10px] text-slate-500 tracking-widest">Zrušit</button>
            <button onClick={handleAddAccount} className="px-10 py-3 bg-emerald-600 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-lg shadow-emerald-500/20 active:scale-95 transition-all">Aktivovat účet</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {(showInactive ? inactiveAccounts : activeAccounts).map(acc => {
          const accTrades = trades.filter(t => t.accountId === acc.id);
          const totalPnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);
          const challengeCost = acc.challengeCost || 0;
          const grossWithdrawals = acc.totalGrossWithdrawals || 0;
          const netWithdrawals = acc.totalWithdrawals || 0;
          const accumulatedChallengePnL = acc.accumulatedChallengePnL || 0;

          const netAccResult = netWithdrawals - challengeCost;
          const isEditing = editingId === acc.id;
          const isChallenge = (acc.phase || 'Challenge') === 'Challenge';

          const currentPlatformBalance = (isEditing ? (editFormData.initialBalance || 0) : acc.initialBalance) + totalPnL - accumulatedChallengePnL - (isEditing ? (editFormData.totalGrossWithdrawals || 0) : grossWithdrawals);

          return (
            <div key={acc.id} onClick={() => !isEditing && acc.status === 'Active' && setActiveAccountId(acc.id)} className={`group relative p-8 rounded-[40px] border-2 transition-all duration-500 cursor-pointer overflow-hidden ${activeAccountId === acc.id && !isEditing ? 'border-blue-600 bg-blue-600/5 shadow-2xl' : (theme === 'dark' ? 'bg-[#1E293B] border-slate-800' : 'bg-white border-slate-100')} ${acc.status === 'Inactive' ? 'opacity-70 grayscale-[0.5]' : ''}`}>

              {/* Header Actions */}
              <div className="flex justify-between items-start mb-8 relative z-20">
                <div className="flex items-center gap-4">
                  <div className={`p-4 rounded-[24px] ${theme === 'dark' ? 'bg-slate-950 shadow-inner' : 'bg-slate-50'}`}>{getAccountIcon(acc.type, acc.status, acc.phase)}</div>
                  {isEditing ? (
                    <input value={editFormData.name} onClick={e => e.stopPropagation()} onChange={e => setEditFormData({ ...editFormData, name: e.target.value })} className="px-3 py-1.5 text-xs font-black uppercase tracking-widest rounded-lg bg-slate-800 text-white border border-slate-700 focus:border-blue-500 outline-none" />
                  ) : (
                    <div>
                      <h3 className={`font-black uppercase tracking-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{acc.name}</h3>
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] uppercase font-black tracking-widest ${acc.phase === 'Funded' ? 'text-purple-500' : 'text-amber-500'}`}>
                          {acc.phase || 'Challenge'}
                        </span>
                        <span className="text-slate-700 text-[8px]">•</span>
                        <span className="text-[9px] uppercase font-black text-slate-500 tracking-tighter">{acc.type}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-1.5 relative z-30">
                  {isEditing ? (
                    <>
                      <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); saveEdit(); }} className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-all"><Save size={18} /></button>
                      <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingId(null); }} className="p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all"><X size={18} /></button>
                    </>
                  ) : (
                    <>
                      {acc.status === 'Active' && isChallenge && (
                        <div className="flex gap-1">
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPassConfirmTarget(acc);
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg shadow-blue-500/20 transition-all active:scale-95 border-none cursor-pointer"
                          >
                            <CheckCircle2 size={14} />
                            <span className="text-[9px] font-black uppercase tracking-widest">Pass</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setFailConfirmTarget(acc);
                            }}
                            className="flex items-center justify-center p-1.5 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white rounded-xl transition-all active:scale-95 border border-rose-600/20 cursor-pointer"
                            title="Mark as Failed"
                          >
                            <Skull size={14} />
                          </button>
                        </div>
                      )}
                      {acc.status === 'Active' && !isChallenge && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPayoutTarget(acc); }}
                          className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-all"
                          title="Provést výplatu"
                        >
                          <HandCoins size={18} />
                        </button>
                      )}
                      <button onClick={(e) => startEditing(e, acc)} className="p-2 text-slate-600 hover:text-blue-500 transition-all"><Edit3 size={18} /></button>
                      {activeAccountId === acc.id && acc.status === 'Active' && <div className="bg-blue-600 text-white p-2 rounded-xl shadow-lg shadow-blue-500/20"><Check size={14} /></div>}
                    </>
                  )}
                </div>
              </div>

              {/* Balances & Metrics */}
              <div className="space-y-6 relative z-20">
                <div className="flex justify-between items-end">
                  <div className="space-y-1">
                    <span className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em]">Platform Balance</span>
                    <p className={`text-3xl font-black font-mono tracking-tighter ${currentPlatformBalance >= (isEditing ? (editFormData.initialBalance || 0) : acc.initialBalance) ? 'text-emerald-500' : 'text-rose-500'}`}>
                      ${currentPlatformBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </p>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[8px] font-black uppercase text-slate-600">Phase Result</span>
                    <span className={`text-xs font-black font-mono ${totalPnL - accumulatedChallengePnL >= 0 ? 'text-emerald-500/60' : 'text-rose-500/60'}`}>
                      {totalPnL - accumulatedChallengePnL >= 0 ? '+' : ''}${(totalPnL - accumulatedChallengePnL).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className={`p-5 rounded-3xl space-y-4 ${theme === 'dark' ? 'bg-slate-950/40 border border-white/5' : 'bg-slate-50 border border-slate-100'}`}>
                  {accumulatedChallengePnL !== 0 && (
                    <div className="flex justify-between items-center opacity-60">
                      <span className="text-[10px] font-black uppercase text-slate-500 flex items-center gap-1">Archived Challenge PnL <RotateCcw size={10} /></span>
                      <span className="text-xs font-black text-blue-400">+${accumulatedChallengePnL.toLocaleString()}</span>
                    </div>
                  )}

                  <div className="flex justify-between items-center border-t border-white/5 pt-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black uppercase text-emerald-500">Net Wallet Payouts</span>
                      <span className="text-[8px] text-slate-500 uppercase font-black">Profit reálně v kapse</span>
                    </div>
                    <span className="text-base font-black text-emerald-500">+${netWithdrawals.toLocaleString()}</span>
                  </div>

                  <div className="flex justify-between items-center border-t border-white/10 pt-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-black uppercase text-blue-400">Profit Split</span>
                      <Scissors size={10} className="text-blue-500/50" />
                    </div>
                    {isEditing ? (
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <input type="number" value={editFormData.profitSplit} onChange={e => setEditFormData({ ...editFormData, profitSplit: Number(e.target.value) })} className="w-16 text-right px-2 py-1 text-xs font-black rounded bg-slate-800 text-blue-400 border border-slate-700 outline-none focus:border-blue-500" />
                        <span className="text-xs font-black text-slate-500">%</span>
                      </div>
                    ) : (
                      <span className="text-sm font-black text-blue-500">{acc.profitSplit || 90}%</span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800/50">
                  <div><p className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1">Trades</p><p className="font-black text-sm">{accTrades.length}</p></div>
                  <div className="text-right">
                    <p className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1">Total Net ROI</p>
                    <p className={`font-black text-sm ${netAccResult >= 0 ? 'text-blue-500' : 'text-rose-600'}`}>
                      {netAccResult >= 0 ? '+' : ''}${netAccResult.toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Card Actions: Archive & Delete */}
                <div className="flex justify-between items-center pt-2">
                  <div className="flex gap-2">
                    {!isEditing && (
                      <>
                        <button
                          onClick={(e) => toggleAccountStatus(e, acc.id)}
                          className={`p-2 rounded-lg transition-all ${acc.status === 'Active' ? 'text-slate-600 hover:text-amber-500' : 'text-emerald-500 hover:text-emerald-400'}`}
                          title={acc.status === 'Active' ? "Archivovat účet" : "Obnovit účet"}
                        >
                          {acc.status === 'Active' ? <Archive size={16} /> : <Zap size={16} />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setAccountToDelete(acc); }}
                          className="p-2 text-slate-700 hover:text-rose-500 transition-all"
                          title="Trvale smazat"
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-40">
                    <Shield size={12} />
                    <span className="text-[8px] font-black uppercase tracking-widest">AlphaTrade Prop-Sync v1.5</span>
                  </div>
                </div>
              </div>

              {/* Background Art */}
              <div className="absolute -bottom-6 -right-6 text-slate-800/10 rotate-12 group-hover:scale-110 pointer-events-none transition-all duration-700">
                {acc.phase === 'Funded' ? <Crown size={160} /> : <Trophy size={160} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* PASS Confirmation Modal */}
      {passConfirmTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={(e) => { e.stopPropagation(); setPassConfirmTarget(null); }}>
          <div className={`max-w-md w-full p-10 rounded-[48px] border shadow-2xl ${theme === 'dark' ? 'bg-[#0F172A] border-blue-500/30' : 'bg-white border-blue-200'}`} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center space-y-6">
              <div className="p-6 bg-blue-500/10 text-blue-500 rounded-full border border-blue-500/20 shadow-xl shadow-blue-500/10 animate-bounce">
                <PartyPopper size={48} />
              </div>
              <div className="space-y-2">
                <h3 className={`text-3xl font-black italic tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>CHALLENGE PASSED!</h3>
                <p className="text-slate-500 font-medium text-sm leading-relaxed px-4">
                  Povýšit účet <span className="text-blue-500 font-bold">"{passConfirmTarget.name}"</span> do fáze Funded?
                  Aktuální zisk bude zafixován do historie a tvůj obchodní balance se resetuje pro novou etapu.
                </p>
              </div>
              <div className="flex gap-4 w-full pt-4">
                <button
                  onClick={() => setPassConfirmTarget(null)}
                  className={`flex-1 py-5 rounded-2xl font-black uppercase text-xs tracking-widest transition-all ${theme === 'dark' ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Zrušit
                </button>
                <button
                  onClick={executePass}
                  className="flex-1 py-5 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-blue-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <Rocket size={18} /> CONFIRM PASS
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Payout Modal */}
      {payoutTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={() => setPayoutTarget(null)}>
          <div className={`max-w-md w-full p-10 rounded-[48px] border shadow-2xl ${theme === 'dark' ? 'bg-[#0F172A] border-emerald-500/30' : 'bg-white border-emerald-200'}`} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center space-y-6">
              <div className="p-6 bg-emerald-500/10 text-emerald-500 rounded-full border border-emerald-500/20 shadow-xl">
                <HandCoins size={48} />
              </div>
              <div className="space-y-2">
                <h3 className={`text-3xl font-black italic tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>RECORD PAYOUT</h3>
                <p className="text-slate-500 font-medium text-xs uppercase tracking-widest">Účet: {payoutTarget.name}</p>
              </div>

              <div className="w-full space-y-4 pt-4">
                <div className="space-y-2 text-left">
                  <label className="text-[10px] font-black uppercase text-slate-500 ml-2">Kolik vybíráš z platformy (Gross)?</label>
                  <div className="relative">
                    <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                    <input
                      type="number"
                      autoFocus
                      value={payoutGross}
                      onChange={e => setPayoutGross(e.target.value)}
                      placeholder="1000"
                      className={`w-full pl-12 pr-4 py-4 rounded-2xl border text-xl font-black font-mono outline-none ${theme === 'dark' ? 'bg-slate-950 border-slate-800 text-white' : 'bg-slate-50 border-slate-200'}`}
                    />
                  </div>
                </div>

                {payoutGross && (
                  <div className="p-5 rounded-[32px] bg-emerald-500/5 border border-emerald-500/20 animate-in zoom-in-95 duration-300">
                    <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-500 mb-2">
                      <span>Profit Split ({payoutTarget.profitSplit}%)</span>
                      <span>Výpočet</span>
                    </div>
                    <div className="flex justify-between items-end">
                      <div className="text-left">
                        <p className="text-[9px] text-slate-500 font-bold uppercase">Tvůj podíl (Net)</p>
                        <p className="text-2xl font-black text-emerald-500">+${(Number(payoutGross) * ((payoutTarget.profitSplit || 90) / 100)).toLocaleString()}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] text-slate-500 font-bold uppercase">Platforma (Gross)</p>
                        <p className="text-sm font-black text-rose-500">-${Number(payoutGross).toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-4 w-full pt-4">
                <button
                  onClick={() => { setPayoutTarget(null); setPayoutGross(''); }}
                  className={`flex-1 py-5 rounded-2xl font-black uppercase text-xs tracking-widest transition-all ${theme === 'dark' ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Zrušit
                </button>
                <button
                  onClick={handleRecordPayout}
                  disabled={!payoutGross}
                  className="flex-1 py-5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-emerald-600/20 active:scale-95 transition-all"
                >
                  Uložit Výplatu
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FAIL Confirmation Modal */}
      {failConfirmTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={(e) => { e.stopPropagation(); setFailConfirmTarget(null); }}>
          <div className={`max-w-md w-full p-10 rounded-[48px] border shadow-2xl ${theme === 'dark' ? 'bg-[#0F172A] border-rose-500/30' : 'bg-white border-rose-200'}`} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center space-y-6">
              <div className="p-6 bg-rose-500/10 text-rose-500 rounded-full border border-rose-500/20 shadow-xl shadow-rose-500/10">
                <Skull size={48} />
              </div>
              <div className="space-y-2">
                <h3 className={`text-3xl font-black italic tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>CHALLENGE FAILED?</h3>
                <p className="text-slate-500 font-medium text-sm leading-relaxed px-4">
                  Označit účet <span className="text-rose-500 font-bold">"{failConfirmTarget.name}"</span> jako neúspěšný?
                  Účet bude přesunut do archivu jako "Burnt" a jeho data už nebudou ovlivňovat tvé aktivní statistiky.
                </p>
              </div>
              <div className="flex gap-4 w-full pt-4">
                <button
                  onClick={() => setFailConfirmTarget(null)}
                  className={`flex-1 py-5 rounded-2xl font-black uppercase text-xs tracking-widest transition-all ${theme === 'dark' ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Zrušit
                </button>
                <button
                  onClick={executeFail}
                  className="flex-1 py-5 bg-rose-600 hover:bg-rose-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-rose-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <Skull size={18} /> CONFIRM FAIL
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Account Modal */}
      {accountToDelete && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={() => setAccountToDelete(null)}>
          <div className={`max-w-md w-full p-10 rounded-[48px] border shadow-2xl ${theme === 'dark' ? 'bg-[#0F172A] border-rose-500/30' : 'bg-white border-rose-200'}`} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center space-y-6">
              <div className="p-6 bg-rose-500/10 text-rose-500 rounded-full border border-rose-500/20 shadow-xl shadow-rose-500/10">
                <AlertCircle size={48} />
              </div>
              <div className="space-y-2">
                <h3 className={`text-3xl font-black italic tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>ERASE CAPITAL?</h3>
                <p className="text-slate-500 font-medium text-sm leading-relaxed px-4">
                  Účet <span className="text-rose-500 font-bold">"{accountToDelete.name}"</span> bude trvale odstraněn ze systému AlphaTrade včetně všech historických záznamů. Tato operace je nevratná.
                </p>
              </div>
              <div className="flex gap-4 w-full pt-4">
                <button
                  onClick={() => setAccountToDelete(null)}
                  className={`flex-1 py-5 rounded-2xl font-black uppercase text-xs tracking-widest transition-all ${theme === 'dark' ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Zrušit
                </button>
                <button
                  onClick={executeDelete}
                  className="flex-1 py-5 bg-rose-600 hover:bg-rose-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-rose-600/20 active:scale-95 transition-all"
                >
                  Smazat Vše
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountsManager;
