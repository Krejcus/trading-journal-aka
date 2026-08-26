import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, Crown, Plus, HelpCircle, Settings2, Eye, MoreVertical,
  RefreshCw, Inbox, Check, RotateCcw, X, Save, Trash2, Power,
  EyeOff, AlertTriangle, CheckCircle2, SlidersHorizontal, ShieldAlert, ShieldCheck, Clock3,
  Lock, Ban, Unplug,
} from 'lucide-react';
import type { LiveAccount, LiveGroup, LiveOrder, LivePosition, LiveSnapshot } from '../services/tradecopiaLiveService';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';
import type { TradovateApiTelemetrySnapshot } from '../lib/tradovateApiTelemetry';
import type { CopierAccountEligibility, CopierStuckOperation } from '../services/copierRuntimeController';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import { effectiveCopyTradeAccountEligibility } from '../lib/copyTradeAccountEligibility';
import { FIRM_LOGOS, firmColor, firmInitials } from '../utils/accountFirm';
import {
  adoptRuntimeCopyGroup,
  copyGroupsFromSnapshot,
  createLocalCopyGroupId,
  DEFAULT_COPY_GROUP_SAFETY,
  mergeCopyGroups,
  normalizeMultiplier,
  replaceCopyGroupFollowerAccount,
  sanitizeCopyGroups,
  unavailableCopyGroupAccounts,
  validateCopyGroup,
  type CopyGroupConfig,
  type CopyFollowerConfig,
  type CopyGroupSafetySettings,
  type CopyReplicationMode,
  type LiveCopyTradingAdapter,
  type LiveCopyTradingCommand,
} from '../services/liveCopyTrading';

const GROUP_COLORS = ['#4f6df5', '#f97316', '#d946ef', '#84cc16', '#06b6d4', '#ec4899', '#8b5cf6', '#64748b'];

interface CopyGroupTemplate {
  id: string;
  name: string;
  leaderAccountId: number | null;
  followers: CopyFollowerConfig[];
  safety: CopyGroupSafetySettings;
}

interface RedactionSettings {
  visibleStart: number;
  visibleEnd: number;
}

const DEFAULT_REDACTION: RedactionSettings = { visibleStart: 4, visibleEnd: 4 };

// Přehled kopírování 1:1 podle obrazovky Copy Trade v Tradecopii — stejné rozvržení,
// stejné sloupce, stejné akce. Dokud nejsou účty připojené přes OAuth, jsou řádky
// tlumené a akce neaktivní; po připojení se rozsvítí bez dalších zásahů do UI.

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Režim replikace follower účtu — hodnoty přebírají chování Tradecopie. */
export type ReplicationMode = CopyReplicationMode;

// ─── Sloupce tabulky účtů ────────────────────────────────────────────────────
// Datově řízené, aby šly jednotlivé sloupce skrývat. `locked` sloupce skrýt nelze
// — bez názvu účtu by řádky nešlo rozlišit.

export type AccountColumnKey =
  | 'account' | 'status' | 'broker' | 'firm' | 'balance' | 'positions'
  | 'daily' | 'unreal' | 'distDd' | 'execLimit' | 'qtyMult' | 'actions';

interface ColumnDef {
  key: AccountColumnKey;
  label: string;
  align?: 'right';
  locked?: boolean;
  widthPx: number;
}

type GroupColumnKey = 'status' | 'leader' | 'firm' | 'followers' | 'capital' | 'daily' | 'unreal';
type OrderColumnKey = 'account' | 'broker' | 'symbol' | 'action' | 'type' | 'qty' | 'limit' | 'stop' | 'status' | 'timestamp' | 'orderId';
const GROUP_COLUMN_OPTIONS: Array<{ key: GroupColumnKey; label: string }> = [
  { key: 'status', label: 'Status' }, { key: 'leader', label: 'Leader' }, { key: 'firm', label: 'Firm' },
  { key: 'followers', label: 'Followers' }, { key: 'capital', label: 'Capital' }, { key: 'daily', label: 'Daily P&L' }, { key: 'unreal', label: 'Unreal P&L' },
];
const ORDER_COLUMN_OPTIONS: Array<{ key: OrderColumnKey; label: string }> = [
  { key: 'account', label: 'Account' }, { key: 'broker', label: 'Broker' }, { key: 'symbol', label: 'Symbol' }, { key: 'action', label: 'Action' },
  { key: 'type', label: 'Type' }, { key: 'qty', label: 'Qty' }, { key: 'limit', label: 'Limit Price' },
  { key: 'stop', label: 'Stop Price' }, { key: 'status', label: 'Status' }, { key: 'timestamp', label: 'Timestamp' }, { key: 'orderId', label: 'Order ID' },
];

const ACCOUNT_COLUMNS: ColumnDef[] = [
  { key: 'account', label: 'Account', locked: true, widthPx: 220 },
  { key: 'status', label: 'Status', widthPx: 170 },
  { key: 'broker', label: 'Broker', widthPx: 72 },
  { key: 'firm', label: 'Firm', widthPx: 120 },
  { key: 'balance', label: 'Balance', align: 'right', widthPx: 112 },
  { key: 'positions', label: 'Positions', align: 'right', widthPx: 260 },
  { key: 'daily', label: 'Daily P&L', align: 'right', widthPx: 96 },
  { key: 'unreal', label: 'Unreal P&L', align: 'right', widthPx: 104 },
  { key: 'distDd', label: 'Dist DD', align: 'right', widthPx: 76 },
  { key: 'execLimit', label: 'Exec/Limit', align: 'right', widthPx: 88 },
  { key: 'qtyMult', label: 'Násobek', align: 'right', widthPx: 96 },
  { key: 'actions', label: 'Akce', align: 'right', widthPx: 92 },
];

const COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_columns';
const GROUP_COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_group_columns';
const ORDER_COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_order_columns';
const VIEW_SETTINGS_STORAGE_KEY = 'alphatrade_live_copytrade_view_settings';
const GROUPS_STORAGE_KEY = 'alphatrade_live_copytrade_draft_groups';
const TEMPLATES_STORAGE_KEY = 'alphatrade_live_copytrade_templates';
const TRADOVATE_OFFICIAL_LOGO = 'https://www.tradovate.com/favicon-48.png';
const manualOperationId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const TradovateMark = ({ size = 'h-6 w-6' }: { size?: string }) => (
  <span className={`relative inline-flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm`} title="Tradovate">
    <img src={TRADOVATE_OFFICIAL_LOGO} alt="Tradovate" className="h-[76%] w-[76%] object-contain" />
  </span>
);

const FirmMark = ({ firm, withLabel = false }: { firm: string; withLabel?: boolean }) => {
  const key = firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return <span className="inline-flex min-w-0 items-center gap-1.5">
    {logo
      ? <img src={logo} alt="" className="h-6 w-6 shrink-0 rounded-full border border-black/10 bg-white object-cover" />
      : <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[8px] font-black text-white" style={{ background: firmColor(key || firm).bg }}>{firmInitials(firm)}</span>}
    {withLabel ? <span className="truncate text-xs leading-none">{firm}</span> : null}
  </span>;
};

function loadTemplates(): CopyGroupTemplate[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATES_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate, index): CopyGroupTemplate[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const record = candidate as Partial<CopyGroupTemplate>;
      const safety = record.safety && typeof record.safety === 'object'
        ? record.safety as Partial<CopyGroupSafetySettings>
        : {};
      const followers = Array.isArray(record.followers)
        ? record.followers.flatMap((follower): CopyFollowerConfig[] => {
            if (!follower || typeof follower !== 'object') return [];
            const entry = follower as Partial<CopyFollowerConfig>;
            if (!Number.isFinite(entry.accountId)) return [];
            const mode = entry.mode === 'on-fill' || entry.mode === 'off' ? entry.mode : 'on-submit';
            const maxContracts = entry.maxContracts;
            return [{
              accountId: Number(entry.accountId),
              mode,
              multiplier: normalizeMultiplier(Number(entry.multiplier ?? 1)),
              ...(Number.isSafeInteger(maxContracts) && Number(maxContracts) >= 1
                ? { maxContracts: Number(maxContracts) }
                : {}),
            }];
          })
        : [];
      return [{
        id: typeof record.id === 'string' && record.id ? record.id : `template-${index}`,
        name: typeof record.name === 'string' ? record.name : '',
        leaderAccountId: Number.isFinite(record.leaderAccountId) ? Number(record.leaderAccountId) : null,
        followers,
        safety: {
          ...DEFAULT_COPY_GROUP_SAFETY,
          positionReconciler: typeof safety.positionReconciler === 'boolean' ? safety.positionReconciler : DEFAULT_COPY_GROUP_SAFETY.positionReconciler,
          disableReplicationOnBreach: true,
          autoCloseFollowerPositions: typeof safety.autoCloseFollowerPositions === 'boolean' ? safety.autoCloseFollowerPositions : DEFAULT_COPY_GROUP_SAFETY.autoCloseFollowerPositions,
          preventHedging: typeof safety.preventHedging === 'boolean' ? safety.preventHedging : DEFAULT_COPY_GROUP_SAFETY.preventHedging,
          entryCooldownMinutes: typeof safety.entryCooldownMinutes === 'number' && Number.isFinite(safety.entryCooldownMinutes) && safety.entryCooldownMinutes >= 0
            ? Math.min(720, Math.floor(safety.entryCooldownMinutes))
            : DEFAULT_COPY_GROUP_SAFETY.entryCooldownMinutes,
        },
      }];
    });
  } catch {
    return [];
  }
}

const redactAccountName = (name: string, active: boolean, settings = DEFAULT_REDACTION) => {
  if (!active) return name;
  const visibleStart = Math.max(0, Math.min(settings.visibleStart, name.length));
  const visibleEnd = Math.max(0, Math.min(settings.visibleEnd, name.length - visibleStart));
  if (visibleStart + visibleEnd >= name.length) return name;
  return `${name.slice(0, visibleStart)}••••${visibleEnd > 0 ? name.slice(-visibleEnd) : ''}`;
};

function loadHiddenColumns(): Set<AccountColumnKey> {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as AccountColumnKey[]) : []);
  } catch {
    return new Set();
  }
}

function loadHiddenColumnSet<T extends string>(key: string): Set<T> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') as T[] : []);
  } catch {
    return new Set();
  }
}

function loadViewSettings(): { density: number; redaction: RedactionSettings; confirmRearmAfterFlatten: boolean } {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_SETTINGS_STORAGE_KEY) ?? '{}') as Partial<{
      density: number;
      redaction: Partial<RedactionSettings>;
      confirmRearmAfterFlatten: boolean;
    }>;
    const density = [80, 90, 100, 110].includes(parsed.density ?? 0) ? parsed.density as number : 100;
    return {
      density,
      redaction: {
        visibleStart: Number.isFinite(parsed.redaction?.visibleStart) ? Math.max(0, Number(parsed.redaction?.visibleStart)) : DEFAULT_REDACTION.visibleStart,
        visibleEnd: Number.isFinite(parsed.redaction?.visibleEnd) ? Math.max(0, Number(parsed.redaction?.visibleEnd)) : DEFAULT_REDACTION.visibleEnd,
      },
      confirmRearmAfterFlatten: typeof parsed.confirmRearmAfterFlatten === 'boolean' ? parsed.confirmRearmAfterFlatten : true,
    };
  } catch {
    return { density: 100, redaction: DEFAULT_REDACTION, confirmRearmAfterFlatten: true };
  }
}

interface Props {
  snapshot: LiveSnapshot;
  accountProfiles?: TradovateAccountProfile[];
  orders?: LiveOrder[];
  onAccount?: (account: LiveAccount) => void;
  onRefreshOrders?: () => Promise<void> | void;
  commandAdapter?: LiveCopyTradingAdapter;
  copierArmed?: boolean;
  /** Runtime je armed, ale pouze sleduje události a neodesílá příkazy. */
  copierObservingOnly?: boolean;
  /** Stav runtime ještě nebyl zjištěn — nesmí se vydávat za odpojený. */
  copierStatusPending?: boolean;
  copierKillSwitch?: boolean;
  apiTelemetry?: TradovateApiTelemetrySnapshot;
  /** Bezpečně přepne jedinou execution skupinu; runtime po přepnutí zůstává DISARMED. */
  onActivateGroup?: (group: CopyGroupConfig) => Promise<void> | void;
  onArmLive?: () => Promise<void> | void;
  onDisarm?: () => Promise<void> | void;
  onEmergencyStop?: () => Promise<void> | void;
  onDayLock?: () => Promise<void> | void;
  dayLockUntil?: number;
  /** Konec anti-revenge cooldownu (epoch ms); 0 = neběží. */
  cooldownUntil?: number;
  /** Operace čekající na ruční kontrolu — blokují ARM a musí být vidět. */
  stuckOperations?: CopierStuckOperation[];
  accountEligibility?: CopierAccountEligibility[];
  executionGroupId?: string | null;
  runtimeGroup?: CopyGroupConfig | null;
  onGroupsChange?: (groups: CopyGroupConfig[]) => void;
}

interface PendingAction {
  title: string;
  detail: string;
  confirmLabel: string;
  danger?: boolean;
  command?: LiveCopyTradingCommand;
  run?: () => Promise<void>;
  successText?: string;
}

function loadDraftGroups(snapshot: LiveSnapshot): CopyGroupConfig[] {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return copyGroupsFromSnapshot(snapshot);
    const parsed = JSON.parse(raw);
    return sanitizeCopyGroups(parsed) ?? copyGroupsFromSnapshot(snapshot);
  } catch {
    return copyGroupsFromSnapshot(snapshot);
  }
}

