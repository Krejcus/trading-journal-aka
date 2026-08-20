
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import {
  getProfile as getCoachProfile,
  listMemories as listCoachMemories,
  forgetMemory as forgetCoachMemory,
  clearAllMemory as clearAllCoachMemory,
  isMemoryActive as isCoachMemoryActive,
  type MemoryEntry as CoachMemoryEntry,
  type CoachProfile,
} from '../services/coachMemoryService';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trash2, Plus, Brain, X, Target,
  Monitor, Zap, Globe, Clock, AlertOctagon, ShieldCheck,
  ShieldAlert, Activity, Check, ChevronLeft,
  ChevronRight, Sparkles, Sliders, Shield, Bell, AlertCircle, FileText, Lock, Link2,
  Smartphone, Share2, CalendarPlus
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import ImportSettings from './ImportSettings';
import ImportQueue from './ImportQueue';
import { CustomEmotion, SessionConfig, IronRule, WeeklyFocus, SystemSettings, Account, DailyReview } from '../types';
import { getPushDiagnostics } from '../utils/notificationHelper';
import { enablePush, disablePush, listPushDevices, sendTestPush, type PushDevice } from '../services/pushSubscriptionService';
import { sendNativeRemoteTestPush } from '../services/nativePushNotifications';
import {
  mergeTradecopiaNotificationPreferences,
  type TradecopiaNotificationPreferences,
} from '../services/tradecopiaNotificationPreferences';
import {
  formatTradecopiaNotification,
  type TradecopiaFastEvent,
} from '../services/tradecopiaNotificationFormatter';
import { isNativeBuild } from '../utils/runtimeConfig';
import {
  getNativeNotificationPermission,
  listPendingNativeNotifications,
  listDeliveredNativeNotifications,
  cancelNativeNotification,
  removeDeliveredNativeNotification,
  openDeliveredNativeNotification,
  cancelPendingNativeTestNotifications,
  requestNativeNotificationPermission,
  scheduleNativeNotification,
  scheduleNativeTestNotification,
  type NativePendingNotification,
  type NativeDeliveredNotification,
} from '../services/nativeNotifications';
import { createTradeNotificationAttachment } from '../services/nativeNotificationCard';
import type { PermissionState } from '@capacitor/core';
import {
  buildNativeSessionReminderPlan,
  NATIVE_SESSION_REMINDERS_SYNCED_EVENT,
  syncNativeSessionReminders,
  type NativeSessionReminderSyncResult,
} from '../services/nativeSessionReminders';
import {
  authenticateNativePrivacy,
  getNativePrivacyEnabled,
  getNativePermissionStatus,
  getNativeKeepAwakeState,
  lockNativePrivacy,
  playNativeHaptic,
  requestNativeSpeechPermissions,
  openNativeAppSettings,
  setNativePrivacyEnabled,
  setNativeKeepAwakeEnabled,
  startNativeDictation,
  stopNativeDictation,
  type NativeHapticStyle,
  type NativePermissionStatus,
  type NativeTradeDraft,
  nativePermissionLabel,
  clearNativeBadgeCount,
  getNativeBadgeCount,
  setNativeBadgeCount,
  getNativeLiveActivityState,
  startNativeLiveActivity,
  updateNativeLiveActivity,
  endNativeLiveActivity,
  type NativeLiveActivityState,
  presentNativeCalendarEvent,
} from '../services/nativeCapabilities';
import { shareTextNative } from '../services/nativeShare';

export type SettingsTab = 'psychology' | 'strategy' | 'market' | 'notifications' | 'system';

interface SettingsProps {
  theme: 'dark' | 'light' | 'oled';
  userEmotions: CustomEmotion[];
  setUserEmotions: React.Dispatch<React.SetStateAction<CustomEmotion[]>>;
  userMistakes: string[];
  setUserMistakes: React.Dispatch<React.SetStateAction<string[]>>;
  htfOptions: string[];
  setHtfOptions: React.Dispatch<React.SetStateAction<string[]>>;
  ltfOptions: string[];
  setLtfOptions: React.Dispatch<React.SetStateAction<string[]>>;
  sessions: SessionConfig[];
  setSessions: React.Dispatch<React.SetStateAction<SessionConfig[]>>;
  backtestSessions: SessionConfig[];
  setBacktestSessions: React.Dispatch<React.SetStateAction<SessionConfig[]>>;
  isBacktestWorld?: boolean;
  ironRules: IronRule[];
  setIronRules: React.Dispatch<React.SetStateAction<IronRule[]>>;
  weeklyFocusList: WeeklyFocus[];
  setWeeklyFocusList: React.Dispatch<React.SetStateAction<WeeklyFocus[]>>;
  systemSettings: SystemSettings;
  setSystemSettings: (settings: SystemSettings) => void;
  standardGoals: string[];
  setStandardGoals: (goals: string[]) => void;
  appVersion?: string;
  onHardRefresh?: () => void;
  accentColor?: string;
  onAccentColorChange?: (color: string) => void;
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  /** Vytvoří účet — auto-import ho volá při zakládání účtu z detekované challenge. */
  onCreateAccount?: (account: Account) => void;
  /** Promítne atomicky uložený importní incident také do živého stavu a offline cache. */
  onImportIncidentSaved?: (review: DailyReview) => void | Promise<void>;
  /** Otevře nový obchod s lokálně rozpoznanými hodnotami; nic automaticky neukládá. */
  onOpenTradeDraft?: (draft: NativeTradeDraft) => void;
}

// Global Helper for Weekly Focus Consistency
const getWeekISOString = (date: Date) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const COMMON_EMOJIS = ['🎯', '🔥', '💎', '🚀', '📈', '🧘', '🧠', '⚡', '🏆', '💰', '📉', '🛡️', '✅', '❌', '⏰', '📅', '📊', '💪', '🦁', '🦅'];

const LOCAL_ALERT_SAMPLES: Array<{ label: string; event: TradecopiaFastEvent }> = [
  {
    label: 'Objednávka zadána',
    event: {
      key: 'local-order-submitted', type: 'order_submitted', severity: 'info', occurredAt: '2026-08-10T09:30:00Z',
      symbol: 'MNQ', side: 'LONG', quantity: 1, orderType: 'Market', copiedAccountCount: 13, expectedAccountCount: 13,
      leaderName: 'Alpha Leader', accountNames: ['Alpha 50K', 'Alpha 100K', 'Lucid 50K', 'Tradeify 50K'],
    },
  },
  {
    label: 'Obchod otevřen',
    event: {
      key: 'local-trade-opened', type: 'trade_opened', severity: 'info', occurredAt: '2026-08-10T09:30:01Z',
      symbol: 'MNQ', side: 'LONG', quantity: 1, price: 21842.25, copiedAccountCount: 13, expectedAccountCount: 13,
      leaderName: 'Alpha Leader', accountNames: ['Alpha 50K', 'Alpha 100K', 'Lucid 50K', 'Tradeify 50K'],
    },
  },
  {
    label: 'Obchod uzavřen',
    event: {
      key: 'local-trade-closed', type: 'trade_closed', severity: 'info', occurredAt: '2026-08-10T09:42:00Z',
      symbol: 'MNQ', side: 'LONG', quantity: 1, price: 21858.75, pnl: 428.5, copiedAccountCount: 13, expectedAccountCount: 13,
      accountNames: ['Alpha 50K', 'Alpha 100K', 'Lucid 50K', 'Tradeify 50K'],
    },
  },
  {
    label: 'Neúplné kopírování',
    event: {
      key: 'local-copy-partial', type: 'copy_partial', severity: 'warning', occurredAt: '2026-08-10T09:30:02Z',
      symbol: 'MNQ', side: 'LONG', quantity: 1, copiedAccountCount: 11, expectedAccountCount: 13, failedAccountCount: 2,
      accountNames: ['Alpha 50K', 'Alpha 100K', 'Lucid 50K'],
    },
  },
  {
    label: 'Objednávka zamítnuta',
    event: {
      key: 'local-order-rejected', type: 'order_rejected', severity: 'critical', occurredAt: '2026-08-10T09:30:02Z',
      symbol: 'MNQ', side: 'SHORT', quantity: 1, copiedAccountCount: 11, expectedAccountCount: 13, failedAccountCount: 2,
      reasons: ['Účet překročil maximální velikost pozice', 'Spojení s brokerem vypršelo'],
    },
  },
  {
    label: 'Prop účet odpojen',
    event: {
      key: 'local-connection-changed', type: 'connection_changed', severity: 'critical', occurredAt: '2026-08-10T09:35:00Z',
      firm: 'Tradeify', connected: false, copiedAccountCount: 0, expectedAccountCount: 13, reason: 'Přihlášení vypršelo',
    },
  },
  {
    label: 'Nesoulad pozic',
    event: {
      key: 'local-position-mismatch', type: 'position_mismatch', severity: 'critical', occurredAt: '2026-08-10T09:36:00Z',
      symbol: 'MNQ', groupName: 'MNQ skupina', copiedAccountCount: 11, expectedAccountCount: 13, failedAccountCount: 2,
      accountNames: ['Alpha 50K', 'Alpha 100K'],
    },
  },
  {
    label: 'Drawdown upozornění',
    event: {
      key: 'local-risk-alert', type: 'risk_alert', severity: 'critical', occurredAt: '2026-08-10T09:40:00Z',
      cushion: 342, drawdownFloor: 50000, balance: 50342, accountNames: ['Alpha 50K'],
    },
  },
];

type NativeCopierAlertSample = {
  label: string;
  title: string;
  body: string;
  kind: 'trade' | 'risk';
};

const NATIVE_COPIER_ALERT_SAMPLES: NativeCopierAlertSample[] = [
  { label: 'ARM aktivní', title: 'Copier: ARM aktivní', body: 'Ostrý ARM je aktivní do konce broker session.', kind: 'risk' },
  { label: 'DISARM', title: 'Copier: ARM skončil', body: 'Kopírování stojí. Nový ARM je vždy ruční.', kind: 'risk' },
  { label: 'Scale-in', title: 'Copier: pozice navýšena', body: 'Long +2 MNQ → 5 followerů.', kind: 'trade' },
  { label: 'Scale-out', title: 'Copier: částečný výstup', body: 'Long -1 MNQ → 5 followerů.', kind: 'trade' },
  { label: 'Cooldown', title: 'Copier: COOLDOWN aktivní', body: 'Po potvrzeném zploštění je nový vstup dočasně blokovaný.', kind: 'risk' },
  { label: 'Day-lock', title: 'Copier: DAY-LOCK', body: 'Denní limit byl dosažen. ARM je blokovaný do konce broker session.', kind: 'risk' },
  { label: 'Účet zamčen', title: 'Účet zamčen: Alpha 50K', body: 'Broker hlásí account lock. Otevři LIVE pro detail.', kind: 'risk' },
  { label: 'Účet odemčen', title: 'Účet odemčen: Alpha 50K', body: 'Broker už účet nehlásí jako zamčený. ARM zůstává ruční.', kind: 'risk' },
  { label: 'Worker offline', title: 'Copier: WORKER OFFLINE', body: 'Mac worker se neozývá. Kopírování neběží; SL/TP u brokera zůstávají.', kind: 'risk' },
  { label: 'Worker online', title: 'Copier: worker zpět online', body: 'Mac worker se znovu ozývá. Před ARM proběhne reconciliation.', kind: 'risk' },
  { label: 'Stuck outbox', title: 'Copier: STUCK OUTBOX', body: 'Objednávka s nejasným výsledkem čeká na ruční kontrolu.', kind: 'risk' },
  { label: 'Divergence', title: 'Copier: ÚČTY NESOUHLASÍ', body: 'Dva účty mají rozdílnou pozici. ARM je zamčený.', kind: 'risk' },
  { label: 'Auto-flatten hotový', title: 'Copier: ARM vypršel — kopie zavřeny', body: 'Zrušeny 2 příkazy, zavřeno 5 pozic. Vše flat.', kind: 'risk' },
  { label: 'Auto-flatten selhal', title: 'Copier: AUTO-FLATTEN SELHAL', body: 'Účty nejsou potvrzené flat. Okamžitě zkontroluj Tradovate!', kind: 'risk' },
];

const NATIVE_ALERT_GALLERY_COUNT = LOCAL_ALERT_SAMPLES.length + NATIVE_COPIER_ALERT_SAMPLES.length;
const NATIVE_ALERT_GALLERY_FIRST_DELAY_MS = 4_000;
const NATIVE_ALERT_GALLERY_INTERVAL_MS = 5_000;

