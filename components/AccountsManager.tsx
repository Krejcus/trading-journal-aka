import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Account, Trade, BusinessPayout, User, DailyReview } from '../types';
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
  LayoutGrid,
  Calendar,
  FlaskConical,
  LayoutDashboard,
  UploadCloud,
  ChevronDown,
  AlertTriangle,
  SlidersHorizontal
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import PayoutModal from './PayoutModal';
import AccountFuneralModal, { type FailureData } from './AccountFuneralModal';
import Graveyard, { MemorialModal, computeStats } from './Graveyard';
import { firmOf, firmInitials, firmColor, firmLabel, FIRM_LOGOS, KNOWN_FIRMS } from '../utils/accountFirm';
import { adjustmentForAccount, adjustmentTotal, directAdjustmentForFirm, getFinancialAdjustments } from '../services/tradingIncidents';
import { calculateAccountDrawdown, inferDrawdownConfig } from '../services/propDrawdown';
import { accountRemovalDecision } from '../lib/oauthAccountArchivePolicy';
import type { OAuthAccountLiveState } from '../lib/oauthAccountLiveState';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';
import type { FirmPayoutRules } from '../lib/propFirmRules';
import { defaultRulesForFirm, loadFirmPayoutRules, saveFirmPayoutRules } from '../services/firmPayoutRules';
import { loadCopierAccountSnapshots, type CopierAccountSnapshotRow } from '../services/copierAccountSnapshots';
import { buildAccountCockpitModel, sortAccountsRiskFirst, summarizeAccountCockpit, type AccountCockpitModel } from '../lib/accountCockpit';
import { funeralAccountScope, planMultiAccountFuneral } from '../lib/accountFuneralPlan';
import FirmPayoutRulesDialog from './FirmPayoutRulesDialog';

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
  onOpenInDashboard?: (id: string) => void;
  onImportTradovate?: (id: string) => void;
  onUpdatePayouts: (payouts: BusinessPayout[]) => boolean | void | Promise<boolean | void>;
  payouts: BusinessPayout[];
  reviews: DailyReview[];
  user: User;
  oauthLiveStates?: Record<string, OAuthAccountLiveState>;
  tradovateProfiles?: TradovateAccountProfile[];
  tradovateConnectionData?: Record<string, TradovatePreflightResult>;
}

const formatOAuthLastSeen = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

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

const SnapshotSparkline = ({ values }: { values: number[] }) => {
  if (values.length < 2) return null;
  const width = 120, height = 38;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const rising = values.at(-1)! >= values[0];
  const color = rising ? '#10b981' : '#f43f5e';
  const path = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible" aria-label="Vývoj equity ze snapshotů"><path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx={width} cy={height - ((values.at(-1)! - min) / range) * (height - 4) - 2} r="2.5" fill={color} /></svg>;
};

const CockpitGauge = ({ label, value, detail, pct, level = 'ok' }: { label: string; value: string; detail: string; pct: number; level?: 'ok' | 'warning' | 'danger' }) => {
  const tone = level === 'danger' ? 'text-rose-500' : level === 'warning' ? 'text-amber-500' : 'text-emerald-500';
  const bar = level === 'danger' ? 'bg-rose-500' : level === 'warning' ? 'bg-amber-500' : 'bg-emerald-500';
  return <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] p-3">
    <div className="flex items-start justify-between gap-2 text-[10px] font-bold text-[var(--text-secondary)]"><span>{label}</span><b className={`text-right tabular-nums ${tone}`}>{value}</b></div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-500/10"><i className={`block h-full rounded-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
    <p className={`mt-1.5 text-[10px] ${level === 'ok' ? 'text-[var(--text-secondary)]' : tone}`}>{detail}</p>
  </div>;
};

