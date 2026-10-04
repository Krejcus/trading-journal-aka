
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { storageService } from '../services/storageService';
import { supabase } from '../services/supabase';
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
  Trash2, Plus, X, Check, ChevronLeft, ChevronRight, Lock, Bell, Palette,
  ScrollText, Tags, UserRound, Search, Send, Wrench, Share2, CalendarPlus
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';


import { CustomEmotion, SessionConfig, IronRule, WeeklyFocus, SystemSettings, Account, DailyPrep, DailyReview } from '../types';
import { getPushDiagnostics } from '../utils/notificationHelper';
import { enablePush, disablePush, listPushDevices, sendTestPush, type PushDevice } from '../services/pushSubscriptionService';
import { initializeNativeRemoteNotifications, sendNativeRemoteTestPush, sendNativeSnapshotTestPush } from '../services/nativePushNotifications';


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
import TradingViewAlertSettings from './TradingViewAlertSettings';
import NativeShellTabsSettings from './NativeShellTabsSettings';
import { requestNativeLiveActivityRestart } from '../services/nativeLiveActivityPush';
import AppearanceSettings from './AppearanceSettings';
import type { AppearanceSettings as AppearanceValue } from '../lib/appearance';
import { ruleAdherenceRecent } from '../lib/ruleAdherence';
import { formatSessionDuration, sessionDurationMinutes, sessionOverlapMinutes, sessionSegments } from '../lib/sessionSchedule';
import {
  SettingsChips, SettingsRow, SettingsSearchContext, SettingsSection, SettingsSegment, SettingsSwitch, StatusPill,
  btn, btnDanger, btnGhost, btnPrimary, field, normalizeSearch, revealOnHover, td, th, timeField,
} from './SettingsUi';

export type SettingsTab = 'trading' | 'tags' | 'alerts' | 'appearance' | 'app';