const EmojiPicker = ({ onSelect, onClose, isDark }: { onSelect: (e: string) => void, onClose: () => void, isDark: boolean }) => (
  <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={`p-6 rounded-[32px] border shadow-2xl max-w-[280px] ${isDark ? 'bg-slate-900 border-white/10' : 'bg-[var(--bg-card)] border-[var(--border-subtle)]'}`}
      onClick={e => e.stopPropagation()}
    >
      <div className="grid grid-cols-5 gap-3">
        {COMMON_EMOJIS.map(emoji => (
          <button
            key={emoji}
            onClick={() => { onSelect(emoji); onClose(); }}
            className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center transition-all ${isDark ? 'hover:bg-white/10 active:bg-white/20' : 'hover:bg-[var(--bg-page)] active:bg-[var(--border-subtle)]'}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </motion.div>
  </div>
);

// Visual Components defined OUTSIDE to prevent remounting on every parent render
const SectionHeader = ({ icon: Icon, title, subtitle, color, isDark }: any) => (
  <div className="flex items-center gap-4 mb-6">
    <div className={`p-3 rounded-2xl ${color} text-white shadow-lg`}>
      <Icon size={20} />
    </div>
    <div>
      <h3 className={`text-lg font-black tracking-tight uppercase ${isDark ? 'text-white' : 'text-[var(--text-primary)]'}`}>{title}</h3>
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">{subtitle}</p>
    </div>
  </div>
);

const InputField = ({ value, onChange, placeholder, onKeyDown, icon: Icon, type = "text", isDark }: any) => (
  <div className="relative group/input flex-1">
    {Icon && <Icon size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within/input:text-blue-500 transition-colors" />}
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={`w-full ${Icon ? 'pl-11' : 'px-4'} py-3.5 rounded-2xl text-xs font-bold outline-none border transition-all ${isDark ? 'bg-white/5 border-white/5 focus:bg-white/10 focus:border-blue-500/50 text-white' : 'bg-[var(--bg-input)] border-[var(--border-subtle)] focus:border-[var(--border-active)] text-[var(--text-primary)]'
        }`}
    />
  </div>
);

const Card = ({ children, className = "", isDark }: any) => (
  <div className={`p-6 rounded-[32px] border ${isDark ? 'bg-theme-card-60 border-white/5 shadow-2xl backdrop-blur-xl' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] shadow-sm backdrop-blur-md'} ${className}`}>
    {children}
  </div>
);

const Toggle = ({ active, onClick, label, desc, isDark }: any) => (
  <div className={`flex items-center justify-between p-4 rounded-2xl border transition-all group cursor-pointer ${isDark ? 'border-white/5 hover:bg-white/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-page)]'}`} onClick={onClick}>
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">{label}</span>
      {desc && <span className="text-[9px] text-[var(--text-muted)] font-bold">{desc}</span>}
    </div>
    <div className={`w-10 h-5 rounded-full transition-all relative ${active ? 'bg-[var(--text-secondary)] shadow-[0_0_12px_var(--border-active)]' : (isDark ? 'bg-slate-800' : 'bg-[var(--border-subtle)]')}`}>
      <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${active ? 'left-6' : 'left-1'}`} />
    </div>
  </div>
);

// Sjednocený akcentový systém — jeden zdroj pravdy pro barvy chipů, add-lišt a tlačítek.
// Tailwind potřebuje literální třídy, proto explicitní mapa (žádné dynamické stringy).
const ACCENT: Record<string, { dot: string; chipDark: string; chipLight: string; wrap: string; btn: string }> = {
  indigo:  { dot: '#6366f1', chipDark: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300 hover:bg-indigo-500 hover:text-white hover:border-transparent', chipLight: 'bg-indigo-50 border-indigo-100 text-indigo-600 hover:bg-indigo-600 hover:text-white', wrap: 'bg-indigo-500/5 border-indigo-500/10', btn: 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/30' },
  rose:    { dot: '#f43f5e', chipDark: 'bg-rose-500/10 border-rose-500/20 text-rose-300 hover:bg-rose-500 hover:text-white hover:border-transparent', chipLight: 'bg-rose-50 border-rose-100 text-rose-600 hover:bg-rose-600 hover:text-white', wrap: 'bg-rose-500/5 border-rose-500/10', btn: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30' },
  purple:  { dot: '#a855f7', chipDark: 'bg-purple-500/10 border-purple-500/20 text-purple-300 hover:bg-purple-500 hover:text-white hover:border-transparent', chipLight: 'bg-purple-50 border-purple-100 text-purple-600 hover:bg-purple-600 hover:text-white', wrap: 'bg-purple-500/5 border-purple-500/10', btn: 'bg-purple-600 hover:bg-purple-500 shadow-purple-600/30' },
  blue:    { dot: '#3b82f6', chipDark: 'bg-blue-500/10 border-blue-500/20 text-blue-300 hover:bg-blue-500 hover:text-white hover:border-transparent', chipLight: 'bg-blue-50 border-blue-100 text-blue-600 hover:bg-blue-600 hover:text-white', wrap: 'bg-blue-500/5 border-blue-500/10', btn: 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/30' },
  emerald: { dot: '#10b981', chipDark: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300 hover:bg-emerald-500 hover:text-white hover:border-transparent', chipLight: 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-600 hover:text-white', wrap: 'bg-emerald-500/5 border-emerald-500/10', btn: 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30' },
  orange:  { dot: '#f97316', chipDark: 'bg-orange-500/10 border-orange-500/20 text-orange-300 hover:bg-orange-500 hover:text-white hover:border-transparent', chipLight: 'bg-orange-50 border-orange-100 text-orange-600 hover:bg-orange-600 hover:text-white', wrap: 'bg-orange-500/5 border-orange-500/10', btn: 'bg-orange-600 hover:bg-orange-500 shadow-orange-600/30' },
  teal:    { dot: '#14b8a6', chipDark: 'bg-teal-500/10 border-teal-500/20 text-teal-300 hover:bg-teal-500 hover:text-white hover:border-transparent', chipLight: 'bg-teal-50 border-teal-100 text-teal-600 hover:bg-teal-600 hover:text-white', wrap: 'bg-teal-500/5 border-teal-500/10', btn: 'bg-teal-600 hover:bg-teal-500 shadow-teal-600/30' },
};

// Sjednocený chip pro krátké štítky (chyby, cíle, HTF, LTF…)
const Chip = ({ label, accent = 'blue', isDark, onRemove }: { label: string; accent?: string; isDark: boolean; onRemove: () => void }) => {
  const a = ACCENT[accent] || ACCENT.blue;
  return (
    <div className={`group flex items-center gap-2 pl-3.5 pr-2.5 py-1.5 rounded-full border text-[10px] font-black tracking-wide transition-all ${isDark ? a.chipDark : a.chipLight}`}>
      <span>{label}</span>
      <button onClick={onRemove} className="opacity-40 group-hover:opacity-100 transition-all"><X size={11} /></button>
    </div>
  );
};

// Sjednocená "add" lišta — stejný radius, padding i tlačítko napříč všemi sekcemi.
const AddBar = ({ value, onChange, onAdd, placeholder, accent = 'blue', isDark }: { value: string; onChange: (e: any) => void; onAdd: () => void; placeholder: string; accent?: string; isDark: boolean }) => {
  const a = ACCENT[accent] || ACCENT.blue;
  return (
    <div className={`flex gap-2 p-1.5 rounded-2xl border ${a.wrap}`}>
      <input
        value={value}
        onChange={onChange}
        onKeyDown={e => e.key === 'Enter' && onAdd()}
        placeholder={placeholder}
        className={`flex-1 bg-transparent px-4 py-2.5 text-[11px] font-bold outline-none ${isDark ? 'text-white placeholder:text-slate-500' : 'text-[var(--text-primary)] placeholder:text-slate-400'}`}
      />
      <button onClick={onAdd} className={`w-11 h-11 shrink-0 rounded-xl text-white flex items-center justify-center shadow-lg active:scale-90 transition-all ${a.btn}`}><Plus size={20} /></button>
    </div>
  );
};

const Settings: React.FC<SettingsProps> = ({
  theme, userEmotions, setUserEmotions,
  userMistakes, setUserMistakes,
  htfOptions, setHtfOptions, ltfOptions, setLtfOptions,
  sessions, setSessions,
  backtestSessions, setBacktestSessions, isBacktestWorld,
  ironRules, setIronRules,
  weeklyFocusList, setWeeklyFocusList,
  systemSettings, setSystemSettings,
  standardGoals, setStandardGoals,
  appVersion, onHardRefresh,
  accentColor = 'blue',
  onAccentColorChange,
  activeTab = 'psychology',
  onTabChange,
  onCreateAccount,
  onImportIncidentSaved,
  onOpenTradeDraft,
}) => {
  const isDark = theme !== 'light';

  // Local State for adding items
  const [newHtf, setNewHtf] = useState('');
  const [newLtf, setNewLtf] = useState('');
  // Editovat lze JEN sadu světa, ve kterém právě jsi (live vs backtest). Scope je proto
  // zamčený na aktuální svět — druhá sada je vidět jen jako zamčená (přepni svět pro editaci).
  const sessionScope: 'live' | 'backtest' = isBacktestWorld ? 'backtest' : 'live';
  const curSessions = sessionScope === 'backtest' ? backtestSessions : sessions;
  const setCurSessions = sessionScope === 'backtest' ? setBacktestSessions : setSessions;
  const otherScope: 'live' | 'backtest' = sessionScope === 'backtest' ? 'live' : 'backtest';
  const [newMistake, setNewMistake] = useState('');
  const [newEmoLabel, setNewEmoLabel] = useState('');
  const [newRuleLabel, setNewRuleLabel] = useState('');
  // 'experiment' je UI volba — ukládá se jako trading rule s prefixem ⏱ [duration]
  // (konzistentní s tím, jak experiment přidává AI Coach).
  const [newRuleType, setNewRuleType] = useState<'ritual' | 'trading' | 'experiment'>('ritual');
  const [newRuleDuration, setNewRuleDuration] = useState<'1w' | '2w' | '1m'>('2w');
  const [newStandardGoal, setNewStandardGoal] = useState('');
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{ goalIdx: number } | null>(null);

  const [itemToDelete, setItemToDelete] = useState<{ id: string | number, type: 'rule' | 'emotion' | 'mistake' | 'session' | 'goal' } | null>(null);
  const [toast, setToast] = useState<{ message: string, id: number } | null>(null);
  const [localAlertBusyKey, setLocalAlertBusyKey] = useState<string | null>(null);

  // Screenshot migration state


  const [coachProfile, setCoachProfile] = useState<CoachProfile>({ facts: {}, preferences: {} });
  const [coachMemories, setCoachMemories] = useState<CoachMemoryEntry[]>([]);
  const [memoryFilter, setMemoryFilter] = useState<'all' | 'observation' | 'episode' | 'conversation_summary' | 'commitment'>('all');
  const [memoryStatusFilter, setMemoryStatusFilter] = useState<'active' | 'history'>('active');
  const [confirmClearMemory, setConfirmClearMemory] = useState(false);

  const refreshCoachMemory = useCallback(async () => {
    const [profile, memories] = await Promise.all([getCoachProfile(), listCoachMemories(300, { includeInactive: true })]);
    setCoachProfile(profile);
    setCoachMemories(memories);
  }, []);

  useEffect(() => {
    if (activeTab === 'system') refreshCoachMemory();
  }, [activeTab, refreshCoachMemory]);

  const handleForgetMemory = useCallback(async (id: string) => {
    const ok = await forgetCoachMemory(id);
    if (ok) {
      setCoachMemories(prev => prev.filter(m => m.id !== id));
      showToast('Smazáno z paměti');
    }

  }, []);

  const handleClearAllMemory = useCallback(async () => {
    await clearAllCoachMemory();
    setCoachMemories([]);
    setConfirmClearMemory(false);
    showToast('Veškerá paměť Coache smazána');

  }, []);

  const filteredMemories = useMemo(() => {
    return coachMemories.filter(m => {
      const statusMatches = memoryStatusFilter === 'active' ? isCoachMemoryActive(m) : !isCoachMemoryActive(m);
      return statusMatches && (memoryFilter === 'all' || m.type === memoryFilter);
    });
  }, [coachMemories, memoryFilter, memoryStatusFilter]);

  // Push notification diagnostics
  const [pushDiag, setPushDiag] = useState<Awaited<ReturnType<typeof getPushDiagnostics>> | null>(null);
  const [pushDevices, setPushDevices] = useState<PushDevice[]>([]);
  const [pushBusy, setPushBusy] = useState(false);
  const [nativeNotificationPermission, setNativeNotificationPermission] = useState<PermissionState>('prompt');
  const [nativePendingNotifications, setNativePendingNotifications] = useState<NativePendingNotification[]>([]);
  const [nativeDeliveredNotifications, setNativeDeliveredNotifications] = useState<NativeDeliveredNotification[]>([]);
  const [nativeBadgeCount, setNativeBadgeCountState] = useState(0);
  const [nativePrivacyEnabled, setNativePrivacyEnabledState] = useState(false);
  const [nativeCapabilityBusy, setNativeCapabilityBusy] = useState(false);
  const [nativeDictating, setNativeDictating] = useState(false);
  const [nativeDictationText, setNativeDictationText] = useState('');
  const [nativePermissionStatus, setNativePermissionStatus] = useState<NativePermissionStatus | null>(null);
  const [nativeKeepAwakeEnabled, setNativeKeepAwakeEnabledState] = useState(false);
  const [nativeKeepAwakeEffective, setNativeKeepAwakeEffective] = useState(false);
  const [nativeReminderSync, setNativeReminderSync] = useState<NativeSessionReminderSyncResult | null>(null);
  const [nativeLiveActivityState, setNativeLiveActivityState] = useState<NativeLiveActivityState | null>(null);

  const refreshNativePermissionStatus = useCallback(async () => {
    if (!isNativeBuild) return;
    const status = await getNativePermissionStatus().catch(() => null);
    setNativePermissionStatus(status);
  }, []);

  const refreshNativeKeepAwakeState = useCallback(async () => {
    if (!isNativeBuild) return;
    const state = await getNativeKeepAwakeState().catch(() => null);
    if (!state) return;
    setNativeKeepAwakeEnabledState(state.enabled);
    setNativeKeepAwakeEffective(state.effective);
  }, []);

  const refreshNativeLiveActivityState = useCallback(async () => {
    if (!isNativeBuild) return;
    const state = await getNativeLiveActivityState().catch(() => null);
    setNativeLiveActivityState(state);
  }, []);

  const refreshPushState = useCallback(async () => {
    if (isNativeBuild) {
      const [permission, pendingNotifications, deliveredNotifications, badgeCount] = await Promise.all([
        getNativeNotificationPermission().catch(() => 'prompt' as PermissionState),
        listPendingNativeNotifications().catch(() => [] as NativePendingNotification[]),
        listDeliveredNativeNotifications().catch(() => [] as NativeDeliveredNotification[]),
        getNativeBadgeCount().catch(() => 0),
      ]);
      setNativeNotificationPermission(permission);
      setNativePendingNotifications(pendingNotifications);
      const reminderCount = pendingNotifications.filter(notification => notification.source === 'sessionReminder').length;
      const requestedReminderCount = buildNativeSessionReminderPlan(sessions, systemSettings, Number.MAX_SAFE_INTEGER).requestedCount;
      setNativeReminderSync(reminderCount > 0
        ? { status: 'scheduled', scheduledCount: reminderCount, omittedCount: Math.max(0, requestedReminderCount - reminderCount) }
        : null);
      setNativeDeliveredNotifications(deliveredNotifications);
      setNativeBadgeCountState(badgeCount);
      setPushDiag(null);
      setPushDevices([]);
      return;
    }
    const [diag, devices] = await Promise.all([
      getPushDiagnostics().catch(() => null),
      listPushDevices().catch(() => []),
    ]);
    setPushDiag(diag);
    setPushDevices(devices);
  }, [sessions, systemSettings]);

  useEffect(() => {
    if (activeTab === 'notifications') void refreshPushState();
  }, [activeTab, refreshPushState]);

  useEffect(() => {
    if (isNativeBuild && activeTab === 'system') {
      void getNativePrivacyEnabled().then(setNativePrivacyEnabledState).catch(() => undefined);
      void refreshNativeKeepAwakeState();
      void refreshNativePermissionStatus();
      void refreshNativeLiveActivityState();
    }
  }, [activeTab, refreshNativeKeepAwakeState, refreshNativeLiveActivityState, refreshNativePermissionStatus]);

  useEffect(() => {
    if (!isNativeBuild) return;
    const refreshAfterSettings = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshNativePermissionStatus();
      if (activeTab === 'system') {
        void refreshNativeKeepAwakeState();
        void refreshNativeLiveActivityState();
      }
      if (activeTab === 'notifications') void refreshPushState();
    };
    document.addEventListener('visibilitychange', refreshAfterSettings);
    window.addEventListener('focus', refreshAfterSettings);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterSettings);
      window.removeEventListener('focus', refreshAfterSettings);
    };
  }, [activeTab, refreshNativeKeepAwakeState, refreshNativeLiveActivityState, refreshNativePermissionStatus, refreshPushState]);

  useEffect(() => {
    if (!isNativeBuild) return;
    const handleReminderSync = (event: Event) => {
      setNativeReminderSync((event as CustomEvent<NativeSessionReminderSyncResult>).detail);
      if (activeTab === 'notifications') void refreshPushState();
    };
    window.addEventListener(NATIVE_SESSION_REMINDERS_SYNCED_EVENT, handleReminderSync);
    return () => window.removeEventListener(NATIVE_SESSION_REMINDERS_SYNCED_EVENT, handleReminderSync);
  }, [activeTab, refreshPushState]);

  const PUSH_ERRORS: Record<string, string> = {
    unsupported: 'Tento prohlížeč notifikace nepodporuje.',
    'ios-needs-standalone': 'Na iPhonu nejdřív přidej appku na plochu (Sdílet → Přidat na plochu) a otevři ji odtud.',
    denied: 'Notifikace jsou zablokované. Povol je v nastavení prohlížeče a zkus to znovu.',
    'subscribe-failed': 'Registrace odběru selhala. Zkus obnovit stránku.',
    'save-failed': 'Odběr se nepodařilo uložit na server.',
  };

  const handleEnablePush = async () => {
    setPushBusy(true);
    try {
      if (isNativeBuild) {
        const permission = await requestNativeNotificationPermission();
        setNativeNotificationPermission(permission);
        if (permission === 'granted') {
          setNativeReminderSync(await syncNativeSessionReminders(sessions, systemSettings));
        }
        await refreshNativePermissionStatus();
        showToast(permission === 'granted'
          ? 'Nativní iOS notifikace jsou zapnuté'
          : 'Notifikace nejsou v Nastavení iOS povolené');
        return;
      }
      const result = await enablePush();
      showToast(result.ok
        ? 'Notifikace zapnuty na tomto zařízení'
        : (PUSH_ERRORS[result.reason || ''] || 'Notifikace se nepodařilo zapnout'));
      await refreshPushState();
    } finally {
      setPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    setPushBusy(true);
    try {
      await disablePush();
      showToast('Notifikace vypnuty na tomto zařízení');
      await refreshPushState();
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    setPushBusy(true);
    try {
      if (isNativeBuild) {
        const result = await sendNativeRemoteTestPush();
        await refreshPushState();
        showToast(result.ok
          ? `APNs odesláno na ${result.sent} z ${result.devices} zařízení — appku můžeš úplně zavřít`
          : (result.message || 'Serverový APNs test se nepodařilo odeslat'));
        return;
      }
      const result = await sendTestPush();
      showToast(result.ok
        ? `Odesláno na ${result.sent} z ${result.devices} zařízení — zavři appku a čekej`
        : (result.message || 'Zkušební notifikaci se nepodařilo odeslat'));
      await refreshPushState();
    } finally {
      setPushBusy(false);
    }
  };

  const handleNativeBadge = async (count: number) => {
    setPushBusy(true);
    try {
      const permission = await requestNativeNotificationPermission();
      if (permission !== 'granted') {
        showToast('Badge vyžaduje povolené notifikace v Nastavení iOS');
        return;
      }
      const nextCount = count === 0
        ? (await clearNativeBadgeCount(), 0)
        : await setNativeBadgeCount(count);
      setNativeBadgeCountState(nextCount);
      showToast(nextCount === 0 ? 'Badge ikony vymazán' : `Badge ikony nastaven na ${nextCount}`);
    } catch (error) {
      showToast(`Badge selhal: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    } finally {
      setPushBusy(false);
    }
  };

  const handleNativeAlertGallery = async () => {
    setPushBusy(true);
    try {
      const permission = await requestNativeNotificationPermission();
      if (permission !== 'granted') {
        showToast('Notifikace nejsou v Nastavení iOS povolené');
        return;
      }

      for (const [index, sample] of LOCAL_ALERT_SAMPLES.entries()) {
        const event = { ...sample.event, occurredAt: new Date().toISOString() };
        const formatted = formatTradecopiaNotification(event, tradecopiaNotifications);
        const isTradeEvent = event.type === 'trade_opened' || event.type === 'trade_closed';
        const attachmentUrl = isTradeEvent
          ? await createTradeNotificationAttachment(event)
          : undefined;
        await scheduleNativeNotification({
          title: formatted.title,
          body: formatted.body,
          route: event.type === 'trade_closed' ? 'journal' : 'live',
          threadIdentifier: `alphatrade-${event.type}`,
          attachmentUrl,
          actionType: event.severity === 'critical' ? 'risk' : (isTradeEvent ? 'trade' : 'general'),
          interruptionLevel: event.severity === 'critical' ? 'timeSensitive' : 'active',
          delayMs: NATIVE_ALERT_GALLERY_FIRST_DELAY_MS + index * NATIVE_ALERT_GALLERY_INTERVAL_MS,
        });
      }
      const copierStartDelay = NATIVE_ALERT_GALLERY_FIRST_DELAY_MS
        + LOCAL_ALERT_SAMPLES.length * NATIVE_ALERT_GALLERY_INTERVAL_MS;
      for (const [index, sample] of NATIVE_COPIER_ALERT_SAMPLES.entries()) {
        await scheduleNativeNotification({
          title: sample.title,
          body: sample.body,
          route: 'live',
          threadIdentifier: sample.kind === 'trade' ? 'alphatrade-copier-trades' : 'alphatrade-copier-risk',
          actionType: sample.kind,
          interruptionLevel: sample.kind === 'risk' ? 'timeSensitive' : 'active',
          delayMs: copierStartDelay + index * NATIVE_ALERT_GALLERY_INTERVAL_MS,
        });
      }
      await refreshPushState();
      showToast(`Naplánováno ${NATIVE_ALERT_GALLERY_COUNT} iOS scénářů během dvou minut`);
    } catch (error) {
      showToast(`Galerie selhala: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    } finally {
      setPushBusy(false);
    }
  };

  const handleCancelNativeAlerts = async () => {
    setPushBusy(true);
    try {
      const cancelledCount = await cancelPendingNativeTestNotifications();
      await refreshPushState();
      showToast(cancelledCount > 0
        ? `Zrušeno ${cancelledCount} čekajících testů; session plán zůstal aktivní`
        : 'Doručené testy byly vyčištěny; session plán zůstal aktivní');
    } finally {
      setPushBusy(false);
    }
  };

  const handleCancelNativeAlert = async (id: number) => {
    setPushBusy(true);
    try {
      await cancelNativeNotification(id);
      await refreshPushState();
      showToast('Naplánovaná notifikace byla zrušena');
    } finally {
      setPushBusy(false);
    }
  };

  const handleRemoveDeliveredNativeAlert = async (id: number) => {
    setPushBusy(true);
    try {
      await removeDeliveredNativeNotification(id);
      await refreshPushState();
      showToast('Doručená notifikace byla odstraněna z centra iOS');
    } finally {
      setPushBusy(false);
    }
  };

  const handleOpenDeliveredNativeAlert = (notification: NativeDeliveredNotification) => {
    openDeliveredNativeNotification(notification);
  };

  const handleNativePrivacyToggle = async () => {
    setNativeCapabilityBusy(true);
    try {
      if (!nativePrivacyEnabled) {
        const authenticated = await authenticateNativePrivacy();
        if (!authenticated) {
          showToast('Ověření vlastníka nebylo dokončeno');
          return;
        }
      }
      const enabled = await setNativePrivacyEnabled(!nativePrivacyEnabled);
      setNativePrivacyEnabledState(enabled);
      // Enabling already required a successful owner check above. Only notify
      // the global gate when disabling so it can dismiss any active overlay;
      // dispatching after enable would immediately ask for Face ID a second time.
      if (!enabled) window.dispatchEvent(new Event('alphatrade:privacy-changed'));
      showToast(enabled ? 'Privacy Mode je aktivní' : 'Privacy Mode je vypnutý');
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const handleNativePrivacyLock = async () => {
    await lockNativePrivacy();
    window.dispatchEvent(new Event('alphatrade:privacy-changed'));
  };

  const handleHapticTest = async (style: NativeHapticStyle) => {
    await playNativeHaptic(style);
    showToast(`Haptika: ${style}`);
  };

  const openNativeDictationDraft = () => {
    if (!nativeDictationText || !onOpenTradeDraft) return;
    onOpenTradeDraft({ notes: `Nativní diktování:\n${nativeDictationText}` });
  };

  const handleNativeDictation = async () => {
    if (nativeDictating) {
      await stopNativeDictation().catch(() => undefined);
      setNativeDictating(false);
      return;
    }

    setNativeCapabilityBusy(true);
    try {
      const permission = await requestNativeSpeechPermissions();
      await refreshNativePermissionStatus();
      if (!permission.speech || !permission.microphone) {
        showToast('Povol mikrofon a rozpoznávání řeči v Nastavení iOS');
        return;
      }
      setNativeDictationText('');
      setNativeDictating(true);
      setNativeCapabilityBusy(false);
      const text = await startNativeDictation();
      setNativeDictationText(text);
      await playNativeHaptic(text ? 'success' : 'warning');
      showToast(text ? 'Diktování dokončeno' : 'Nebyla rozpoznána žádná řeč');
    } catch (error) {
      await playNativeHaptic('error').catch(() => undefined);
      showToast(`Diktování selhalo: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    } finally {
      setNativeDictating(false);
      setNativeCapabilityBusy(false);
    }
  };

  const handleOpenNativeSettings = async () => {
    setNativeCapabilityBusy(true);
    try {
      const opened = await openNativeAppSettings();
      if (!opened) showToast('Nastavení iOS se nepodařilo otevřít');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Nastavení iOS se nepodařilo otevřít');
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const handleNativeKeepAwakeToggle = async () => {
    setNativeCapabilityBusy(true);
    try {
      const enabled = await setNativeKeepAwakeEnabled(!nativeKeepAwakeEnabled);
      setNativeKeepAwakeEnabledState(enabled);
      await refreshNativeKeepAwakeState();
      await playNativeHaptic(enabled ? 'success' : 'selection').catch(() => undefined);
      showToast(enabled ? 'Displej zůstane při LIVE režimu vzhůru' : 'Automatické uspání displeje je obnoveno');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Nastavení displeje se nepodařilo změnit');
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const handleNativeLiveActivity = async (action: 'start' | 'profit' | 'risk' | 'end') => {
    setNativeCapabilityBusy(true);
    try {
      let state: NativeLiveActivityState;
      if (action === 'end') {
        state = await endNativeLiveActivity();
      } else if (action === 'risk') {
        state = await updateNativeLiveActivity({
          symbol: 'MNQ',
          status: 'RISK ALERT · TEST',
          headline: 'Blížíš se dennímu limitu',
          detail: 'Simulace varování · bez broker akce',
          pnlText: '-$185.00',
          isPositive: false,
          progress: 0.88,
          alert: true,
        });
      } else {
        const payload = {
          symbol: 'MNQ' as const,
          status: 'NEW YORK · LIVE TEST',
          headline: action === 'profit' ? 'Profit chráněn · plán splněn' : 'Seance pod kontrolou',
          detail: action === 'profit' ? 'Risk 24 % · 2 / 3 obchody' : 'Risk 38 % · 3 / 3 obchody',
          pnlText: action === 'profit' ? '+$612.75' : '+$428.50',
          isPositive: true,
          progress: action === 'profit' ? 0.82 : 0.62,
          alert: action === 'profit',
        };
        state = action === 'start'
          ? await startNativeLiveActivity(payload)
          : await updateNativeLiveActivity(payload);
      }
      setNativeLiveActivityState(state);
      await playNativeHaptic(action === 'end' ? 'selection' : action === 'risk' ? 'warning' : 'success').catch(() => undefined);
      showToast(action === 'end' ? 'Live Activity ukončena' : action === 'start' ? 'Live Activity spuštěna — zamkni iPhone' : 'Live Activity aktualizována');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Live Activity se nepodařilo změnit');
      await refreshNativeLiveActivityState();
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const handleNativeShareTest = async () => {
    setNativeCapabilityBusy(true);
    try {
      const result = await shareTextNative({
        text: 'AlphaTrade iOS · test nativního sdílení',
        url: 'https://alphatrade-mentor-15.vercel.app',
      });
      showToast(result.completed ? 'Sdílení dokončeno' : 'Sdílení zrušeno');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Sdílení se nepodařilo otevřít');
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const handleNativeCalendarEvent = async () => {
    setNativeCapabilityBusy(true);
    try {
      const start = new Date();
      start.setHours(start.getHours() + 1, 0, 0, 0);
      const result = await presentNativeCalendarEvent({
        title: 'AlphaTrade · LIVE seance',
        startTimestampMs: start.getTime(),
        durationMinutes: 90,
        location: 'AlphaTrade',
        notes: 'Příprava, exekuce podle plánu a závěrečný audit. Událost byla předvyplněna aplikací AlphaTrade; uložení potvrzuje uživatel v Apple Kalendáři.',
      });
      await playNativeHaptic(result.action === 'saved' ? 'success' : 'selection').catch(() => undefined);
      showToast(result.action === 'saved' ? 'Seance uložena do Kalendáře' : 'Kalendář zavřen bez uložení');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kalendář se nepodařilo otevřít');
    } finally {
      setNativeCapabilityBusy(false);
    }
  };

  const showToast = (message: string) => {
    setToast({ message, id: Date.now() });
    setTimeout(() => {
      setToast(prev => prev?.message === message ? null : prev);
    }, 2000);
  };

  // Weekly Focus Logic with standardized helper
  const [selectedWeek, setSelectedWeek] = useState(() => getWeekISOString(new Date()));

  const handleWeekChange = (dir: number) => {
    setSelectedWeek(current => {
      const [year, week] = current.split('-W').map(Number);
      const d = new Date(Date.UTC(year, 0, 1));
      const dayNum = d.getUTCDay() || 7;
      // Go to Monday of that week
      d.setUTCDate(d.getUTCDate() + (week - 1) * 7 - dayNum + 1);
      // Apply offset
      d.setUTCDate(d.getUTCDate() + (dir * 7));
      return getWeekISOString(d);
    });
  };

  const getWeekRange = (weekISO: string) => {
    const [year, week] = weekISO.split('-W').map(Number);
    const d = new Date(Date.UTC(year, 0, 1));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + (week - 1) * 7 - dayNum + 1);
    const mon = new Date(d);
    const sun = new Date(d);
    sun.setUTCDate(sun.getUTCDate() + 6);
    return `${mon.getUTCDate()}.${mon.getUTCMonth() + 1}. - ${sun.getUTCDate()}.${sun.getUTCMonth() + 1}.`;
  };

  // Re-compute current focus ensuring strict filtering by weekISO
  const currentWeeklyFocus = useMemo(() => {
    return weeklyFocusList.find(wf => wf.weekISO === selectedWeek) || { id: '', weekISO: selectedWeek, goals: [] };
  }, [weeklyFocusList, selectedWeek]);

  // Handlers
  const addMistake = () => { if (newMistake && !userMistakes.includes(newMistake)) { setUserMistakes([...userMistakes, newMistake]); setNewMistake(''); showToast('Chyba přidána'); } };
  const addEmo = () => { if (newEmoLabel) { setUserEmotions([...userEmotions, { id: Date.now().toString(), label: newEmoLabel, icon: '' }]); setNewEmoLabel(''); showToast('Emoce přidána'); } };
  const addIronRule = () => {
    if (!newRuleLabel) return;
    // Experiment = trading rule s prefixem ⏱ [duration] (parsuje se zpět v render logice).
    const isExp = newRuleType === 'experiment';
    const label = isExp ? `⏱ [${newRuleDuration}] ${newRuleLabel}` : newRuleLabel;
    const type: 'ritual' | 'trading' = newRuleType === 'ritual' ? 'ritual' : 'trading';
    setIronRules([...ironRules, { id: `rule_${Date.now()}`, label, type }]);
    setNewRuleLabel('');
    showToast(isExp ? 'Experiment přidán' : 'Pravidlo přidáno');
  };
  const addHtf = () => { if (newHtf && !htfOptions.includes(newHtf)) { setHtfOptions([...htfOptions, newHtf]); setNewHtf(''); showToast('HTF přidána'); } };
  const addLtf = () => { if (newLtf && !ltfOptions.includes(newLtf)) { setLtfOptions([...ltfOptions, newLtf]); setNewLtf(''); showToast('LTF přidána'); } };
  const addStandardGoal = () => { if (newStandardGoal && !standardGoals.includes(newStandardGoal)) { setStandardGoals([...standardGoals, newStandardGoal]); setNewStandardGoal(''); showToast('Cíl přidán'); } };
  const addSession = () => { setCurSessions([...curSessions, { id: `session_${Date.now()}`, name: 'Nová Seance', startTime: '09:00', endTime: '17:00', color: '#6366f1' }]); showToast('Seance vytvořena'); };
  const updateSession = (id: string, up: Partial<SessionConfig>) => { setCurSessions(curSessions.map(s => s.id === id ? { ...s, ...up } : s)); showToast('Seance aktualizována'); };
  const copyLiveToBacktest = () => { setBacktestSessions(sessions.map(s => ({ ...s, id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }))); showToast('Zkopírováno z Live sessionů'); };

  const updateSystem = (key: keyof SystemSettings, val: any) => {
    setSystemSettings({ ...systemSettings, [key]: val });
    showToast('Nastavení aktualizováno');
  };

  const tradecopiaNotifications = useMemo(
    () => mergeTradecopiaNotificationPreferences(systemSettings.tradecopiaNotifications),
    [systemSettings.tradecopiaNotifications],
  );

  const isLocalAlertLab = isNativeBuild || (import.meta.env.DEV
    && typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname));

  const localAlertSamples = useMemo(
    () => LOCAL_ALERT_SAMPLES.map(sample => ({
      ...sample,
      formatted: formatTradecopiaNotification(sample.event, tradecopiaNotifications),
    })),
    [tradecopiaNotifications],
  );

  const handleLocalAlertTest = async (event: TradecopiaFastEvent) => {
    setLocalAlertBusyKey(event.key);
    try {
      if (isNativeBuild) {
        const formatted = formatTradecopiaNotification(event, tradecopiaNotifications);
        const isTradeEvent = event.type === 'trade_opened' || event.type === 'trade_closed';
        const attachmentUrl = isTradeEvent
          ? await createTradeNotificationAttachment(event)
          : undefined;
        await scheduleNativeNotification({
          title: formatted.title,
          body: formatted.body,
          route: event.type === 'trade_closed' ? 'journal' : 'live',
          threadIdentifier: 'alphatrade-tradecopia',
          attachmentUrl,
          actionType: event.severity === 'critical' ? 'risk' : (isTradeEvent ? 'trade' : 'general'),
          interruptionLevel: event.severity === 'critical' ? 'timeSensitive' : 'active',
        });
        showToast(`${attachmentUrl ? 'Rich' : 'Nativní'} alert naplánován — zavři appku a počkej 2 sekundy`);
        return;
      }
      const response = await fetch('/__dev/tradecopia-alert-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            ...event,
            key: `${event.key}:${Date.now()}:${crypto.randomUUID()}`,
            occurredAt: new Date().toISOString(),
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        showToast(result.error ? `Push selhal: ${result.error}` : `Push selhal: HTTP ${response.status}`);
      } else if (Number(result.sent || 0) > 0) {
        showToast(`Skutečný push odeslán na ${result.sent} z ${result.devices} zařízení`);
      } else if (Number(result.skipped || 0) > 0) {
        showToast('Tento typ alertu je vypnutý nebo právě běží tichý režim');
      } else {
        showToast('Žádné aktivní zařízení push nepřijalo');
      }
    } catch (error) {
      showToast(`Push selhal: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    } finally {
      setLocalAlertBusyKey(null);
    }
  };

  const updateTradecopiaNotification = <K extends keyof TradecopiaNotificationPreferences>(
    key: K,
    value: TradecopiaNotificationPreferences[K],
  ) => {
    setSystemSettings({
      ...systemSettings,
      tradecopiaNotifications: { ...tradecopiaNotifications, [key]: value },
    });
    showToast('Nastavení notifikací aktualizováno');
  };

  const tabs = [
    { id: 'psychology', label: 'Psychologie', icon: Brain, desc: 'Pravidla, Cíle & Focus' },
    { id: 'strategy', label: 'Strategie', icon: Target, desc: 'Confluence, Chyby & Emoce' },
    { id: 'market', label: 'Trh', icon: Clock, desc: 'Seance & Čas' },
    { id: 'notifications', label: 'Notifikace', icon: Bell, desc: 'TradeCopia & Push' },
    { id: 'system', label: 'Systém', icon: Shield, desc: 'Alpha Guardian' },
  ] as const;

  return (
    <div className="max-w-7xl mx-auto pb-20 space-y-6">

      {/* Kompaktní přepínač — do lg breakpointu, kde by se pět tabů nevešlo do headeru. */}
      {onTabChange && (
        <div className="flex lg:hidden w-full p-1 rounded-2xl border gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
          {([
            { id: 'psychology', label: 'Psycho' },
            { id: 'strategy', label: 'Strategie' },
            { id: 'market', label: 'Trh' },
            { id: 'notifications', label: 'Notifikace' },
            { id: 'system', label: 'Systém' }
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`relative flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
                activeTab === tab.id
                  ? (isDark ? 'bg-slate-700/60 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm border border-slate-200/60')
                  : (isDark ? 'text-slate-500' : 'text-slate-400')
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <main className="min-w-0">
        <div className="space-y-6">
          {activeTab === 'psychology' && (
            <div className="space-y-6">
              <Card isDark={isDark}>
                <SectionHeader icon={ShieldCheck} title="Železná Pravidla" subtitle="Tvůj denní kodex disciplíny" color="bg-blue-600" isDark={isDark} />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 mb-6">
                  {ironRules.map(rule => {
                    // Parse label — detekce typu (checklist 📋 / experiment ⏱ / standard rule)
                    const label = rule.label || '';
                    const isChecklist = label.startsWith('📋 ');
                    const expMatch = label.match(/^⏱\s*\[([^\]]+)\]\s*(.+)$/);
                    const isExperiment = !!expMatch;

                    let title = label;
                    let items: string[] = [];
                    let duration = '';
                    if (isChecklist) {
                      const lines = label.split('\n');
                      title = lines[0].replace(/^📋\s+/, '').trim();
                      items = lines.slice(1)
                        .map(l => l.replace(/^\s*▢\s*/, '').trim())
                        .filter(Boolean);
                    } else if (isExperiment && expMatch) {
                      duration = expMatch[1];
                      title = expMatch[2].trim();
                    }

                    // Visual styling per typ — checklist = purple, experiment = amber, ritual = indigo, default = blue
                    const accentBg = isChecklist
                      ? 'bg-purple-600 shadow-purple-600/20'
                      : isExperiment
                        ? 'bg-amber-500 shadow-amber-500/20'
                        : rule.type === 'ritual'
                          ? 'bg-indigo-600 shadow-indigo-600/20'
                          : 'bg-blue-600 shadow-blue-600/20';
                    const accentChip = isChecklist
                      ? 'bg-purple-500/20 text-purple-500'
                      : isExperiment
                        ? 'bg-amber-500/20 text-amber-600'
                        : rule.type === 'ritual'
                          ? 'bg-indigo-500/20 text-indigo-400'
                          : 'bg-blue-500/20 text-blue-400';
                    const typeLabel = isChecklist
                      ? 'Checklist'
                      : isExperiment
                        ? 'Experiment'
                        : (rule.type === 'ritual' ? 'Ritual' : 'Hard Rule');
                    const Icon = isChecklist ? FileText : isExperiment ? Zap : (rule.type === 'ritual' ? Zap : ShieldAlert);

                    return (
                    <div key={rule.id} className={`relative p-3.5 rounded-2xl border group transition-all ${isDark ? 'bg-white/5 border-white/5 hover:border-blue-500/30' : 'bg-slate-50 border-slate-100 hover:shadow-lg'}`}>
                      <div className="flex items-start gap-3">
                        <div className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center shadow-md text-white ${accentBg}`}>
                          <Icon size={16} />
                        </div>
                        <div className="flex-1 min-w-0 pr-6">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-[11px] font-black tracking-tight leading-tight">{title}</p>
                            <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md ${accentChip}`}>
                              {typeLabel}
                            </span>
                            {isExperiment && (
                              <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-600 flex items-center gap-1">
                                ⏱ {duration}
                              </span>
                            )}
                          </div>
                          {isChecklist && items.length > 0 && (
                            <ul className="space-y-0.5 mt-1.5 pl-0.5">
                              {items.map((item, i) => (
                                <li key={i} className="text-[10px] flex items-start gap-1.5 leading-snug">
                                  <span className="text-purple-500/60 shrink-0 font-mono mt-px">▢</span>
                                  <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{item}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      <button onClick={() => setItemToDelete({ id: rule.id, type: 'rule' })} className="absolute top-2.5 right-2.5 p-1.5 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={13} /></button>
                    </div>);
                  })}
                </div>
                <div className="flex flex-col sm:flex-row gap-2 p-1.5 rounded-2xl bg-blue-500/5 border border-blue-500/10">
                  <InputField value={newRuleLabel} onChange={(e: any) => setNewRuleLabel(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addIronRule()} placeholder="Nadefinuj nové pravidlo..." isDark={isDark} />
                  <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as any)} className={`px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}>
                    <option value="ritual">Rituál</option>
                    <option value="trading">Pravidlo</option>
                    <option value="experiment">Experiment</option>
                  </select>
                  {newRuleType === 'experiment' && (
                    <select value={newRuleDuration} onChange={e => setNewRuleDuration(e.target.value as any)} className={`px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest outline-none border transition-all ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                      <option value="1w">1 týden</option>
                      <option value="2w">2 týdny</option>
                      <option value="1m">1 měsíc</option>
                    </select>
                  )}
                  <button onClick={addIronRule} className="px-8 py-3 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-blue-600/30 hover:bg-blue-500 active:scale-95 transition-all">{newRuleType === 'experiment' ? 'Přidat Experiment' : newRuleType === 'ritual' ? 'Přidat Rituál' : 'Přidat Pravidlo'}</button>
                </div>
              </Card>

              <Card isDark={isDark}>
                <SectionHeader icon={Target} title="Výchozí Cíle Dne" subtitle="Automaticky předvyplněno v deníku" color="bg-orange-600" isDark={isDark} />
                <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                  {standardGoals.map(goal => (
                    <Chip key={goal} label={goal} accent="orange" isDark={isDark} onRemove={() => { setStandardGoals(standardGoals.filter(x => x !== goal)); showToast('Odstraněno'); }} />
                  ))}
                </div>
                <AddBar value={newStandardGoal} onChange={(e: any) => setNewStandardGoal(e.target.value)} onAdd={addStandardGoal} placeholder="Nový výchozí cíl..." accent="orange" isDark={isDark} />
              </Card>

              <Card isDark={isDark}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                  <SectionHeader icon={Target} title="Weekly Focus" subtitle="Tvůj hlavní směr pro tento týden" color="bg-emerald-600" isDark={isDark} />
                  <div className={`flex items-center gap-2 p-1.5 rounded-[22px] border ${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200 shadow-inner'}`}>
                    <button onClick={() => handleWeekChange(-1)} className="p-2 rounded-xl hover:bg-white/5 transition-all text-slate-400"><ChevronLeft size={18} /></button>
                    <div className="px-4 text-center">
                      <p className={`text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${isDark ? 'text-emerald-500' : 'text-emerald-600'}`}>{selectedWeek}</p>
                      <p className="text-[7px] font-black text-slate-500 leading-none">{getWeekRange(selectedWeek)}</p>
                    </div>
                    <button onClick={() => handleWeekChange(1)} className="p-2 rounded-xl hover:bg-white/5 transition-all text-slate-400"><ChevronRight size={18} /></button>
                  </div>
                </div>

                <div className="space-y-3 mb-8 min-h-[100px] flex flex-col items-center justify-center">
                  <AnimatePresence mode="popLayout">
                    {currentWeeklyFocus.goals.length === 0 ? (
                      <motion.div key={`empty-${selectedWeek}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-12 flex flex-col items-center text-slate-500 gap-2">
                        <Sparkles size={24} className="opacity-20" />
                        <p className="text-[9px] font-black uppercase tracking-[0.2em]">Žádné cíle pro tento týden</p>
                      </motion.div>
                    ) : (
                      currentWeeklyFocus.goals.map((goal, idx) => (
                        <motion.div
                          key={`${selectedWeek}-${goal.id}`}
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className={`w-full flex items-center gap-4 p-4 rounded-2xl border transition-all ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'}`}
                        >
                          <button
                            onClick={() => setEmojiPickerTarget({ goalIdx: idx })}
                            className="w-10 h-10 rounded-xl bg-emerald-500/10 text-xl flex items-center justify-center hover:scale-105 active:scale-95 transition-all text-center"
                          >
                            {goal.emoji || '🎯'}
                          </button>
                          <input
                            value={goal.text}
                            onChange={(e) => {
                              const newList = [...weeklyFocusList];
                              const exIdx = newList.findIndex(wf => wf.weekISO === selectedWeek);
                              const val = e.target.value;

                              if (exIdx !== -1) {
                                const newGoals = [...newList[exIdx].goals];
                                newGoals[idx] = { ...newGoals[idx], text: val };
                                newList[exIdx] = { ...newList[exIdx], goals: newGoals };
                                setWeeklyFocusList(newList);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && currentWeeklyFocus.goals.length < 5) {
                                const nl = [...weeklyFocusList];
                                const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                                const newGoal = { id: crypto.randomUUID(), text: '', emoji: '🎯' };
                                if (i !== -1) nl[i] = { ...nl[i], goals: [...nl[i].goals, newGoal] };
                                else nl.push({ id: crypto.randomUUID(), weekISO: selectedWeek, goals: [newGoal] });
                                setWeeklyFocusList(nl);
                                showToast('Cíl přidán');
                              }
                            }}
                            className="flex-1 bg-transparent border-0 outline-none text-xs font-bold"
                            placeholder="Zadej týdenní focus..."
                          />
                          <button onClick={() => {
                            const nl = [...weeklyFocusList];
                            const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                            if (i !== -1) {
                              nl[i] = { ...nl[i], goals: nl[i].goals.filter((_, gx) => gx !== idx) };
                              setWeeklyFocusList(nl);
                              showToast('Odstraněno');
                            }
                          }} className="p-2 text-slate-600 hover:text-rose-500 transition-colors"><Trash2 size={14} /></button>
                        </motion.div>
                      ))
                    )}
                  </AnimatePresence>

                  {currentWeeklyFocus.goals.length < 5 && (
                    <button onClick={() => {
                      const nl = [...weeklyFocusList];
                      const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                      const newGoal = { id: crypto.randomUUID(), text: '', emoji: '🎯' };
                      if (i !== -1) nl[i] = { ...nl[i], goals: [...nl[i].goals, newGoal] };
                      else nl.push({ id: crypto.randomUUID(), weekISO: selectedWeek, goals: [newGoal] });
                      setWeeklyFocusList(nl);
                      showToast('Cíl přidán');
                    }} className={`w-full py-5 mt-4 rounded-[22px] border border-dashed text-[10px] font-black uppercase tracking-[0.2em] transition-all ${isDark ? 'border-white/10 text-slate-500 hover:border-emerald-500/50 hover:text-emerald-500 hover:bg-emerald-500/5' : 'border-slate-300 text-slate-400 hover:border-emerald-500/50 hover:bg-emerald-50 hover:text-emerald-600'}`}>
                      + Další Týdenní Cíl
                    </button>
                  )}
                </div>
              </Card>
            </div>
          )}

          {activeTab === 'strategy' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={Activity} title="HTF Confluence" subtitle="Vyšší časové rámce" color="bg-teal-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {htfOptions.map(opt => (
                      <Chip key={opt} label={opt} accent="teal" isDark={isDark} onRemove={() => { setHtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }} />
                    ))}
                  </div>
                  <AddBar value={newHtf} onChange={(e: any) => setNewHtf(e.target.value)} onAdd={addHtf} placeholder="Nová HTF..." accent="teal" isDark={isDark} />
                </Card>
                <Card isDark={isDark}>
                  <SectionHeader icon={Monitor} title="LTF Confluence" subtitle="Potvrzení vstupu" color="bg-blue-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {ltfOptions.map(opt => (
                      <Chip key={opt} label={opt} accent="blue" isDark={isDark} onRemove={() => { setLtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }} />
                    ))}
                  </div>
                  <AddBar value={newLtf} onChange={(e: any) => setNewLtf(e.target.value)} onAdd={addLtf} placeholder="Nová LTF..." accent="blue" isDark={isDark} />
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={AlertOctagon} title="Katalog Chyb" subtitle="Identifikace slabých stránek" color="bg-rose-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {userMistakes.map(m => (
                      <Chip key={m} label={m} accent="rose" isDark={isDark} onRemove={() => { setUserMistakes(prev => prev.filter(x => x !== m)); showToast('Odstraněno'); }} />
                    ))}
                  </div>
                  <AddBar value={newMistake} onChange={(e: any) => setNewMistake(e.target.value)} onAdd={addMistake} placeholder="Přidat chybu (např. Overtrading)" accent="rose" isDark={isDark} />
                </Card>
                <Card isDark={isDark}>
                  <SectionHeader icon={Brain} title="Emoční Mapa" subtitle="Vliv emocí na rozhodování" color="bg-purple-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {userEmotions.map(emo => (
                      <Chip key={emo.id} label={emo.label} accent="purple" isDark={isDark} onRemove={() => { setUserEmotions(prev => prev.filter(e => e.id !== emo.id)); showToast('Odstraněno'); }} />
                    ))}
                  </div>
                  <AddBar value={newEmoLabel} onChange={(e: any) => setNewEmoLabel(e.target.value)} onAdd={addEmo} placeholder="Nová emoce..." accent="purple" isDark={isDark} />
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'market' && (
            <div className="space-y-6">
              <Card isDark={isDark}>
                <div className="flex items-center justify-between mb-8">
                  <SectionHeader icon={Globe} title="Obchodní Seance" subtitle="Harmonogram tvého dne" color="bg-indigo-600" isDark={isDark} />
                  <button onClick={addSession} className="px-6 py-3 bg-indigo-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl shadow-indigo-600/30 hover:bg-indigo-500 active:scale-95 transition-all flex items-center gap-2"><Plus size={16} /> Přidat seanci</button>
                </div>

                {/* Editovat lze JEN sadu světa, ve kterém právě jsi. Aktuální svět = editovatelný,
                    druhý = zamčený (přepni svět pro jeho úpravu). */}
                <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className={`inline-flex p-1 rounded-2xl ${isDark ? 'bg-black/40' : 'bg-slate-100'}`}>
                    {(['live', 'backtest'] as const).map(scope => {
                      const isCurrent = scope === sessionScope;
                      return (
                        <div
                          key={scope}
                          title={isCurrent ? undefined : `Pro editaci se přepni do ${scope === 'backtest' ? 'backtest' : 'live'} světa`}
                          className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isCurrent ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30' : 'text-slate-500 opacity-50 cursor-not-allowed'}`}
                        >
                          {!isCurrent && <Lock size={11} />}
                          {scope === 'live' ? 'Live sessiony' : 'Backtest sessiony'}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-slate-500 font-semibold">
                    Edituješ sadu pro <span className="text-indigo-400">{sessionScope === 'backtest' ? 'BACKTEST' : 'LIVE'}</span>. Pro úpravu {otherScope === 'backtest' ? 'backtest' : 'live'} sady se přepni do {otherScope === 'backtest' ? 'backtest' : 'live'} světa.
                    {sessionScope === 'backtest' && backtestSessions.length === 0 && ' (Sada je prázdná → backtest teď jede na Live.)'}
                  </p>
                  {sessionScope === 'backtest' && (
                    <button onClick={copyLiveToBacktest} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 text-slate-300 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Zkopírovat z Live</button>
                  )}
                </div>

                <div className={`mb-10 p-8 rounded-[40px] border ${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-100'} overflow-hidden relative group`}>
                  <div className="flex justify-between text-[8px] font-black text-slate-500 uppercase mb-5 px-3">
                    {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h}>{h}h</span>)}
                    <span>24h</span>
                  </div>
                  <div className={`h-4 w-full rounded-full relative shadow-inner flex items-center ${isDark ? 'bg-black/50' : 'bg-slate-200'}`}>
                    <div className={`absolute inset-x-0 h-[1px] top-1/2 ${isDark ? 'bg-white/5' : 'bg-white/60'}`} />
                    {curSessions.map(s => {
                      const [sh, sm] = (s.startTime || '09:00').split(':').map(Number);
                      const [eh, em] = (s.endTime || '17:00').split(':').map(Number);
                      const start = ((sh * 60 + sm) / 1440) * 100;
                      const end = ((eh * 60 + em) / 1440) * 100;
                      const width = end >= start ? end - start : (100 - start) + end;
                      return (
                        <div key={s.id} className="absolute h-full opacity-80 rounded-full transition-all duration-500 hover:opacity-100 group-hover:h-[120%]" style={{ left: `${start}%`, width: `${width}%`, backgroundColor: s.color || '#3b82f6', boxShadow: `0 0 15px ${s.color}40` }} />
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {curSessions.map(s => (
                    <div key={s.id} className={`p-4 rounded-3xl border relative group transition-all duration-300 hover:scale-[1.02] ${isDark ? 'bg-white/5 border-white/5 hover:border-indigo-500/40' : 'bg-white border-slate-100 hover:shadow-xl'}`}>
                      <div className="space-y-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="relative group shrink-0">
                            <input type="color" value={s.color || '#3b82f6'} onChange={e => updateSession(s.id, { color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                            <div className="w-7 h-7 rounded-lg border-2 border-white/10 shadow-lg" style={{ backgroundColor: s.color || '#3b82f6' }} />
                          </div>
                          <input value={s.name} onChange={e => updateSession(s.id, { name: e.target.value })} className={`flex-1 bg-transparent text-sm font-black tracking-tight outline-none border-b border-transparent focus:border-indigo-500 py-0.5 transition-all ${isDark ? 'text-white' : 'text-slate-900'}`} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest">Start Time</label>
                            <input type="time" value={s.startTime} onChange={e => updateSession(s.id, { startTime: e.target.value })} className={`w-full px-3 py-2 rounded-xl text-xs font-bold ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-200'}`} />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest">End Time</label>
                            <input type="time" value={s.endTime} onChange={e => updateSession(s.id, { endTime: e.target.value })} className={`w-full px-3 py-2 rounded-xl text-xs font-bold ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-200'}`} />
                          </div>
                        </div>
                      </div>
                      <button onClick={() => { setCurSessions(prev => prev.filter(x => x.id !== s.id)); showToast('Odstraněno'); }} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-rose-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-lg active:scale-90"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-6">
              <Card isDark={isDark}>
                <SectionHeader icon={Bell} title="TradeCopia notifikace" subtitle="Jeden obchod · všechny kopírované účty" color="bg-gradient-to-br from-emerald-600 to-cyan-600" isDark={isDark} />

                <div className={`mb-5 p-4 rounded-xl border ${isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'}`}>
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-emerald-500 mb-2">Ukázka výsledné zprávy</p>
                  <p className="text-sm font-black text-[var(--text-primary)]">💰 LONG MNQ uzavřen na 13 účtech</p>
                  <p className="mt-1 text-[11px] font-bold text-[var(--text-muted)]">Výsledek skupiny: +$428.50 · ✅ 13/13 účtů uzavřeno</p>
                  <p className="mt-1 text-[10px] font-bold text-[var(--text-muted)]">Alpha 50K, Alpha 100K, Lucid 50K +10</p>
                </div>

                <div className="space-y-2">
                  <Toggle
                    active={tradecopiaNotifications.enabled}
                    onClick={() => updateTradecopiaNotification('enabled', !tradecopiaNotifications.enabled)}
                    label="TradeCopia notifikace"
                    desc="Hlavní vypínač pro rychlé události z copieru."
                    isDark={isDark}
                  />
                  <div className={`grid grid-cols-1 md:grid-cols-2 gap-2 ${tradecopiaNotifications.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
                    <Toggle active={tradecopiaNotifications.orderSubmitted} onClick={() => updateTradecopiaNotification('orderSubmitted', !tradecopiaNotifications.orderSubmitted)} label="📤 Objednávka zadána" desc="Kolik z očekávaných účtů ji přijalo." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.tradeOpened} onClick={() => updateTradecopiaNotification('tradeOpened', !tradecopiaNotifications.tradeOpened)} label="🟢 Obchod otevřen" desc="Jedna souhrnná zpráva místo X zpráv." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.tradeClosed} onClick={() => updateTradecopiaNotification('tradeClosed', !tradecopiaNotifications.tradeClosed)} label="💰 Obchod uzavřen" desc="Souhrn účtů a dostupné P&L skupiny." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.copyPartial} onClick={() => updateTradecopiaNotification('copyPartial', !tradecopiaNotifications.copyPartial)} label="⚠️ Neúplné kopírování" desc="Například 11 z 13 účtů." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.orderRejected} onClick={() => updateTradecopiaNotification('orderRejected', !tradecopiaNotifications.orderRejected)} label="🚫 Zamítnutá objednávka" desc="Chyba účtu nebo prop firmy." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.connectionChanged} onClick={() => updateTradecopiaNotification('connectionChanged', !tradecopiaNotifications.connectionChanged)} label="🔌 Připojení prop firmy" desc="Odpojení i opětovné připojení." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.positionMismatch} onClick={() => updateTradecopiaNotification('positionMismatch', !tradecopiaNotifications.positionMismatch)} label="🚨 Nesoulad pozic" desc="Follower nemá očekávanou pozici leaderu." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.riskAlerts} onClick={() => updateTradecopiaNotification('riskAlerts', !tradecopiaNotifications.riskAlerts)} label="🛑 Drawdown a risk" desc="Blížící se nebo dosažený limit." isDark={isDark} />
                  </div>
                </div>

                <div className="mt-6 pt-5 border-t border-[var(--border-subtle)] space-y-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">Obsah zprávy</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Toggle active={tradecopiaNotifications.includeAccountNames} onClick={() => updateTradecopiaNotification('includeAccountNames', !tradecopiaNotifications.includeAccountNames)} label="Názvy účtů" desc="Ukáže první tři a počet dalších." isDark={isDark} />
                    <Toggle active={tradecopiaNotifications.includePnl} onClick={() => updateTradecopiaNotification('includePnl', !tradecopiaNotifications.includePnl)} label="P&L ve zprávě" desc="Jen když je v okamžiku události dostupné." isDark={isDark} />
                  </div>
                </div>

                <div className="mt-6 pt-5 border-t border-[var(--border-subtle)] space-y-3">
                  <Toggle active={tradecopiaNotifications.quietHoursEnabled} onClick={() => updateTradecopiaNotification('quietHoursEnabled', !tradecopiaNotifications.quietHoursEnabled)} label="Tichý režim" desc="Běžné zprávy v tomto čase nechodí." isDark={isDark} />
                  {tradecopiaNotifications.quietHoursEnabled && (
                    <div className="grid grid-cols-2 gap-3 px-4">
                      <label className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">Od
                        <input type="time" value={tradecopiaNotifications.quietHoursStart} onChange={event => updateTradecopiaNotification('quietHoursStart', event.target.value)} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] text-xs text-[var(--text-primary)]" />
                      </label>
                      <label className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">Do
                        <input type="time" value={tradecopiaNotifications.quietHoursEnd} onChange={event => updateTradecopiaNotification('quietHoursEnd', event.target.value)} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] text-xs text-[var(--text-primary)]" />
                      </label>
                    </div>
                  )}
                  <Toggle active={tradecopiaNotifications.criticalBypassQuietHours} onClick={() => updateTradecopiaNotification('criticalBypassQuietHours', !tradecopiaNotifications.criticalBypassQuietHours)} label="Kritické zprávy vždy" desc="Zamítnutí, odpojení, nesoulad a drawdown obejdou tichý režim." isDark={isDark} />
                </div>
              </Card>

              {isLocalAlertLab && (
                <Card isDark={isDark} className="!rounded-lg !p-0 overflow-hidden border-violet-500/30">
                  <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-5 py-4 border-b ${isDark ? 'bg-violet-500/5 border-white/10' : 'bg-violet-50 border-violet-100'}`}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-1 rounded-md bg-violet-600 text-white text-[8px] font-black uppercase tracking-[0.18em]">{isNativeBuild ? 'iOS Lab' : 'Pouze localhost'}</span>
                        <h3 className="text-sm font-black uppercase tracking-tight text-[var(--text-primary)]">Alert test lab</h3>
                      </div>
                      <p className="mt-1.5 text-[10px] font-bold text-[var(--text-muted)]">Dočasný panel · nic neposílá na server ani do Supabase.</p>
                    </div>
                    <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      {isNativeBuild ? 'Nativní iOS alert · toto zařízení' : 'Skutečný Web Push · všechna zařízení'}
                    </div>
                  </div>

                  {isNativeBuild && (
                    <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={pushBusy || localAlertBusyKey !== null}
                        onClick={() => void handleNativeAlertGallery()}
                        className="py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-[9px] font-black uppercase tracking-widest disabled:opacity-50"
                      >
                        {pushBusy ? 'Plánuji galerii…' : `Naplánovat všech ${NATIVE_ALERT_GALLERY_COUNT} scénářů`}
                      </button>
                      <button
                        type="button"
                        disabled={pushBusy || nativePendingNotifications.every(notification => notification.source === 'sessionReminder')}
                        onClick={() => void handleCancelNativeAlerts()}
                        className="py-3 rounded-xl border border-[var(--border-subtle)] text-[9px] font-black uppercase tracking-widest text-[var(--text-primary)] disabled:opacity-40"
                      >
                        Zrušit čekající testy ({nativePendingNotifications.filter(notification => notification.source !== 'sessionReminder').length})
                      </button>
                      </div>
                      {nativePendingNotifications.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <p className="text-[8px] font-black uppercase tracking-[0.18em] text-[var(--text-muted)]">Skutečně čeká v iOS</p>
                          {nativePendingNotifications.map(notification => (
                            <div key={notification.id} className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-page)] p-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate text-[10px] font-black text-[var(--text-primary)]">{notification.title}</p>
                                  <span className={`rounded px-1.5 py-0.5 text-[7px] font-black uppercase ${notification.kind === 'risk' ? 'bg-red-500/10 text-red-500' : notification.kind === 'trade' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>{notification.source === 'sessionReminder' ? 'plán' : notification.kind}</span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-[9px] font-semibold text-[var(--text-muted)]">{notification.body}</p>
                                <p className="mt-1 text-[8px] font-black uppercase tracking-wider text-[var(--text-muted)]">{notification.scheduledAt ? new Date(notification.scheduledAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Čas řídí iOS'}{notification.route ? ` · otevře ${notification.route}` : ''}</p>
                              </div>
                              {notification.source !== 'sessionReminder' && <button type="button" disabled={pushBusy} onClick={() => void handleCancelNativeAlert(notification.id)} aria-label={`Zrušit ${notification.title}`} className="shrink-0 rounded-lg border border-red-500/20 p-2 text-red-500 disabled:opacity-40"><X size={13} /></button>}
                            </div>
                          ))}
                        </div>
                      )}
                      {nativeDeliveredNotifications.length > 0 && (
                        <div className="mt-4 space-y-2 border-t border-[var(--border-subtle)] pt-4">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-[8px] font-black uppercase tracking-[0.18em] text-[var(--text-muted)]">Doručeno do centra iOS</p>
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[8px] font-black text-emerald-500">{nativeDeliveredNotifications.length}</span>
                          </div>
                          {nativeDeliveredNotifications.map(notification => (
                            <div key={notification.id} className="flex items-start gap-3 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] p-3">
                              <button type="button" onClick={() => handleOpenDeliveredNativeAlert(notification)} className="min-w-0 flex-1 text-left">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate text-[10px] font-black text-[var(--text-primary)]">{notification.title}</p>
                                  <span className={`rounded px-1.5 py-0.5 text-[7px] font-black uppercase ${notification.kind === 'risk' ? 'bg-red-500/10 text-red-500' : notification.kind === 'trade' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>{notification.kind}</span>
                                  {notification.hasAttachment && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[7px] font-black uppercase text-violet-500">screen</span>}
                                </div>
                                <p className="mt-1 line-clamp-2 text-[9px] font-semibold text-[var(--text-muted)]">{notification.body}</p>
                                <p className="mt-1 text-[8px] font-black uppercase tracking-wider text-[var(--text-muted)]">{notification.deliveredAt ? new Date(notification.deliveredAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Doručeno systémem'} · klepnutím otevřít {notification.route || 'dashboard'}</p>
                              </button>
                              <button type="button" disabled={pushBusy} onClick={() => void handleRemoveDeliveredNativeAlert(notification.id)} aria-label={`Odstranit doručenou notifikaci ${notification.title}`} className="shrink-0 rounded-lg border border-red-500/20 p-2 text-red-500 disabled:opacity-40"><Trash2 size={13} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left">
                      <thead>
                        <tr className="border-b border-[var(--border-subtle)] text-[8px] font-black uppercase tracking-[0.18em] text-[var(--text-muted)]">
                          <th className="px-5 py-3 w-[175px]">Typ alertu</th>
                          <th className="px-4 py-3">Přesný náhled zprávy</th>
                          <th className="px-4 py-3 w-[100px]">Priorita</th>
                          <th className="px-5 py-3 w-[125px] text-right">Test</th>
                        </tr>
                      </thead>
                      <tbody>
                        {localAlertSamples.map(({ label, event, formatted }) => {
                          const severityStyle = event.severity === 'critical'
                            ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                            : event.severity === 'warning'
                              ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                              : 'bg-blue-500/10 text-blue-500 border-blue-500/20';
                          return (
                            <tr key={event.key} className="border-b last:border-b-0 border-[var(--border-subtle)] hover:bg-[var(--bg-page)]/60 transition-colors">
                              <td className="px-5 py-4 align-top">
                                <p className="text-[11px] font-black text-[var(--text-primary)]">{label}</p>
                                <p className="mt-1 text-[8px] font-bold uppercase tracking-wider text-[var(--text-muted)]">{event.type.replaceAll('_', ' ')}</p>
                              </td>
                              <td className="px-4 py-4 align-top">
                                <p className="text-[11px] font-black text-[var(--text-primary)]">{formatted.title}</p>
                                <p className="mt-1 whitespace-pre-line text-[10px] font-semibold leading-relaxed text-[var(--text-muted)]">{formatted.body}</p>
                              </td>
                              <td className="px-4 py-4 align-top">
                                <span className={`inline-flex px-2 py-1 rounded-md border text-[8px] font-black uppercase tracking-wider ${severityStyle}`}>{event.severity}</span>
                              </td>
                              <td className="px-5 py-4 align-top text-right">
                                <button
                                  type="button"
                                  disabled={localAlertBusyKey !== null}
                                  onClick={() => void handleLocalAlertTest(event)}
                                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[9px] font-black uppercase tracking-wider transition-colors active:scale-95 disabled:opacity-50 disabled:cursor-wait"
                                >
                                  <Bell size={12} /> {localAlertBusyKey === event.key ? 'Plánuji…' : (isNativeBuild ? 'Test na iPhone' : 'Odeslat push')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              <Card isDark={isDark}>
                <SectionHeader icon={Smartphone} title="Doručení na zařízení" subtitle={isNativeBuild ? 'Nativní iOS notifikace' : 'Web Push i při zavřené aplikaci'} color="bg-gradient-to-br from-blue-600 to-indigo-600" isDark={isDark} />
                <p className={`text-xs mb-5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {isNativeBuild
                    ? 'Povol systémová upozornění. Testy se naplánují přímo v iPhonu a fungují i po zavření aplikace.'
                    : 'Zapni odběr na každém telefonu nebo počítači, kam mají upozornění chodit.'}
                </p>
                {!isNativeBuild && pushDiag?.isApple && !pushDiag?.isStandalone && (
                  <div className="mb-5 p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 text-[10px] font-bold text-amber-500">
                    Na iPhonu nejdřív v Safari použij Sdílet → Přidat na plochu a otevři AlphaTrade z nové ikony.
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={handleEnablePush} disabled={pushBusy || (isNativeBuild ? nativeNotificationPermission === 'granted' : !!pushDiag?.ready)} className="flex-1 py-3 rounded-xl bg-[var(--text-secondary)] text-[var(--bg-page)] text-[10px] font-black uppercase tracking-widest disabled:opacity-40">
                    {(isNativeBuild ? nativeNotificationPermission === 'granted' : pushDiag?.ready) ? 'Notifikace aktivní' : (pushBusy ? 'Zapínám…' : 'Zapnout notifikace')}
                  </button>
                  {!isNativeBuild && pushDiag?.hasActiveSubscription && <button onClick={handleDisablePush} disabled={pushBusy} className="px-4 py-3 rounded-xl border border-[var(--border-subtle)] text-[10px] font-black uppercase text-[var(--text-muted)]">Vypnout</button>}
                </div>
                {/* Test lze spustit i z počítače bez vlastního odběru; endpoint
                    ho pošle na všechna registrovaná zařízení uživatele. */}
                {(isNativeBuild || pushDevices.length > 0) && <button onClick={handleTestPush} disabled={pushBusy} className="mt-2 w-full py-3 rounded-xl border border-[var(--border-subtle)] text-[10px] font-black uppercase tracking-widest text-[var(--text-primary)]">{pushBusy ? 'Odesílám…' : (isNativeBuild ? 'Poslat APNs test ze serveru' : `Poslat zkušební notifikaci (${pushDevices.length})`)}</button>}
                {isNativeBuild && (
                  <div className="mt-4 rounded-xl border border-[var(--border-subtle)] p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-[var(--text-primary)]">Badge na ikoně</p>
                      <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[9px] font-black text-white">{nativeBadgeCount}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[1, 5].map(count => (
                        <button key={count} type="button" disabled={pushBusy} onClick={() => void handleNativeBadge(count)} className="rounded-lg bg-rose-600 py-2.5 text-[9px] font-black uppercase tracking-wider text-white disabled:opacity-40">Nastavit {count}</button>
                      ))}
                      <button type="button" disabled={pushBusy || nativeBadgeCount === 0} onClick={() => void handleNativeBadge(0)} className="rounded-lg border border-[var(--border-subtle)] py-2.5 text-[9px] font-black uppercase tracking-wider text-[var(--text-primary)] disabled:opacity-40">Vymazat</button>
                    </div>
                    <p className="mt-2 text-[9px] font-bold text-[var(--text-muted)]">Testovací notifikace nastaví 1; po jejím otevření se badge automaticky vymaže.</p>
                  </div>
                )}
                <p className="mt-4 text-[10px] font-bold text-[var(--text-muted)]">
                  {isNativeBuild
                    ? `Oprávnění iOS: ${nativeNotificationPermission === 'granted' ? 'povoleno' : nativeNotificationPermission}`
                    : `Aktivní zařízení: ${pushDevices.filter(device => !device.expiredAt).length} / ${pushDevices.length}`}
                </p>
                {isNativeBuild && nativeNotificationPermission === 'granted' && (
                  <div className={`mt-3 rounded-xl border px-3 py-2.5 text-[9px] font-bold ${nativeReminderSync?.omittedCount ? 'border-amber-500/25 bg-amber-500/5 text-amber-500' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500'}`}>
                    {nativeReminderSync?.omittedCount
                      ? `iOS plán: ${nativeReminderSync.scheduledCount} aktivních, ${nativeReminderSync.omittedCount} vynecháno kvůli systémovému limitu. Omez počet session alertů.`
                      : `iOS plán session a auditu je aktivní${nativeReminderSync ? ` · ${nativeReminderSync.scheduledCount} opakování Po–Pá` : ''}. Funguje i při vypnuté aplikaci.`}
                  </div>
                )}
              </Card>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="space-y-6">
              {isNativeBuild && (
                <Card isDark={isDark} className="border-blue-500/25">
                  <SectionHeader icon={Smartphone} title="Nativní iOS funkce" subtitle="Face ID · Live Activity · Kalendář · Diktování · Haptika · Sdílení" color="bg-gradient-to-br from-blue-600 to-cyan-600" isDark={isDark} />
                  <div className="space-y-5">
                    <div className="rounded-2xl border border-[var(--border-subtle)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Oprávnění tohoto iPhonu</p>
                          <p className="mt-1 text-[9px] font-bold text-[var(--text-muted)]">Skutečný systémový stav, ne pouze stav uložený ve webové části.</p>
                        </div>
                        <button type="button" onClick={() => void refreshNativePermissionStatus()} className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-[8px] font-black uppercase tracking-wider text-[var(--text-primary)]">Obnovit</button>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {([
                          ['notifications', 'Notifikace'],
                          ['microphone', 'Mikrofon'],
                          ['speech', 'Rozpoznávání řeči'],
                        ] as const).map(([key, label]) => {
                          const state = nativePermissionStatus?.[key] ?? 'unknown';
                          const allowed = state === 'authorized' || state === 'provisional' || state === 'ephemeral';
                          return (
                            <div key={key} className="rounded-xl bg-[var(--bg-page)] p-3">
                              <p className="text-[8px] font-black uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
                              <p className={`mt-1 text-[10px] font-black ${allowed ? 'text-emerald-500' : state === 'denied' || state === 'restricted' ? 'text-red-500' : 'text-amber-500'}`}>{nativePermissionLabel(state)}</p>
                            </div>
                          );
                        })}
                      </div>
                      <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleOpenNativeSettings()} className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-[9px] font-black uppercase tracking-widest text-white disabled:opacity-40">Otevřít Nastavení iOS</button>
                    </div>

                    <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] p-4">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Privacy Mode</p>
                        <p className="mt-1 text-[9px] font-bold text-[var(--text-muted)]">Při odchodu z appky skryje obsah a návrat chrání Face ID nebo kód zařízení.</p>
                      </div>
                      <button
                        type="button"
                        disabled={nativeCapabilityBusy}
                        onClick={() => void handleNativePrivacyToggle()}
                        className={`shrink-0 rounded-xl px-4 py-2.5 text-[9px] font-black uppercase tracking-wider text-white ${nativePrivacyEnabled ? 'bg-emerald-600' : 'bg-slate-600'}`}
                      >
                        {nativePrivacyEnabled ? 'Aktivní' : 'Zapnout'}
                      </button>
                    </div>
                    {nativePrivacyEnabled && (
                      <button type="button" onClick={() => void handleNativePrivacyLock()} className="w-full rounded-xl border border-[var(--border-subtle)] py-3 text-[9px] font-black uppercase tracking-widest text-[var(--text-primary)]">Uzamknout a vyzkoušet teď</button>
                    )}

                    <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] p-4">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">LIVE bez uspání displeje</p>
                        <p className="mt-1 text-[9px] font-bold text-[var(--text-muted)]">V LIVE světě nezhasne obrazovka. V Backtestu a na pozadí se zákaz uspání automaticky vypne.</p>
                        {nativeKeepAwakeEnabled && (
                          <p className={`mt-2 text-[9px] font-black uppercase tracking-wider ${nativeKeepAwakeEffective ? 'text-emerald-500' : 'text-amber-500'}`}>
                            {nativeKeepAwakeEffective ? 'iOS právě drží displej vzhůru' : 'Nyní neaktivní — Backtest nebo pozadí'}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={nativeCapabilityBusy}
                        onClick={() => void handleNativeKeepAwakeToggle()}
                        className={`shrink-0 rounded-xl px-4 py-2.5 text-[9px] font-black uppercase tracking-wider text-white ${nativeKeepAwakeEnabled ? 'bg-emerald-600' : 'bg-slate-600'}`}
                      >
                        {nativeKeepAwakeEnabled ? 'Aktivní' : 'Zapnout'}
                      </button>
                    </div>

                    <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/[0.035] p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-500"><Activity size={17} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Live Activity</p>
                            <span className={`rounded-full px-2 py-1 text-[8px] font-black uppercase ${nativeLiveActivityState?.activeCount ? 'bg-emerald-500/10 text-emerald-500' : nativeLiveActivityState?.enabled === false ? 'bg-red-500/10 text-red-500' : 'bg-slate-500/10 text-[var(--text-muted)]'}`}>
                              {nativeLiveActivityState?.activeCount ? 'Aktivní' : nativeLiveActivityState?.enabled === false ? 'Vypnuto v iOS' : 'Připraveno'}
                            </span>
                          </div>
                          <p className="mt-1 text-[9px] font-bold leading-4 text-[var(--text-muted)]">Test seance a P&amp;L na zamčené obrazovce; na podporovaných iPhonech také Dynamic Island. Data jsou označená TEST a nic neposílají brokerovi.</p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button type="button" disabled={nativeCapabilityBusy || !!nativeLiveActivityState?.activeCount || nativeLiveActivityState?.enabled === false} onClick={() => void handleNativeLiveActivity('start')} className="rounded-xl bg-cyan-600 px-3 py-3 text-[9px] font-black uppercase tracking-wider text-white disabled:opacity-35">Spustit test</button>
                        <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('profit')} className="rounded-xl bg-emerald-600 px-3 py-3 text-[9px] font-black uppercase tracking-wider text-white disabled:opacity-35">Update +P&amp;L</button>
                        <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('risk')} className="rounded-xl bg-orange-600 px-3 py-3 text-[9px] font-black uppercase tracking-wider text-white disabled:opacity-35">Risk alert</button>
                        <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('end')} className="rounded-xl border border-[var(--border-subtle)] px-3 py-3 text-[9px] font-black uppercase tracking-wider text-[var(--text-primary)] disabled:opacity-35">Ukončit</button>
                      </div>
                    </div>

                    <div>
                      <p className="mb-2 text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">Haptická odezva</p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {(['selection', 'success', 'warning', 'error'] as NativeHapticStyle[]).map(style => (
                          <button key={style} type="button" onClick={() => void handleHapticTest(style)} className="rounded-xl border border-[var(--border-subtle)] px-3 py-3 text-[9px] font-black uppercase tracking-wider text-[var(--text-primary)]">{style}</button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/[0.035] p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500"><CalendarPlus size={17} /></span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Apple Kalendář</p>
                          <p className="mt-1 text-[9px] font-bold leading-4 text-[var(--text-muted)]">Otevře systémový editor s LIVE seancí na příští celou hodinu. AlphaTrade nečte tvoje kalendáře a bez klepnutí na Přidat nic neuloží.</p>
                        </div>
                      </div>
                      <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleNativeCalendarEvent()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-[9px] font-black uppercase tracking-widest text-white disabled:opacity-40">
                        <CalendarPlus size={14} /> Naplánovat LIVE seanci
                      </button>
                    </div>

                    <div className="rounded-2xl border border-blue-500/25 bg-blue-500/[0.035] p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500"><Zap size={17} /></span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Ovládací centrum iOS</p>
                          <p className="mt-1 text-[9px] font-bold leading-4 text-[var(--text-muted)]">Přidej si ovladače AlphaTrade LIVE a Zapsat obchod přes upravení Ovládacího centra. Oba pouze otevřou správnou část appky; nikdy neposílají příkaz brokerovi ani samy neukládají obchod.</p>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={nativeCapabilityBusy}
                      onClick={() => void handleNativeShareTest()}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border-subtle)] py-3 text-[9px] font-black uppercase tracking-widest text-[var(--text-primary)] disabled:opacity-40"
                    >
                      <Share2 size={14} /> Otevřít iOS sdílení
                    </button>

                    <div className="rounded-2xl border border-[var(--border-subtle)] p-4">
                      <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Nativní diktování poznámky</p>
                      <p className="mt-1 text-[9px] font-bold text-[var(--text-muted)]">Apple Speech poslouchá maximálně 30 sekund. Test nic automaticky neukládá ani neposílá.</p>
                      <button
                        type="button"
                        disabled={nativeCapabilityBusy}
                        onClick={() => void handleNativeDictation()}
                        className={`mt-3 w-full rounded-xl px-4 py-3 text-[9px] font-black uppercase tracking-widest text-white ${nativeDictating ? 'bg-red-600' : 'bg-blue-600'}`}
                      >
                        {nativeDictating ? 'Zastavit diktování' : 'Začít diktovat'}
                      </button>
                      {nativeDictationText && (
                        <div className="mt-3 rounded-xl bg-[var(--bg-page)] p-3 text-[10px] font-semibold text-[var(--text-muted)]">
                          <p>{nativeDictationText}</p>
                          {onOpenTradeDraft && <button type="button" onClick={openNativeDictationDraft} className="mt-3 w-full rounded-lg bg-emerald-600 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-white">Použít jako poznámku obchodu</button>}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              )}
              {/* Accent Color Picker */}
              <Card isDark={isDark}>
                <SectionHeader icon={Sliders} title="Accent Color" subtitle="Personalizuj barvu rozhraní" color="bg-gradient-to-br from-purple-600 to-pink-600" isDark={isDark} />
                <p className={`text-xs mb-6 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Vyber akcentovou barvu, která se objeví na buttonech, aktivních prvcích a zvýrazněních v celé aplikaci.
                </p>
                <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
                  {[
                    { id: 'blue', color: '#3b82f6', label: 'Modrá' },
                    { id: 'purple', color: '#a855f7', label: 'Fialová' },
                    { id: 'pink', color: '#ec4899', label: 'Růžová' },
                    { id: 'green', color: '#10b981', label: 'Zelená' },
                    { id: 'orange', color: '#f97316', label: 'Oranžová' },
                    { id: 'red', color: '#ef4444', label: 'Červená' },
                    { id: 'cyan', color: '#06b6d4', label: 'Cyan' },
                  ].map(ac => (
                    <button
                      key={ac.id}
                      onClick={() => {
                        if (onAccentColorChange) {
                          onAccentColorChange(ac.id);
                          showToast(`${ac.label} aktivována`);
                        }
                      }}
                      className={`group relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-300 ${accentColor === ac.id
                        ? 'border-white/40 scale-105'
                        : isDark
                          ? 'border-white/5 hover:border-white/20'
                          : 'border-slate-200 hover:border-slate-300'
                        }`}
                      style={{
                        backgroundColor: accentColor === ac.id ? `${ac.color}20` : 'transparent'
                      }}
                    >
                      <div
                        className="w-12 h-12 rounded-xl shadow-lg transition-all duration-300 group-hover:scale-110"
                        style={{
                          backgroundColor: ac.color,
                          boxShadow: accentColor === ac.id ? `0 0 20px ${ac.color}80` : `0 4px 12px ${ac.color}40`
                        }}
                      />
                      <span className={`text-[9px] font-black uppercase tracking-widest transition-all ${accentColor === ac.id
                        ? isDark ? 'text-white' : 'text-slate-900'
                        : 'text-slate-500'
                        }`}>
                        {ac.label}
                      </span>
                      {accentColor === ac.id && (
                        <motion.div
                          layoutId="accent-indicator"
                          className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-white shadow-lg flex items-center justify-center"
                        >
                          <Check size={14} style={{ color: ac.color }} strokeWidth={3} />
                        </motion.div>
                      )}
                    </button>
                  ))}
                </div>
              </Card>

              {/* Tradecopia auto-import — párování účtů */}
              <Card isDark={isDark}>
                <SectionHeader icon={Activity} title="Auto-import obchodů" subtitle="Tradecopia → AlphaTrade" color="bg-gradient-to-br from-blue-600 to-cyan-600" isDark={isDark} />
                <p className={`text-xs mb-4 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Sync agent čte lokální data Tradecopie a posílá obchody ze všech prop účtů. Tady je přiřadíš k účtům v appce — nové účty (koupené challenge) se detekují automaticky.
                </p>
                <ImportSettings isDark={isDark} onToast={showToast} onCreateAccount={onCreateAccount} />
              </Card>

              {/* Fronta importu — párování exekucí na deník */}
              <Card isDark={isDark}>
                <SectionHeader icon={Link2} title="Fronta importu" subtitle="Párování exekucí na deník" color="bg-gradient-to-br from-emerald-600 to-teal-600" isDark={isDark} />
                <ImportQueue isDark={isDark} onToast={showToast} onIncidentSaved={onImportIncidentSaved} />
              </Card>

              <div className="grid grid-cols-1 gap-6">
                {/* Alpha Guardian */}
                <Card isDark={isDark}>
                  <SectionHeader icon={Shield} title="Alpha Guardian" subtitle="Hlídač disciplíny a procesu" color="bg-emerald-600" isDark={isDark} />
                  <div className="space-y-2">
                    <Toggle
                      active={systemSettings.guardianEnabled}
                      onClick={() => updateSystem('guardianEnabled', !systemSettings.guardianEnabled)}
                      label="Aktivovat Alpha Guardian"
                      desc="Integrovaný risk manager a mentor."
                      isDark={isDark}
                    />
                    <AnimatePresence>
                      {systemSettings.guardianEnabled && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-2 pl-4 border-l border-emerald-500/20 ml-2 py-2">
                          <p className="text-[8px] font-black uppercase text-[var(--text-muted)] tracking-widest mb-2 px-4">Upozornění na přípravu</p>
                          <Toggle active={systemSettings.morningPrepAlert60m} onClick={() => updateSystem('morningPrepAlert60m', !systemSettings.morningPrepAlert60m)} label="60 minut před startem" desc="Informační připomínka" isDark={isDark} />
                          <Toggle active={systemSettings.morningPrepAlert15m} onClick={() => updateSystem('morningPrepAlert15m', !systemSettings.morningPrepAlert15m)} label="15 minut před startem" desc="Důrazná připomínka" isDark={isDark} />
                          <Toggle active={systemSettings.morningPrepAlertCritical} onClick={() => updateSystem('morningPrepAlertCritical', !systemSettings.morningPrepAlertCritical)} label="Start seance (Kritické)" desc="Pruhy na dashboardu" isDark={isDark} />

                          <div className={`h-px my-4 ${isDark ? 'bg-white/5' : 'bg-[var(--border-subtle)]'}`} />
                          <Toggle active={systemSettings.strictModeEnabled} onClick={() => updateSystem('strictModeEnabled', !systemSettings.strictModeEnabled)} label="Strict Enforcement" desc="Blokovat zápis obchodu bez přípravy" isDark={isDark} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={Check} title="Večerní Audit" subtitle="Uzavření obchodního dne" color="bg-indigo-600" isDark={isDark} />
                  <div className="space-y-4">
                    <Toggle
                      active={systemSettings.eveningAuditAlertEnabled}
                      onClick={() => updateSystem('eveningAuditAlertEnabled', !systemSettings.eveningAuditAlertEnabled)}
                      label="Připomínka Auditu"
                      desc="Kdy chcete uzavřít deník?"
                      isDark={isDark}
                    />
                    {systemSettings.eveningAuditAlertEnabled && (
                      <div className="px-4">
                        <label className="text-[8px] font-black uppercase text-[var(--text-muted)] tracking-widest mb-1.5 block">Čas notifikace</label>
                        <input
                          type="time"
                          value={systemSettings.eveningAuditAlertTime}
                          onChange={(e) => updateSystem('eveningAuditAlertTime', e.target.value)}
                          className={`w-full max-w-[120px] px-4 py-2.5 rounded-2xl text-xs font-bold outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-[var(--text-primary)]'
                            }`}
                        />
                      </div>
                    )}
                  </div>
                </Card>

                {/* Resty z minulosti */}
                <Card isDark={isDark}>
                  <SectionHeader icon={AlertCircle} title="Backlog Guardian" subtitle="Vymahač dluhů z minulosti" color="bg-rose-600" isDark={isDark} />
                  <div className="space-y-2">
                    <Toggle
                      active={systemSettings.morningWakeUpDebtAlert}
                      onClick={() => updateSystem('morningWakeUpDebtAlert', !systemSettings.morningWakeUpDebtAlert)}
                      label="Morning Debt Collector"
                      desc="Ranní upozornění na neuzavřený audit z včerejška."
                      isDark={isDark}
                    />
                  </div>
                </Card>
              </div>

              {/* Coach Memory Management */}
              <Card isDark={isDark}>
                <SectionHeader icon={Brain} title="Paměť AI Coache" subtitle="Hluboká dlouhodobá paměť — fakta, pozorování, epizody" color="bg-gradient-to-br from-indigo-600 to-purple-600" isDark={isDark} />

                {/* Profile (facts + preferences) */}
                <div className="space-y-4 mb-6">
                  <div className={`p-4 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                    <h4 className={`text-[10px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>Fakta o tobě (Layer 1)</h4>
                    {Object.keys(coachProfile.facts).length > 0 ? (
                      <div className="space-y-1 text-xs">
                        {Object.entries(coachProfile.facts).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className={`font-bold min-w-[140px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{k}:</span>
                            <span className={isDark ? 'text-slate-300' : 'text-slate-800'}>{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Coach si zatím nezapamatoval žádná fakta. Bude přidávat během konverzací.</p>
                    )}
                  </div>

                  <div className={`p-4 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                    <h4 className={`text-[10px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>Preference komunikace (Layer 2)</h4>
                    {Object.keys(coachProfile.preferences).length > 0 ? (
                      <div className="space-y-1 text-xs">
                        {Object.entries(coachProfile.preferences).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className={`font-bold min-w-[140px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{k}:</span>
                            <span className={isDark ? 'text-slate-300' : 'text-slate-800'}>{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Žádné preference. Můžeš Coachovi v chatu říct: "Vždy ukazuj v R", "Buď stručnější", atd.</p>
                    )}
                  </div>
                </div>

                {/* Long-term memory list */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h4 className={`text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>
                      Dlouhodobá paměť ({coachMemories.filter(m => isCoachMemoryActive(m)).length} aktivních · {coachMemories.filter(m => !isCoachMemoryActive(m)).length} v historii)
                    </h4>
                    <div className="flex gap-1 text-[9px] flex-wrap justify-end">
                      {(['active', 'history'] as const).map(status => (
                        <button
                          key={status}
                          onClick={() => setMemoryStatusFilter(status)}
                          className={`px-2.5 py-1 rounded-lg font-black uppercase tracking-wider transition-all ${memoryStatusFilter === status
                            ? status === 'active' ? 'bg-emerald-600 text-white' : 'bg-slate-600 text-white'
                            : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {status === 'active' ? 'Aktivní' : 'Historie'}
                        </button>
                      ))}
                      {(['all', 'observation', 'episode', 'conversation_summary', 'commitment'] as const).map(t => (
                        <button
                          key={t}
                          onClick={() => setMemoryFilter(t)}
                          className={`px-2.5 py-1 rounded-lg font-black uppercase tracking-wider transition-all ${memoryFilter === t
                            ? 'bg-indigo-600 text-white'
                            : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {t === 'all' ? 'Vše' : t === 'observation' ? 'Pozorování' : t === 'episode' ? 'Epizody' : t === 'commitment' ? 'Závazky' : 'Shrnutí'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {filteredMemories.length === 0 ? (
                    <p className={`text-xs italic p-4 rounded-2xl ${isDark ? 'bg-white/5 text-slate-500' : 'bg-slate-50 text-slate-500'}`}>
                      Žádné záznamy v této kategorii. Coach si je sám vytvoří při konverzacích a po důležitých obchodech.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                      {filteredMemories.map(m => {
                        const typeLabel = m.type === 'observation' ? 'Pozorování' : m.type === 'episode' ? 'Epizoda' : m.type === 'commitment' ? 'Závazek' : 'Shrnutí';
                        const typeClass = m.type === 'episode'
                          ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                          : m.type === 'conversation_summary'
                            ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                            : m.type === 'commitment'
                              ? 'bg-purple-500/10 text-purple-500 border-purple-500/20'
                              : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
                        const validation = String(m.metadata?.validation_state || (m.type === 'commitment' ? 'user_stated' : 'hypothesis'));
                        const confidence = typeof m.metadata?.confidence === 'number' ? Math.round(m.metadata.confidence * 100) : null;
                        const evidenceCount = Array.isArray(m.metadata?.evidence) ? m.metadata.evidence.length : 0;
                        const counterCount = Array.isArray(m.metadata?.counter_evidence) ? m.metadata.counter_evidence.length : 0;
                        const status = String(m.metadata?.status || 'active');
                        return (
                          <div key={m.id} className={`p-3 rounded-xl border flex items-start gap-3 group ${isDark ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200'}`}>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${typeClass}`}>
                                  {typeLabel}
                                </span>
                                <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${validation === 'supported' || validation === 'user_stated'
                                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                                  : validation === 'contested'
                                    ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                                    : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                }`}>
                                  {validation === 'supported' ? 'podloženo' : validation === 'user_stated' ? 'řečeno uživatelem' : validation === 'contested' ? 'sporné' : 'hypotéza'}
                                </span>
                                {status !== 'active' && <span className="text-[9px] font-black uppercase text-slate-500">{status === 'superseded' ? 'nahrazeno' : 'staženo'}</span>}
                                {m.memory_date && (
                                  <span className={`text-[9px] font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{m.memory_date}</span>
                                )}
                                {m.importance >= 8 && (
                                  <span className="text-[9px] font-black text-amber-500">⚡ důležité</span>
                                )}
                              </div>
                              <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{m.content}</p>
                              <div className={`mt-2 text-[9px] font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {confidence != null ? `Confidence ${confidence}% · ` : ''}evidence {evidenceCount}{counterCount ? ` · counter-evidence ${counterCount}` : ''}
                                {m.metadata?.validation_note ? ` · ${String(m.metadata.validation_note)}` : ''}
                              </div>
                            </div>
                            <button
                              onClick={() => handleForgetMemory(m.id)}
                              className={`opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all ${isDark ? 'hover:bg-rose-500/20 text-slate-500 hover:text-rose-400' : 'hover:bg-rose-50 text-slate-400 hover:text-rose-600'}`}
                              title="Smazat tuto vzpomínku"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {coachMemories.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-700/30 flex flex-col gap-2">
                    {!confirmClearMemory ? (
                      <button
                        onClick={() => setConfirmClearMemory(true)}
                        className={`self-start text-[9px] font-black uppercase tracking-widest px-3 py-2 rounded-xl transition-all ${isDark ? 'text-rose-400 hover:bg-rose-500/10 border border-rose-500/20' : 'text-rose-600 hover:bg-rose-50 border border-rose-200'}`}
                      >
                        Vymazat veškerou paměť
                      </button>
                    ) : (
                      <div className={`flex items-center gap-2 p-3 rounded-xl border ${isDark ? 'bg-rose-500/10 border-rose-500/20' : 'bg-rose-50 border-rose-200'}`}>
                        <span className={`text-xs ${isDark ? 'text-rose-300' : 'text-rose-700'}`}>Smazat všech {coachMemories.length} záznamů? Tato akce je nevratná.</span>
                        <button onClick={handleClearAllMemory} className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[10px] font-black uppercase">Smazat</button>
                        <button onClick={() => setConfirmClearMemory(false)} className="px-3 py-1.5 rounded-lg bg-slate-600 text-white text-[10px] font-black uppercase">Zrušit</button>
                      </div>
                    )}
                  </div>
                )}
              </Card>

            </div>
          )}
        </div>
      </main>

      <ConfirmationModal
        isOpen={!!itemToDelete}
        onClose={() => setItemToDelete(null)}
        onConfirm={() => {
          if (!itemToDelete) return;
          if (itemToDelete.type === 'rule') setIronRules(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'emotion') setUserEmotions(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'mistake') setUserMistakes(prev => prev.filter(x => x !== itemToDelete.id));
          if (itemToDelete.type === 'session') {
            // Odeber z té sady, kde ID je (live i backtest se edituje stejným UI).
            setSessions(prev => prev.filter(x => x.id !== itemToDelete.id));
            setBacktestSessions(prev => prev.filter(x => x.id !== itemToDelete.id));
          }
          if (itemToDelete.type === 'goal') setStandardGoals(standardGoals.filter(x => x !== itemToDelete.id));
          showToast('Odstraněno');
        }}
        title={
            itemToDelete?.type === 'rule' ? 'Smazat pravidlo' :
              itemToDelete?.type === 'emotion' ? 'Smazat emoci' :
                itemToDelete?.type === 'session' ? 'Smazat seanci' : 'Smazat položku'
        }
        message="Opravdu chcete tuto položku trvale odstranit? Tato akce je nevratná."
        theme={theme}
      />

      {/* Emoji Picker Modal */}
      {
        emojiPickerTarget && (
          <EmojiPicker
            isDark={isDark}
            onClose={() => setEmojiPickerTarget(null)}
            onSelect={(emoji) => {
              const newList = [...weeklyFocusList];
              const exIdx = newList.findIndex(wf => wf.weekISO === selectedWeek);
              if (exIdx !== -1) {
                const newGoals = [...newList[exIdx].goals];
                newGoals[emojiPickerTarget.goalIdx] = { ...newGoals[emojiPickerTarget.goalIdx], emoji };
                newList[exIdx] = { ...newList[exIdx], goals: newGoals };
                setWeeklyFocusList(newList);
              }
            }}
          />
        )
      }

      {/* Persistence Notification Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[300] pointer-events-none"
          >
            <div className={`px-6 py-3 rounded-2xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${isDark ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : 'bg-emerald-600 border-emerald-500 text-white'}`}>
              <Check size={16} strokeWidth={3} className={isDark ? 'text-emerald-400' : 'text-white'} />
              <span className="text-[10px] font-black uppercase tracking-[0.2em]">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;