// Vlastní výběr firmy: vyjede přesně pod pole a každá položka má malé logo + název.
// (Nativní datalist si browser umísťoval mimo a logo u položek neuměl.) Kromě
// známých firem umí i vlastní název (spodní pole) → monogram fallback.
const FirmSelect: React.FC<{
  value?: string;
  onChange: (v: string | undefined) => void;
  isDark: boolean;
  placeholder?: string;
}> = ({ value, onChange, isDark, placeholder }) => {
  const [open, setOpen] = useState(false);
  const triggerCls = `w-full px-4 py-2.5 rounded-xl border outline-none transition-all flex items-center gap-2 text-left ${isDark ? 'bg-slate-900 border-white/10 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'}`;
  const key = value ? firmOf({ name: '', firmOverride: value }) : '';
  const known = KNOWN_FIRMS.find(f => f.label.toUpperCase() === (value || '').toUpperCase() || f.key === key);
  const customText = known ? '' : (value || '');

  const badge = (k: string, logo: string | undefined, sz = 'w-6 h-6') => logo
    ? <img src={logo} alt="" className={`${sz} rounded-md object-contain bg-white/90 p-0.5 border border-black/5 shrink-0`} />
    : <div className={`${sz} rounded-md shrink-0 flex items-center justify-center text-[9px] font-black text-white`} style={{ background: firmColor(k).bg }}>{firmInitials(k)}</div>;

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className={triggerCls}>
        {value ? badge(key, FIRM_LOGOS[key]) : null}
        <span className={`flex-1 truncate text-sm font-bold ${value ? '' : (isDark ? 'text-slate-600' : 'text-slate-400')}`}>{value || placeholder || 'Vyber firmu'}</span>
        <ChevronDown size={16} className={`text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className={`absolute z-50 mt-1 left-0 min-w-full w-max max-w-[280px] rounded-xl border shadow-2xl overflow-hidden ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}>
            {KNOWN_FIRMS.map(f => (
              <button
                key={f.key}
                type="button"
                onClick={() => { onChange(f.label); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}
              >
                {badge(f.key, f.logo)}
                <span className={`flex-1 text-sm font-bold whitespace-nowrap ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{f.label}</span>
                {(known?.key === f.key) && <Check size={14} className="text-blue-500 shrink-0" />}
              </button>
            ))}
            <div className={`border-t p-2 ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
              <input
                type="text"
                value={customText}
                placeholder="Jiná firma…"
                onChange={e => onChange(e.target.value || undefined)}
                className={`w-full px-3 py-1.5 rounded-lg text-sm outline-none border ${isDark ? 'bg-slate-800 border-white/10 text-white placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'}`}
              />
            </div>
          </div>
        </>
      )}
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
  reviews,
  user,
  onAddExpense,
  onOpenInDashboard,
  onImportTradovate,
  oauthLiveStates = {},
  tradovateProfiles = [],
  tradovateConnectionData = {},
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [payoutTargetAccountId, setPayoutTargetAccountId] = useState<string | null>(null);
  const [passConfirmTarget, setPassConfirmTarget] = useState<Account | null>(null);
  const [failConfirmTarget, setFailConfirmTarget] = useState<Account | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [archivedDetail, setArchivedDetail] = useState<Account | null>(null);
  // Firmy: sbalené sekce + cíl hromadného pohřbení celé firmy
  const [collapsedFirms, setCollapsedFirms] = useState<Set<string>>(new Set());
  const [firmFuneralTarget, setFirmFuneralTarget] = useState<string | null>(null);
  const [funeralCandidateIds, setFuneralCandidateIds] = useState<string[] | null>(null);
  const [drawdownDetailAccountId, setDrawdownDetailAccountId] = useState<string | null>(null);
  const [snapshotRows, setSnapshotRows] = useState<CopierAccountSnapshotRow[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [firmRules, setFirmRules] = useState<Record<string, FirmPayoutRules | null>>({});
  const [rulesDialogFirm, setRulesDialogFirm] = useState<string | null>(null);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);

  const [newAccount, setNewAccount] = useState<Partial<Account>>({
    name: '',
    initialBalance: 10000,
    challengeCost: 0,
    profitSplit: 90,
    profitTarget: 10,
    type: 'Funded',
    phase: 'Challenge',
    status: 'Active',
    currency: 'USD',
    instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
  });

  const [editFormData, setEditFormData] = useState<Partial<Account>>({});

  const financialAdjustments = useMemo(() => getFinancialAdjustments(reviews), [reviews]);

  useEffect(() => {
    let cancelled = false;
    loadCopierAccountSnapshots().then(rows => {
      if (!cancelled) setSnapshotRows(rows);
    }).catch(error => {
      if (!cancelled) setSnapshotError(error instanceof Error ? error.message : 'Snapshoty účtů se nepodařilo načíst.');
    });
    return () => { cancelled = true; };
  }, []);

  const firmKeys = useMemo(() => [...new Set(accounts.filter(account => account.oauth).map(firmOf))].sort(), [accounts]);
  const firmKeySignature = firmKeys.join('|');
  useEffect(() => {
    let cancelled = false;
    Promise.all(firmKeys.map(async firm => [firm, await loadFirmPayoutRules(firm)] as const))
      .then(entries => { if (!cancelled) setFirmRules(current => ({ ...current, ...Object.fromEntries(entries) })); })
      .catch(error => { if (!cancelled) setRulesError(error instanceof Error ? error.message : 'Pravidla firem se nepodařilo načíst.'); });
    return () => { cancelled = true; };
  // Stabilní podpis brání opakovaným dotazům při změně identity pole accounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmKeySignature]);

  const profileByAccountId = useMemo(() => new Map(accounts.flatMap(account => {
    if (!account.oauth) return [];
    const profile = tradovateProfiles.find(candidate => candidate.provider === account.oauth!.provider
      && candidate.environment === account.oauth!.environment
      && candidate.externalAccountId === account.oauth!.externalAccountId) ?? null;
    return [[account.id, profile] as const];
  })), [accounts, tradovateProfiles]);

  const liveBrokerByAccountId = useMemo(() => new Map(accounts.flatMap(account => {
    if (!account.oauth || oauthLiveStates[account.id]?.status !== 'connected') return [];
    const dataset = tradovateConnectionData[account.oauth.connectionId]
      ?? Object.values(tradovateConnectionData).find(candidate => candidate.environment === account.oauth!.environment
        && candidate.accounts.some(brokerAccount => String(brokerAccount.id) === account.oauth!.externalAccountId));
    const brokerAccount = dataset?.accounts.find(candidate => String(candidate.id) === account.oauth!.externalAccountId);
    return brokerAccount && dataset ? [[account.id, { account: brokerAccount, capturedAt: dataset.capturedAt }] as const] : [];
  })), [accounts, oauthLiveStates, tradovateConnectionData]);

  const cockpitByAccount = useMemo(() => new Map(accounts.flatMap(account => {
    if (!account.oauth) return [];
    const firm = firmOf(account);
    const rules = Object.prototype.hasOwnProperty.call(firmRules, firm) ? firmRules[firm] : defaultRulesForFirm(firm);
    const live = liveBrokerByAccountId.get(account.id);
    return [[account.id, buildAccountCockpitModel({
      account,
      rows: snapshotRows,
      profile: profileByAccountId.get(account.id) ?? null,
      rules,
      liveAccount: live?.account,
      liveCapturedAt: live?.capturedAt,
    })] as const];
  })), [accounts, firmRules, liveBrokerByAccountId, profileByAccountId, snapshotRows]);

  const activeCockpitModels = useMemo(() => accounts.filter(account => account.status === 'Active').flatMap(account => cockpitByAccount.get(account.id) ? [cockpitByAccount.get(account.id)!] : []), [accounts, cockpitByAccount]);
  const cockpitSummary = useMemo(() => summarizeAccountCockpit(activeCockpitModels), [activeCockpitModels]);
  const drawdownByAccount = useMemo(() => new Map(
    accounts.map(account => [account.id, calculateAccountDrawdown(account, trades, payouts, financialAdjustments)] as const)
  ), [accounts, trades, payouts, financialAdjustments]);

  const portfolioStats = useMemo(() => {
    const totalChallengeCosts = accounts.reduce((sum, acc) => sum + (acc.challengeCost || 0), 0);
    const totalNetPayouts = payouts.filter(p => p.status === 'Received').reduce((sum, p) => sum + p.amount, 0);
    const tradePnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const incidentPnL = adjustmentTotal(financialAdjustments);
    const totalTradesPnL = tradePnL + incidentPnL;
    const netCashflow = totalNetPayouts - totalChallengeCosts;

    const challenges = accounts.filter(a => a.type === 'Funded');
    const challengeCount = challenges.length;
    const passedChallenges = accounts.filter(a => a.type === 'Funded' && a.phase === 'Funded').length;
    const passRate = challengeCount > 0 ? (passedChallenges / challengeCount) * 100 : 0;

    return {
      totalChallengeCosts,
      totalNetPayouts,
      totalTradesPnL,
      tradePnL,
      incidentPnL,
      netCashflow,
      challengeCount,
      passRate,
      activeCount: accounts.filter(a => a.status === 'Active').length,
      inactiveCount: accounts.filter(a => a.status === 'Inactive').length
    };
  }, [accounts, trades, payouts, financialAdjustments]);

  // Spálené účty (result Failed) — zobrazí se v Hřbitově, ne v běžném gridu
  const failedAccounts = useMemo(
    () => accounts.filter(a => a.status === 'Inactive' && a.result === 'Failed'),
    [accounts]
  );

  // P&L per účet předpočítaný jednou (firm agregace by jinak filtrovala trades v cyklu)
  const pnlByAccount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of trades) m[t.accountId] = (m[t.accountId] || 0) + t.pnl;
    for (const account of accounts) {
      m[account.id] = (m[account.id] || 0) + adjustmentForAccount(financialAdjustments, account);
    }
    return m;
  }, [trades, accounts, financialAdjustments]);

  // ── Seskupení po FIRMÁCH (TopStep / Tradeify / Lucid…) ──────────────────────
  // Kopírka jede z jednoho masteru → parentAccountId dávky nerozdělí. Firma se
  // odvodí z názvu (firmOf), takže grouping funguje zpětně na všech účtech.
  // Viditelné karty respektují záložku Aktivní/Archiv; BYZNYS čísla v hlavičce
  // (koupeno/zaplaceno/payouty/čistý výnos) jsou lifetime přes VŠECHNY účty firmy
  // včetně pohřbených — to je ta odpověď na „vydělala mi tahle firma?".
  const firmGroups = useMemo(() => {
    const list = showInactive
      ? accounts.filter(a => a.status === 'Inactive' && a.result !== 'Failed')
      : accounts.filter(a => a.status === 'Active');

    const byFirm = new Map<string, Account[]>();
    for (const a of list) {
      const f = firmOf(a);
      if (!byFirm.has(f)) byFirm.set(f, []);
      byFirm.get(f)!.push(a);
    }

    return [...byFirm.entries()].map(([firm, visible]) => {
      const all = accounts.filter(a => firmOf(a) === firm);
      const allIds = new Set(all.map(a => a.id));
      const paid = all.reduce((s, a) => s + (a.challengeCost || 0), 0);
      const received = payouts.filter(p => p.accountId && allIds.has(p.accountId) && p.status === 'Received').reduce((s, p) => s + p.amount, 0);
      const pending = payouts.filter(p => p.accountId && allIds.has(p.accountId) && p.status === 'Pending').reduce((s, p) => s + p.amount, 0);
      const activeCount = all.filter(a => a.status === 'Active').length;
      const failedCount = all.filter(a => a.result === 'Failed').length;
      // Koupeno = reálné nákupy. Challenge → funded je JEDEN účet/platba: passnutý
      // challenge se archivuje (result=Passed) a vznikne funded následník, kterého
      // už počítáme → odečteme passnuté archivy, ať se nákup nepočítá dvakrát.
      const passedCount = all.filter(a => a.result === 'Passed').length;
      const bought = all.length - passedCount;

      // Trading Σ přes účty viditelné v aktuální záložce (stejný vzorec jako karta)
      let sumBalance = 0, sumPnl = 0;
      for (const a of visible) {
        const pnl = pnlByAccount[a.id] || 0;
        const gross = payouts.filter(p => p.accountId === a.id && p.status === 'Received').reduce((s, p) => s + (p.grossAmount || p.amount), 0);
        sumBalance += a.initialBalance + pnl - (a.accumulatedChallengePnL || 0) - gross;
        sumPnl += pnl - (a.accumulatedChallengePnL || 0);
      }
      // Korekce zadaná přímo na firmu nemá jednoznačné rozdělení mezi její účty,
      // ale patří do souhrnného balance/P&L firmy i portfolia.
      const directFirmAdjustment = directAdjustmentForFirm(financialAdjustments, firm);
      sumBalance += directFirmAdjustment;
      sumPnl += directFirmAdjustment;

      const mults = [...new Set(visible.map(a => a.copyMultiplier || 1))];
      const multiplierLabel = mults.length === 1 ? (mults[0] > 1 ? `${mults[0]}×` : null) : 'mix';

      // Master (bez parentAccountId) první, zbytek přirozeně podle názvu (TOPSTEP 2 < TOPSTEP 10)
      const sortedVisible = sortAccountsRiskFirst(visible, cockpitByAccount);

      const cockpitModels = sortedVisible.flatMap(account => cockpitByAccount.get(account.id) ? [cockpitByAccount.get(account.id)!] : []);
      const snapshotBalances = cockpitModels.filter(model => model.balance != null);
      const snapshotToday = cockpitModels.filter(model => model.todayPnl != null);
      const liveEquity = snapshotBalances.length ? snapshotBalances.reduce((sum, model) => sum + model.balance!, 0) : null;
      const liveToday = snapshotToday.length ? snapshotToday.reduce((sum, model) => sum + model.todayPnl!, 0) : null;
      return { firm, visible: sortedVisible, bought, paid, received, pending, net: received - paid, activeCount, failedCount, sumBalance, sumPnl, multiplierLabel, liveEquity, liveToday };
    }).sort((a, b) => (b.activeCount - a.activeCount) || a.firm.localeCompare(b.firm, 'cs'));
  }, [accounts, showInactive, payouts, pnlByAccount, financialAdjustments, cockpitByAccount]);

  // Firma určuje jen počáteční výběr; samotný plán smí zahrnout účty napříč firmami.
  const executeFirmFuneral = useCallback((failureData: FailureData) => {
    if (!firmFuneralTarget) return;
    const selectedAccountIds = failureData.selectedAccountIds ?? funeralCandidateIds ?? [];
    const selected = new Set(selectedAccountIds);
    const statsByAccountId = Object.fromEntries(accounts.filter(account => selected.has(account.id)).map(account => {
      const stats = computeStats(account, trades);
      return [account.id, { amountLost: stats.amountLost, progressPct: stats.progressPct, daysConsistency: stats.daysConsistency }];
    }));
    const updated = planMultiAccountFuneral({
      accounts,
      selectedAccountIds,
      failureData,
      statsByAccountId,
      archivedAt: Date.now(),
      funeralGroupId: crypto.randomUUID(),
    });
    onUpdate(updated);
    setFirmFuneralTarget(null);
    setFuneralCandidateIds(null);
  }, [firmFuneralTarget, funeralCandidateIds, accounts, trades, onUpdate]);

  const saveRules = useCallback(async (rules: FirmPayoutRules) => {
    if (!rulesDialogFirm) return;
    setRulesSaving(true);
    setRulesError(null);
    try {
      const saved = await saveFirmPayoutRules(rulesDialogFirm, rules);
      setFirmRules(current => ({ ...current, [rulesDialogFirm]: saved }));
      setRulesDialogFirm(null);
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : 'Pravidla se nepodařilo uložit.');
    } finally {
      setRulesSaving(false);
    }
  }, [rulesDialogFirm]);

  const toggleFirmCollapsed = (firm: string) => {
    setCollapsedFirms(prev => {
      const next = new Set(prev);
      if (next.has(firm)) next.delete(firm); else next.add(firm);
      return next;
    });
  };

  const handleAddAccount = () => {
    if (!newAccount.name) return;
    const account: Account = {
      id: crypto.randomUUID(),
      name: newAccount.name!,
      initialBalance: Number(newAccount.initialBalance),
      challengeCost: Number(newAccount.challengeCost) || 0,
      totalWithdrawals: 0,
      totalGrossWithdrawals: 0,
      profitSplit: Number(newAccount.profitSplit) || 90,
      profitTarget: Number(newAccount.profitTarget) || 10,
      phase: newAccount.type === 'Backtest' ? undefined : (newAccount.phase as any || 'Challenge'),
      accumulatedChallengePnL: 0,
      type: newAccount.type as any,
      status: 'Active',
      currency: 'USD',
      propThreshold: 150,
      firmOverride: newAccount.firmOverride || undefined,
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
      profitTarget: 10,
      type: 'Funded',
      phase: 'Challenge',
      status: 'Active',
      instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
    });
  };

  const handleSavePayout = (payout: BusinessPayout) => {
    const exists = payouts.find(p => p.id === payout.id);
    if (exists) {
      return onUpdatePayouts(payouts.map(p => p.id === payout.id ? payout : p));
    } else {
      return onUpdatePayouts([...payouts, payout]);
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

  const executeFail = useCallback((failureData: FailureData) => {
    if (!failConfirmTarget) return;
    const selectedAccountIds = failureData.selectedAccountIds ?? [failConfirmTarget.id];
    const selected = new Set(selectedAccountIds);
    const statsByAccountId = Object.fromEntries(accounts.filter(account => selected.has(account.id)).map(account => {
      const stats = computeStats(account, trades);
      return [account.id, { amountLost: stats.amountLost, progressPct: stats.progressPct, daysConsistency: stats.daysConsistency }];
    }));
    const updated = planMultiAccountFuneral({
      accounts,
      selectedAccountIds,
      failureData,
      statsByAccountId,
      archivedAt: Date.now(),
      funeralGroupId: crypto.randomUUID(),
    });
    onUpdate(updated);
    setFailConfirmTarget(null);
  }, [failConfirmTarget, accounts, trades, onUpdate]);

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
    setEditFormData({ ...acc, drawdownConfig: acc.drawdownConfig || inferDrawdownConfig(acc) || undefined });
  };

  const saveEdit = () => {
    if (!editFormData.name || !editingAccount) return;
    const updated = accounts.map(a => a.id === editingAccount.id ? { ...a, ...editFormData } as Account : a);
    onUpdate(updated);
    setEditingAccount(null);
  };

  const executeDelete = () => {
    if (!accountToDelete) return;
    const decision = accountRemovalDecision(accounts, accountToDelete);
    if (decision.kind === 'archive') onUpdate(decision.accounts);
    else onDelete(decision.id);
    setAccountToDelete(null);
  };

  const getAccountIcon = (type: string, status: string, phase?: string, size: number = 18, result?: 'Passed' | 'Failed') => {
    if (result === 'Passed') return <Trophy className="text-emerald-500" size={size} />;
    if (result === 'Failed') return <Skull className="text-rose-500" size={size} />;
    if (status === 'Inactive') return <Skull className="text-slate-600" size={size} />;
    if (type === 'Backtest') return <FlaskConical className="text-violet-400" size={size} />;
    if (phase === 'Challenge') return <Trophy className="text-amber-500" size={size} />;
    if (phase === 'Funded') return <Crown className="text-purple-500" size={size} />;
    return <Activity className="text-emerald-500" size={size} />;
  };

  const inputClass = `w-full px-4 py-2.5 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${theme !== 'light' ? 'bg-slate-900 border-white/10 text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'}`;

  const renderOAuthAccountCard = (acc: Account, model: AccountCockpitModel) => {
    const profile = profileByAccountId.get(acc.id) ?? null;
    const rules = firmRules[firmOf(acc)] ?? defaultRulesForFirm(firmOf(acc));
    const oauthState = oauthLiveStates[acc.id];
    const oauthLastSeen = formatOAuthLastSeen(oauthState?.lastSeenAt);
    const accTrades = trades.filter(trade => trade.accountId === acc.id);
    const phaseFunded = acc.phase === 'Funded';
    const border = model.risk === 'danger' ? 'border-rose-500/55 shadow-[0_0_24px_rgba(244,63,94,0.07)]'
      : model.risk === 'warning' ? 'border-amber-500/45' : model.payout?.eligible ? 'border-emerald-500/45' : 'border-[var(--border-subtle)]';
    const money = (value: number) => `$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
    const signed = (value: number) => `${value >= 0 ? '+' : '−'}${money(value)}`;
    const consistencyLevel = model.consistency?.limit == null ? 'ok'
      : model.consistency.breached ? 'danger'
        : model.consistency.pct >= model.consistency.limit * 0.8 ? 'warning' : 'ok';

    return <div key={acc.id} onClick={() => acc.status === 'Active' ? setActiveAccountId(acc.id) : setArchivedDetail(acc)} className={`group relative cursor-pointer rounded-xl border bg-[var(--bg-card)] p-5 transition-all hover:border-indigo-500/35 ${border} ${oauthState?.status === 'disconnected' ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${oauthState?.status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,.8)]' : 'bg-slate-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h3 className="truncate text-sm font-black text-[var(--text-primary)]">{acc.name}</h3>{model.breached && <span className="rounded-full border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-500">Breach?</span>}</div>
          <p className="mt-0.5 truncate text-[10px] font-semibold text-[var(--text-secondary)] tabular-nums">{acc.oauth?.externalAccountId}{profile?.accountSize != null ? ` · ${money(profile.accountSize)}` : ''}{(acc.copyMultiplier ?? 1) > 1 ? ` · ×${acc.copyMultiplier}` : ''}{oauthState?.status === 'disconnected' && oauthLastSeen ? ` · naposledy ${oauthLastSeen}` : ''}</p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${phaseFunded ? 'border-violet-500/30 bg-violet-500/10 text-violet-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-500'}`}>{phaseFunded ? 'Funded' : 'Challenge'}</span>
        <button type="button" onClick={event => startEditing(event, acc)} className="rounded-lg p-1.5 text-slate-500 hover:bg-indigo-500/10 hover:text-indigo-500" aria-label={`Upravit ${acc.name}`}><Settings2 size={14} /></button>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div><p className="text-[9px] font-black uppercase tracking-widest text-slate-500">{model.balance == null ? 'Poslední balance' : 'Balance'}</p><p className="mt-0.5 text-2xl font-black text-[var(--text-primary)] tabular-nums">{model.balance == null ? '—' : money(model.balance)}</p>{model.todayPnl != null && <p className={`text-xs font-bold tabular-nums ${model.todayPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>dnes {signed(model.todayPnl)}</p>}</div>
        {model.equity.length >= 2 ? <SnapshotSparkline values={model.equity} /> : <div className="relative h-10 w-[120px] overflow-hidden"><AccountSparkline trades={accTrades} initialBalance={acc.initialBalance} color={(accTrades.reduce((sum, trade) => sum + trade.pnl, 0) >= 0) ? 'emerald' : 'rose'} theme={theme} /></div>}
      </div>

      {(model.dailyLimit || model.drawdown || model.evaluation || model.profitDays || model.consistency || (phaseFunded && rules && (rules.minPayoutUsd != null || rules.maxPayoutUsd != null || rules.withdrawablePctOfProfit != null || rules.minBalanceToRequestUsd != null))) && <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {model.dailyLimit && profile?.dailyLossLimit != null && model.todayPnl != null && <CockpitGauge label="Denní limit" value={`${signed(model.todayPnl)} / ${money(profile.dailyLossLimit)}`} pct={model.dailyLimit.usedPct} level={model.dailyLimit.level} detail={model.dailyLimit.usedUsd === 0 ? 'v zisku — limit netknutý' : model.dailyLimit.level === 'danger' ? `zbývá jen ${money(model.dailyLimit.remainingUsd)} — zvaž stop na dnešek` : `zbývá ${money(model.dailyLimit.remainingUsd)} prostoru`} />}
        {model.drawdown && <CockpitGauge label="Trailing DD" value={`${money(model.drawdown.distance)} od flooru`} pct={model.drawdown.usage.usedPct} level={model.drawdown.usage.level} detail={`floor ${money(model.drawdown.floor)}`} />}
        {!phaseFunded && model.evaluation && <CockpitGauge label="Profit target" value={`${signed(model.evaluation.profitUsd)} / ${money(model.evaluation.targetUsd)}`} pct={model.evaluation.progressPct} level={model.evaluation.progressPct >= 80 ? 'warning' : 'ok'} detail={`${model.evaluation.progressPct.toFixed(0)} % — zbývá ${money(model.evaluation.remainingUsd)}`} />}
        {phaseFunded && model.profitDays && <CockpitGauge label={`Profit dny${rules?.minProfitPerDayUsd != null ? ` (≥ ${money(rules.minProfitPerDayUsd)})` : ''}`} value={`${model.profitDays.completed} / ${model.profitDays.required}`} pct={(model.profitDays.completed / Math.max(1, model.profitDays.required)) * 100} detail={model.profitDays.remaining ? `zbývá ${model.profitDays.remaining} zelených dnů` : 'podmínka splněna'} />}
        {model.consistency?.limit != null && <CockpitGauge label="Consistency" value={`${model.consistency.pct.toFixed(0)} % / ${model.consistency.limit} %`} pct={(model.consistency.pct / Math.max(1, model.consistency.limit)) * 100} level={consistencyLevel} detail={model.consistency.breached ? 'limit překročen' : consistencyLevel === 'warning' ? 'nejlepší den se blíží limitu' : 'v limitu'} />}
        {phaseFunded && rules && (rules.minPayoutUsd != null || rules.maxPayoutUsd != null || rules.withdrawablePctOfProfit != null || rules.minBalanceToRequestUsd != null) && <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] p-3"><p className="text-[10px] font-bold text-[var(--text-secondary)]">Payout</p><div className="mt-2 flex flex-wrap gap-2">{rules.minPayoutUsd != null && <span className="rounded border border-emerald-500/25 px-2 py-1 text-[10px] font-bold text-emerald-500 tabular-nums">min {money(rules.minPayoutUsd)}</span>}{rules.maxPayoutUsd != null && <span className="rounded border border-indigo-500/25 px-2 py-1 text-[10px] font-bold text-indigo-400 tabular-nums">max {money(rules.maxPayoutUsd)}</span>}{rules.withdrawablePctOfProfit != null && <span className="rounded border border-violet-500/25 px-2 py-1 text-[10px] font-bold text-violet-400 tabular-nums">{rules.withdrawablePctOfProfit} % zisku</span>}{rules.minBalanceToRequestUsd != null && <span className="rounded border border-amber-500/25 px-2 py-1 text-[10px] font-bold text-amber-500 tabular-nums">balance ≥ {money(rules.minBalanceToRequestUsd)}</span>}</div><p className="mt-2 text-[10px] text-[var(--text-secondary)]">{model.payout?.eligible ? `lze vybrat ${money(model.payout.withdrawableUsd)}` : model.payout?.missing.amountUsd != null ? `chybí ${money(model.payout.missing.amountUsd)}` : 'čeká na další podmínky'}</p></div>}
      </div>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        {model.breached && <><span className="rounded border border-rose-500/35 px-2 py-1 text-[10px] font-bold text-rose-500">Breach: floor protnut</span><button type="button" onClick={event => { event.stopPropagation(); const breachedIds = accounts.filter(candidate => candidate.status === 'Active' && cockpitByAccount.get(candidate.id)?.breached).map(candidate => candidate.id); setFuneralCandidateIds(breachedIds.length ? breachedIds : [acc.id]); setFirmFuneralTarget('Breached účty'); }} className="rounded-lg bg-rose-600 px-3 py-1.5 text-[10px] font-black uppercase text-white">Pohřbít</button></>}
        {model.payout?.eligible && <span className="rounded border border-emerald-500/30 px-2 py-1 text-[10px] font-bold text-emerald-500">Payout připraven</span>}
        {!model.breached && model.risk === 'ok' && <span className="rounded border border-emerald-500/25 px-2 py-1 text-[10px] font-bold text-emerald-500">V bezpečí</span>}
        <div className="ml-auto flex items-center gap-2">
          {phaseFunded && <button type="button" onClick={event => { event.stopPropagation(); setPayoutTargetAccountId(acc.id); }} className="rounded-lg p-1.5 text-emerald-500 hover:bg-emerald-500/10" aria-label="Výplata"><HandCoins size={14} /></button>}
          {onImportTradovate && <button type="button" onClick={event => { event.stopPropagation(); onImportTradovate(acc.id); }} className="rounded-lg p-1.5 text-indigo-500 hover:bg-indigo-500/10" aria-label="Importovat"><UploadCloud size={14} /></button>}
          <button type="button" onClick={event => toggleAccountStatus(event, acc.id)} className="text-[9px] font-black uppercase text-slate-500 hover:text-amber-500">Archivovat</button>
        </div>
      </div>
    </div>;
  };

  const renderAccountCard = (acc: Account, isSlave = false) => {
    const cockpit = cockpitByAccount.get(acc.id);
    if (acc.oauth && cockpit) return renderOAuthAccountCard(acc, cockpit);
    const accTrades = trades.filter(t => t.accountId === acc.id);
    const tradePnL = accTrades.reduce((sum, t) => sum + t.pnl, 0);
    const incidentPnL = adjustmentForAccount(financialAdjustments, acc);
    const totalPnL = tradePnL + incidentPnL;
    const accPayouts = payouts.filter(p => p.accountId === acc.id && p.status === 'Received');
    const grossWithdrawals = accPayouts.reduce((sum, p) => sum + (p.grossAmount || p.amount), 0);
    const accumulatedChallengePnL = acc.accumulatedChallengePnL || 0;
    const isChallenge = (acc.phase || 'Challenge') === 'Challenge';
    const isBacktest = acc.type === 'Backtest';
    const currentPlatformBalance = acc.initialBalance + totalPnL - accumulatedChallengePnL - grossWithdrawals;
    const propDrawdown = drawdownByAccount.get(acc.id) || null;
    const performanceColor = totalPnL >= 0 ? 'emerald' : 'rose';
    const oauthState = acc.oauth ? oauthLiveStates[acc.id] : undefined;
    const oauthLastSeen = formatOAuthLastSeen(oauthState?.lastSeenAt);

    const cardPadding = isSlave ? 'p-4' : 'p-6';
    const cardHeight = isSlave ? 'min-h-[240px]' : 'min-h-[320px]';

    return (
      <div
        key={acc.id}
        onClick={() => acc.status === 'Active' ? setActiveAccountId(acc.id) : setArchivedDetail(acc)}
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
                {(() => {
                  // Logo firmy u názvu účtu; fallback na status ikonu (backtest / neznámá firma).
                  const fk = firmOf(acc);
                  const logo = acc.type !== 'Backtest' ? FIRM_LOGOS[fk] : undefined;
                  return logo
                    ? <img src={logo} alt={fk} className={`${isSlave ? 'w-3.5 h-3.5' : 'w-[18px] h-[18px]'} object-contain`} />
                    : getAccountIcon(acc.type, acc.status, acc.phase, isSlave ? 14 : 18, acc.result);
                })()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className={`font-black uppercase tracking-tight truncate ${isSlave ? 'text-xs' : 'text-sm'} ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{acc.name}</h3>
                  {isSlave && <span className="px-1.5 py-0.5 rounded-md bg-blue-500/10 text-[8px] font-black text-blue-500 uppercase flex items-center gap-1 flex-shrink-0"><Link size={8} /> Copy</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap overflow-hidden text-[8px] font-black uppercase tracking-widest text-slate-500">
                  {isBacktest
                    ? <span className="text-violet-400">Backtesting</span>
                    : <span className={`${acc.phase === 'Funded' ? 'text-purple-500' : 'text-amber-500'}`}>{acc.phase || 'Challenge'}</span>
                  }
                </div>
                {acc.oauth && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[8px] font-bold text-slate-500">
                    <span className="rounded-md border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 uppercase tracking-wider text-blue-400">
                      Tradovate{acc.oauth.firm ? ` · ${acc.oauth.firm}` : ''}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${oauthState?.status === 'connected' ? 'bg-emerald-500' : 'bg-slate-500'}`} />
                      {oauthState?.status === 'connected' ? 'připojen' : oauthState?.status === 'disconnected' ? 'odpojen' : 'stav nedostupný'}
                      {oauthLastSeen ? ` · naposledy viděn ${oauthLastSeen}` : ''}
                    </span>
                  </div>
                )}
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
              {/* Vyplacené peníze se odečítají, ať platí balance = initial + Net PnL.
                  Dřív balance výplatu odečetla, ale Net PnL ne → čísla si protiřečila. */}
              {(() => {
                const netPnl = totalPnL - accumulatedChallengePnL - grossWithdrawals;
                return (
                  <>
                    <span className={`${isSlave ? 'text-base' : 'text-lg'} font-black font-mono ${netPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {netPnl >= 0 ? '+' : ''}${netPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    {grossWithdrawals > 0 && (
                      <span className="text-[8px] font-bold text-slate-500">vyplaceno −${grossWithdrawals.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          <div className={`${isSlave ? 'mt-3 pt-3' : 'mt-4 pt-4'} border-t border-white/5`}>
            {propDrawdown && !isBacktest && (
              <button type="button" onClick={(event) => { event.stopPropagation(); setDrawdownDetailAccountId(acc.id); }} className="mb-3 w-full text-left rounded-xl hover:bg-rose-500/5 transition-colors p-1 -m-1">
                <div className="flex items-center justify-between mb-1.5 gap-2">
                  <span className={`text-[8px] font-black uppercase ${propDrawdown.remainingPct <= 25 ? 'text-rose-500' : propDrawdown.remainingPct <= 50 ? 'text-amber-500' : 'text-emerald-500'}`}>DD prostor</span>
                  <span className="text-[8px] font-black text-slate-500 truncate">
                    ${Math.round(propDrawdown.remainingRoom).toLocaleString('en-US')} · floor ${Math.round(propDrawdown.currentFloor).toLocaleString('en-US')} · {propDrawdown.locked ? 'LOCKED' : 'TRAILING'}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full overflow-hidden bg-slate-800/80">
                  <div
                    className={`h-full transition-all ${propDrawdown.remainingPct <= 25 ? 'bg-rose-500' : propDrawdown.remainingPct <= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.max(0, Math.min(100, propDrawdown.remainingPct))}%` }}
                  />
                </div>
                {propDrawdown.projectedNextFloor != null && propDrawdown.projectedNextFloor > propDrawdown.currentFloor && (
                  <p className="mt-1 text-[8px] font-bold text-slate-500">Po dnešním EOD: ${Math.round(propDrawdown.projectedNextFloor).toLocaleString('en-US')}</p>
                )}
              </button>
            )}
            {isBacktest ? (
              <div className="flex items-center justify-between">
                <span className="text-[8px] font-black uppercase text-violet-400">Backtest účet</span>
                <span className="text-[8px] font-black text-slate-500">{accTrades.length} obchodů</span>
              </div>
            ) : isChallenge && acc.status === 'Active' ? (
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
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[8px] font-black uppercase text-emerald-500">Profit Split</span>
                    <span className="text-[8px] font-black text-slate-500">{acc.profitSplit || 90}%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] font-black uppercase text-slate-600">Výplata</span>
                    <span className="text-[8px] font-black text-emerald-500 uppercase">Aktivní</span>
                  </div>
                </div>
                {/* Funded účet se nepassuje — jen padne. Bez tohohle tlačítka nešlo spálený funded pohřbít. */}
                <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFailConfirmTarget(acc); }} className="p-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20 transform active:scale-90" title="Spálený účet (Fail)"><Skull size={14} /></button>
              </div>
            ) : <div className="h-[28px]" />}
          </div>
        </div>

        <div className={`flex justify-between items-center ${isSlave ? 'mt-2' : 'mt-5'} pt-3 border-t border-white/5 opacity-0 group-hover:opacity-100 transition-all duration-500 h-[24px]`}>
          <div className="flex gap-2">
            <button onClick={(e) => toggleAccountStatus(e, acc.id)} className={`text-[8px] font-black uppercase tracking-wider flex items-center gap-1 transition-all ${acc.status === 'Active' ? 'text-slate-500 hover:text-amber-500' : 'text-emerald-500 hover:text-emerald-400'}`}>
              {acc.status === 'Active' ? <><Archive size={10} /> Archivovat</> : <><Check size={10} /> Obnovit</>}
            </button>
            {acc.status === 'Inactive' && onOpenInDashboard && (
              <button onClick={(e) => { e.stopPropagation(); onOpenInDashboard(acc.id); }} className="text-[8px] font-black uppercase tracking-wider flex items-center gap-1 text-blue-500 hover:text-blue-400 transition-all" title="Otevřít v dashboardu">
                <LayoutDashboard size={10} /> Dashboard
              </button>
            )}
            {acc.status === 'Active' && onImportTradovate && (
              <button onClick={(e) => { e.stopPropagation(); onImportTradovate(acc.id); }} className="text-[8px] font-black uppercase tracking-wider flex items-center gap-1 text-blue-500 hover:text-blue-400 transition-all" title="Importovat obchody z Tradovate">
                <UploadCloud size={10} /> Import
              </button>
            )}
          </div>
          <button onClick={(e) => { e.stopPropagation(); setAccountToDelete(acc); }} className="text-[8px] font-black uppercase text-slate-600 hover:text-rose-500 transition-all flex items-center gap-1">
            {acc.oauth ? <><Archive size={10} /> Archivovat</> : <><Trash2 size={10} /> Smazat</>}
          </button>
        </div>
      </div>
    );
  };

  const payoutCandidateAccount = cockpitSummary.payoutCandidate
    ? accounts.find(account => account.id === cockpitSummary.payoutCandidate!.accountId) : null;
  const riskAccount = accounts.find(account => account.status === 'Active' && cockpitByAccount.get(account.id)?.risk === 'danger')
    ?? accounts.find(account => account.status === 'Active' && cockpitByAccount.get(account.id)?.risk === 'warning');

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4"><p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Celková equity</p><p className="mt-1 text-2xl font-black text-[var(--text-primary)] tabular-nums">{cockpitSummary.totalEquity == null ? '—' : `$${Math.round(cockpitSummary.totalEquity).toLocaleString('en-US')}`}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{activeCockpitModels.length} OAuth účtů · {new Set(accounts.filter(account => account.status === 'Active' && account.oauth).map(firmOf)).size} firem</p></div>
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4"><p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Dnes</p><p className={`mt-1 text-2xl font-black tabular-nums ${cockpitSummary.todayPnl == null ? 'text-[var(--text-primary)]' : cockpitSummary.todayPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{cockpitSummary.todayPnl == null ? '—' : `${cockpitSummary.todayPnl >= 0 ? '+' : '−'}$${Math.round(Math.abs(cockpitSummary.todayPnl)).toLocaleString('en-US')}`}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">z denních snapshot ledgerů</p></div>
        <div className={`rounded-xl border p-4 ${cockpitSummary.riskCount > 0 ? 'border-rose-500/35 bg-gradient-to-b from-rose-500/10 to-[var(--bg-card)]' : 'border-[var(--border-subtle)] bg-[var(--bg-card)]'}`}><p className="text-[9px] font-black uppercase tracking-widest text-slate-500">V riziku</p><p className={`mt-1 text-2xl font-black ${cockpitSummary.riskCount ? 'text-rose-500' : 'text-emerald-500'}`}>{cockpitSummary.riskCount} {cockpitSummary.riskCount === 1 ? 'účet' : 'účtů'}</p><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{riskAccount ? riskAccount.name : 'žádný aktivní semafor'}</p></div>
        <div className={`rounded-xl border p-4 ${payoutCandidateAccount ? 'border-emerald-500/35 bg-gradient-to-b from-emerald-500/10 to-[var(--bg-card)]' : 'border-[var(--border-subtle)] bg-[var(--bg-card)]'}`}><p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Payout</p><p className={`mt-1 text-2xl font-black tabular-nums ${payoutCandidateAccount ? 'text-emerald-500' : 'text-[var(--text-primary)]'}`}>{cockpitSummary.payoutCandidate ? cockpitSummary.payoutCandidate.amountUsd === 0 ? 'připraven' : `za ~$${Math.round(cockpitSummary.payoutCandidate.amountUsd).toLocaleString('en-US')}` : '—'}</p><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{payoutCandidateAccount?.name ?? 'chybí úplná payout pravidla'}</p></div>
      </section>

      {snapshotError && <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-2 text-xs text-amber-500"><AlertTriangle size={14} />{snapshotError} Karty nezobrazují odhadované hodnoty.</div>}

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
          
          {/* Account type selector */}
          <div className="flex gap-3 mb-6">
            <button
              onClick={() => setNewAccount({ ...newAccount, type: 'Funded', phase: 'Challenge' })}
              className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border ${
                newAccount.type !== 'Backtest' ? 'bg-blue-600/20 border-blue-500/40 text-blue-400' : (theme !== 'light' ? 'border-white/10 text-slate-500' : 'border-slate-200 text-slate-400')
              }`}
            >
              <Trophy size={14} className="inline mr-1" /> Funded / Challenge
            </button>
            <button
              onClick={() => setNewAccount({ ...newAccount, type: 'Backtest', phase: undefined, challengeCost: 0, profitSplit: 100 })}
              className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border ${
                newAccount.type === 'Backtest' ? 'bg-violet-600/20 border-violet-500/40 text-violet-400' : (theme !== 'light' ? 'border-white/10 text-slate-500' : 'border-slate-200 text-slate-400')
              }`}
            >
              <FlaskConical size={14} className="inline mr-1" /> Backtesting
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Název účtu</label><input type="text" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} className={inputClass} placeholder="Např. FX Replay BT" /></div>
            <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Počáteční Balance ($)</label><input type="number" value={newAccount.initialBalance} onChange={e => setNewAccount({ ...newAccount, initialBalance: Number(e.target.value) })} className={inputClass} /></div>
            {newAccount.type !== 'Backtest' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-[9px] uppercase font-black text-blue-500 tracking-widest">Firma</label>
                  <FirmSelect value={newAccount.firmOverride} onChange={v => setNewAccount({ ...newAccount, firmOverride: v })} isDark={theme !== 'light'} placeholder="Vyber firmu" />
                </div>
                <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Fáze</label><select value={newAccount.phase} onChange={e => setNewAccount({ ...newAccount, phase: e.target.value as any })} className={inputClass}><option value="Challenge">Challenge</option><option value="Funded">Funded</option></select></div>
                <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-rose-500 tracking-widest">Cena Pořízení ($)</label><input type="number" value={newAccount.challengeCost} onChange={e => setNewAccount({ ...newAccount, challengeCost: Number(e.target.value) })} className={`${inputClass} border-rose-500/20`} /></div>
                <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-emerald-500 tracking-widest">Profit Split (%)</label><input type="number" value={newAccount.profitSplit} onChange={e => setNewAccount({ ...newAccount, profitSplit: Number(e.target.value) })} className={inputClass} /></div>
                <div className="space-y-1.5"><label className="text-[9px] uppercase font-black text-blue-500 tracking-widest">Profit Cíl (%)</label><input type="number" value={newAccount.profitTarget} onChange={e => setNewAccount({ ...newAccount, profitTarget: Number(e.target.value) })} className={inputClass} placeholder="napr. 6" /></div>
              </>
            )}
          </div>
          <div className="flex justify-end gap-3"><button onClick={() => setIsAdding(false)} className="px-6 py-2.5 rounded-xl font-black uppercase text-[10px] text-slate-500 tracking-widest hover:text-slate-300">Zrušit</button><button onClick={handleAddAccount} className="px-8 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg active:scale-95 transition-all">Aktivovat</button></div>
        </div>
      )}

      {showInactive && failedAccounts.length > 0 && (
        <Graveyard accounts={failedAccounts} allAccounts={accounts} trades={trades} theme={theme} />
      )}

      {/* Sekce po firmách: hlavička s agregáty + byznys řádkem, pod ní karty účtů */}
      <div className="space-y-5">
        {firmGroups.map(g => {
          const collapsed = collapsedFirms.has(g.firm);
          const canBuryFirm = !showInactive && g.visible.some(a => a.type !== 'Backtest');
          return (
            <section key={g.firm} className={`rounded-xl border overflow-hidden ${theme !== 'light' ? 'bg-slate-900/25 border-white/5' : 'bg-slate-50/60 border-slate-200'}`}>
              <button
                onClick={() => toggleFirmCollapsed(g.firm)}
                aria-expanded={!collapsed}
                className={`w-full text-left px-5 py-4 transition-colors ${theme !== 'light' ? 'hover:bg-white/[0.02]' : 'hover:bg-slate-100/60'}`}
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <ChevronDown size={16} className={`text-slate-500 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                  {/* Miniatura firmy: pravé logo z registru, jinak auto-monogram s barvou z názvu */}
                  {FIRM_LOGOS[g.firm] ? (
                    <img src={FIRM_LOGOS[g.firm]} alt={g.firm} className="w-8 h-8 rounded-xl object-contain shrink-0 bg-white/90 p-1 border border-white/10" />
                  ) : (
                    <div
                      className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center text-[11px] font-black tracking-tight shadow-inner"
                      style={{ background: firmColor(g.firm).bg, color: firmColor(g.firm).fg }}
                      aria-hidden="true"
                    >{firmInitials(g.firm)}</div>
                  )}
                  <h3 className={`text-sm font-black uppercase tracking-tight ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{firmLabel(g.firm)}</h3>
                  {g.multiplierLabel && <span className="px-1.5 py-0.5 rounded-md bg-violet-500/10 border border-violet-500/25 text-violet-400 text-[8px] font-black uppercase tracking-widest">{g.multiplierLabel} risk</span>}
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">
                    {g.activeCount} akt{g.failedCount > 0 && <span className="text-rose-500/80"> · {g.failedCount} ☠</span>}
                  </span>
                  <div className="ml-auto flex items-center gap-5">
                    <div className="text-right">
                      <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Equity</p>
                      <p className={`text-sm font-black tabular-nums ${(g.liveEquity ?? g.sumBalance) >= 0 ? 'text-slate-200' : 'text-rose-500'} ${theme === 'light' ? '!text-slate-900' : ''}`}>${(g.liveEquity ?? g.sumBalance).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Dnes</p>
                      <p className={`text-sm font-black tabular-nums ${(g.liveToday ?? g.sumPnl) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{(g.liveToday ?? g.sumPnl) >= 0 ? '+' : ''}${(g.liveToday ?? g.sumPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                    {g.visible.some(account => account.oauth) && <span role="button" tabIndex={0} onClick={event => { event.stopPropagation(); setRulesError(null); setRulesDialogFirm(g.firm); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setRulesError(null); setRulesDialogFirm(g.firm); } }} className="flex cursor-pointer items-center gap-1 rounded-lg border border-indigo-500/25 bg-indigo-500/10 px-2.5 py-2 text-[9px] font-black uppercase tracking-wider text-indigo-400 hover:bg-indigo-500/20"><SlidersHorizontal size={13} /> Pravidla</span>}
                    {canBuryFirm && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setFuneralCandidateIds(g.visible.filter(account => account.status === 'Active' && account.type !== 'Backtest').map(account => account.id)); setFirmFuneralTarget(g.firm); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setFuneralCandidateIds(g.visible.filter(account => account.status === 'Active' && account.type !== 'Backtest').map(account => account.id)); setFirmFuneralTarget(g.firm); } }}
                        className="p-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20 cursor-pointer"
                        title={`Pohřbít celou firmu ${g.firm} (všechny aktivní účty → Failed)`}
                      >
                        <Skull size={14} />
                      </span>
                    )}
                  </div>
                </div>
                {/* Byznys řádek — lifetime přes všechny účty firmy (i pohřbené) */}
                <div className="mt-2 pl-8 flex items-center gap-x-4 gap-y-1 flex-wrap text-[9px] font-black uppercase tracking-widest text-slate-500">
                  <span>Koupeno <span className="text-slate-300">{g.bought} účtů</span></span>
                  <span className="opacity-30">·</span>
                  <span>Zaplaceno <span className="text-rose-500 font-mono">−${g.paid.toLocaleString()}</span></span>
                  <span className="opacity-30">·</span>
                  <span>Payouty <span className="text-emerald-500 font-mono">+${g.received.toLocaleString()}</span>{g.pending > 0 && <span className="text-amber-500 font-mono"> (+${g.pending.toLocaleString()} čeká)</span>}</span>
                  <span className="opacity-30">·</span>
                  <span className={`px-2 py-0.5 rounded-md border font-mono ${g.net >= 0 ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-rose-500/10 border-rose-500/25 text-rose-400'}`}>
                    Čistě {g.net >= 0 ? '+' : '−'}${Math.abs(g.net).toLocaleString()}
                  </span>
                </div>
              </button>
              {!collapsed && (
                <div className="px-5 pb-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
                  {g.visible.map(acc => renderAccountCard(acc, !!acc.parentAccountId))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <PayoutModal isOpen={!!payoutTargetAccountId} onClose={() => setPayoutTargetAccountId(null)} onSave={handleSavePayout} accounts={accounts} initialAccountId={payoutTargetAccountId || undefined} theme={theme} user={user} />

      {drawdownDetailAccountId && (() => {
        const summary = drawdownByAccount.get(drawdownDetailAccountId);
        if (!summary) return null;
        return (
          <div className="fixed inset-0 z-[450] flex items-center justify-center p-4 bg-black/65 backdrop-blur-md" role="dialog" aria-label="Historie prop drawdownu" onClick={() => setDrawdownDetailAccountId(null)}>
            <div className={`w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-[30px] border shadow-2xl ${theme !== 'light' ? 'bg-slate-950 border-white/10' : 'bg-white border-slate-200'}`} onClick={event => event.stopPropagation()}>
              <div className="p-6 border-b border-white/10 flex items-start justify-between gap-4">
                <div><p className="text-[9px] font-black uppercase tracking-widest text-rose-500">EOD Drawdown</p><h3 className="text-xl font-black">{summary.accountName}</h3><p className="text-xs text-slate-500">{summary.locked ? 'LOCKED' : 'TRAILING'} · floor ${Math.round(summary.currentFloor).toLocaleString('en-US')}</p></div>
                <button type="button" aria-label="Zavřít drawdown" onClick={() => setDrawdownDetailAccountId(null)} className="p-2 rounded-xl text-slate-500 hover:text-rose-500 hover:bg-rose-500/10"><X size={20} /></button>
              </div>
              <div className="p-6 grid grid-cols-3 gap-3">
                <div className="p-4 rounded-2xl bg-blue-500/8 border border-blue-500/15"><p className="text-[8px] font-black uppercase text-slate-500">Balance</p><p className="text-lg font-black font-mono">${Math.round(summary.currentBalance).toLocaleString('en-US')}</p></div>
                <div className="p-4 rounded-2xl bg-rose-500/8 border border-rose-500/15"><p className="text-[8px] font-black uppercase text-slate-500">Hard breach floor</p><p className="text-lg font-black font-mono text-rose-500">${Math.round(summary.currentFloor).toLocaleString('en-US')}</p></div>
                <div className="p-4 rounded-2xl bg-emerald-500/8 border border-emerald-500/15"><p className="text-[8px] font-black uppercase text-slate-500">Zbývající prostor</p><p className={`text-lg font-black font-mono ${summary.remainingPct <= 25 ? 'text-rose-500' : summary.remainingPct <= 50 ? 'text-amber-500' : 'text-emerald-500'}`}>${Math.round(summary.remainingRoom).toLocaleString('en-US')}</p></div>
              </div>
              <div className="px-6 pb-6 overflow-auto max-h-[52vh]">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-inherit"><tr className="text-[8px] uppercase tracking-widest text-slate-500"><th className="py-2">Den</th><th>EOD balance</th><th>Floor před</th><th>Floor po</th><th className="text-right">Prostor</th></tr></thead>
                  <tbody>{[...summary.history].reverse().map(day => <tr key={day.date} className="border-t border-white/5"><td className="py-3 font-bold">{day.date}</td><td className="font-mono">${Math.round(day.closingBalance).toLocaleString('en-US')}</td><td className="font-mono text-slate-500">${Math.round(day.floorBefore).toLocaleString('en-US')}</td><td className="font-mono text-rose-400">${Math.round(day.projectedFloorAfter ?? day.floorAfter).toLocaleString('en-US')}{day.projectedFloorAfter != null ? ' odhad' : ''}</td><td className="font-mono font-black text-right">${Math.round(day.roomAfter).toLocaleString('en-US')}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {editingAccount && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md" onClick={() => setEditingAccount(null)}>
          <div className={`max-w-2xl w-full max-h-[90vh] overflow-y-auto p-8 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200 shadow-2xl'}`} onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-8"><div className="flex items-center gap-3"><div className="p-3 bg-blue-500/10 text-blue-500 rounded-2xl"><Settings2 size={24} /></div><h3 className="text-xl font-black italic uppercase">Nastavení Účtu</h3></div><button onClick={() => setEditingAccount(null)} className="text-slate-500 hover:text-white"><X size={24} /></button></div>
            <div className="grid grid-cols-2 gap-6 mb-8">
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Název účtu</label><input type="text" value={editFormData.name || ''} onChange={e => setEditFormData({ ...editFormData, name: e.target.value })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Počáteční Balance</label><input type="number" value={editFormData.initialBalance || ''} onChange={e => setEditFormData({ ...editFormData, initialBalance: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Cena Pořízení</label><input type="number" value={editFormData.challengeCost || 0} onChange={e => setEditFormData({ ...editFormData, challengeCost: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-500">Profit Split (%)</label><input type="number" value={editFormData.profitSplit || 90} onChange={e => setEditFormData({ ...editFormData, profitSplit: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-blue-500">Profit Cíl (%)</label><input type="number" value={editFormData.profitTarget ?? 10} onChange={e => setEditFormData({ ...editFormData, profitTarget: Number(e.target.value) })} className={inputClass} /></div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Fáze Účtu</label>
                <select value={editFormData.phase || 'Challenge'} onChange={e => setEditFormData({ ...editFormData, phase: e.target.value as any })} className={inputClass}><option value="Challenge">Challenge</option><option value="Funded">Funded</option></select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Master Účet (Link)</label>
                <select value={editFormData.parentAccountId || ''} onChange={e => setEditFormData({ ...editFormData, parentAccountId: e.target.value || undefined })} className={inputClass}><option value="">-- Žádný --</option>{accounts.filter(a => a.id !== editingAccount.id && !a.parentAccountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Firma (skupina)</label>
                <FirmSelect
                  value={editFormData.firmOverride}
                  onChange={v => setEditFormData({ ...editFormData, firmOverride: v })}
                  isDark={theme !== 'light'}
                  placeholder={editingAccount ? firmOf({ name: editFormData.name || editingAccount.name, firmOverride: undefined }) : 'Vyber firmu'}
                />
                <p className="text-[9px] text-slate-500 font-semibold">Prázdné = automaticky první slovo názvu. Vyber ze seznamu (spáruje logo) nebo napiš vlastní.</p>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-slate-500">Risk Multiplikátor (AlphaBridge)</label>
                <input
                  type="number" min={1} step={1}
                  value={editFormData.copyMultiplier ?? 1}
                  onChange={e => { const n = Math.max(1, Math.round(parseInt(e.target.value, 10) || 1)); setEditFormData({ ...editFormData, copyMultiplier: n }); }}
                  className={inputClass}
                />
                <p className="text-[9px] text-slate-500 font-semibold">Násobek risku/kontraktů při fan-outu. Základ = 1×, dvojnásobný risk = 2×. Jen celá čísla.</p>
              </div>
              <div className="col-span-2 p-4 rounded-2xl border border-rose-500/20 bg-rose-500/5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase text-rose-500">Prop-firm drawdown</p>
                    <p className="text-[9px] text-slate-500 font-semibold">Preset se odvodí podle firmy; tady jej můžeš potvrdit nebo upravit.</p>
                  </div>
                  <label className="flex items-center gap-2 text-[9px] font-black uppercase text-slate-500">
                    <input
                      type="checkbox"
                      checked={editFormData.drawdownConfig?.enabled !== false && !!editFormData.drawdownConfig}
                      onChange={e => setEditFormData({
                        ...editFormData,
                        drawdownConfig: e.target.checked
                          ? (editFormData.drawdownConfig || { enabled: true, mode: 'eod_trailing', amount: 2000, timezone: 'America/New_York' })
                          : editFormData.drawdownConfig ? { ...editFormData.drawdownConfig, enabled: false } : { enabled: false, mode: 'eod_trailing', amount: 2000 },
                      })}
                    /> Sledovat
                  </label>
                </div>
                {editFormData.drawdownConfig?.enabled !== false && editFormData.drawdownConfig && (
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="text-[9px] font-black uppercase text-slate-500">Typ</label><select value={editFormData.drawdownConfig.mode} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, mode: e.target.value as any } })} className={inputClass}><option value="eod_trailing">EOD trailing</option><option value="intraday_trailing">Intraday trailing</option><option value="static">Static</option></select></div>
                    <div><label className="text-[9px] font-black uppercase text-slate-500">DD částka ($)</label><input type="number" value={editFormData.drawdownConfig.amount} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, amount: Number(e.target.value) } })} className={inputClass} /></div>
                    <div><label className="text-[9px] font-black uppercase text-slate-500">Lock trigger balance</label><input type="number" value={editFormData.drawdownConfig.lockTriggerBalance ?? ''} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, lockTriggerBalance: e.target.value ? Number(e.target.value) : undefined } })} className={inputClass} /></div>
                    <div><label className="text-[9px] font-black uppercase text-slate-500">Locked floor</label><input type="number" value={editFormData.drawdownConfig.lockedFloor ?? ''} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, lockedFloor: e.target.value ? Number(e.target.value) : undefined } })} className={inputClass} /></div>
                    <div><label className="text-[9px] font-black uppercase text-slate-500">Aktuální floor (volitelné)</label><input type="number" value={editFormData.drawdownConfig.manualCurrentFloor ?? ''} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, manualCurrentFloor: e.target.value ? Number(e.target.value) : undefined } })} className={inputClass} /></div>
                    <label className="flex items-end pb-3 gap-2 text-[9px] font-black uppercase text-slate-500"><input type="checkbox" checked={!!editFormData.drawdownConfig.forceLocked} onChange={e => setEditFormData({ ...editFormData, drawdownConfig: { ...editFormData.drawdownConfig!, forceLocked: e.target.checked } })} /> Už zamčeno</label>
                  </div>
                )}
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
        (() => {
          const breachedIds = accounts.filter(candidate => candidate.status === 'Active'
            && cockpitByAccount.get(candidate.id)?.breached).map(candidate => candidate.id);
          const scope = funeralAccountScope({
            accounts,
            openedAccountId: failConfirmTarget.id,
            breachedAccountIds: breachedIds,
          });
          return <AccountFuneralModal
            account={failConfirmTarget}
            accounts={scope.accounts}
            initialSelectedAccountIds={scope.selectedAccountIds}
            successorCandidates={accounts.filter(candidate => candidate.status === 'Active' && candidate.type !== 'Backtest')}
            trades={trades}
            userId={user.id}
            onConfirm={executeFail}
            onClose={() => setFailConfirmTarget(null)}
            theme={theme}
          />;
        })()
      )}

      <ConfirmationModal
        isOpen={!!accountToDelete}
        onClose={() => setAccountToDelete(null)}
        onConfirm={executeDelete}
        title={accountToDelete?.oauth ? 'Archivovat OAuth účet' : 'Smazat Účet'}
        message={accountToDelete?.oauth
          ? `Účet "${accountToDelete.name}" je trvale propojený s Tradovate a mohou se na něj vázat obchody. Místo smazání bude bezpečně přesunut do archivu.`
          : `Opravdu chcete smazat účet "${accountToDelete?.name}"? Smažou se i VŠECHNY jeho obchody — nevratně. Pro archivaci s historií použij lebku (Fail).`}
        theme={theme}
      />

      {firmFuneralTarget && (() => {
        const candidateSet = funeralCandidateIds ? new Set(funeralCandidateIds) : null;
        const targetAccounts = accounts.filter(a => (candidateSet ? candidateSet.has(a.id) : firmOf(a) === firmFuneralTarget) && a.status === 'Active' && a.type !== 'Backtest');
        if (!targetAccounts.length) return null;
        const breachedIds = accounts.filter(candidate => candidate.status === 'Active'
          && cockpitByAccount.get(candidate.id)?.breached).map(candidate => candidate.id);
        const scope = funeralAccountScope({
          accounts,
          openedAccountId: targetAccounts[0].id,
          breachedAccountIds: breachedIds,
          preferredAccountIds: targetAccounts.map(account => account.id),
        });
        return (
          <AccountFuneralModal
            account={targetAccounts[0]}
            accounts={scope.accounts}
            initialSelectedAccountIds={scope.selectedAccountIds}
            successorCandidates={accounts.filter(account => account.status === 'Active' && account.type !== 'Backtest')}
            compactMulti
            initialFailureDate={targetAccounts.flatMap(account => cockpitByAccount.get(account.id)?.breachDate ? [cockpitByAccount.get(account.id)!.breachDate!] : []).sort()[0]}
            title={firmFuneralTarget}
            trades={trades}
            userId={user.id}
            onConfirm={executeFirmFuneral}
            onClose={() => { setFirmFuneralTarget(null); setFuneralCandidateIds(null); }}
            theme={theme}
          />
        );
      })()}

      {rulesDialogFirm && (() => {
        const initialRules = firmRules[rulesDialogFirm] ?? defaultRulesForFirm(rulesDialogFirm) ?? {
          planName: firmLabel(rulesDialogFirm), profitDaysRequired: null, minProfitPerDayUsd: null,
          minPayoutUsd: null, maxPayoutUsd: null, payoutCycleDays: null, consistencyPct: null,
          withdrawablePctOfProfit: null, minBalanceToRequestUsd: null, splitPct: null, drawdownType: null,
        } satisfies FirmPayoutRules;
        return <FirmPayoutRulesDialog firm={firmLabel(rulesDialogFirm)} initialRules={initialRules} theme={theme} saving={rulesSaving} error={rulesError} onSave={saveRules} onClose={() => { if (!rulesSaving) { setRulesDialogFirm(null); setRulesError(null); } }} />;
      })()}

      {archivedDetail && (
        <MemorialModal
          account={archivedDetail}
          stats={computeStats(archivedDetail, trades)}
          trades={trades.filter(t => t.accountId === archivedDetail.id)}
          successorName={archivedDetail.successorOfAccountId ? accounts.find(account => account.id === archivedDetail.successorOfAccountId)?.name : undefined}
          isDark={theme !== 'light'}
          onClose={() => setArchivedDetail(null)}
          onOpenInDashboard={onOpenInDashboard ? (id) => { setArchivedDetail(null); onOpenInDashboard(id); } : undefined}
        />
      )}
    </div>
  );
};

export default AccountsManager;