interface SettingsProps {
  accountEmail?: string;
  onLogout?: () => Promise<void>;
  logoutBusy?: boolean;
  logoutError?: string | null;
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
  /** Ranní přípravy a večerní review — pro sloupec „Dodrženo“ u železných pravidel. */
  dailyPreps?: DailyPrep[];
  dailyReviews?: DailyReview[];
  /** Vzhled Aurora (Nastavení → Vzhled). */
  appearance?: AppearanceValue;
  onAppearanceChange?: (next: AppearanceValue) => void;
  onThemeChange?: (theme: 'dark' | 'light' | 'oled') => void;
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  /** Vytvoří účet — auto-import ho volá při zakládání účtu z detekované challenge. */
  onCreateAccount?: (account: Account) => void;
  /** Promítne atomicky uložený importní incident také do živého stavu a offline cache. */
  onImportIncidentSaved?: (review: DailyReview) => void | Promise<void>;
  /** Otevře nový obchod s lokálně rozpoznanými hodnotami; nic automaticky neukládá. */
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

const NATIVE_ALERT_GALLERY_COUNT = NATIVE_COPIER_ALERT_SAMPLES.length;
const NATIVE_ALERT_GALLERY_FIRST_DELAY_MS = 4_000;
const NATIVE_ALERT_GALLERY_INTERVAL_MS = 5_000;

const EXPERIMENT_DURATION_LABELS: Record<string, string> = { '1w': '1 týden', '2w': '2 týdny', '1m': '1 měsíc' };

type SettingsSectionId = 'rules' | 'goals' | 'weekly' | 'sessions' | 'htf' | 'ltf' | 'mistakes' | 'emotions'
  | 'reminders' | 'delivery' | 'tradingview' | 'appearance' | 'account' | 'iphone' | 'coach' | 'diagnostics';

const EmojiPicker = ({ onSelect, onClose }: { onSelect: (e: string) => void, onClose: () => void }) => (
  <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="theme-card max-w-[280px] rounded-lg p-4 shadow-2xl"
      onClick={e => e.stopPropagation()}
    >
      <div className="grid grid-cols-5 gap-1.5">
        {COMMON_EMOJIS.map(emoji => (
          <button
            key={emoji}
            type="button"
            onClick={() => { onSelect(emoji); onClose(); }}
            className="flex h-10 w-10 items-center justify-center rounded-md text-xl transition-colors hover:bg-[var(--bg-page)]"
          >
            {emoji}
          </button>
        ))}
      </div>
    </motion.div>
  </div>
);

const EMPTY_PREPS: DailyPrep[] = [];
const EMPTY_REVIEWS: DailyReview[] = [];

const Settings: React.FC<SettingsProps> = ({
  accountEmail, onLogout, logoutBusy, logoutError,
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
  dailyPreps = EMPTY_PREPS,
  dailyReviews = EMPTY_REVIEWS,
  appearance, onAppearanceChange, onThemeChange,
  activeTab = 'trading',
  onTabChange,
  onCreateAccount,
  onImportIncidentSaved,
}) => {
  // Hledání napříč záložkami a rozbalený panel paměti coache
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [coachPanel, setCoachPanel] = useState<'facts' | 'preferences' | 'memories' | null>(null);

  // Editovat lze JEN sadu světa, ve kterém právě jsi (live vs backtest). Scope je proto
  // zamčený na aktuální svět — druhá sada je vidět jen jako zamčená (přepni svět pro editaci).
  const sessionScope: 'live' | 'backtest' = isBacktestWorld ? 'backtest' : 'live';
  const curSessions = sessionScope === 'backtest' ? backtestSessions : sessions;
  const setCurSessions = sessionScope === 'backtest' ? setBacktestSessions : setSessions;
  const otherScope: 'live' | 'backtest' = sessionScope === 'backtest' ? 'live' : 'backtest';
  const [newRuleLabel, setNewRuleLabel] = useState('');
  // 'experiment' je UI volba — ukládá se jako trading rule s prefixem ⏱ [duration]
  // (konzistentní s tím, jak experiment přidává AI Coach).
  const [newRuleType, setNewRuleType] = useState<'ritual' | 'trading' | 'experiment'>('ritual');
  const [newRuleDuration, setNewRuleDuration] = useState<'1w' | '2w' | '1m'>('2w');
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{ goalIdx: number } | null>(null);

  const [itemToDelete, setItemToDelete] = useState<{ id: string | number, type: 'rule' | 'emotion' | 'mistake' | 'session' | 'goal' } | null>(null);
  const [toast, setToast] = useState<{ message: string, id: number } | null>(null);
  const [nativeRemoteRegistered, setNativeRemoteRegistered] = useState(false);
  const alertTestInFlightRef = useRef(false);

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
    if (activeTab === 'app' || search) refreshCoachMemory();
  }, [activeTab, refreshCoachMemory, search]);

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
    if (activeTab === 'alerts' || activeTab === 'app' || search) void refreshPushState();
  }, [activeTab, refreshPushState, search]);

  useEffect(() => {
    if (isNativeBuild && (activeTab === 'app' || search)) {
      void getNativePrivacyEnabled().then(setNativePrivacyEnabledState).catch(() => undefined);
      void refreshNativeKeepAwakeState();
      void refreshNativePermissionStatus();
      void refreshNativeLiveActivityState();
    }
  }, [activeTab, refreshNativeKeepAwakeState, refreshNativeLiveActivityState, refreshNativePermissionStatus, search]);

  useEffect(() => {
    if (!isNativeBuild) return;
    const refreshAfterSettings = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshNativePermissionStatus();
      if (activeTab === 'app') {
        void refreshNativeKeepAwakeState();
        void refreshNativeLiveActivityState();
      }
      if (activeTab === 'alerts' || activeTab === 'app') void refreshPushState();
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
      if (activeTab === 'alerts' || activeTab === 'app') void refreshPushState();
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
        const { data: { session } } = await supabase.auth.getSession();
        const registered = permission === 'granted' && !!session
          && await initializeNativeRemoteNotifications(session.user.id);
        setNativeRemoteRegistered(registered);
        window.dispatchEvent(new Event('alphatrade:native-push-retry'));
        showToast(registered ? 'Lokální i serverové notifikace jsou připravené'
          : permission === 'granted' ? 'Lokální upozornění jsou povolená. Serverovou registraci se nepodařilo ověřit; zkus Obnovit registraci.'
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

  const handleSnapshotTestPush = async () => {
    setPushBusy(true);
    try {
      const result = await sendNativeSnapshotTestPush();
      showToast(result.ok
        ? 'Mac worker fotí TradingView — čekej na jednu notifikaci s obrázkem'
        : (result.message || 'Test snapshotu se nepodařilo spustit'));
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
    if (pushBusy || alertTestInFlightRef.current) return;
    alertTestInFlightRef.current = true;
    setPushBusy(true);
    try {
      const permission = await requestNativeNotificationPermission();
      if (permission !== 'granted') {
        showToast('Notifikace nejsou v Nastavení iOS povolené');
        return;
      }

      for (const [index, sample] of NATIVE_COPIER_ALERT_SAMPLES.entries()) {
        await scheduleNativeNotification({
          source: 'test',
          title: sample.title,
          body: sample.body,
          route: 'live',
          threadIdentifier: sample.kind === 'trade' ? 'alphatrade-copier-trades' : 'alphatrade-copier-risk',
          actionType: sample.kind,
          interruptionLevel: sample.kind === 'risk' ? 'timeSensitive' : 'active',
          delayMs: NATIVE_ALERT_GALLERY_FIRST_DELAY_MS + index * NATIVE_ALERT_GALLERY_INTERVAL_MS,
        });
      }
      await refreshPushState();
      showToast(`Naplánováno ${NATIVE_ALERT_GALLERY_COUNT} iOS scénářů během dvou minut`);
    } catch (error) {
      showToast(`Galerie selhala: ${error instanceof Error ? error.message : 'neznámá chyba'}`);
    } finally {
      alertTestInFlightRef.current = false;
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
        : 'Žádné čekající testy nebyly nalezeny; session plán zůstal aktivní');
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
        // Ukončení sebere i ostrou aktivitu; server ji smí znovu nastartovat.
        void requestNativeLiveActivityRestart();
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
  const addSession = () => { setCurSessions([...curSessions, { id: `session_${Date.now()}`, name: 'Nová Seance', startTime: '09:00', endTime: '17:00', color: '#6366f1' }]); showToast('Seance vytvořena'); };
  const updateSession = (id: string, up: Partial<SessionConfig>) => { setCurSessions(curSessions.map(s => s.id === id ? { ...s, ...up } : s)); showToast('Seance aktualizována'); };
  const copyLiveToBacktest = () => { setBacktestSessions(sessions.map(s => ({ ...s, id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }))); showToast('Zkopírováno z Live sessionů'); };

  const updateSystem = (key: keyof SystemSettings, val: any) => {
    setSystemSettings({ ...systemSettings, [key]: val });
    showToast('Nastavení aktualizováno');
  };

  const searchQuery = normalizeSearch(search);
  const searching = searchQuery.length > 0;

  // Co se dá v každé sekci najít (názvy + položky) — hledání prochází všechny záložky.
  const searchIndex = useMemo<Record<SettingsSectionId, string>>(() => ({
    rules: `zelezna pravidla ritual pravidlo experiment checklist dodrzeno ${ironRules.map(rule => rule.label).join(' ')}`,
    goals: `vychozi cile dne ranni priprava ${standardGoals.join(' ')}`,
    weekly: `tydenni focus cile tydne ${weeklyFocusList.flatMap(focus => focus.goals.map(goal => goal.text)).join(' ')}`,
    sessions: `seance session harmonogram casova osa live backtest prekryv ${[...sessions, ...backtestSessions].map(item => item.name).join(' ')}`,
    htf: `htf konfluence vyssi casove ramce stitky ${htfOptions.join(' ')}`,
    ltf: `ltf konfluence potvrzeni vstupu stitky ${ltfOptions.join(' ')}`,
    mistakes: `katalog chyb chyby stitky ${userMistakes.join(' ')}`,
    emotions: `emoce emocni mapa stitky ${userEmotions.map(emotion => emotion.label).join(' ')}`,
    reminders: 'pripominky pripomenout pripravu 60 15 minut pred startem vecerni audit notifikace cas',
    delivery: 'doruceni push notifikace zarizeni prohlizec zapnout vypnout zkusebni test apns ios',
    tradingview: 'tradingview alerty webhook url obrazek grafu prijimat',
    appearance: 'vzhled rezim svetly tmavy oled pozadi hlubiny barevne pole barvy paleta sila pruhlednost karet aurora',
    account: `ucet prihlaseny email odhlasit verze aplikace obnovit mezipamet ${accountEmail ?? ''}`,
    iphone: 'iphone spodni lista karty opravneni mikrofon rec soukromy rezim privacy face id displej uspani live ovladaci centrum',
    coach: 'pamet ai coache coach fakta preference komunikace dlouhodoba pamet pozorovani epizody zavazky vymazat',
    diagnostics: 'diagnostika test snapshot tradingview galerie alertu kopirky badge live activity haptika kalendar sdileni diktovani',
  }), [accountEmail, backtestSessions, htfOptions, ironRules, ltfOptions, sessions, standardGoals, userEmotions, userMistakes, weeklyFocusList]);

  const sectionMatches = useCallback((id: string) => {
    if (!searching) return true;
    if (id === 'iphone' && !isNativeBuild) return false;
    return normalizeSearch(searchIndex[id as SettingsSectionId] ?? '').includes(searchQuery);
  }, [searchIndex, searchQuery, searching]);
  const searchContext = useMemo(() => ({ query: searchQuery, matches: sectionMatches }), [searchQuery, sectionMatches]);

  // Klávesa „/“ skočí do hledání (mimo psaní do jiného pole), Escape hledání zruší.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const today = new Date().toLocaleDateString('sv-SE');
  const adherence = useMemo(
    () => ruleAdherenceRecent(ironRules.map(rule => rule.id), dailyPreps, dailyReviews, today),
    [dailyPreps, dailyReviews, ironRules, today],
  );

  const tabs: ReadonlyArray<{ id: SettingsTab; label: string; icon: React.ElementType; sections: SettingsSectionId[] }> = [
    { id: 'trading', label: 'Obchodování', icon: ScrollText, sections: ['rules', 'goals', 'weekly', 'sessions'] },
    { id: 'tags', label: 'Štítky', icon: Tags, sections: ['htf', 'ltf', 'mistakes', 'emotions'] },
    { id: 'alerts', label: 'Upozornění', icon: Bell, sections: ['reminders', 'delivery', 'tradingview'] },
    { id: 'appearance', label: 'Vzhled', icon: Palette, sections: ['appearance'] },
    { id: 'app', label: 'Účet a aplikace', icon: UserRound, sections: ['account', 'iphone', 'coach', 'diagnostics'] },
  ];

  const weekNumber = Number(selectedWeek.split('-W')[1]) || 0;
  const addWeeklyGoal = () => {
    const nl = [...weeklyFocusList];
    const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
    const newGoal = { id: crypto.randomUUID(), text: '', emoji: '🎯' };
    if (i !== -1) nl[i] = { ...nl[i], goals: [...nl[i].goals, newGoal] };
    else nl.push({ id: crypto.randomUUID(), weekISO: selectedWeek, goals: [newGoal] });
    setWeeklyFocusList(nl);
    showToast('Cíl přidán');
  };
  const updateWeeklyGoal = (idx: number, text: string) => {
    const newList = [...weeklyFocusList];
    const exIdx = newList.findIndex(wf => wf.weekISO === selectedWeek);
    if (exIdx === -1) return;
    const newGoals = [...newList[exIdx].goals];
    newGoals[idx] = { ...newGoals[idx], text };
    newList[exIdx] = { ...newList[exIdx], goals: newGoals };
    setWeeklyFocusList(newList);
  };
  const removeWeeklyGoal = (idx: number) => {
    const nl = [...weeklyFocusList];
    const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
    if (i === -1) return;
    nl[i] = { ...nl[i], goals: nl[i].goals.filter((_, gx) => gx !== idx) };
    setWeeklyFocusList(nl);
    showToast('Odstraněno');
  };

  const nowMinutes = (() => { const now = new Date(); return now.getHours() * 60 + now.getMinutes(); })();
  const permissionText = (state: string | undefined) => nativePermissionLabel((state ?? 'unknown') as never);

  const renderTrading = () => (
    <div className="space-y-3">
      <SettingsSection
        id="rules"
        title="Železná pravidla"
        meta={ironRules.length}
        actions={<span className="hidden text-[11.5px] text-[var(--text-muted)] md:inline">Ukazují se v ranní přípravě a na dashboardu</span>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px] [&_tbody_tr:last-child_td]:border-b-0">
            <thead><tr>
              <th className={th}>Pravidlo</th>
              <th className={`${th} w-[92px] sm:w-[170px]`}>Typ</th>
              <th className={`${th} hidden w-[150px] text-right sm:table-cell`} title="Posledních 30 dní, kdy bylo pravidlo vyhodnocené v ranní přípravě nebo večerním review">Dodrženo</th>
              <th className={`${th} w-10`}><span className="sr-only">Akce</span></th>
            </tr></thead>
            <tbody>
              {ironRules.map(rule => {
                const label = rule.label || '';
                const isChecklist = label.startsWith('📋 ');
                const expMatch = label.match(/^⏱\s*\[([^\]]+)\]\s*(.+)$/);
                let title = label;
                let items: string[] = [];
                if (isChecklist) {
                  const lines = label.split('\n');
                  title = lines[0].replace(/^📋\s+/, '').trim();
                  items = lines.slice(1).map(l => l.replace(/^\s*▢\s*/, '').trim()).filter(Boolean);
                } else if (expMatch) {
                  title = expMatch[2].trim();
                }
                const kind = isChecklist
                  ? { dot: 'bg-purple-500', text: 'Checklist' }
                  : expMatch
                    ? { dot: 'bg-amber-500', text: `Experiment · ${EXPERIMENT_DURATION_LABELS[expMatch[1]] ?? expMatch[1]}` }
                    : rule.type === 'ritual'
                      ? { dot: 'bg-indigo-400', text: 'Rituál' }
                      : { dot: 'bg-rose-500', text: 'Pravidlo' };
                const stat = adherence[rule.id];
                return (
                  <tr key={rule.id} className="group hover:bg-[var(--bg-page)]/60">
                    <td className={`${td} py-2.5`}>
                      <p className="font-medium text-[var(--text-primary)]">{title}</p>
                      {items.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {items.map((item, i) => <li key={i} className="text-[11.5px] text-[var(--text-secondary)]">▢ {item}</li>)}
                        </ul>
                      )}
                    </td>
                    <td className={`${td} pr-0 sm:pr-4`}><span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"><i className={`h-[7px] w-[7px] shrink-0 rounded-sm ${kind.dot}`} />{kind.text}</span></td>
                    <td
                      className={`${td} hidden text-right font-mono text-xs tabular-nums text-[var(--text-primary)] sm:table-cell`}
                      title={stat?.since ? `${stat.passed} z ${stat.evaluated} vyhodnocených dní od ${new Date(`${stat.since}T00:00:00`).toLocaleDateString('cs-CZ')}` : 'Zatím nevyhodnoceno'}
                    >
                      {stat && stat.evaluated > 0 ? `${stat.passed} / ${stat.evaluated}` : <span className="text-[var(--text-muted)]">—</span>}
                    </td>
                    <td className={`${td} text-right`}>
                      <button type="button" onClick={() => setItemToDelete({ id: rule.id, type: 'rule' })} aria-label={`Smazat ${title}`} className={`inline-grid h-7 w-7 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}><Trash2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
              {ironRules.length === 0 && <tr><td colSpan={4} className={`${td} text-[var(--text-muted)]`}>Zatím žádná pravidla.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-page)]/50 px-3 py-2.5">
          <input value={newRuleLabel} onChange={e => setNewRuleLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addIronRule(); }} placeholder="Nové pravidlo…" className={`${field} min-w-[160px] flex-1`} />
          <SettingsSegment
            label="Typ pravidla"
            value={newRuleType}
            onChange={setNewRuleType}
            options={[{ value: 'ritual', label: 'Rituál' }, { value: 'trading', label: 'Pravidlo' }, { value: 'experiment', label: 'Experiment' }]}
          />
          {newRuleType === 'experiment' && (
            <select value={newRuleDuration} onChange={e => setNewRuleDuration(e.target.value as '1w' | '2w' | '1m')} aria-label="Délka experimentu" className={field}>
              <option value="1w">1 týden</option>
              <option value="2w">2 týdny</option>
              <option value="1m">1 měsíc</option>
            </select>
          )}
          <button type="button" onClick={addIronRule} disabled={!newRuleLabel.trim()} className={btnPrimary}><Plus size={14} /> Přidat</button>
        </div>
      </SettingsSection>

      <div className="grid gap-3 md:grid-cols-2">
        <SettingsSection id="goals" title="Výchozí cíle dne" meta={standardGoals.length}>
          <p className="px-4 pt-3 text-xs text-[var(--text-secondary)]">Předvyplní se v každé ranní přípravě.</p>
          <SettingsChips
            items={standardGoals.map(goal => ({ key: goal, label: goal }))}
            onRemove={goal => { setStandardGoals(standardGoals.filter(x => x !== goal)); showToast('Odstraněno'); }}
            onAdd={goal => { if (standardGoals.includes(goal)) return false; setStandardGoals([...standardGoals, goal]); showToast('Cíl přidán'); return true; }}
            addLabel="Přidat cíl"
          />
        </SettingsSection>

        <SettingsSection
          id="weekly"
          title="Týdenní focus"
          meta={`Týden ${weekNumber} · ${getWeekRange(selectedWeek).replace(' - ', '–')}`}
          actions={<>
            <button type="button" onClick={() => handleWeekChange(-1)} aria-label="Předchozí týden" className={btnGhost}><ChevronLeft size={15} /></button>
            <button type="button" onClick={() => handleWeekChange(1)} aria-label="Další týden" className={btnGhost}><ChevronRight size={15} /></button>
          </>}
        >
          {currentWeeklyFocus.goals.length === 0 ? (
            <p className="px-4 py-3.5 text-xs text-[var(--text-secondary)]">Na tento týden zatím nemáš focus.</p>
          ) : currentWeeklyFocus.goals.map((goal, idx) => (
            <div key={`${selectedWeek}-${goal.id}`} className="group flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
              <button type="button" onClick={() => setEmojiPickerTarget({ goalIdx: idx })} aria-label="Změnit ikonu" className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--bg-page)] text-base">{goal.emoji || '🎯'}</button>
              <input
                value={goal.text}
                onChange={e => updateWeeklyGoal(idx, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && currentWeeklyFocus.goals.length < 5) addWeeklyGoal(); }}
                placeholder="Zadej týdenní focus…"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              <button type="button" onClick={() => removeWeeklyGoal(idx)} aria-label="Smazat cíl" className={`grid h-7 w-7 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}><Trash2 size={13} /></button>
            </div>
          ))}
          {currentWeeklyFocus.goals.length < 5 && (
            <div className="px-3 py-2"><button type="button" onClick={addWeeklyGoal} className={btn}><Plus size={13} /> Přidat cíl týdne</button></div>
          )}
        </SettingsSection>
      </div>

      <SettingsSection
        id="sessions"
        title="Seance"
        meta={`${curSessions.length} · ${sessionScope === 'backtest' ? 'Backtest' : 'Live'}`}
        actions={<>
          <SettingsSegment
            label="Sada seancí"
            value={sessionScope}
            onChange={() => undefined}
            options={(['live', 'backtest'] as const).map(scope => ({
              value: scope,
              disabled: scope !== sessionScope,
              title: scope !== sessionScope ? `Pro úpravu se přepni do ${scope === 'backtest' ? 'backtest' : 'live'} světa` : undefined,
              label: <>{scope !== sessionScope && <Lock size={10} />}{scope === 'live' ? 'Live' : 'Backtest'}</>,
            }))}
          />
          {sessionScope === 'backtest' && <button type="button" onClick={copyLiveToBacktest} className={btn}>Zkopírovat z Live</button>}
          <button type="button" onClick={addSession} className={btn}><Plus size={13} /> Přidat</button>
        </>}
      >
        <div className="px-4 pb-1 pt-3">
          <div className="mb-1.5 flex justify-between font-mono text-[10.5px] text-[var(--text-muted)]">
            {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(hour => <span key={hour}>{hour}</span>)}
          </div>
          <div
            className="relative rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)]"
            style={{ height: Math.max(1, curSessions.length) * 18 + 8, backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 1px), var(--border-subtle) calc(12.5% - 1px) 12.5%)' }}
            aria-hidden="true"
          >
            {curSessions.map((session, lane) => sessionSegments(session.startTime, session.endTime).map(([from, to], part) => (
              <span
                key={`${session.id}-${part}`}
                className="absolute flex h-3.5 items-center overflow-hidden whitespace-nowrap rounded-[3px] px-1.5 text-[10px] font-semibold text-white"
                style={{ left: `${(from / 1440) * 100}%`, width: `${((to - from) / 1440) * 100}%`, top: 5 + lane * 18, backgroundColor: session.color || '#3b82f6' }}
              >
                {part === 0 ? session.name : ''}
              </span>
            )))}
            <span className="absolute -bottom-1 -top-1 w-0.5 rounded bg-[var(--text-primary)] opacity-50" style={{ left: `${(nowMinutes / 1440) * 100}%` }} title="Teď" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px] [&_tbody_tr:last-child_td]:border-b-0">
            <thead><tr>
              <th className={th}>Seance</th>
              <th className={`${th} w-[110px] text-right`}>Od</th>
              <th className={`${th} w-[110px] text-right`}>Do</th>
              <th className={`${th} hidden w-[80px] text-right sm:table-cell`}>Délka</th>
              <th className={`${th} hidden w-[190px] md:table-cell`}>Překryv</th>
              <th className={`${th} w-10`}><span className="sr-only">Akce</span></th>
            </tr></thead>
            <tbody>
              {curSessions.map(session => {
                const overlaps = curSessions
                  .filter(other => other.id !== session.id)
                  .map(other => ({ name: other.name, minutes: sessionOverlapMinutes(session, other) }))
                  .filter(item => item.minutes > 0);
                return (
                  <tr key={session.id} className="group hover:bg-[var(--bg-page)]/60">
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <span className="relative h-3.5 w-3.5 shrink-0 rounded-[3px]" style={{ backgroundColor: session.color || '#3b82f6' }}>
                          <input type="color" value={session.color || '#3b82f6'} onChange={e => updateSession(session.id, { color: e.target.value })} aria-label={`Barva seance ${session.name}`} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                        </span>
                        <input value={session.name} onChange={e => updateSession(session.id, { name: e.target.value })} aria-label="Název seance" className="min-w-0 flex-1 border-b border-transparent bg-transparent py-1 font-semibold text-[var(--text-primary)] outline-none focus:border-indigo-500" />
                      </div>
                    </td>
                    <td className={`${td} text-right`}><input type="time" value={session.startTime} onChange={e => updateSession(session.id, { startTime: e.target.value })} aria-label={`Začátek ${session.name}`} className={timeField} /></td>
                    <td className={`${td} text-right`}><input type="time" value={session.endTime} onChange={e => updateSession(session.id, { endTime: e.target.value })} aria-label={`Konec ${session.name}`} className={timeField} /></td>
                    <td className={`${td} hidden text-right font-mono text-xs tabular-nums sm:table-cell`}>{formatSessionDuration(sessionDurationMinutes(session.startTime, session.endTime))}</td>
                    <td className={`${td} hidden text-xs text-[var(--text-secondary)] md:table-cell`}>{overlaps.length ? overlaps.map(item => `${item.name} ${formatSessionDuration(item.minutes)}`).join(', ') : '—'}</td>
                    <td className={`${td} text-right`}>
                      <button type="button" onClick={() => { setCurSessions(prev => prev.filter(x => x.id !== session.id)); showToast('Odstraněno'); }} aria-label={`Smazat seanci ${session.name}`} className={`inline-grid h-7 w-7 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}><Trash2 size={13} /></button>
                    </td>
                  </tr>
                );
              })}
              {curSessions.length === 0 && <tr><td colSpan={6} className={`${td} text-[var(--text-muted)]`}>Žádné seance{sessionScope === 'backtest' ? ' — backtest teď jede na Live sadě.' : '.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[var(--border-subtle)] px-4 py-2 text-[11.5px] text-[var(--text-secondary)]">
          Upravuješ sadu pro {sessionScope === 'backtest' ? 'Backtest' : 'Live'}. {otherScope === 'backtest' ? 'Backtest' : 'Live'} sadu uprav z {otherScope === 'backtest' ? 'backtest' : 'live'} světa.
        </p>
      </SettingsSection>
    </div>
  );

  const renderTags = () => (
    <div className="grid gap-3 md:grid-cols-2">
      <SettingsSection id="htf" title="HTF konfluence" meta={`${htfOptions.length} · vyšší časové rámce`}>
        <SettingsChips
          items={htfOptions.map(opt => ({ key: opt, label: opt }))}
          onRemove={opt => { setHtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }}
          onAdd={opt => { if (htfOptions.includes(opt)) return false; setHtfOptions([...htfOptions, opt]); showToast('HTF přidána'); return true; }}
          addLabel="Přidat"
        />
      </SettingsSection>
      <SettingsSection id="ltf" title="LTF konfluence" meta={`${ltfOptions.length} · potvrzení vstupu`}>
        <SettingsChips
          items={ltfOptions.map(opt => ({ key: opt, label: opt }))}
          onRemove={opt => { setLtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }}
          onAdd={opt => { if (ltfOptions.includes(opt)) return false; setLtfOptions([...ltfOptions, opt]); showToast('LTF přidána'); return true; }}
          addLabel="Přidat"
        />
      </SettingsSection>
      <SettingsSection id="mistakes" title="Katalog chyb" meta={userMistakes.length}>
        <SettingsChips
          items={userMistakes.map(m => ({ key: m, label: m }))}
          onRemove={m => { setUserMistakes(prev => prev.filter(x => x !== m)); showToast('Odstraněno'); }}
          onAdd={m => { if (userMistakes.includes(m)) return false; setUserMistakes([...userMistakes, m]); showToast('Chyba přidána'); return true; }}
          addLabel="Přidat"
        />
      </SettingsSection>
      <SettingsSection id="emotions" title="Emoce" meta={userEmotions.length}>
        <SettingsChips
          items={userEmotions.map(emo => ({ key: emo.id, label: emo.label }))}
          onRemove={id => { setUserEmotions(prev => prev.filter(e => e.id !== id)); showToast('Odstraněno'); }}
          onAdd={label => { setUserEmotions([...userEmotions, { id: Date.now().toString(), label, icon: '' }]); showToast('Emoce přidána'); return true; }}
          addLabel="Přidat"
        />
      </SettingsSection>
    </div>
  );

  const activeDevices = pushDevices.filter(device => !device.expiredAt).length;
  const renderAlerts = () => (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <SettingsSection id="reminders" title="Připomínky">
          <SettingsRow label="Připomenout přípravu" desc="Když před seancí nemáš hotovou ranní přípravu." keywords="60 15 minut">
            <SettingsSwitch on={systemSettings.guardianEnabled} onChange={() => updateSystem('guardianEnabled', !systemSettings.guardianEnabled)} label="Připomenout přípravu" />
          </SettingsRow>
          {systemSettings.guardianEnabled && <>
            <SettingsRow sub label="60 minut před startem" desc="Informační">
              <SettingsSwitch on={systemSettings.morningPrepAlert60m} onChange={() => updateSystem('morningPrepAlert60m', !systemSettings.morningPrepAlert60m)} label="60 minut před startem" />
            </SettingsRow>
            <SettingsRow sub label="15 minut před startem" desc="Důrazná">
              <SettingsSwitch on={systemSettings.morningPrepAlert15m} onChange={() => updateSystem('morningPrepAlert15m', !systemSettings.morningPrepAlert15m)} label="15 minut před startem" />
            </SettingsRow>
          </>}
          <SettingsRow label="Večerní audit" desc="Připomínka uzavřít den v deníku." keywords="cas notifikace">
            {systemSettings.eveningAuditAlertEnabled && (
              <input type="time" value={systemSettings.eveningAuditAlertTime} onChange={e => updateSystem('eveningAuditAlertTime', e.target.value)} aria-label="Čas večerního auditu" className={timeField} />
            )}
            <SettingsSwitch on={systemSettings.eveningAuditAlertEnabled} onChange={() => updateSystem('eveningAuditAlertEnabled', !systemSettings.eveningAuditAlertEnabled)} label="Večerní audit" />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection id="delivery" title="Doručení" meta="push i při zavřené appce">
          {isNativeBuild ? <>
            <SettingsRow label="Notifikace iOS" desc={`Oprávnění: ${nativeNotificationPermission === 'granted' ? 'povoleno' : nativeNotificationPermission}`} keywords="zapnout registrace">
              <button type="button" onClick={handleEnablePush} disabled={pushBusy} className={nativeNotificationPermission === 'granted' ? btn : btnPrimary}>
                {pushBusy ? 'Ověřuji…' : nativeNotificationPermission === 'granted' ? (nativeRemoteRegistered ? 'Ověřit registraci' : 'Obnovit registraci') : 'Zapnout'}
              </button>
            </SettingsRow>
            <SettingsRow label="Zkušební notifikace" desc="APNs ze serveru — funguje i se zavřenou appkou." keywords="test">
              <button type="button" onClick={handleTestPush} disabled={pushBusy} className={btn}><Send size={13} /> Poslat</button>
            </SettingsRow>
            {nativeNotificationPermission === 'granted' && (
              <SettingsRow
                label="Plán připomínek v iPhonu"
                desc={nativeReminderSync?.omittedCount
                  ? `${nativeReminderSync.scheduledCount} aktivních, ${nativeReminderSync.omittedCount} vynecháno kvůli limitu iOS — omez počet připomínek.`
                  : `Funguje i při vypnuté aplikaci${nativeReminderSync ? ` · ${nativeReminderSync.scheduledCount} opakování Po–Pá` : ''}.`}
              >
                <StatusPill tone={nativeReminderSync?.omittedCount ? 'warn' : 'ok'}>{nativeReminderSync?.omittedCount ? 'Částečně' : 'Aktivní'}</StatusPill>
              </SettingsRow>
            )}
          </> : <>
            <SettingsRow label="Aktivní zařízení" desc={pushDevices.length > activeDevices ? `${pushDevices.length - activeDevices} vypršela — znovu je zapni na daném zařízení.` : 'Telefony a počítače, kam chodí upozornění.'} keywords="zarizeni">
              <StatusPill tone={activeDevices > 0 ? 'ok' : 'off'}>{activeDevices} / {pushDevices.length}</StatusPill>
            </SettingsRow>
            <SettingsRow
              label="Tento prohlížeč"
              desc={pushDiag?.isApple && !pushDiag?.isStandalone
                ? <span className="text-amber-500">Na iPhonu nejdřív v Safari použij Sdílet → Přidat na plochu a otevři AlphaTrade z nové ikony.</span>
                : pushDiag?.ready ? 'Upozornění odebírá.' : 'Zatím neodebírá upozornění.'}
              keywords="zapnout vypnout"
            >
              {pushDiag?.hasActiveSubscription && <button type="button" onClick={handleDisablePush} disabled={pushBusy} className={btnGhost}>Vypnout</button>}
              {!pushDiag?.ready && <button type="button" onClick={handleEnablePush} disabled={pushBusy} className={btnPrimary}>{pushBusy ? 'Ověřuji…' : 'Zapnout'}</button>}
            </SettingsRow>
            {pushDevices.length > 0 && (
              <SettingsRow label="Zkušební notifikace" desc="Pošle se na všechna aktivní zařízení." keywords="test">
                <button type="button" onClick={handleTestPush} disabled={pushBusy} className={btn}><Send size={13} /> {pushBusy ? 'Odesílám…' : 'Poslat'}</button>
              </SettingsRow>
            )}
          </>}
        </SettingsSection>
      </div>
      <TradingViewAlertSettings onToast={showToast} />
    </div>
  );

  const renderCoachEntries = (entries: Record<string, unknown>, empty: string) => (
    <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-page)]/50 px-4 py-3">
      {Object.keys(entries).length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[160px_1fr]">
          {Object.entries(entries).map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="font-semibold text-[var(--text-secondary)]">{key}</dt>
              <dd className="text-[var(--text-primary)]">{Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : <p className="text-xs text-[var(--text-secondary)]">{empty}</p>}
    </div>
  );

  const activeMemoryCount = coachMemories.filter(m => isCoachMemoryActive(m)).length;
  const renderApp = () => (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <SettingsSection id="account" title="Účet">
          {accountEmail && (
            <SettingsRow label={accountEmail} desc="Přihlášený účet" keywords="odhlasit email">
              {onLogout && <button type="button" disabled={logoutBusy} onClick={() => void onLogout()} className={btn}>{logoutBusy ? 'Odhlašuji…' : 'Odhlásit se'}</button>}
            </SettingsRow>
          )}
          {logoutError && <p role="alert" className="border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-rose-500">{logoutError}</p>}
          <SettingsRow label="Verze aplikace" desc={<span className="font-mono">{appVersion ?? '—'}</span>} keywords="obnovit mezipamet">
            {onHardRefresh && <button type="button" onClick={onHardRefresh} className={btnGhost}>Vynutit obnovení</button>}
          </SettingsRow>
        </SettingsSection>

        {isNativeBuild && (
          <SettingsSection id="iphone" title="Tento iPhone">
            <NativeShellTabsSettings />
            <SettingsRow
              label="Oprávnění"
              desc={`Notifikace ${permissionText(nativePermissionStatus?.notifications)} · mikrofon ${permissionText(nativePermissionStatus?.microphone)} · řeč ${permissionText(nativePermissionStatus?.speech)}`}
              keywords="mikrofon rec notifikace"
            >
              <button type="button" onClick={() => void refreshNativePermissionStatus()} className={btnGhost}>Obnovit</button>
              <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleOpenNativeSettings()} className={btn}>Nastavení iOS</button>
            </SettingsRow>
            <SettingsRow label="Soukromý režim" desc="Při odchodu z appky skryje obsah, návrat chrání Face ID nebo kód." keywords="privacy face id">
              {nativePrivacyEnabled && <button type="button" onClick={() => void handleNativePrivacyLock()} className={btnGhost}>Zamknout teď</button>}
              <SettingsSwitch on={nativePrivacyEnabled} disabled={nativeCapabilityBusy} onChange={() => void handleNativePrivacyToggle()} label="Soukromý režim" />
            </SettingsRow>
            <SettingsRow
              label="LIVE bez uspání displeje"
              desc={nativeKeepAwakeEnabled
                ? (nativeKeepAwakeEffective ? <span className="text-emerald-500">iOS právě drží displej vzhůru.</span> : 'Teď neaktivní — Backtest nebo appka na pozadí.')
                : 'V LIVE světě nezhasne obrazovka; v Backtestu a na pozadí se vypne.'}
              keywords="displej uspani"
            >
              <SettingsSwitch on={nativeKeepAwakeEnabled} disabled={nativeCapabilityBusy} onChange={() => void handleNativeKeepAwakeToggle()} label="LIVE bez uspání displeje" />
            </SettingsRow>
            <SettingsRow label="Ovládací centrum" desc="Ovladače AlphaTrade LIVE a Zapsat obchod přidáš přes úpravu Ovládacího centra. Jen otevřou appku, nic neodesílají brokerovi." />
          </SettingsSection>
        )}

        {!isNativeBuild && renderDiagnostics()}
      </div>

      <SettingsSection id="coach" title="Paměť AI Coache" meta="co si o tobě pamatuje">
        <SettingsRow label="Fakta o tobě" desc="Věk, situace, limity, plán odpovědnosti…">
          <span className="font-mono text-xs font-bold tabular-nums text-[var(--text-primary)]">{Object.keys(coachProfile.facts).length}</span>
          <button type="button" onClick={() => setCoachPanel(panel => panel === 'facts' ? null : 'facts')} aria-expanded={coachPanel === 'facts'} className={btnGhost}>{coachPanel === 'facts' ? 'Skrýt' : 'Zobrazit'}</button>
        </SettingsRow>
        {coachPanel === 'facts' && renderCoachEntries(coachProfile.facts, 'Coach si zatím nezapamatoval žádná fakta. Bude je přidávat během konverzací.')}
        <SettingsRow label="Preference komunikace" desc={'Např. „ukazuj v R“, „buď stručnější“ — stačí to Coachovi říct v chatu.'}>
          <span className="font-mono text-xs font-bold tabular-nums text-[var(--text-primary)]">{Object.keys(coachProfile.preferences).length}</span>
          <button type="button" onClick={() => setCoachPanel(panel => panel === 'preferences' ? null : 'preferences')} aria-expanded={coachPanel === 'preferences'} className={btnGhost}>{coachPanel === 'preferences' ? 'Skrýt' : 'Zobrazit'}</button>
        </SettingsRow>
        {coachPanel === 'preferences' && renderCoachEntries(coachProfile.preferences, 'Žádné preference.')}
        <SettingsRow label="Dlouhodobá paměť" desc={`Pozorování, epizody, shrnutí a závazky · ${coachMemories.length - activeMemoryCount} v historii`}>
          <span className="font-mono text-xs font-bold tabular-nums text-[var(--text-primary)]">{activeMemoryCount}</span>
          <button type="button" onClick={() => setCoachPanel(panel => panel === 'memories' ? null : 'memories')} aria-expanded={coachPanel === 'memories'} className={btn}>{coachPanel === 'memories' ? 'Skrýt' : 'Spravovat'}</button>
        </SettingsRow>
        {coachPanel === 'memories' && (
          <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-page)]/50 px-4 py-3">
            <div className="mb-3 flex flex-wrap gap-1.5">
              <SettingsSegment label="Stav vzpomínek" value={memoryStatusFilter} onChange={setMemoryStatusFilter} options={[{ value: 'active', label: 'Aktivní' }, { value: 'history', label: 'Historie' }]} />
              <SettingsSegment
                label="Typ vzpomínek"
                value={memoryFilter}
                onChange={setMemoryFilter}
                options={[{ value: 'all', label: 'Vše' }, { value: 'observation', label: 'Pozorování' }, { value: 'episode', label: 'Epizody' }, { value: 'conversation_summary', label: 'Shrnutí' }, { value: 'commitment', label: 'Závazky' }]}
              />
            </div>
            {filteredMemories.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">Žádné záznamy v této kategorii. Coach si je vytvoří při konverzacích a po důležitých obchodech.</p>
            ) : (
              <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {filteredMemories.map(m => {
                  const typeLabel = m.type === 'observation' ? 'Pozorování' : m.type === 'episode' ? 'Epizoda' : m.type === 'commitment' ? 'Závazek' : 'Shrnutí';
                  const validation = String(m.metadata?.validation_state || (m.type === 'commitment' ? 'user_stated' : 'hypothesis'));
                  const confidence = typeof m.metadata?.confidence === 'number' ? Math.round(m.metadata.confidence * 100) : null;
                  const evidenceCount = Array.isArray(m.metadata?.evidence) ? m.metadata.evidence.length : 0;
                  const counterCount = Array.isArray(m.metadata?.counter_evidence) ? m.metadata.counter_evidence.length : 0;
                  const status = String(m.metadata?.status || 'active');
                  return (
                    <div key={m.id} className="group flex items-start gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] p-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                          <span className="font-semibold text-[var(--text-primary)]">{typeLabel}</span>
                          <span className={validation === 'supported' || validation === 'user_stated' ? 'text-emerald-500' : validation === 'contested' ? 'text-rose-500' : 'text-amber-500'}>
                            {validation === 'supported' ? 'podloženo' : validation === 'user_stated' ? 'řečeno uživatelem' : validation === 'contested' ? 'sporné' : 'hypotéza'}
                          </span>
                          {status !== 'active' && <span className="text-[var(--text-muted)]">{status === 'superseded' ? 'nahrazeno' : 'staženo'}</span>}
                          {m.memory_date && <span className="font-mono text-[var(--text-muted)]">{m.memory_date}</span>}
                          {m.importance >= 8 && <span className="font-semibold text-amber-500">důležité</span>}
                        </div>
                        <p className="whitespace-pre-line text-xs leading-relaxed text-[var(--text-primary)]">{m.content}</p>
                        <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                          {confidence != null ? `Jistota ${confidence} % · ` : ''}důkazy {evidenceCount}{counterCount ? ` · protidůkazy ${counterCount}` : ''}
                          {m.metadata?.validation_note ? ` · ${String(m.metadata.validation_note)}` : ''}
                        </p>
                      </div>
                      <button type="button" onClick={() => handleForgetMemory(m.id)} title="Smazat tuto vzpomínku" aria-label="Smazat tuto vzpomínku" className={`grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}><Trash2 size={13} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {coachMemories.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            {!confirmClearMemory ? <>
              <span className="text-[11.5px] text-[var(--text-secondary)]">Smazání paměti je nevratné.</span>
              <button type="button" onClick={() => setConfirmClearMemory(true)} className={btnDanger}>Vymazat paměť…</button>
            </> : <>
              <span className="text-xs font-semibold text-rose-500">Smazat všech {coachMemories.length} záznamů? Nejde to vrátit.</span>
              <span className="flex gap-1.5">
                <button type="button" onClick={() => setConfirmClearMemory(false)} className={btnGhost}>Zrušit</button>
                <button type="button" onClick={handleClearAllMemory} className="inline-flex h-[30px] items-center rounded-md bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500">Smazat</button>
              </span>
            </>}
          </div>
        )}
      </SettingsSection>

      {isNativeBuild && renderDiagnostics()}
    </div>
  );

  function renderDiagnostics() {
    if (!sectionMatches('diagnostics')) return null;
    const pendingTests = nativePendingNotifications.filter(notification => notification.source === 'test').length;
    const kindTone = (kind: string) => kind === 'risk' ? 'text-rose-500' : kind === 'trade' ? 'text-emerald-500' : 'text-indigo-500';
    return (
      <details open={searching || undefined} className="theme-card group/diag min-w-0 self-start overflow-hidden rounded-lg">
        <summary className="flex min-h-[46px] cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 group-open/diag:border-b group-open/diag:border-[var(--border-subtle)] [&::-webkit-details-marker]:hidden">
          <Wrench size={14} className="text-[var(--text-muted)]" />
          <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">Diagnostika</h2>
          <span className="text-xs font-medium text-[var(--text-muted)]">testy pro ladění</span>
          <ChevronRight size={15} className="ml-auto text-[var(--text-muted)] transition-transform group-open/diag:rotate-90" />
        </summary>
        <SettingsRow label="Test snapshotu TradingView" desc="Bez ARMu a bez obchodu: vyfotí layout AlphaTrade Snapshoty, pošle obrázkový APNs test a nic nezapíše do deníku." keywords="snapshot">
          <button type="button" onClick={handleSnapshotTestPush} disabled={pushBusy} className={btn}>{pushBusy ? 'Čekám…' : 'Poslat'}</button>
        </SettingsRow>
        {isNativeBuild && <>
          <SettingsRow label="Galerie iOS alertů kopírky" desc={`${NATIVE_ALERT_GALLERY_COUNT} scénářů během dvou minut — patří současnému copieru.`} keywords="galerie alertu">
            <button type="button" disabled={pushBusy} onClick={() => void handleNativeAlertGallery()} className={btn}>{pushBusy ? 'Plánuji…' : 'Naplánovat'}</button>
          </SettingsRow>
          <SettingsRow label="Čekající testy" desc={`${pendingTests} čeká v iOS`} keywords="zrusit">
            <button type="button" disabled={pushBusy || pendingTests === 0} onClick={() => void handleCancelNativeAlerts()} className={btnGhost}>Zrušit</button>
          </SettingsRow>
          {!searching && (nativePendingNotifications.length > 0 || nativeDeliveredNotifications.length > 0) && (
            <div className="space-y-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-page)]/50 px-4 py-3">
              {nativePendingNotifications.map(notification => (
                <div key={`p-${notification.id}`} className="flex items-start gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] p-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{notification.title} <span className={`font-medium ${kindTone(notification.kind)}`}>· {notification.source === 'sessionReminder' ? 'plán' : notification.kind}</span></p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-secondary)]">{notification.body}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">čeká · {notification.scheduledAt ? new Date(notification.scheduledAt).toLocaleTimeString('cs-CZ') : 'čas řídí iOS'}{notification.route ? ` · otevře ${notification.route}` : ''}</p>
                  </div>
                  {notification.source === 'test' && <button type="button" disabled={pushBusy} onClick={() => void handleCancelNativeAlert(notification.id)} aria-label={`Zrušit ${notification.title}`} className="grid h-7 w-7 place-items-center rounded text-rose-500 disabled:opacity-40"><X size={13} /></button>}
                </div>
              ))}
              {nativeDeliveredNotifications.map(notification => (
                <div key={`d-${notification.id}`} className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-[var(--bg-input)] p-2.5">
                  <button type="button" onClick={() => handleOpenDeliveredNativeAlert(notification)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{notification.title} <span className={`font-medium ${kindTone(notification.kind)}`}>· {notification.kind}</span>{notification.hasAttachment && <span className="font-medium text-indigo-500"> · obrázek</span>}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-secondary)]">{notification.body}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">doručeno · {notification.deliveredAt ? new Date(notification.deliveredAt).toLocaleTimeString('cs-CZ') : 'systémem'} · klepnutím otevřít {notification.route || 'dashboard'}</p>
                  </button>
                  <button type="button" disabled={pushBusy} onClick={() => void handleRemoveDeliveredNativeAlert(notification.id)} aria-label={`Odstranit doručenou notifikaci ${notification.title}`} className="grid h-7 w-7 place-items-center rounded text-rose-500 disabled:opacity-40"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <SettingsRow label="Badge na ikoně" desc={`Teď ${nativeBadgeCount} · testovací notifikace nastaví 1, otevření ho vymaže.`} keywords="badge">
            {[1, 5].map(count => <button key={count} type="button" disabled={pushBusy} onClick={() => void handleNativeBadge(count)} className={btn}>{count}</button>)}
            <button type="button" disabled={pushBusy || nativeBadgeCount === 0} onClick={() => void handleNativeBadge(0)} className={btnGhost}>Vymazat</button>
          </SettingsRow>
          <SettingsRow
            label="Live Activity"
            desc={<>Test seance a P&amp;L na zamčené obrazovce · {nativeLiveActivityState?.activeCount ? <span className="text-emerald-500">aktivní</span> : nativeLiveActivityState?.enabled === false ? <span className="text-rose-500">vypnuto v iOS</span> : 'připraveno'}</>}
            keywords="live activity dynamic island"
          >
            <button type="button" disabled={nativeCapabilityBusy || !!nativeLiveActivityState?.activeCount || nativeLiveActivityState?.enabled === false} onClick={() => void handleNativeLiveActivity('start')} className={btn}>Spustit</button>
            <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('profit')} className={btnGhost}>+P&amp;L</button>
            <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('risk')} className={btnGhost}>Risk</button>
            <button type="button" disabled={nativeCapabilityBusy || !nativeLiveActivityState?.activeCount} onClick={() => void handleNativeLiveActivity('end')} className={btnGhost}>Ukončit</button>
          </SettingsRow>
          <SettingsRow label="Haptika" keywords="haptika">
            {(['selection', 'success', 'warning', 'error'] as NativeHapticStyle[]).map(style => (
              <button key={style} type="button" onClick={() => void handleHapticTest(style)} className={btnGhost}>{style}</button>
            ))}
          </SettingsRow>
          <SettingsRow label="Apple Kalendář" desc="Otevře editor s LIVE seancí na příští celou hodinu. Bez klepnutí na Přidat nic neuloží." keywords="kalendar">
            <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleNativeCalendarEvent()} className={btn}><CalendarPlus size={13} /> Naplánovat</button>
          </SettingsRow>
          <SettingsRow label="Sdílení iOS" keywords="sdileni">
            <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleNativeShareTest()} className={btn}><Share2 size={13} /> Otevřít</button>
          </SettingsRow>
          <SettingsRow label="Diktování poznámky" desc={nativeDictationText || 'Apple Speech poslouchá nejvýš 30 sekund; nic neukládá ani neposílá.'} keywords="diktovani">
            <button type="button" disabled={nativeCapabilityBusy} onClick={() => void handleNativeDictation()} className={nativeDictating ? btnDanger : btn}>{nativeDictating ? 'Zastavit' : 'Začít diktovat'}</button>
          </SettingsRow>
        </>}
      </details>
    );
  }

  const renderTab = (tab: SettingsTab) => {
    switch (tab) {
      case 'trading': return renderTrading();
      case 'tags': return renderTags();
      case 'alerts': return renderAlerts();
      case 'appearance': return appearance && onAppearanceChange && onThemeChange && sectionMatches('appearance')
        ? <AppearanceSettings appearance={appearance} onChange={onAppearanceChange} theme={theme} onThemeChange={onThemeChange} />
        : null;
      case 'app': return renderApp();
    }
  };
  const visibleSearchTabs = tabs.filter(tab => tab.sections.some(section => sectionMatches(section)));

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-20">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-end">
        <nav role="tablist" aria-label="Sekce nastavení" className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)]">
          {tabs.map(tab => {
            const active = !searching && activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => { setSearch(''); onTabChange?.(tab.id); }}
                className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${active ? 'border-indigo-500 text-indigo-500' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'} ${searching ? 'opacity-50' : ''}`}
              >
                <Icon size={14} /> {tab.label}
              </button>
            );
          })}
        </nav>
        <label className="relative block sm:mb-1.5 sm:w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); event.currentTarget.blur(); } }}
            placeholder="Hledat v nastavení…"
            aria-label="Hledat v nastavení"
            className={`${field} h-8 w-full pl-8 pr-8`}
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-[var(--border-subtle)] px-1.5 font-mono text-[10px] text-[var(--text-muted)] sm:block">/</kbd>
        </label>
      </div>

      <SettingsSearchContext.Provider value={searchContext}>
        {searching ? (
          visibleSearchTabs.length > 0 ? (
            <div className="space-y-6">
              {visibleSearchTabs.map(tab => (
                <div key={tab.id}>
                  <h3 className="mb-2.5 flex items-center gap-2.5 px-0.5 text-[11.5px] font-bold text-[var(--text-muted)] after:h-px after:flex-1 after:bg-[var(--border-subtle)]">{tab.label}</h3>
                  {renderTab(tab.id)}
                </div>
              ))}
            </div>
          ) : (
            <p className="theme-card rounded-lg px-4 py-8 text-center text-sm text-[var(--text-secondary)]">Nic nenalezeno pro „{search.trim()}“.</p>
          )
        ) : renderTab(activeTab)}
      </SettingsSearchContext.Provider>

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

      {emojiPickerTarget && (
        <EmojiPicker
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
      )}

      {/* Potvrzení uložení */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="native-fixed-above-tab-bar pointer-events-none fixed bottom-12 left-1/2 z-[300] -translate-x-1/2"
          >
            <div role="status" className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-[var(--bg-card)] px-4 py-2.5 text-emerald-500 shadow-2xl backdrop-blur-xl">
              <Check size={15} strokeWidth={3} />
              <span className="text-xs font-semibold">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;