export const LiveCopyTradeOverview: React.FC<Props> = ({
  snapshot,
  accountProfiles = [],
  orders = [],
  onAccount,
  onRefreshOrders,
  commandAdapter,
  copierArmed = false,
  copierObservingOnly = false,
  copierStatusPending = false,
  copierKillSwitch = false,
  apiTelemetry,
  onActivateGroup,
  onArmLive,
  onDisarm,
  onEmergencyStop,
  onDayLock,
  dayLockUntil = 0,
  cooldownUntil = 0,
  stuckOperations = [],
  accountEligibility = [],
  executionGroupId = null,
  runtimeGroup = null,
  onGroupsChange,
}) => {
  const [initialViewSettings] = useState(loadViewSettings);
  const effectiveEligibility = useMemo(
    () => effectiveCopyTradeAccountEligibility(snapshot.accounts, accountProfiles, accountEligibility),
    [accountEligibility, accountProfiles, snapshot.accounts],
  );
  const eligibilityByAccount = useMemo(
    () => new Map(effectiveEligibility.map(entry => [entry.accountId, entry])),
    [effectiveEligibility],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(snapshot.groups.map(g => g.id)));
  const didAutoExpandGroups = useRef(false);
  const [groupTab, setGroupTab] = useState<Record<string, 'accounts' | 'orders'>>({});
  const [apiPanelOpen, setApiPanelOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<AccountColumnKey>>(loadHiddenColumns);
  const [hiddenGroupColumns, setHiddenGroupColumns] = useState<Set<GroupColumnKey>>(() => loadHiddenColumnSet<GroupColumnKey>(GROUP_COLUMNS_STORAGE_KEY));
  const [hiddenOrderColumns, setHiddenOrderColumns] = useState<Set<OrderColumnKey>>(() => loadHiddenColumnSet<OrderColumnKey>(ORDER_COLUMNS_STORAGE_KEY));
  const [groups, setGroups] = useState<CopyGroupConfig[]>(() => loadDraftGroups(snapshot));
  const [editorGroup, setEditorGroup] = useState<CopyGroupConfig | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tableSettingsOpen, setTableSettingsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [redactNames, setRedactNames] = useState(false);
  const [redaction, setRedaction] = useState<RedactionSettings>(initialViewSettings.redaction);
  const [confirmRearmAfterFlatten, setConfirmRearmAfterFlatten] = useState(initialViewSettings.confirmRearmAfterFlatten);
  const [density, setDensity] = useState(initialViewSettings.density);
  const [templates, setTemplates] = useState<CopyGroupTemplate[]>(loadTemplates);
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [copierTransition, setCopierTransition] = useState<'connecting' | 'disconnecting' | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Volba sloupců přežívá reload — je to nastavení pohledu, ne stav relace.
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...hiddenColumns]));
    } catch { /* private mode */ }
  }, [hiddenColumns]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_COLUMNS_STORAGE_KEY, JSON.stringify([...hiddenGroupColumns]));
      localStorage.setItem(ORDER_COLUMNS_STORAGE_KEY, JSON.stringify([...hiddenOrderColumns]));
      localStorage.setItem(VIEW_SETTINGS_STORAGE_KEY, JSON.stringify({ density, redaction, confirmRearmAfterFlatten }));
    } catch { /* private mode */ }
  }, [confirmRearmAfterFlatten, density, hiddenGroupColumns, hiddenOrderColumns, redaction]);

  useEffect(() => {
    setGroups(current => {
      const merged = mergeCopyGroups(current, snapshot);
      return runtimeGroup
        ? adoptRuntimeCopyGroup(merged, snapshot.accounts.map(account => account.id), runtimeGroup)
        : merged;
    });
  }, [runtimeGroup, snapshot]);

  // `enabled` zde znamená jedinou execution-aktivní skupinu, ne členství
  // účtů v uloženém profilu. Runtime je autoritativní a všechny ostatní
  // uložené skupiny musí zůstat neaktivní i když sdílejí stejné účty.
  useEffect(() => {
    if (!executionGroupId) return;
    setGroups(current => current.map(group => {
      const enabled = group.id === executionGroupId
        ? (runtimeGroup?.enabled ?? group.enabled)
        : false;
      return group.enabled === enabled ? group : { ...group, enabled };
    }));
  }, [executionGroupId, runtimeGroup?.enabled]);

  useEffect(() => {
    if (didAutoExpandGroups.current || groups.length === 0) return;
    didAutoExpandGroups.current = true;
    setExpanded(new Set(groups.map(group => group.id)));
  }, [groups]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
    } catch { /* private mode */ }
    onGroupsChange?.(groups);
  }, [groups, onGroupsChange]);

  useEffect(() => {
    try {
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
    } catch { /* private mode */ }
  }, [templates]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleColumns = useMemo(
    () => ACCOUNT_COLUMNS.filter(c => !hiddenColumns.has(c.key)),
    [hiddenColumns],
  );

  const toggleColumn = (key: AccountColumnKey) =>
    setHiddenColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const accountsById = useMemo(
    () => new Map(snapshot.accounts.map(a => [a.id, a])),
    [snapshot.accounts],
  );
  const profilesById = useMemo(() => {
    const next = new Map<number, TradovateAccountProfile>();
    for (const profile of accountProfiles) {
      const accountId = Number(profile.externalAccountId);
      if (Number.isSafeInteger(accountId)) next.set(accountId, profile);
    }
    return next;
  }, [accountProfiles]);
  const connectionByFirm = useMemo(
    () => new Map(snapshot.connections.map(c => [c.firm, c])),
    [snapshot.connections],
  );

  /** Účet je živý jen tehdy, když jeho firma hlásí aktivní připojení. */
  const isLive = (account?: LiveAccount) =>
    !!account && (connectionByFirm.get(account.firm)?.connected ?? false);

  const anyLive = snapshot.accounts.some(isLive);
  const sourceGroupsById = useMemo(() => new Map(snapshot.groups.map(group => [group.id, group])), [snapshot.groups]);

  const toggleCopierConnection = async () => {
    if (copierTransition) return;
    const connecting = !copierArmed;
    if (connecting) {
      const selectedGroup = executionGroupId != null
        ? groups.find(group => group.id === executionGroupId) ?? (runtimeGroup?.id === executionGroupId ? runtimeGroup : null)
        : runtimeGroup;
      if (selectedGroup) {
        const validation = validateCopyGroup(selectedGroup, snapshot.accounts.map(account => account.id));
        if (!validation.valid) {
          setToast({
            tone: 'error',
            text: `ARM blokován: ${validation.errors.join(' ')} Oprav skupinu přes menu ⋮ → Edit group.`,
          });
          return;
        }
      }
    }
    const action = connecting ? onArmLive : onDisarm;
    if (!action) return;
    const startedAt = Date.now();
    setCopierTransition(connecting ? 'connecting' : 'disconnecting');
    try {
      await action();
      setToast(connecting
        // Připojení znamená ostré odesílání příkazů brokerovi — potvrzení
        // musí být stejně výrazné jako u odpojení, ne tiché.
        ? { tone: 'success', text: 'Copier je připojený — příkazy leadera se kopírují naostro.' }
        : { tone: 'info', text: 'Copier je bezpečně odpojený.' });
    } catch (reason) {
      setToast({
        tone: 'error',
        text: reason instanceof Error
          ? reason.message
          : connecting ? 'Copier se nepodařilo připojit.' : 'Copier se nepodařilo odpojit.',
      });
    } finally {
      const remainingAnimation = Math.max(0, 650 - (Date.now() - startedAt));
      if (remainingAnimation > 0) await new Promise(resolve => window.setTimeout(resolve, remainingAnimation));
      setCopierTransition(null);
    }
  };

  const triggerKillSwitch = onEmergencyStop ? async () => {
    try {
      await onEmergencyStop();
      setToast({ tone: 'error', text: 'Execution runtime potvrdil kill switch. Brokerové akce copieru jsou zablokované.' });
    } catch (reason) {
      setToast({ tone: 'error', text: reason instanceof Error ? reason.message : 'Kill switch se nepodařilo potvrdit.' });
    }
  } : undefined;

  const triggerDayLock = onDayLock ? async () => {
    try {
      await onDayLock();
      setToast({ tone: 'info', text: 'Execution runtime potvrdil zámek do konce aktuální broker session.' });
    } catch (reason) {
      setToast({ tone: 'error', text: reason instanceof Error ? reason.message : 'Denní zámek se nepodařilo potvrdit.' });
    }
  } : undefined;

  const runCommand = async (command: LiveCopyTradingCommand, update?: () => void) => {
    const key = command.type === 'flatten-account' || command.type === 'set-replication' || command.type === 'set-multiplier'
      ? `${command.type}-${command.accountId}`
      : 'groupId' in command ? `${command.type}-${command.groupId}` : command.type;
    const brokerWrite = command.type === 'flatten-account' || command.type === 'flatten-group' || command.type === 'cancel-order';
    const requiresArmed = command.type === 'cancel-order';
    const commandGroupId = command.type === 'create-group' || command.type === 'update-group'
      ? command.group.id
      : 'groupId' in command ? command.groupId : null;
    const targetsExecutionRuntime = commandGroupId != null && commandGroupId === executionGroupId;
    if (busyCommand) return;
    setBusyCommand(key);
    try {
      if (brokerWrite && copierKillSwitch) {
        setToast({ tone: 'error', text: 'Kill switch je aktivní. Brokerový příkaz byl zablokován.' });
        return;
      }
      if (brokerWrite && (!commandAdapter || !targetsExecutionRuntime || (requiresArmed && !copierArmed))) {
        update?.();
        setToast({ tone: 'info', text: 'Preview pouze: tato skupina není připojená k připravenému execution runtime.' });
        return;
      }
      const result = commandAdapter && targetsExecutionRuntime
        ? await commandAdapter.execute(command)
        : undefined;
      if (result && result.type === 'flatten' && !result.flat) {
        throw new Error(
          `Flatten není potvrzen jako flat: positions=${result.remainingPositionAccounts.join(',') || 'none'} working=${result.workingOrderAccounts.join(',') || 'none'}`,
        );
      }
      update?.();
      const successText = result && result.type === 'flatten'
        ? `Flatten potvrzen: ${result.accountIds.length} účtů je flat, zrušeno ${result.canceledOrders} příkazů, odesláno ${result.submittedClosures} close příkazů.`
        : command.type === 'resolve-stuck-operation'
          ? 'Operace označena za vyřešenou. Runtime je DISARMED; před ARM proběhne nová reconciliation.'
          : command.type === 'set-multiplier'
          ? `Násobek ${normalizeMultiplier(command.multiplier)} byl potvrzen lokálním execution runtime. Runtime zůstává DISARMED do nového ARM.`
          : 'Změna byla potvrzena přes execution adaptér.';
      setToast({
        tone: commandAdapter && targetsExecutionRuntime ? 'success' : 'info',
        text: commandAdapter && targetsExecutionRuntime
          ? successText
          : 'Konfigurace byla uložena pouze lokálně. Tato skupina není připojená k execution runtime.',
      });
    } catch (reason) {
      setToast({ tone: 'error', text: reason instanceof Error ? reason.message : 'Akci se nepodařilo dokončit.' });
    } finally {
      setBusyCommand(null);
    }
  };

  const saveGroup = async (group: CopyGroupConfig) => {
    const exists = groups.some(candidate => candidate.id === group.id);
    const normalizedGroup = group.id === executionGroupId
      ? group
      : { ...group, enabled: false };
    const validation = validateCopyGroup(normalizedGroup, snapshot.accounts.map(account => account.id));
    if (!validation.valid) {
      setToast({ tone: 'error', text: validation.errors.join(' ') });
      return;
    }
    const command: LiveCopyTradingCommand = exists
      ? { type: 'update-group', group: normalizedGroup }
      : { type: 'create-group', group: normalizedGroup };
    // Editor se smí přepnout na nový leader až po potvrzení execution
    // runtime. Když broker preflight změnu odmítne, runCommand callback
    // nespustí a UI tak nikdy nelže o jiné topologii než drží worker.
    await runCommand(command, () => {
      setGroups(current => exists
        ? current.map(candidate => candidate.id === normalizedGroup.id ? normalizedGroup : candidate)
        : [...current, normalizedGroup]);
      setExpanded(current => new Set(current).add(normalizedGroup.id));
      setEditorGroup(null);
    });
  };

  const updateFollower = (groupId: string, accountId: number, patch: Partial<{ mode: ReplicationMode; multiplier: number }>) => {
    setGroups(current => current.map(group => group.id !== groupId ? group : {
      ...group,
      followers: group.followers.map(follower => follower.accountId !== accountId ? follower : {
        ...follower,
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.multiplier != null ? { multiplier: normalizeMultiplier(patch.multiplier) } : {}),
      }),
    }));
  };

  const toggleGroup = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-5" style={{ fontSize: `${density}%` }}>
      <LivePnlPanel
        open={apiPanelOpen}
        onToggle={() => setApiPanelOpen(v => !v)}
        dataActive={anyLive}
        apiReady={!!commandAdapter}
        onHelp={() => setHelpOpen(true)}
        telemetry={apiTelemetry}
      />

      {stuckOperations.length > 0 && commandAdapter ? (
        <StuckOperationsPanel
          operations={stuckOperations}
          busy={busyCommand != null}
          onResolve={operation => void runCommand({
            type: 'resolve-stuck-operation',
            groupId: executionGroupId ?? '',
            kind: operation.kind,
            key: operation.key,
            reason: `Ručně potvrzeno v LIVE UI (${operation.kind} ${operation.key})`,
          })}
        />
      ) : null}

      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-5 lg:px-6 py-4 flex-wrap">
          <h3 className="text-lg font-black text-[var(--text-primary)]">Kopírovací skupiny</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditorGroup({
                id: createLocalCopyGroupId(), name: '', enabled: false, leaderAccountId: null,
                followers: [], color: GROUP_COLORS[0], safety: { ...DEFAULT_COPY_GROUP_SAFETY }, localOnly: true,
              })}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2 text-xs font-bold text-[var(--text-secondary)] transition-colors hover:border-indigo-500/30 hover:bg-indigo-500/[0.06] hover:text-indigo-500"
            >
              <Plus size={14} /> Přidat skupinu
            </button>
            <button onClick={() => setHelpOpen(true)} title="Nápověda" className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><HelpCircle size={14} /></button>
            <button onClick={() => setTableSettingsOpen(true)} title="Table settings" className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><Settings2 size={14} /></button>
            <button onClick={() => setRedactNames(value => !value)} title={redactNames ? 'No redaction' : 'Redact account names'} className={`flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] ${redactNames ? 'bg-indigo-500/10 text-indigo-500' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{redactNames ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <TopActionsMenu
              onTemplates={() => setTemplatesOpen(true)}
              onKillSwitch={triggerKillSwitch}
              onDayLock={triggerDayLock}
              killSwitchActive={copierKillSwitch}
              dayLockActive={dayLockUntil > Date.now()}
              runtimeReady={!!commandAdapter}
            />
          </div>
        </header>

        {groups.length === 0 ? (
          <div className="px-6 pb-8 pt-2 text-center">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3">
              <Inbox size={22} />
            </div>
            <p className="text-sm font-bold text-[var(--text-primary)]">Žádné kopírovací skupiny</p>
            <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-md mx-auto">
              Přidej skupinu, vyber leader účet, followery a bezpečnostní pravidla.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-left"
              style={{ minWidth: `${Math.max(900, visibleColumns.reduce((total, column) => total + column.widthPx, 0))}px` }}
            >
              <thead>
                <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-y border-[var(--border-subtle)]">
                  <th className="w-8" />
                  <th className="px-3 py-2.5">Group</th>
                  {!hiddenGroupColumns.has('status') && <th className="px-3 py-2.5">Status</th>}
                  {!hiddenGroupColumns.has('leader') && <th className="px-3 py-2.5">Leader</th>}
                  {!hiddenGroupColumns.has('firm') && <th className="px-3 py-2.5">Firm</th>}
                  {!hiddenGroupColumns.has('followers') && <th className="px-3 py-2.5 text-right">Followers</th>}
                  {!hiddenGroupColumns.has('capital') && <th className="px-3 py-2.5 text-right">Capital</th>}
                  {!hiddenGroupColumns.has('daily') && <th className="px-3 py-2.5 text-right">Daily P&amp;L</th>}
                  {!hiddenGroupColumns.has('unreal') && <th className="px-3 py-2.5 text-right">Unreal P&amp;L</th>}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {groups.map(group => {
                  const rows = groupRows(group, accountsById, sourceGroupsById.get(group.id), profilesById);
                  const selected = group.id === executionGroupId;
                  // `groups` se po mountu synchronizují efektem, ale už první
                  // render musí respektovat autoritativní runtime `enabled`.
                  // Jinak po reloadu na okamžik svítí vypnutá skupina jako aktivní.
                  const active = selected && (runtimeGroup?.enabled ?? group.enabled);
                  // Runtime je jediný autoritativní zdroj ARM stavu. Připojení
                  // účtů, lokální group.enabled ani dostupnost adaptéru nesmí
                  // skutečně armovaný copier v UI zamaskovat jako OFF.
                  const armed = selected && copierArmed;
                  const tab = groupTab[group.id] || 'accounts';
                  return (
                    <React.Fragment key={group.id}>
                      <GroupRow
                        group={group} rows={rows} active={active} armed={armed}
                        eligibility={group.followers
                          .filter(follower => follower.mode !== 'off')
                          .map(follower => eligibilityByAccount.get(follower.accountId))}
                        observingOnly={selected && copierObservingOnly}
                        // Dokud stav neznáme, neznáme ani execution skupinu —
                        // neznámý stav proto platí pro všechny řádky.
                        statusPending={copierStatusPending && (executionGroupId == null || selected)}
                        runtimeReady={!!commandAdapter && selected}
                        transition={selected ? copierTransition : null}
                        connectBlocked={copierKillSwitch || dayLockUntil > Date.now() || cooldownUntil > Date.now()}
                        onConnectionToggle={() => void toggleCopierConnection()}
                        open={expanded.has(group.id)}
                        onToggle={() => toggleGroup(group.id)}
                        onEdit={() => setEditorGroup(structuredClone(group))}
                        templates={templates}
                        onApplyTemplate={template => {
                          const updated: CopyGroupConfig = {
                            ...group,
                            leaderAccountId: template.leaderAccountId ?? group.leaderAccountId,
                            followers: template.followers.filter(follower => follower.accountId !== (template.leaderAccountId ?? group.leaderAccountId)),
                            safety: { ...template.safety },
                          };
                          void saveGroup(updated);
                        }}
                        onToggleEnabled={() => active
                          ? setPendingAction({
                              title: 'Deaktivovat execution skupinu?',
                              detail: `Skupina ${group.name} zůstane uložená, ale nové leader příkazy se nebudou kopírovat. Runtime zůstane DISARMED.`,
                              confirmLabel: 'Deaktivovat',
                              danger: true,
                              command: { type: 'set-group-enabled', groupId: group.id, enabled: false },
                            })
                          : setPendingAction({
                              title: 'Aktivovat execution skupinu?',
                              detail: `Skupina ${group.name} nahradí současnou execution skupinu. Runtime nejprve DISARMuje a ověří starou i novou topologii jako flat a bez pracovních příkazů. Po úspěchu zůstane DISARMED; ostrý ARM je samostatný krok.`,
                              confirmLabel: 'Aktivovat',
                              run: async () => {
                                if (!onActivateGroup) throw new Error('Execution runtime nepodporuje bezpečné přepnutí skupiny.');
                                const validation = validateCopyGroup(group, snapshot.accounts.map(account => account.id));
                                if (!validation.valid) {
                                  throw new Error(`Skupinu nelze aktivovat: ${validation.errors.join(' ')} Oprav ji přes Edit group.`);
                                }
                                await onActivateGroup({ ...group, enabled: true, localOnly: true });
                                setGroups(current => current.map(candidate => ({
                                  ...candidate,
                                  enabled: candidate.id === group.id,
                                })));
                              },
                              successText: `Skupina ${group.name} je jediná aktivní execution skupina. Runtime zůstává DISARMED.`,
                            })}
                        onFlatten={() => setPendingAction({
                          title: 'Flatten All?', detail: `Připraví uzavření všech otevřených pozic ve skupině ${group.name}.`,
                          confirmLabel: 'Flatten All', danger: true, command: {
                            type: 'flatten-group', groupId: group.id, operationId: manualOperationId(),
                          },
                        })}
                        redactNames={redactNames}
                        redaction={redaction}
                        hiddenGroupColumns={hiddenGroupColumns}
                      />
                      <tr aria-hidden={!expanded.has(group.id)}>
                        <td colSpan={3 + GROUP_COLUMN_OPTIONS.length - hiddenGroupColumns.size} className="p-0">
                          <div className={`grid overflow-hidden transition-all duration-300 ease-out ${expanded.has(group.id) ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}>
                            <div className="min-h-0 overflow-hidden"><GroupDetail
                              rows={rows} tab={tab} isLive={isLive} onAccount={onAccount}
                              columns={visibleColumns}
                              orders={orders}
                              eligibilityByAccount={eligibilityByAccount}
                              busyCommand={busyCommand}
                              onRefreshOrders={onRefreshOrders}
                              onMultiplier={(accountId, multiplier) => {
                                void runCommand({ type: 'set-multiplier', groupId: group.id, accountId, multiplier }, () => updateFollower(group.id, accountId, { multiplier }));
                              }}
                              onFlattenAccount={accountId => setPendingAction({
                                title: 'Flatten účet?', detail: 'Připraví uzavření všech otevřených pozic pouze na tomto účtu.',
                                confirmLabel: 'Flatten', danger: true, command: {
                                  type: 'flatten-account', groupId: group.id, accountId, operationId: manualOperationId(),
                                },
                              })}
                              onCancelOrder={orderId => setPendingAction({
                                title: 'Zrušit příkaz?', detail: 'Připraví zrušení tohoto pracovního příkazu.',
                                confirmLabel: 'Zrušit příkaz', danger: true, command: { type: 'cancel-order', groupId: group.id, orderId },
                              })}
                              onTab={t => setGroupTab(prev => ({ ...prev, [group.id]: t }))}
                              redactNames={redactNames}
                              redaction={redaction}
                              hiddenOrderColumns={hiddenOrderColumns}
                            /></div>
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <footer className="px-5 lg:px-6 py-3 border-t border-[var(--border-subtle)] text-[11px] font-bold text-[var(--text-secondary)]">
          Total Groups: <span className="text-[var(--text-primary)]">{groups.length}</span>
        </footer>
      </section>

      {editorGroup && (
        <GroupEditorDialog
          group={editorGroup}
          isNew={!groups.some(group => group.id === editorGroup.id)}
          accounts={snapshot.accounts}
          onClose={() => setEditorGroup(null)}
          onSave={group => void saveGroup(group)}
          onDelete={groups.some(group => group.id === editorGroup.id) ? () => {
            setEditorGroup(null);
            setPendingAction({
              title: 'Smazat skupinu?', detail: `Skupina ${editorGroup.name} bude odstraněna z konfigurace.`,
              confirmLabel: 'Smazat', danger: true, command: { type: 'delete-group', groupId: editorGroup.id },
            });
          } : undefined}
          saving={busyCommand != null}
        />
      )}
      {pendingAction && (
        <ConfirmActionDialog
          action={pendingAction}
          busy={busyCommand != null}
          apiReady={!!commandAdapter}
          onClose={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            if (action.run) {
              if (busyCommand) return;
              setBusyCommand('confirmed-runtime-action');
              void action.run()
                .then(() => {
                  setPendingAction(null);
                  setToast({
                    tone: 'success',
                    text: action.successText ?? 'Potvrzená runtime akce byla úspěšně dokončena.',
                  });
                })
                .catch(reason => {
                  setToast({ tone: 'error', text: reason instanceof Error ? reason.message : 'Akci se nepodařilo dokončit.' });
                })
                .finally(() => setBusyCommand(null));
              return;
            }
            const command = action.command;
            if (!command) return;
            void runCommand(command, () => {
              if (command.type === 'set-group-enabled') {
                const { groupId, enabled } = command;
                setGroups(current => current.map(group => group.id === groupId ? { ...group, enabled } : group));
              } else if (command.type === 'delete-group') {
                const { groupId } = command;
                setGroups(current => current.filter(group => group.id !== groupId));
              }
              if (command.type === 'flatten-group' && confirmRearmAfterFlatten && onArmLive && !copierKillSwitch) {
                setPendingAction({
                  title: 'Pokračovat v kopírování?',
                  detail: 'Flatten je potvrzen: všechny účty jsou flat. ARM spustí novou reconciliation a kopírování pojede dál.',
                  confirmLabel: 'ARM & pokračovat',
                  run: async () => { await onArmLive(); },
                  successText: 'Copier je znovu ARMED — kopírování pokračuje.',
                });
              } else {
                setPendingAction(null);
              }
            });
          }}
        />
      )}
      {helpOpen && <CopyTradingHelpDialog onClose={() => setHelpOpen(false)} apiReady={!!commandAdapter} />}
      {tableSettingsOpen && <TableSettingsDialog hiddenColumns={hiddenColumns} hiddenGroupColumns={hiddenGroupColumns} hiddenOrderColumns={hiddenOrderColumns} density={density} redaction={redaction} confirmRearmAfterFlatten={confirmRearmAfterFlatten} onDensity={setDensity} onRedaction={setRedaction} onConfirmRearmAfterFlatten={setConfirmRearmAfterFlatten} onToggleColumn={toggleColumn} onToggleGroupColumn={key => setHiddenGroupColumns(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onToggleOrderColumn={key => setHiddenOrderColumns(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onReset={() => { setHiddenColumns(new Set()); setHiddenGroupColumns(new Set()); setHiddenOrderColumns(new Set()); setDensity(100); setRedaction(DEFAULT_REDACTION); setConfirmRearmAfterFlatten(true); }} onClose={() => setTableSettingsOpen(false)} />}
      {templatesOpen && <GroupTemplatesDialog templates={templates} accounts={snapshot.accounts} onChange={setTemplates} onClose={() => setTemplatesOpen(false)} />}
      {toast && <StatusToast tone={toast.tone} text={toast.text} />}
    </div>
  );
};

// ─── Live P&L & API Usage ────────────────────────────────────────────────────

// „44 chyb" bez příčiny nic neříká — rozpad ukáže, jestli jde o síť
// (klientovo prostředí), auth (session) nebo skutečné serverové chyby.
const FAILURE_CAUSE_LABEL: Record<string, string> = {
  network: 'síť', auth: 'auth', http4xx: '4xx', http5xx: '5xx',
};
const describeFailureCauses = (causes: Record<string, number>): string =>
  Object.entries(causes)
    .filter(([, count]) => count > 0)
    .map(([cause, count]) => `${FAILURE_CAUSE_LABEL[cause] ?? cause} ${count}`)
    .join(' · ') || '—';

const EMPTY_USAGE_WINDOW = { requests: 0, failures: 0, rateLimited: 0, failureCauses: { network: 0, auth: 0, http4xx: 0, http5xx: 0 } };
const EMPTY_API_TELEMETRY: TradovateApiTelemetrySnapshot = {
  minute: { ...EMPTY_USAGE_WINDOW, failureCauses: { ...EMPTY_USAGE_WINDOW.failureCauses } },
  hour: { ...EMPTY_USAGE_WINDOW, failureCauses: { ...EMPTY_USAGE_WINDOW.failureCauses } },
  day: { ...EMPTY_USAGE_WINDOW, failureCauses: { ...EMPTY_USAGE_WINDOW.failureCauses } },
  inFlight: 0,
  lastStatus: null,
  lastUpdatedAt: null,
  rateLimitedUntil: null,
};

const LivePnlPanel = ({ open, onToggle, dataActive, apiReady, onHelp, telemetry = EMPTY_API_TELEMETRY }: { open: boolean; onToggle: () => void; dataActive: boolean; apiReady: boolean; onHelp: () => void; telemetry?: TradovateApiTelemetrySnapshot }) => {
  const rows = [
    { label: 'Za minutu', usage: telemetry.minute },
    { label: 'Za hodinu', usage: telemetry.hour },
    { label: 'Za 24 hodin', usage: telemetry.day },
  ];
  return (
  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
    <header className="flex items-center justify-between px-5 lg:px-6 py-4">
      <h3 className="font-black text-[var(--text-primary)]">Live P&amp;L &amp; API Usage</h3>
      <div className="flex items-center gap-2">
        <button onClick={onHelp} title="Jak funguje Live P&L" className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center">
          <HelpCircle size={14} />
        </button>
        <button onClick={onToggle} className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
    </header>

    {open && (
      <div className="grid lg:grid-cols-[minmax(0,240px)_1fr] gap-6 px-5 lg:px-6 pb-6">
        <div className="lg:border-r lg:border-[var(--border-subtle)] lg:pr-6">
          <div className="flex items-center gap-2.5 mb-1.5">
            <span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${dataActive ? 'bg-indigo-600 justify-end' : 'bg-[var(--border-subtle)] justify-start'}`}>
              <span className="w-4 h-4 rounded-full bg-white shadow" />
            </span>
            <span className="text-sm font-bold text-[var(--text-primary)]">Live P&amp;L</span>
          </div>
          <p className={`text-xs font-bold ${dataActive ? 'text-emerald-500' : 'text-[var(--text-muted)]'}`}>
            {dataActive ? 'Broker snapshot aktivní' : 'Broker data nepřipojena'}
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] mt-1.5 leading-snug">
            {dataActive
              ? apiReady ? 'Read-only broker data i execution adaptér jsou připojené.' : 'Read-only broker snapshot je dostupný. Copier zůstává DISARMED.'
              : 'Po připojení účtů se zobrazí read-only broker snapshot pro všechny skupiny.'}
          </p>
        </div>

        <div>
          <p className="text-[11px] font-bold text-[var(--text-secondary)] mb-2">tradovate</p>
          <div className="space-y-2.5">
            {rows.map(row => (
              <div key={row.label} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-secondary)] w-20 shrink-0">{row.label}</span>
                <div className="flex-1 text-[10px] text-[var(--text-muted)]">Klientské OAuth/API požadavky</div>
                <span className="text-xs font-bold tabular-nums text-[var(--text-primary)] w-24 text-right shrink-0">
                  {row.usage.requests} požadavků
                </span>
                <span className={`text-[10px] w-40 text-right shrink-0 hidden sm:block ${row.usage.failures > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                  {row.usage.rateLimited > 0 ? `${row.usage.rateLimited}× rate limit` : row.usage.failures > 0 ? `${row.usage.failures} chyb (${describeFailureCauses(row.usage.failureCauses)})` : 'bez chyb'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Jde o přesný počet požadavků z této otevřené aplikace na AlphaTrade Tradovate proxy. Tradovate neposkytuje autoritativní procento vyčerpaného limitu; odpovědi 429 evidujeme zvlášť.
            {telemetry.inFlight > 0 ? ` Právě probíhá: ${telemetry.inFlight}.` : ''}
          </p>
        </div>
      </div>
    )}
  </section>
  );
};

// Zaseknuté operace čekající na člověka. Dřív byly vidět jen z terminálu —
// uživatel pak zíral na 'záhadně' vypnutou kopírku. Blokují ARM, takže musí
// být vedle ARM tlačítka, s důvodem a cestou ven. Resolve NIKDY neposílá
// broker příkaz; jen durable označí položku a vynutí novou reconciliation.
const STUCK_KIND_LABEL: Record<CopierStuckOperation['kind'], string> = {
  place: 'objednávka', bracket: 'OCO bracket', oso: 'OSO', 'cancel-or-modify': 'cancel/modify',
};
const StuckOperationsPanel = ({ operations, busy, onResolve }: {
  operations: CopierStuckOperation[];
  busy: boolean;
  onResolve: (operation: CopierStuckOperation) => void;
}) => {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmKey) return;
    const timer = window.setTimeout(() => setConfirmKey(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [confirmKey]);
  return (
    <section className="rounded-lg border border-amber-500/35 bg-amber-500/[0.06] px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldAlert size={15} className="shrink-0 text-amber-600" />
        <b className="text-xs text-[var(--text-primary)]">Operace čekající na ruční kontrolu ({operations.length})</b>
        <span className="hidden text-[10px] text-[var(--text-secondary)] sm:block">Blokují ARM. Ověř stav v Tradovate a teprve pak označ za vyřešené.</span>
      </div>
      <div className="mt-2 divide-y divide-amber-500/15">
        {operations.map(operation => (
          <div key={`${operation.kind}:${operation.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700">{STUCK_KIND_LABEL[operation.kind]}</span>
            <span className="rounded bg-[var(--bg-page)] px-1.5 py-0.5 text-[9px] font-black uppercase text-[var(--text-secondary)]">{operation.status}</span>
            {operation.accountId != null ? <span className="text-[10px] font-bold text-[var(--text-secondary)]">účet {operation.accountId}</span> : null}
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]" title={operation.reason}>{operation.reason ?? operation.key}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirmKey === operation.key) {
                  setConfirmKey(null);
                  onResolve(operation);
                } else {
                  setConfirmKey(operation.key);
                }
              }}
              className={`h-7 shrink-0 rounded-md px-2.5 text-[10px] font-black disabled:cursor-not-allowed disabled:opacity-40 ${confirmKey === operation.key ? 'bg-amber-600 text-white' : 'border border-amber-500/40 text-amber-700'}`}
            >
              {confirmKey === operation.key ? 'Opravdu — ověřeno v Tradovate' : 'Označit za vyřešené'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};

// ─── Řádek skupiny ───────────────────────────────────────────────────────────

interface Row {
  account?: LiveAccount;
  accountId: number | null;
  name: string;
  firm?: string;
  isLeader: boolean;
  mode: ReplicationMode;
  scale: number;
  synced: boolean;
}

/** Poskládá leadera a followery do pořadí, v jakém je zobrazuje Tradecopia. */
function groupRows(
  group: CopyGroupConfig,
  byId: Map<number, LiveAccount>,
  source?: LiveGroup,
  profilesById = new Map<number, TradovateAccountProfile>(),
): Row[] {
  const rows: Row[] = [];
  const leader = group.leaderAccountId != null ? byId.get(group.leaderAccountId) : undefined;
  const leaderProfile = group.leaderAccountId != null ? profilesById.get(group.leaderAccountId) : undefined;
  rows.push({
    account: leader,
    accountId: group.leaderAccountId,
    name: leader?.name || leaderProfile?.displayName || leaderProfile?.accountName || source?.leaderName || 'Bez leadera',
    firm: leader?.firm || leaderProfile?.propFirm || undefined,
    isLeader: true,
    mode: 'off',
    scale: 1,
    synced: true,
  });
  for (const follower of group.followers) {
    const acc = byId.get(follower.accountId);
    const profile = profilesById.get(follower.accountId);
    const sourceFollower = source?.followers.find(candidate => candidate.accountId === follower.accountId);
    rows.push({
      account: acc,
      accountId: follower.accountId,
      name: acc?.name || profile?.displayName || profile?.accountName || sourceFollower?.accountName || `Účet ${follower.accountId}`,
      firm: acc?.firm || profile?.propFirm || undefined,
      isLeader: false,
      mode: follower.mode,
      scale: follower.multiplier,
      synced: sourceFollower?.synced ?? true,
    });
  }
  return rows;
}

export const CopierConnectionSwitch = ({ connected, statusPending, runtimeReady, transition, connectBlocked, onToggle }: {
  connected: boolean;
  statusPending: boolean;
  runtimeReady: boolean;
  transition: 'connecting' | 'disconnecting' | null;
  connectBlocked: boolean;
  onToggle: () => void;
}) => {
  const busy = transition != null;
  const disabled = statusPending || !runtimeReady || busy || (!connected && connectBlocked);
  const busyLabel = transition === 'connecting' ? 'ON…' : 'OFF…';
  const title = statusPending
    ? 'Zjišťuji stav copieru…'
    : !runtimeReady
      ? 'Execution runtime není pro tuto skupinu dostupný.'
      : !connected && connectBlocked
        ? 'Connect blokuje kill switch, denní zámek nebo anti-revenge cooldown.'
        : connected ? 'Kliknutím bezpečně DISARMovat copier.' : 'Kliknutím ARMovat copier naostro.';

  // Dokud stav neznáme, nesmí přepínač tvrdit OFF — armovaný copier by se
  // tvářil jako odpojený. Neutrální „?" místo toho přiznává, že se ptáme.
  if (statusPending) {
    return (
      <span
        role="status"
        title={title}
        className="flex h-7 w-[82px] items-center justify-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-secondary)]"
      >
        <RefreshCw size={12} className="animate-spin" />
        ?
      </span>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={connected}
      aria-label={connected ? 'Disconnect copier' : 'Connect copier'}
      title={title}
      disabled={disabled}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
      className="group flex h-11 w-[82px] items-center justify-center text-[9px] font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className={`relative flex h-7 w-full items-center justify-center overflow-hidden rounded-md border px-2 transition-all duration-300 ${connected
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500 group-hover:border-rose-500/40 group-hover:bg-rose-500/10 group-hover:text-rose-500'
        : 'border-rose-500/40 bg-rose-500/10 text-rose-500 group-hover:border-emerald-500/40 group-hover:bg-emerald-500/10 group-hover:text-emerald-500'}`}>
        {busy ? (
          <span className="flex items-center gap-2">
            <RefreshCw size={12} className="animate-spin" />
            {busyLabel}
          </span>
        ) : (
          <>
            <span className={`absolute right-2 h-1.5 w-1.5 rounded-full bg-emerald-500 transition-opacity duration-200 ${connected ? 'opacity-100 group-hover:opacity-0' : 'opacity-0 group-hover:opacity-100'}`}>
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400" />
            </span>
            <Power size={12} className="absolute left-2.5 transition-transform duration-300 group-hover:rotate-90" />
            <span className="absolute left-7 right-4 overflow-hidden text-center">
              <span className="block transition-all duration-300 ease-in-out group-hover:-translate-y-full group-hover:opacity-0">
                {connected ? 'ON' : 'OFF'}
              </span>
              <span className="absolute inset-0 translate-y-full opacity-0 transition-all duration-300 ease-in-out group-hover:translate-y-0 group-hover:opacity-100">
                {connected ? 'OFF' : 'ON'}
              </span>
            </span>
          </>
        )}
      </span>
    </button>
  );
};

const GroupRow = ({ group, rows, active, armed, eligibility, observingOnly, statusPending, runtimeReady, transition, connectBlocked, onConnectionToggle, open, onToggle, onEdit, onToggleEnabled, onFlatten, redactNames, redaction, templates, onApplyTemplate, hiddenGroupColumns }: {
  group: CopyGroupConfig; rows: Row[]; active: boolean; armed: boolean; open: boolean; onToggle: () => void;
  eligibility: (CopierAccountEligibility | undefined)[];
  observingOnly: boolean;
  statusPending: boolean;
  runtimeReady: boolean;
  transition: 'connecting' | 'disconnecting' | null;
  connectBlocked: boolean;
  onConnectionToggle: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onFlatten: () => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  templates: CopyGroupTemplate[];
  onApplyTemplate: (template: CopyGroupTemplate) => void;
  hiddenGroupColumns: Set<GroupColumnKey>;
}) => {
  const capital = rows.reduce((s, r) => s + (r.account?.balance || 0), 0);
  const daily = rows.reduce((s, r) => s + (r.account?.realizedPnl || 0), 0);
  const unreal = rows.reduce((s, r) => s + (r.account?.unrealizedPnl || 0), 0);
  const unrealSource = rows.some(row => row.account?.unrealizedPnlSource === 'stale')
    ? 'stale'
    : rows.some(row => row.account?.unrealizedPnlSource === 'estimated') ? 'estimated' : 'broker';
  const firm = rows.find(r => r.isLeader)?.firm;
  const enabledFollowerCount = group.followers.filter(follower => follower.mode !== 'off').length;
  const enabledFollowerRows = rows.filter(row => !row.isLeader && row.mode !== 'off');
  const unavailableLeader = rows.some(row => row.isLeader && row.accountId != null && !row.account);
  const unavailableFollowerCount = enabledFollowerRows.filter(row => !row.account).length;
  const inactiveFollowerCount = enabledFollowerRows.filter((row, index) =>
    !row.account || (eligibility[index]?.state != null && eligibility[index]?.state !== 'active')).length;
  const activeFollowerCount = Math.max(0, enabledFollowerCount - inactiveFollowerCount);
  const dllCount = eligibility.filter(entry => entry?.state === 'dll-locked').length;
  const breachedCount = eligibility.filter(entry => entry?.state === 'breached').length;

  return (
    <tr onClick={onToggle} className="h-10 cursor-pointer border-b border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-page)]">
      <td className="pl-3">
        <button onClick={event => { event.stopPropagation(); onToggle(); }} className="w-6 h-6 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
          <ChevronRight size={14} className={`transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </button>
      </td>
      <td className="px-3 py-1.5">
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-bold" style={{ color: group.color ?? GROUP_COLORS[0] }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: group.color ?? GROUP_COLORS[0] }} />
          {group.name}
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-black text-emerald-600">
            {activeFollowerCount}/{enabledFollowerCount} aktivních
          </span>
          {dllCount > 0 ? <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-black text-amber-600">{dllCount}× DLL</span> : null}
          {breachedCount > 0 ? <span className="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[9px] font-black text-rose-600">{breachedCount}× BREACHED</span> : null}
          {unavailableFollowerCount > 0 ? <span className="rounded-full bg-slate-500/15 px-1.5 py-0.5 text-[9px] font-black text-slate-600">{unavailableFollowerCount}× nedostupný</span> : null}
          {unavailableLeader ? <span className="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[9px] font-black text-rose-600">leader nedostupný</span> : null}
        </span>
      </td>
      {!hiddenGroupColumns.has('status') && <td className="px-3 py-0">
        {!active ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 py-1 text-[9px] font-black uppercase tracking-wide text-[var(--text-secondary)]">
            Uložená
          </span>
        ) : observingOnly ? (
          <span className="inline-flex max-w-[170px] items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[9px] font-bold leading-tight text-amber-600">
            <ShieldAlert size={12} className="shrink-0" />
            Kopírka jen sleduje, neodesílá příkazy
          </span>
        ) : (
          <CopierConnectionSwitch
            connected={armed}
            statusPending={statusPending}
            runtimeReady={runtimeReady}
            transition={transition}
            connectBlocked={connectBlocked}
            onToggle={onConnectionToggle}
          />
        )}
      </td>}
      {!hiddenGroupColumns.has('leader') && <td className="px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
          <Crown size={13} className="text-amber-400 shrink-0" />
          <span className="truncate max-w-[180px]">{redactAccountName(rows.find(r => r.isLeader)?.name ?? '—', redactNames, redaction)}</span>
        </span>
      </td>}
      {!hiddenGroupColumns.has('firm') && <td className="max-w-[150px] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">{firm ? <FirmMark firm={firm} withLabel /> : '—'}</td>}
      {!hiddenGroupColumns.has('followers') && <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--text-primary)]">{group.followers.length}</td>}
      {!hiddenGroupColumns.has('capital') && <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--text-primary)]">{money.format(capital)}</td>}
      {!hiddenGroupColumns.has('daily') && <td className={`px-3 py-1.5 text-right text-xs tabular-nums font-bold ${pnlClass(daily)}`}>{money.format(daily)}</td>}
      {!hiddenGroupColumns.has('unreal') && <td className={`px-3 py-1.5 text-right text-xs tabular-nums font-bold ${pnlClass(unreal)}`} title={unrealSource === 'estimated' ? 'Součet obsahuje live odhady.' : unrealSource === 'stale' ? 'Některý účet čeká na nový snapshot.' : 'Potvrzeno broker snapshotem.'}><span className="inline-flex items-center justify-end gap-1.5">{money.format(unreal)}{unrealSource === 'stale' ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}</span></td>}
      <td className="px-3 py-0">
        <div className="flex items-center justify-end gap-1.5" onClick={event => event.stopPropagation()}>
          <button onClick={onFlatten} title="Uzavřít všechny pozice ve skupině"
            className="group flex h-11 items-center whitespace-nowrap text-[10px] font-bold text-rose-500">
            <span className="flex h-7 items-center rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-2.5 transition-colors group-hover:border-rose-500/40 group-hover:bg-rose-500/12">Flatten All</span>
          </button>
          <GroupActionMenu active={active} onToggleEnabled={onToggleEnabled} onEdit={onEdit} templates={templates} onApplyTemplate={onApplyTemplate} />
        </div>
      </td>
    </tr>
  );
};

const GroupActionMenu = ({ active, onToggleEnabled, onEdit, templates, onApplyTemplate }: {
  active: boolean;
  onToggleEnabled: () => void;
  onEdit: () => void;
  templates: CopyGroupTemplate[];
  onApplyTemplate: (template: CopyGroupTemplate) => void;
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 208) });
    }
    setOpen(value => !value);
  };
  return <div className="relative">
    <button ref={triggerRef} onClick={toggle} title="More actions" className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]"><MoreVertical size={14} /></button>
    {open ? createPortal(<>
      <button aria-label="Close group actions" className="fixed inset-0 z-[139] cursor-default" onClick={() => setOpen(false)} />
      <div className="fixed z-[140] w-52 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] py-1 shadow-xl" style={position}>
        <button onClick={() => { setOpen(false); onEdit(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-page)]"><Settings2 size={13} />Edit group</button>
        <button onClick={() => { setOpen(false); onToggleEnabled(); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-[var(--bg-page)] ${active ? 'text-amber-600' : 'text-emerald-600'}`}><Power size={13} />{active ? 'Deaktivovat execution skupinu' : 'Aktivovat pro execution'}</button>
        {templates.length ? <>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <div className="px-3 pb-1 pt-1 text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">Apply template</div>
          {templates.map(template => <button key={template.id} onClick={() => { setOpen(false); onApplyTemplate(template); }} className="w-full truncate px-3 py-2 text-left text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-page)]">{template.name}</button>)}
        </> : null}
      </div>
    </>, document.body) : null}
  </div>;
};

const TopActionsMenu = ({ onTemplates, onKillSwitch, onDayLock, killSwitchActive, dayLockActive, runtimeReady }: {
  onTemplates: () => void;
  onKillSwitch?: () => Promise<void> | void;
  onDayLock?: () => Promise<void> | void;
  killSwitchActive: boolean;
  dayLockActive: boolean;
  runtimeReady: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 192) });
    }
    setOpen(value => !value);
  };
  return <div>
    <button ref={triggerRef} onClick={toggle} title="More actions" className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><MoreVertical size={14} /></button>
    {open ? createPortal(<>
      <button aria-label="Close more actions" className="fixed inset-0 z-[139] cursor-default" onClick={() => setOpen(false)} />
      <div className="fixed z-[140] w-48 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] py-1 shadow-xl" style={position}>
        <button onClick={() => { setOpen(false); onTemplates(); }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-page)]"><Save size={13} />Group Templates</button>
        <div className="my-1 border-t border-[var(--border-subtle)]" />
        <button
          disabled={!runtimeReady || !onDayLock || killSwitchActive || dayLockActive}
          onClick={() => { setOpen(false); void onDayLock?.(); }}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-bold text-rose-500 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ShieldAlert size={13} />{dayLockActive ? 'Den je zamčený' : 'Zamknout den'}
        </button>
        <button
          disabled={!runtimeReady || !onKillSwitch || killSwitchActive}
          onClick={() => { setOpen(false); void onKillSwitch?.(); }}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-bold text-rose-600 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <AlertTriangle size={13} />{killSwitchActive ? 'Kill switch aktivní' : 'Kill switch'}
        </button>
      </div>
    </>, document.body) : null}
  </div>;
};

// ─── Detail skupiny: Accounts / Orders ───────────────────────────────────────

const orderTypeKey = (orderType: string) => orderType.trim().toLowerCase().replace(/[^a-z]/g, '');
const isStopOrder = (order: LiveOrder) => {
  const type = orderTypeKey(order.orderType);
  return type === 'stop' || type === 'stoplimit';
};
const isLimitOrder = (order: LiveOrder) => orderTypeKey(order.orderType) === 'limit';
const isPendingEntryOrder = (order: LiveOrder) => isStopOrder(order) || isLimitOrder(order);
const fullSymbolKey = (symbol: string) => symbol.trim().toUpperCase();
const displaySymbol = (symbol: string) => futuresSymbolRoot(symbol) || fullSymbolKey(symbol) || '—';
const contractQuantity = (quantity: number) => Number.isFinite(quantity)
  ? Math.abs(quantity).toLocaleString('en-US', { maximumFractionDigits: 2 })
  : '—';
const workingQuantity = (order: LiveOrder) => Number.isFinite(order.quantity) ? Math.max(0, Math.abs(order.quantity)) : 0;
const hasProtectiveAction = (order: LiveOrder, netPosition: number) => {
  const action = order.action.trim().toLowerCase();
  return netPosition > 0 ? action.includes('sell') : action.includes('buy');
};

/**
 * Compact position/order status for one account. Protection is intentionally
 * conservative: only a working opposite-side order on the exact contract can
 * protect a position. The shortened futures root is display-only.
 */
export const CopyTradePositionsCell = ({ accountId, positions, orders }: {
  accountId: number | null;
  positions: LivePosition[];
  orders: LiveOrder[];
}) => {
  const openPositions = positions.filter(position => position.netPosition !== 0);
  const workingOrders = accountId == null
    ? []
    : orders.filter(order => order.accountId === accountId && order.working);
  const openSymbols = new Set(openPositions.map(position => fullSymbolKey(position.symbol)));
  const entryOrders = workingOrders.filter(order =>
    isPendingEntryOrder(order) && !openSymbols.has(fullSymbolKey(order.symbol)));

  if (openPositions.length === 0 && entryOrders.length === 0) {
    return <span className="text-xs tabular-nums text-[var(--text-secondary)]">—</span>;
  }

  return <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
    {openPositions.map((position, index) => {
      const symbol = displaySymbol(position.symbol);
      const protectiveOrders = workingOrders.filter(order =>
        fullSymbolKey(order.symbol) === fullSymbolKey(position.symbol)
        && hasProtectiveAction(order, position.netPosition));
      const stopOrders = protectiveOrders.filter(isStopOrder);
      const targetOrders = protectiveOrders.filter(isLimitOrder);
      const hasStop = stopOrders.length > 0;
      const positionQuantity = Math.abs(position.netPosition);
      const stopCoverage = stopOrders.reduce((total, order) => total + workingQuantity(order), 0);
      const targetCoverage = targetOrders.reduce((total, order) => total + workingQuantity(order), 0);
      const stopCoverageComplete = stopCoverage >= positionQuantity;
      const protectionComplete = stopCoverageComplete && targetCoverage >= positionQuantity;
      const signedQuantity = `${position.netPosition > 0 ? '+' : '−'}${contractQuantity(position.netPosition)}`;
      const positionLabel = `${symbol} ${position.netPosition > 0 ? 'long' : 'short'} ${contractQuantity(position.netPosition)}`;
      const protectionLabel = protectionComplete
        ? 'working SL a target'
        : !hasStop ? 'bez working SL' : stopCoverageComplete ? 'working SL' : 'working SL nepokrývá celou pozici';

      return <span key={`${fullSymbolKey(position.symbol)}-${index}`} className="inline-flex items-center gap-1">
        <span
          aria-label={`${positionLabel}, ${protectionLabel}`}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-black leading-none tabular-nums ${position.netPosition > 0
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600'
            : 'border-rose-500/25 bg-rose-500/10 text-rose-600'}`}
        >
          <span>{symbol}</span><span>{signedQuantity}</span>
          {protectionComplete ? <ShieldCheck aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" /> : null}
        </span>
        {!hasStop ? <span
          aria-label={`${symbol} bez working stop lossu`}
          title={`${symbol}: pozice nemá working stop loss`}
          className="inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-1 text-[9px] font-black leading-none text-amber-600"
        ><AlertTriangle aria-hidden="true" size={9} strokeWidth={2.8} className="shrink-0" />bez SL</span> : null}
      </span>;
    })}
    {entryOrders.map(order => {
      const symbol = displaySymbol(order.symbol);
      return <span
        key={`${order.accountId}-${order.id}`}
        aria-label={`Čekající vstup ${symbol}, ${contractQuantity(order.quantity)} kontraktů`}
        title={`${order.orderType} entry čeká na fill`}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold leading-none text-[var(--text-secondary)] tabular-nums"
      ><Clock3 aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" /><span>{symbol}</span><span>{contractQuantity(order.quantity)}</span></span>;
    })}
  </span>;
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

/**
 * Eligibility pill. Connection status (tečka), způsobilost účtu (pill)
 * a poslední execution událost (řádek pod jménem) jsou tři různé věci —
 * záměrně se neslučují do jednoho zašedlého řádku.
 */
export const AccountEligibilityPill = ({ eligibility, live, unavailable = false }: {
  eligibility?: CopierAccountEligibility;
  live: boolean;
  unavailable?: boolean;
}) => {
  if (unavailable) {
    return <span title="Účet není v aktuálním OAuth snapshotu" className="inline-flex items-center gap-1 rounded-md border border-slate-500/40 bg-slate-500/15 px-2 py-1 text-[10px] font-black leading-none text-slate-600">
      <Unplug aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Nedostupný účet</span>;
  }
  const state = eligibility?.state ?? 'active';
  if (state === 'dll-locked') {
    return <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-black leading-none text-amber-600">
      <Lock aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />DLL · do konce session</span>;
  }
  if (state === 'breached') {
    return <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[10px] font-black leading-none text-rose-600">
      <Ban aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />BREACHED</span>;
  }
  if (state === 'unverifiable') {
    return <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-slate-500/40 bg-slate-500/20 px-2 py-1 text-[10px] font-black leading-none text-slate-500">
      <HelpCircle aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />Stav nelze ověřit</span>;
  }
  if (!live) {
    return <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold leading-none text-[var(--text-secondary)]">
      <Unplug aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Odpojeno</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold leading-none text-emerald-600">
    <CheckCircle2 aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Aktivní</span>;
};

const GroupDetail = ({ rows, tab, isLive, onTab, onAccount, columns, orders, eligibilityByAccount, busyCommand, onRefreshOrders, onMultiplier, onFlattenAccount, onCancelOrder, redactNames, redaction, hiddenOrderColumns }: {
  rows: Row[];
  tab: 'accounts' | 'orders';
  isLive: (a?: LiveAccount) => boolean;
  onTab: (t: 'accounts' | 'orders') => void;
  onAccount?: (a: LiveAccount) => void;
  columns: ColumnDef[];
  orders: LiveOrder[];
  eligibilityByAccount: Map<number, CopierAccountEligibility>;
  busyCommand: string | null;
  onRefreshOrders?: () => Promise<void> | void;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlattenAccount: (accountId: number) => void;
  onCancelOrder: (orderId: number) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  hiddenOrderColumns: Set<OrderColumnKey>;
}) => {
  const accountIds = new Set(rows.flatMap(row => row.accountId != null ? [row.accountId] : []));
  const groupOrders = orders.filter(order => order.accountId != null && accountIds.has(order.accountId));
  return (
  <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-app)]/40 pb-2">
    <div className="flex items-center justify-between gap-3 px-3 pt-1.5 lg:px-4">
      <div className="flex items-center gap-1">
        {(['accounts', 'orders'] as const).map(t => (
          <button
            key={t} onClick={() => onTab(t)}
            className={`border-b-2 px-3 py-1.5 text-[11px] font-bold transition-colors ${tab === t
              ? 'border-indigo-500 text-indigo-500'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {t === 'accounts' ? 'Accounts' : 'Orders'}
          </button>
        ))}
      </div>
      {tab === 'orders' && (
        <div className="flex items-center gap-1.5">
          {(() => {
            const followers = rows.filter(row => !row.isLeader && row.accountId != null);
            const active = followers.filter(row => row.account
              && (eligibilityByAccount.get(row.accountId as number)?.state ?? 'active') === 'active');
            const excluded = followers.length - active.length;
            return <span className="inline-flex items-center gap-1.5">
              <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${excluded > 0
                ? 'border border-amber-500/40 bg-amber-500/15 text-amber-600'
                : 'border border-emerald-500/25 bg-emerald-500/10 text-emerald-600'}`}>
                Followeři {active.length}/{followers.length} aktivní
              </span>
              {excluded > 0 ? <span className="text-[10px] font-bold text-amber-600">{excluded}× vyřazen z kopírování</span> : null}
            </span>;
          })()}
          <span className="text-[10px] font-bold text-[var(--text-muted)]">{groupOrders.filter(order => order.working).length} working</span>
          <button onClick={() => void onRefreshOrders?.()} title="Obnovit příkazy" className="w-7 h-7 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-indigo-500 flex items-center justify-center"><RefreshCw size={13} /></button>
        </div>
      )}
    </div>

    {tab === 'accounts' ? (
      <div>
        <table
          className="w-full table-fixed text-left"
          style={{ minWidth: `${columns.reduce((total, column) => total + column.widthPx, 0)}px` }}
        >
          <colgroup>
            {columns.map(column => <col key={column.key} style={{ width: `${column.widthPx}px` }} />)}
          </colgroup>
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`px-3 py-1.5 whitespace-nowrap ${col.key === 'qtyMult' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}`}
                >
                  {col.key === 'actions' ? '' : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <AccountRow
                key={`${row.name}-${i}`} row={row} live={isLive(row.account)} onAccount={onAccount} columns={columns}
                orders={groupOrders}
                eligibility={row.accountId != null ? eligibilityByAccount.get(row.accountId) : undefined}
                busyCommand={busyCommand}
                onMultiplier={onMultiplier} onFlatten={onFlattenAccount}
                redactNames={redactNames} redaction={redaction}
              />
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      groupOrders.length === 0 ? (
        <div className="py-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3"><Inbox size={22} /></div>
          <p className="text-sm font-bold text-[var(--text-primary)]">No orders for this group</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-sm mx-auto leading-snug">Ordery se objeví, jakmile leader zadá obchod, který se replikuje na followery.</p>
        </div>
      ) : (
        <div className="pt-2">
          <table className="w-full min-w-[760px] text-left">
            <thead><tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
              {!hiddenOrderColumns.has('account') && <th className="px-3 py-2">Account</th>}{!hiddenOrderColumns.has('broker') && <th className="px-3 py-2">Broker</th>}{!hiddenOrderColumns.has('symbol') && <th className="px-3 py-2">Symbol</th>}{!hiddenOrderColumns.has('action') && <th className="px-3 py-2">Action</th>}{!hiddenOrderColumns.has('type') && <th className="px-3 py-2">Type</th>}{!hiddenOrderColumns.has('qty') && <th className="px-3 py-2 text-right">Qty</th>}{!hiddenOrderColumns.has('limit') && <th className="px-3 py-2 text-right">Limit Price</th>}{!hiddenOrderColumns.has('stop') && <th className="px-3 py-2 text-right">Stop Price</th>}{!hiddenOrderColumns.has('status') && <th className="px-3 py-2">Status</th>}{!hiddenOrderColumns.has('timestamp') && <th className="px-3 py-2">Timestamp</th>}{!hiddenOrderColumns.has('orderId') && <th className="px-3 py-2 text-right">Order ID</th>}<th className="px-3 py-2" />
            </tr></thead>
            <tbody>{groupOrders.map(order => (
              <tr key={`${order.accountId}-${order.id}`} className="border-b border-[var(--border-subtle)] last:border-0 text-xs">
                {!hiddenOrderColumns.has('account') && <td className="px-3 py-2.5 font-bold text-[var(--text-primary)]">{redactAccountName(order.accountName, redactNames, redaction)}</td>}
                {!hiddenOrderColumns.has('broker') && <td className="px-3 py-2.5"><TradovateMark size="h-5 w-5" /></td>}
                {!hiddenOrderColumns.has('symbol') && <td className="px-3 py-2.5 text-[var(--text-secondary)]">{order.symbol}</td>}
                {!hiddenOrderColumns.has('action') && <td className={`px-3 py-2.5 font-bold ${order.action.toLowerCase().includes('buy') ? 'text-emerald-500' : 'text-rose-500'}`}>{order.action}</td>}
                {!hiddenOrderColumns.has('type') && <td className="px-3 py-2.5 text-[var(--text-secondary)]">{order.orderType}</td>}
                {!hiddenOrderColumns.has('qty') && <td className="px-3 py-2.5 text-right tabular-nums">{order.quantity}</td>}
                {!hiddenOrderColumns.has('limit') && <td className="px-3 py-2.5 text-right tabular-nums">{order.price ?? '—'}</td>}
                {!hiddenOrderColumns.has('stop') && <td className="px-3 py-2.5 text-right tabular-nums">{order.stopPrice ?? '—'}</td>}
                {!hiddenOrderColumns.has('status') && <td className="px-3 py-2.5"><span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase ${order.working ? 'bg-blue-500/10 text-blue-500' : 'bg-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>{order.status}</span></td>}
                {!hiddenOrderColumns.has('timestamp') && <td className="px-3 py-2.5 text-[var(--text-secondary)]">{order.placedAt ? new Date(order.placedAt).toLocaleString() : '—'}</td>}
                {!hiddenOrderColumns.has('orderId') && <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-secondary)]">{order.id}</td>}
                <td className="px-3 py-2.5 text-right"><button disabled={!order.working || busyCommand != null} onClick={() => onCancelOrder(order.id)} className="px-2.5 py-1.5 rounded-lg border border-rose-500/20 text-rose-500 font-bold disabled:opacity-35">Cancel</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )
    )}
  </div>
  );
};

const AccountRow = ({ row, live, onAccount, columns, orders, eligibility, busyCommand, onMultiplier, onFlatten, redactNames, redaction }: {
  row: Row; live: boolean; onAccount?: (a: LiveAccount) => void; columns: ColumnDef[];
  orders: LiveOrder[];
  eligibility?: CopierAccountEligibility;
  busyCommand: string | null;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlatten: (accountId: number) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
}) => {
  const a = row.account;
  const accountId = row.accountId;
  const cushion = a?.cushion ?? null;

  const cell = (key: AccountColumnKey): React.ReactNode => {
    switch (key) {
      case 'account':
        return (
          <span className="block">
            <span className="flex items-center gap-2 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <span className={`truncate max-w-[190px] ${live ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{redactAccountName(row.name, redactNames, redaction)}</span>
            {row.isLeader && (
              <span title="Leader účet" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-amber-400/35 bg-amber-400/12 text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.12)]">
                <Crown size={14} strokeWidth={2.4} />
              </span>
            )}
            {!row.synced && <span title="Nesedí s leaderem" className="text-amber-500">⚠</span>}
            </span>
            {!a && accountId != null ? (
              <span className="block pl-3.5 text-[10px] font-bold leading-tight text-slate-500">
                Účet není v aktuálním OAuth snapshotu. Oprav skupinu přes Edit group.
              </span>
            ) : eligibility?.lastExecution ? (
              <span className="block pl-3.5 text-[10px] leading-tight text-rose-500/90">
                Příkaz odmítnut · {eligibility.lastExecution.reason ?? 'bez důvodu'} · {timeLabel(eligibility.lastExecution.at)}
              </span>
            ) : eligibility && eligibility.state !== 'active' && eligibility.reason ? (
              <span className="block pl-3.5 text-[10px] leading-tight text-[var(--text-muted)]">{eligibility.reason}</span>
            ) : null}
          </span>
        );
      case 'status':
        return <AccountEligibilityPill eligibility={eligibility} live={live} unavailable={!a && accountId != null} />;
      case 'broker':
        return <TradovateMark size="h-5 w-5" />;
      case 'firm':
        return row.firm ? <FirmMark firm={row.firm} withLabel /> : <span className="text-[11px] text-[var(--text-secondary)]">—</span>;
      case 'balance':
        return <span className="text-xs tabular-nums text-[var(--text-primary)]">{a ? money.format(a.balance) : '—'}</span>;
      case 'positions':
        return a
          ? <CopyTradePositionsCell accountId={accountId} positions={a.positions} orders={orders} />
          : <span className="text-xs tabular-nums text-[var(--text-secondary)]">—</span>;
      case 'daily':
        return <span className={`text-xs tabular-nums ${a ? pnlClass(a.realizedPnl) : ''}`}>{a ? money.format(a.realizedPnl) : '—'}</span>;
      case 'unreal':
        return a ? <span
          className={`inline-flex items-center justify-end gap-1.5 text-xs tabular-nums ${pnlClass(a.unrealizedPnl)}`}
          title={a.unrealizedPnlSource === 'estimated'
            ? 'Live odhad podle skutečné vstupní ceny účtu a posledního broker snapshotu.'
            : a.unrealizedPnlSource === 'stale' ? 'Čeká na nový broker snapshot.' : 'Potvrzeno broker snapshotem.'}
        >
          {money.format(a.unrealizedPnl)}
          {a.unrealizedPnlSource === 'stale' ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label="Čeká na snapshot" /> : null}
        </span> : <span className="text-xs text-[var(--text-secondary)]">—</span>;
      case 'distDd':
        return <span className={`text-xs tabular-nums font-bold ${cushionClass(cushion)}`}>{cushion != null ? plain.format(cushion) : '—'}</span>;
      case 'execLimit':
        return <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">—</span>;
      case 'qtyMult':
        return row.isLeader || accountId == null
          ? <span className="mx-auto flex w-full items-center justify-center text-center text-[11px] text-[var(--text-secondary)]">—</span>
          : <label onClick={event => event.stopPropagation()} className="inline-flex items-center justify-end gap-1 text-[11px] text-[var(--text-secondary)]">
              <input
                aria-label={`Násobek ${row.name}`}
                key={`${accountId}-${row.scale}`}
                type="number" min="0.01" max="100" step="0.25" defaultValue={row.scale}
                disabled={busyCommand != null}
                onBlur={event => onMultiplier(accountId, Number(event.target.value))}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                className="w-14 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-1.5 py-1 text-center tabular-nums outline-none focus:border-indigo-500"
              />
            </label>;
      case 'actions':
        return null;
    }
  };

  return (
    <tr
      onClick={() => a && onAccount?.(a)}
      className={`border-b border-[var(--border-subtle)] last:border-0 transition-colors ${a ? 'cursor-pointer hover:bg-[var(--bg-card)]' : ''}`}
    >
      {columns.map(col => (
        <td key={col.key} className={`px-3 ${col.key === 'actions' ? 'py-0' : 'py-1.5'} ${col.key === 'qtyMult' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}`}>
          {col.key === 'actions' && a ? (
            <button
              disabled={busyCommand != null}
              onClick={event => { event.stopPropagation(); onFlatten(a.id); }}
              className="group flex h-11 items-center whitespace-nowrap text-[10px] font-bold text-[var(--text-secondary)] hover:text-rose-500 disabled:opacity-40"
            ><span className="flex h-7 items-center rounded-md border border-[var(--border-subtle)] px-2.5 group-hover:border-rose-500/25">Flatten</span></button>
          ) : cell(col.key)}
        </td>
      ))}
    </tr>
  );
};

// ─── Dialogy a lokální command režim ────────────────────────────────────────

export const changeCopyGroupLeader = (
  group: CopyGroupConfig,
  nextLeaderAccountId: number,
  availableAccountIds?: Iterable<number>,
): CopyGroupConfig => {
  if (group.leaderAccountId === nextLeaderAccountId) return group;

  const previousLeaderAccountId = group.leaderAccountId;
  const promotedFollower = group.followers.find(follower => follower.accountId === nextLeaderAccountId);
  const followers = group.followers.filter(follower => follower.accountId !== nextLeaderAccountId);

  const previousLeaderAvailable = previousLeaderAccountId != null
    && (availableAccountIds == null || new Set(availableAccountIds).has(previousLeaderAccountId));
  if (previousLeaderAvailable && !followers.some(follower => follower.accountId === previousLeaderAccountId)) {
    followers.push(promotedFollower
      ? { ...promotedFollower, accountId: previousLeaderAccountId }
      : { accountId: previousLeaderAccountId, mode: 'on-submit', multiplier: 1 });
  }

  return { ...group, leaderAccountId: nextLeaderAccountId, followers };
};

const GroupEditorDialog = ({ group, isNew, accounts, saving, onClose, onSave, onDelete }: {
  group: CopyGroupConfig;
  isNew: boolean;
  accounts: LiveAccount[];
  saving: boolean;
  onClose: () => void;
  onSave: (group: CopyGroupConfig) => void;
  onDelete?: () => void;
}) => {
  const [draft, setDraft] = useState<CopyGroupConfig>(() => ({
    ...structuredClone(group),
    color: group.color ?? GROUP_COLORS[0],
    safety: group.safety ?? { ...DEFAULT_COPY_GROUP_SAFETY },
  }));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const followerById = new Map(draft.followers.map(follower => [follower.accountId, follower]));
  const availableAccountIds = useMemo(() => accounts.map(account => account.id), [accounts]);
  const unavailable = unavailableCopyGroupAccounts(draft, availableAccountIds);
  const unavailableFollowers = draft.followers.filter(follower => unavailable.followerAccountIds.includes(follower.accountId));
  const followerCandidates = accounts.filter(account => account.id !== draft.leaderAccountId);
  const allFollowersSelected = followerCandidates.length > 0
    && followerCandidates.every(account => followerById.has(account.id));
  const toggleFollower = (accountId: number) => {
    setDraft(current => ({
      ...current,
      followers: current.followers.some(follower => follower.accountId === accountId)
        ? current.followers.filter(follower => follower.accountId !== accountId)
        : [...current.followers, { accountId, mode: 'on-submit', multiplier: 1 }],
    }));
  };
  const toggleAllFollowers = () => {
    const candidateIds = new Set(followerCandidates.map(account => account.id));
    setDraft(current => ({
      ...current,
      followers: allFollowersSelected
        ? current.followers.filter(follower => !candidateIds.has(follower.accountId))
        : [
            ...current.followers.filter(follower => !candidateIds.has(follower.accountId)),
            ...followerCandidates.map(account => current.followers.find(follower => follower.accountId === account.id)
              ?? { accountId: account.id, mode: 'on-submit' as const, multiplier: 1 }),
          ],
    }));
  };

  const submit = () => {
    const validation = validateCopyGroup(draft, accounts.map(account => account.id));
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    onSave({ ...draft, name: draft.name.trim() });
  };

  const next = () => {
    if (step === 0 && !draft.name.trim()) return setErrors(['Zadej název skupiny.']);
    if (step === 1 && draft.leaderAccountId == null) return setErrors(['Vyber leader účet.']);
    if (step === 1 && unavailable.leaderAccountId != null) return setErrors([`Uložený leader účet ${unavailable.leaderAccountId} není dostupný. Vyber aktuální leader účet.`]);
    if (step === 2 && draft.followers.length === 0) return setErrors(['Vyber alespoň jeden follower účet.']);
    if (step === 2 && unavailableFollowers.length > 0) return setErrors([`Nahraď nebo odeber ${unavailableFollowers.length} nedostupný follower účet.`]);
    setErrors([]);
    setStep(current => Math.min(3, current + 1));
  };

  const steps = ['Identita', 'Leader', 'Followeři', 'Nastavení'];
  const safety = draft.safety ?? DEFAULT_COPY_GROUP_SAFETY;
  const updateSafety = <K extends keyof CopyGroupSafetySettings>(key: K, value: CopyGroupSafetySettings[K]) => setDraft(current => ({
    ...current,
    safety: { ...(current.safety ?? DEFAULT_COPY_GROUP_SAFETY), [key]: value },
  }));

  return createPortal(
    <div className="fixed inset-0 z-[150] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="Nastavení kopírovací skupiny" className="w-full max-w-3xl max-h-[92vh] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl flex flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-black text-[var(--text-primary)]">{isNew ? 'Vytvořit kopírovací skupinu' : 'Upravit kopírovací skupinu'}</h3>
          <button onClick={onClose} disabled={saving} className="w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] flex items-center justify-center disabled:opacity-40"><X size={18} /></button>
        </header>

        <div className="grid grid-cols-4 border-b border-[var(--border-subtle)] px-5">
          {steps.map((label, index) => <button key={label} type="button" onClick={() => index <= step && setStep(index)} className={`relative flex items-center justify-center gap-2 py-3 text-[11px] font-black ${index === step ? 'text-indigo-500' : index < step ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}><span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[9px] ${index <= step ? 'border-indigo-500 bg-indigo-500/10' : 'border-[var(--border-subtle)]'}`}>{index + 1}</span>{label}{index === step ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-500" /> : null}</button>)}
        </div>

        <div className="p-5 overflow-y-auto custom-scrollbar min-h-[360px]">
          {step === 0 ? <div className="mx-auto max-w-xl space-y-6"><div><h4 className="text-xl font-black text-[var(--text-primary)]">Pojmenuj skupinu</h4><p className="mt-1.5 text-sm text-[var(--text-secondary)]">Zvol název, který snadno poznáš v tabulce kopírování. Později ho můžeš změnit.</p></div><label className="block space-y-2"><span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Název skupiny</span><input autoFocus value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="např. Tradeify 50K" className="h-11 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-sm font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500" /></label><div><div className="mb-2 text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Barva</div><div className="flex flex-wrap gap-2.5">{GROUP_COLORS.map(color => <button key={color} type="button" aria-label={`Barva ${color}`} onClick={() => setDraft(current => ({ ...current, color }))} className={`h-8 w-8 rounded-full border-4 transition-transform ${draft.color === color ? 'scale-110 border-[var(--text-primary)]' : 'border-transparent'}`} style={{ backgroundColor: color }} />)}</div><p className="mt-2 text-[11px] text-[var(--text-muted)]">Pomůže ti rychle rozlišit jednotlivé skupiny.</p></div></div> : null}

          {step === 1 ? <div className="space-y-4"><div><h4 className="text-xl font-black text-[var(--text-primary)]">Vyber leader účet</h4><p className="mt-1.5 text-sm text-[var(--text-secondary)]">Obchody leadera se budou kopírovat na všechny followery v této skupině. Stejný účet může být uložený i v jiných skupinách; execution-aktivní bude vždy pouze jedna.</p></div>{unavailable.leaderAccountId != null ? <div className="flex gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/[0.08] p-3 text-amber-700"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div><b className="block text-xs">Uložený leader {unavailable.leaderAccountId} už není dostupný</b><span className="mt-0.5 block text-[11px] leading-relaxed">Vyber níže aktuální účet. AlphaTrade náhradu nikdy nehádá automaticky.</span></div></div> : null}<div className="grid gap-2 sm:grid-cols-2">{accounts.map(account => {
            const active = draft.leaderAccountId === account.id;
            return <button
              key={account.id}
              type="button"
              onClick={() => setDraft(current => changeCopyGroupLeader(current, account.id, availableAccountIds))}
              className={`flex items-center gap-3 rounded-lg border p-3 text-left ${active ? 'border-indigo-500 bg-indigo-500/[0.06]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-page)]'}`}
            ><span className={`flex h-9 w-9 items-center justify-center rounded-full ${active ? 'bg-indigo-600 text-white' : 'bg-[var(--bg-page)] text-[var(--text-secondary)]'}`}><Crown size={16} /></span><span className="min-w-0"><b className="block truncate text-xs text-[var(--text-primary)]">{account.name}</b><span className="mt-0.5 block truncate text-[10px] text-[var(--text-secondary)]">{account.firm} · {money.format(account.balance)}</span></span>{active ? <Check size={16} className="ml-auto text-indigo-500" /> : null}</button>;
          })}</div></div> : null}

          {step === 2 ? <div className="space-y-4"><div className="flex items-end justify-between gap-3"><div><h4 className="text-xl font-black text-[var(--text-primary)]">Vyber followery</h4><p className="mt-1.5 text-sm text-[var(--text-secondary)]">Vyber účty, které mají kopírovat leadera. Uložené skupiny se mohou překrývat; současně se spustí jen jedna execution skupina.</p></div><div className="flex items-center gap-3"><button type="button" onClick={toggleAllFollowers} disabled={followerCandidates.length === 0} className="text-xs font-black text-indigo-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40">{allFollowersSelected ? 'Zrušit výběr' : 'Označit vše'}</button><span className="text-xs font-black text-indigo-500">Vybráno: {draft.followers.length}</span></div></div>{unavailableFollowers.length > 0 ? <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.07] p-3"><div className="flex gap-2.5"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" /><div><b className="block text-xs text-amber-700">Nedostupné účty v uložené skupině</b><span className="mt-0.5 block text-[11px] text-amber-700/80">Vyber přesnou náhradu z OAuth snapshotu, nebo starý účet odeber. Nic se nepáruje automaticky.</span></div></div><div className="mt-3 space-y-2">{unavailableFollowers.map(follower => {
            const replacementCandidates = accounts.filter(account => account.id !== draft.leaderAccountId && !draft.followers.some(item => item.accountId === account.id));
            return <div key={follower.accountId} className="grid gap-2 rounded-md border border-amber-500/20 bg-[var(--bg-card)] p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(190px,1fr)_auto] sm:items-center"><span><b className="block text-xs text-[var(--text-primary)]">Účet {follower.accountId}</b><span className="block text-[10px] text-[var(--text-secondary)]">{follower.mode === 'on-fill' ? 'Při vyplnění' : follower.mode === 'off' ? 'Vypnuto' : 'Při zadání'} · násobek {follower.multiplier}</span></span><select aria-label={`Nahradit nedostupný účet ${follower.accountId}`} defaultValue="" onChange={event => { const replacementId = Number(event.target.value); if (Number.isSafeInteger(replacementId)) setDraft(current => replaceCopyGroupFollowerAccount(current, follower.accountId, replacementId)); }} className="h-9 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]"><option value="">Vyber náhradu…</option>{replacementCandidates.map(account => <option key={account.id} value={account.id}>{account.name} · {account.firm}</option>)}</select><button type="button" onClick={() => setDraft(current => ({ ...current, followers: current.followers.filter(item => item.accountId !== follower.accountId) }))} className="h-9 rounded-md border border-rose-500/25 px-3 text-xs font-bold text-rose-500 hover:bg-rose-500/10">Odebrat</button></div>;
          })}</div></div> : null}<div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]"><div className="grid grid-cols-[minmax(0,1fr)_130px_84px_64px] gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 py-2 text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]"><span>Účet</span><span>Replikace</span><span className="text-right">Násobek</span><span className="text-right" title="Tvrdý strop expozice; překročení odmítne celý příkaz a odzbrojí copier">Max</span></div>{followerCandidates.map(account => {
            const follower = followerById.get(account.id);
            return <div key={account.id} className={`grid grid-cols-[minmax(0,1fr)_130px_84px_64px] items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5 last:border-0 ${follower ? 'bg-indigo-500/[0.035]' : ''}`}><label className="flex min-w-0 cursor-pointer items-center gap-2.5"><input type="checkbox" checked={!!follower} onChange={() => toggleFollower(account.id)} className="accent-indigo-600" /><span className="min-w-0"><b className="block truncate text-xs text-[var(--text-primary)]">{account.name}</b><span className="block truncate text-[10px] text-[var(--text-secondary)]">{account.firm} · {money.format(account.balance)}</span></span></label><select disabled={!follower} value={follower?.mode ?? 'on-submit'} onChange={event => setDraft(current => ({ ...current, followers: current.followers.map(item => item.accountId === account.id ? { ...item, mode: event.target.value as ReplicationMode } : item) }))} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-[11px] font-bold text-[var(--text-primary)] disabled:opacity-35"><option value="off">Vypnuto</option><option value="on-submit">Při zadání</option><option value="on-fill">Při vyplnění</option></select><input aria-label={`Násobek ${account.name}`} disabled={!follower} type="number" min="0.01" max="100" step="0.25" value={follower?.multiplier ?? 1} onChange={event => setDraft(current => ({ ...current, followers: current.followers.map(item => item.accountId === account.id ? { ...item, multiplier: Number(event.target.value) } : item) }))} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-right text-[11px] font-bold text-[var(--text-primary)] disabled:opacity-35" /><input aria-label={`Max kontrakty ${account.name}`} title="Tvrdý strop expozice na symbol; překročení odmítne celý příkaz a odzbrojí copier; prázdné = bez limitu" disabled={!follower} type="number" min="1" step="1" placeholder="∞" value={follower?.maxContracts ?? ''} onChange={event => setDraft(current => ({ ...current, followers: current.followers.map(item => item.accountId === account.id ? { ...item, maxContracts: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : undefined } : item) }))} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-right text-[11px] font-bold text-[var(--text-primary)] disabled:opacity-35" /></div>;
          })}</div></div> : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div>
                <h4 className="text-xl font-black text-[var(--text-primary)]">Nastavení skupiny</h4>
                <p className="mt-1.5 text-sm text-[var(--text-secondary)]">Nastav ochrany kopírování pro tuto skupinu.</p>
              </div>
              <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                {([
                  ['positionReconciler', 'Kontrola shody pozic', 'Po každém vyplnění followera ověří, že nová pozice odpovídá směru a symbolu leadera.'],
                  ['disableReplicationOnBreach', 'Zastavit skupinu při nesouladu', 'Povinná fail-closed ochrana: rozdíl na jediném followerovi okamžitě zastaví replikaci celé skupiny.'],
                  ['autoCloseFollowerPositions', 'Automaticky zavřít pozice followerů', 'Jakmile se zavře pozice leadera, automaticky zavře odpovídající pozice followerů.'],
                  ['preventHedging', 'Zabránit opačné pozici', 'Nedovolí opačnému příkazu překlopit follower účet do obráceného směru.'],
                ] as const).map(([key, title, detail]) => {
                  const mandatory = key === 'disableReplicationOnBreach';
                  return (
                    <label key={key} className={`flex items-start gap-3 px-4 py-3.5 ${mandatory ? 'cursor-not-allowed bg-emerald-500/[0.025]' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={mandatory ? true : safety[key]} disabled={mandatory} onChange={event => updateSafety(key, event.target.checked)} className="mt-1 accent-indigo-600" />
                      <span>
                        <b className="block text-xs text-[var(--text-primary)]">{title}{mandatory ? <span className="ml-2 text-[9px] uppercase text-emerald-600">Povinné</span> : null}</b>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-secondary)]">{detail}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
                <span>
                  <b className="block text-xs text-[var(--text-primary)]">Pauza po uzavření pozice</b>
                  <span className="mt-0.5 block text-[11px] text-[var(--text-secondary)]">Po potvrzeném zploštění celé skupiny zablokuje ostrý ARM. Nula znamená vypnuto.</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <input
                    aria-label="Cooldown po uzavření v minutách"
                    type="number"
                    min="0"
                    max="720"
                    step="1"
                    value={safety.entryCooldownMinutes}
                    onChange={event => updateSafety('entryCooldownMinutes', Math.min(720, Math.max(0, Math.floor(Number(event.target.value) || 0))))}
                    className="h-9 w-20 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-xs font-bold text-[var(--text-primary)]"
                  />
                  <span className="text-[11px] font-bold text-[var(--text-secondary)]">min</span>
                </span>
              </label>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
                <span>
                  <b className="block text-xs text-[var(--text-primary)]">Auto-zavření kopií</b>
                  <span className="mt-0.5 block text-[11px] text-[var(--text-secondary)]">Když copier přestane kopírovat s otevřenou pozicí (vypršení ARM nebo fail-closed chyba), risk-redukčně zavře kopie. Nikdy nezvětší pozici ani neotočí směr.</span>
                </span>
                <select
                  aria-label="Akce po vypršení ARM"
                  value={safety.armExpiryFlatten}
                  onChange={event => updateSafety('armExpiryFlatten', event.target.value as CopyGroupSafetySettings['armExpiryFlatten'])}
                  className="h-9 shrink-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]"
                >
                  <option value="followers">Zavřít followery</option>
                  <option value="group">Zavřít celou skupinu</option>
                  <option value="off">Nezavírat (jen DISARM)</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
                <span>
                  <b className="block text-xs text-[var(--text-primary)]">Auto day-lock: denní ztráta</b>
                  <span className="mt-0.5 block text-[11px] text-[var(--text-secondary)]">Realizovaná denní ztráta leadera, při které se copier po zploštění skupiny sám zamkne do konce session. Nula znamená vypnuto.</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <input
                    aria-label="Denní ztrátový limit v USD"
                    type="number"
                    min="0"
                    step="50"
                    value={safety.dailyLossLimitUsd}
                    onChange={event => updateSafety('dailyLossLimitUsd', Math.min(1_000_000, Math.max(0, Number(event.target.value) || 0)))}
                    className="h-9 w-24 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-xs font-bold text-[var(--text-primary)]"
                  />
                  <span className="text-[11px] font-bold text-[var(--text-secondary)]">USD</span>
                </span>
              </label>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
                <span>
                  <b className="block text-xs text-[var(--text-primary)]">Auto day-lock: ztrátové obchody</b>
                  <span className="mt-0.5 block text-[11px] text-[var(--text-secondary)]">Počet ztrátových obchodů leadera za den, po kterém se copier po zploštění zamkne. Nula znamená vypnuto.</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <input
                    aria-label="Max ztrátových obchodů za den"
                    type="number"
                    min="0"
                    max="50"
                    step="1"
                    value={safety.dailyMaxLosingTrades}
                    onChange={event => updateSafety('dailyMaxLosingTrades', Math.min(50, Math.max(0, Math.floor(Number(event.target.value) || 0))))}
                    className="h-9 w-20 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-xs font-bold text-[var(--text-primary)]"
                  />
                  <span className="text-[11px] font-bold text-[var(--text-secondary)]">obchodů</span>
                </span>
              </label>
              <div className="flex items-start gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045] px-4 py-3">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-indigo-500" />
                <span>
                  <b className="block text-xs text-[var(--text-primary)]">Uložený profil skupiny</b>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-secondary)]">Skupinu uložíš bez automatické aktivace. Z menu skupiny ji můžeš bezpečně zvolit jako jedinou execution skupinu; runtime po přepnutí zůstane DISARMED až do samostatného ARM.</span>
                </span>
              </div>
            </div>
          ) : null}

          {errors.length > 0 && <div className="rounded-md border border-rose-500/25 bg-rose-500/8 p-3.5 flex gap-2.5"><AlertTriangle size={17} className="text-rose-500 shrink-0 mt-0.5" /><div className="space-y-1">{errors.map(error => <div key={error} className="text-xs font-bold text-rose-500">{error}</div>)}</div></div>}
        </div>

        <footer className="px-5 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <div>{onDelete ? <button onClick={onDelete} disabled={saving} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-rose-500 hover:bg-rose-500/10"><Trash2 size={14} /> Smazat</button> : <button onClick={onClose} disabled={saving} className="h-9 rounded-lg border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zrušit</button>}</div>
          <div className="flex gap-2">{step > 0 ? <button onClick={() => { setErrors([]); setStep(current => current - 1); }} disabled={saving} className="h-9 rounded-lg border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zpět</button> : null}{step < 3 ? <button onClick={next} disabled={saving} className="h-9 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white hover:bg-indigo-500">Další</button> : <button onClick={submit} disabled={saving} className="flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Save size={14} /> {saving ? 'Ukládám…' : isNew ? 'Vytvořit skupinu' : 'Uložit změny'}</button>}</div>
        </footer>
      </section>
    </div>,
    document.body,
  );
};

const TableSettingsDialog = ({ hiddenColumns, hiddenGroupColumns, hiddenOrderColumns, density, redaction, confirmRearmAfterFlatten, onDensity, onRedaction, onConfirmRearmAfterFlatten, onToggleColumn, onToggleGroupColumn, onToggleOrderColumn, onReset, onClose }: {
  hiddenColumns: Set<AccountColumnKey>;
  hiddenGroupColumns: Set<GroupColumnKey>;
  hiddenOrderColumns: Set<OrderColumnKey>;
  density: number;
  redaction: RedactionSettings;
  confirmRearmAfterFlatten: boolean;
  onDensity: (value: number) => void;
  onRedaction: (value: RedactionSettings) => void;
  onConfirmRearmAfterFlatten: (value: boolean) => void;
  onToggleColumn: (key: AccountColumnKey) => void;
  onToggleGroupColumn: (key: GroupColumnKey) => void;
  onToggleOrderColumn: (key: OrderColumnKey) => void;
  onReset: () => void;
  onClose: () => void;
}) => createPortal(
  <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label="Table Settings" className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4"><h3 className="text-lg font-black text-[var(--text-primary)]">Table Settings</h3><button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)]"><X size={17} /></button></header>
      <div className="space-y-5 overflow-y-auto p-5">
        <div><div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">Appearance</div><label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-3 py-2.5"><span className="text-xs font-bold text-[var(--text-primary)]">Table density</span><select value={density} onChange={event => onDensity(Number(event.target.value))} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]"><option value={80}>80%</option><option value={90}>90%</option><option value={100}>100%</option><option value={110}>110%</option></select></label></div>
        <div><div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">Groups columns</div><div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]"><label className="flex items-center gap-2.5 px-3 py-2 text-xs font-bold text-[var(--text-muted)]"><input type="checkbox" checked disabled className="accent-indigo-600" />Group · Pinned</label>{GROUP_COLUMN_OPTIONS.map(column => <label key={column.key} className="flex items-center gap-2.5 px-3 py-2 text-xs font-bold text-[var(--text-primary)]"><input type="checkbox" checked={!hiddenGroupColumns.has(column.key)} onChange={() => onToggleGroupColumn(column.key)} className="accent-indigo-600" />{column.label}</label>)}</div></div>
        <div><div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">Orders columns</div><div className="grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--border-subtle)]">{ORDER_COLUMN_OPTIONS.map(column => <label key={column.key} className="flex items-center gap-2 border-b border-r border-[var(--border-subtle)] px-3 py-2 text-xs font-bold text-[var(--text-primary)]"><input type="checkbox" checked={!hiddenOrderColumns.has(column.key)} onChange={() => onToggleOrderColumn(column.key)} className="accent-indigo-600" />{column.label}</label>)}</div></div>
        <div><div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">Accounts columns</div><div className="grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--border-subtle)]">{ACCOUNT_COLUMNS.map(column => { const pinned = column.key === 'actions' || column.locked; return <label key={column.key} className={`flex items-center gap-2 border-b border-r border-[var(--border-subtle)] px-3 py-2 text-xs font-bold ${pinned ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}><input type="checkbox" checked={pinned || !hiddenColumns.has(column.key)} disabled={pinned} onChange={() => onToggleColumn(column.key)} className="accent-indigo-600" />{column.label}{pinned ? ' · Pinned' : ''}</label>; })}</div></div>
        <div>
          <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">Account name redaction</div>
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
            <label className="space-y-1.5"><span className="block text-[10px] font-bold text-[var(--text-secondary)]">Visible first characters</span><input aria-label="Visible first account characters" type="number" min="0" max="12" value={redaction.visibleStart} onChange={event => onRedaction({ ...redaction, visibleStart: Math.max(0, Number(event.target.value)) })} className="h-8 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]" /></label>
            <label className="space-y-1.5"><span className="block text-[10px] font-bold text-[var(--text-secondary)]">Visible last characters</span><input aria-label="Visible last account characters" type="number" min="0" max="12" value={redaction.visibleEnd} onChange={event => onRedaction({ ...redaction, visibleEnd: Math.max(0, Number(event.target.value)) })} className="h-8 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]" /></label>
          </div>
        </div>
        <label className="flex items-center gap-2.5 text-xs font-bold text-[var(--text-primary)]"><input type="checkbox" checked={confirmRearmAfterFlatten} onChange={event => onConfirmRearmAfterFlatten(event.target.checked)} className="accent-indigo-600" />Po Flatten All nabídnout ARM &amp; pokračovat</label>
      </div>
      <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] px-5 py-4"><button onClick={onReset} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-page)]"><RotateCcw size={13} /> Reset to default</button><button onClick={onClose} className="h-9 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white">Done</button></footer>
    </section>
  </div>, document.body,
);

const GroupTemplatesDialog = ({ templates, accounts, onChange, onClose }: {
  templates: CopyGroupTemplate[];
  accounts: LiveAccount[];
  onChange: (templates: CopyGroupTemplate[]) => void;
  onClose: () => void;
}) => {
  const [draft, setDraft] = useState<CopyGroupTemplate | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const toggleFollower = (accountId: number) => setDraft(current => current ? ({
    ...current,
    followers: current.followers.some(follower => follower.accountId === accountId)
      ? current.followers.filter(follower => follower.accountId !== accountId)
      : [...current.followers, { accountId, mode: 'on-submit', multiplier: 1 }],
  }) : current);
  const save = () => {
    if (!draft?.name.trim()) return setError('Zadej název šablony.');
    onChange(templates.some(template => template.id === draft.id)
      ? templates.map(template => template.id === draft.id ? { ...draft, name: draft.name.trim() } : template)
      : [...templates, { ...draft, name: draft.name.trim() }]);
    setDraft(null);
    setError('');
  };

  const updateFollower = (accountId: number, patch: Partial<Pick<CopyFollowerConfig, 'mode' | 'multiplier' | 'maxContracts'>>) => {
    setDraft(current => current ? ({
      ...current,
      followers: current.followers.map(follower => follower.accountId === accountId
        ? { ...follower, ...patch }
        : follower),
    }) : current);
  };

  const updateSafety = <K extends keyof CopyGroupSafetySettings>(key: K, value: CopyGroupSafetySettings[K]) => {
    setDraft(current => current ? ({
      ...current,
      safety: { ...current.safety, [key]: value },
    }) : current);
  };

  const visibleFollowerAccounts = accounts.filter(account =>
    account.id !== draft?.leaderAccountId
      && `${account.name} ${account.firm}`.toLowerCase().includes(search.trim().toLowerCase()));

  const selectVisibleFollowers = () => {
    setDraft(current => current ? ({
      ...current,
      followers: [
        ...current.followers,
        ...visibleFollowerAccounts
          .filter(account => !current.followers.some(follower => follower.accountId === account.id))
          .map(account => ({ accountId: account.id, mode: 'on-submit' as const, multiplier: 1 })),
      ],
    }) : current);
  };

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="Group Templates" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <div>
            <h3 className="text-lg font-black text-[var(--text-primary)]">Group Templates</h3>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Reusable leader, follower and protection settings.</p>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)]"><X size={17} /></button>
        </header>
        <div className="overflow-y-auto p-5">
          {!draft ? (
            <>
              <button onClick={() => setDraft({ id: `template-${Date.now()}`, name: '', leaderAccountId: null, followers: [], safety: { ...DEFAULT_COPY_GROUP_SAFETY } })} className="mb-4 h-9 rounded-lg bg-indigo-600 px-4 text-xs font-bold text-white"><Plus size={13} className="mr-1.5 inline" />New Template</button>
              {templates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--border-subtle)] py-12 text-center">
                  <Inbox size={22} className="mx-auto text-[var(--text-muted)]" />
                  <p className="mt-3 text-sm font-bold text-[var(--text-primary)]">No templates yet</p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">Click New Template above to build one.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {templates.map(template => (
                    <div key={template.id} className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <b className="block truncate text-sm text-[var(--text-primary)]">{template.name}</b>
                        <span className="text-[11px] text-[var(--text-secondary)]">{template.leaderAccountId == null ? 'Keeps target leader' : accounts.find(account => account.id === template.leaderAccountId)?.name ?? 'Leader'} · {template.followers.length} followers</span>
                      </div>
                      <button onClick={() => setDraft(structuredClone(template))} className="h-8 rounded-lg border border-[var(--border-subtle)] px-3 text-[11px] font-bold text-[var(--text-secondary)]">Edit</button>
                      <button aria-label={`Delete template ${template.name}`} onClick={() => onChange(templates.filter(item => item.id !== template.id))} className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-500/10"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-5">
              <label className="block space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Template name</span>
                <input autoFocus value={draft.name} onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)} placeholder="e.g. Scalp set-up" className="h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-sm font-bold text-[var(--text-primary)]" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Leader (optional)</span>
                <select value={draft.leaderAccountId ?? ''} onChange={event => setDraft(current => current ? { ...current, leaderAccountId: event.target.value ? Number(event.target.value) : null, followers: current.followers.filter(follower => follower.accountId !== Number(event.target.value)) } : current)} className="h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-xs font-bold text-[var(--text-primary)]">
                  <option value="">No leader · keep target group leader</option>
                  {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3"><span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Followers</span><button type="button" onClick={selectVisibleFollowers} className="text-[10px] font-black text-indigo-500 hover:underline">Select all</button></div>
                <input aria-label="Search followers" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search accounts" className="mb-2 h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-indigo-500" />
                <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                  {visibleFollowerAccounts.map(account => {
                    const follower = draft.followers.find(item => item.accountId === account.id);
                    return (
                      <div key={account.id} className="grid grid-cols-[minmax(0,1fr)_112px_66px_58px] items-center gap-2 px-3 py-2.5">
                        <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                          <input type="checkbox" checked={!!follower} onChange={() => toggleFollower(account.id)} className="accent-indigo-600" />
                          <span className="min-w-0"><b className="block truncate text-xs text-[var(--text-primary)]">{account.name}</b><span className="block truncate text-[10px] text-[var(--text-secondary)]">{account.firm} · {money.format(account.balance)}</span></span>
                        </label>
                        <select disabled={!follower} value={follower?.mode ?? 'on-submit'} onChange={event => updateFollower(account.id, { mode: event.target.value as ReplicationMode })} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-[10px] font-bold text-[var(--text-primary)] disabled:opacity-35">
                          <option value="off">Off</option><option value="on-submit">On Submit</option><option value="on-fill">On Fill</option>
                        </select>
                        <input aria-label={`Násobek ${account.name}`} disabled={!follower} type="number" min="0.01" max="100" step="0.25" value={follower?.multiplier ?? 1} onChange={event => updateFollower(account.id, { multiplier: normalizeMultiplier(Number(event.target.value)) })} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-[10px] font-bold text-[var(--text-primary)] disabled:opacity-35" />
                        <input aria-label={`Max kontrakty ${account.name}`} title="Tvrdý strop expozice na symbol; překročení odmítne celý příkaz a odzbrojí copier; prázdné = bez limitu" disabled={!follower} type="number" min="1" step="1" placeholder="∞" value={follower?.maxContracts ?? ''} onChange={event => updateFollower(account.id, { maxContracts: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : undefined })} className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-[10px] font-bold text-[var(--text-primary)] disabled:opacity-35" />
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="mb-2 text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Group safety</div>
                <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                  {([
                    ['positionReconciler', 'Position reconciler'],
                    ['disableReplicationOnBreach', 'Disable replication on breach'],
                    ['autoCloseFollowerPositions', 'Auto-close follower positions'],
                    ['preventHedging', 'Prevent hedging'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-xs font-bold text-[var(--text-primary)]">
                      {label}<input type="checkbox" checked={draft.safety[key]} onChange={event => updateSafety(key, event.target.checked)} className="accent-indigo-600" />
                    </label>
                  ))}
                </div>
                <label className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] px-3 py-2.5">
                  <span className="text-xs font-bold text-[var(--text-primary)]">Cooldown po uzavření</span>
                  <span className="flex items-center gap-2">
                    <input
                      aria-label="Cooldown šablony v minutách"
                      type="number"
                      min="0"
                      max="720"
                      step="1"
                      value={draft.safety.entryCooldownMinutes}
                      onChange={event => updateSafety('entryCooldownMinutes', Math.min(720, Math.max(0, Math.floor(Number(event.target.value) || 0))))}
                      className="h-8 w-20 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-right text-xs font-bold text-[var(--text-primary)]"
                    />
                    <span className="text-[10px] font-bold text-[var(--text-secondary)]">min</span>
                  </span>
                </label>
              </div>
              {error ? <p className="text-xs font-bold text-rose-500">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <button onClick={() => setDraft(null)} className="h-9 rounded-lg border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Cancel</button>
                <button onClick={save} className="h-9 rounded-lg bg-indigo-600 px-4 text-xs font-bold text-white">Save Template</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>, document.body,
  );
};

const ConfirmActionDialog = ({ action, busy, apiReady, onClose, onConfirm }: { action: PendingAction; busy: boolean; apiReady: boolean; onClose: () => void; onConfirm: () => void }) => createPortal(
  <div className="fixed inset-0 z-[160] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl p-5">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${action.danger ? 'bg-rose-500/10 text-rose-500' : 'bg-indigo-500/10 text-indigo-500'}`}>{action.danger ? <AlertTriangle size={21} /> : <Power size={21} />}</div>
      <h3 className="text-lg font-black text-[var(--text-primary)] mt-4">{action.title}</h3><p className="text-sm text-[var(--text-secondary)] mt-1.5 leading-relaxed">{action.detail}</p>
      {!action.run && (
        <div className={`rounded-xl border px-3 py-2.5 text-[11px] font-bold mt-4 ${apiReady ? 'border-emerald-500/15 bg-emerald-500/[0.055] text-emerald-600' : 'border-blue-500/15 bg-blue-500/[0.055] text-blue-500'}`}>
          {apiReady
            ? 'Execution adaptér je připojen. Potvrzená akce bude předána lokálnímu DEMO runtime.'
            : 'Bez připojeného execution adaptéru se akce pouze uloží lokálně a žádný brokerový příkaz se neodešle.'}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-5"><button onClick={onClose} disabled={busy} className="h-10 px-4 rounded-xl border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)]">Zrušit</button><button onClick={onConfirm} disabled={busy} className={`h-10 px-4 rounded-xl text-white text-xs font-bold disabled:opacity-50 ${action.danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>{busy ? 'Připravuji…' : action.confirmLabel}</button></div>
    </section>
  </div>, document.body,
);

const CopyTradingHelpDialog = ({ onClose, apiReady }: { onClose: () => void; apiReady: boolean }) => createPortal(
  <div className="fixed inset-0 z-[150] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" className="w-full max-w-lg rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl overflow-hidden">
      <header className="p-5 border-b border-[var(--border-subtle)] flex items-center justify-between"><div><div className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-500">LIVE CONTROL</div><h3 className="text-lg font-black text-[var(--text-primary)] mt-1">Připravenost funkcí</h3></div><button onClick={onClose} className="w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-page)] flex items-center justify-center"><X size={18} /></button></header>
      <div className="p-5 space-y-3">
        {[['Skupiny a účty', 'Vytvoření, leader, followeři, režim On Submit / On Fill a multiplier.'], ['Řízení rizika', 'Enable/Disable, Flatten účtu a Flatten All s povinným potvrzením.'], ['Příkazy', 'Skupinové ordery, refresh a příprava zrušení pracovního příkazu.'], ['Pohled', 'Skrývání sloupců, offline skupin, rozbalení a lokální uložení konfigurace.']].map(([title, detail]) => <div key={title} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-3.5 flex gap-3"><CheckCircle2 size={17} className="text-emerald-500 shrink-0 mt-0.5" /><div><div className="text-xs font-black text-[var(--text-primary)]">{title}</div><div className="text-[11px] text-[var(--text-secondary)] mt-1 leading-relaxed">{detail}</div></div></div>)}
        <div className={`rounded-md border p-3.5 flex gap-3 ${apiReady ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}><SlidersHorizontal size={17} className={apiReady ? 'text-emerald-500' : 'text-amber-500'} /><div><div className="text-xs font-black text-[var(--text-primary)]">{apiReady ? 'Execution adapter připojen' : 'Lokální přípravný režim'}</div><div className="text-[11px] text-[var(--text-secondary)] mt-1">{apiReady ? 'Příkazy lze předat připojenému broker adaptéru až po explicitním ARM.' : 'UI je kompletní, ale žádné akce se neposílají brokerovi.'}</div></div></div>
      </div>
    </section>
  </div>, document.body,
);

const StatusToast = ({ tone, text }: { tone: 'success' | 'info' | 'error'; text: string }) => createPortal(
  <div role="status" className={`native-fixed-above-tab-bar fixed z-[180] right-5 bottom-5 max-w-sm rounded-lg border bg-[var(--bg-card)] shadow-xl px-4 py-3 flex items-start gap-2.5 ${tone === 'error' ? 'border-rose-500/30' : tone === 'success' ? 'border-emerald-500/30' : 'border-blue-500/30'}`}>
    {tone === 'error' ? <AlertTriangle size={17} className="text-rose-500 shrink-0" /> : <CheckCircle2 size={17} className={tone === 'success' ? 'text-emerald-500 shrink-0' : 'text-blue-500 shrink-0'} />}<span className="text-xs font-bold text-[var(--text-primary)] leading-relaxed">{text}</span>
  </div>, document.body,
);

// ─── Pomocné ─────────────────────────────────────────────────────────────────

const pnlClass = (v: number) =>
  v > 0 ? 'text-emerald-500' : v < 0 ? 'text-rose-500' : 'text-[var(--text-secondary)]';

/** Vzdálenost k drawdownu: nízká = blízko limitu, proto červená. */
const cushionClass = (v: number | null) => {
  if (v == null) return 'text-[var(--text-secondary)]';
  if (v < 1000) return 'text-rose-500';
  return 'text-emerald-500/80';
};

export default LiveCopyTradeOverview;
