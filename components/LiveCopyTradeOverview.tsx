import { LiveRiskValue } from './LiveRiskValue';
import { ColumnOrderList, type ColumnOrderItem } from './ColumnOrderList';
import { applyColumnOrder, moveColumn, pinColumnEdges } from '../lib/tableColumnOrder';
import LiveCopierIsland from './LiveCopierIsland';
import { LiveDayTrigger, LiveDayCardDialog } from './LiveDayCard';
import { buildLiveDaySummary, liveDayReadAnswered } from '../lib/liveDaySummary';
import { buildLiveCopierIsland } from '../lib/liveCopierIsland';
import { copierArmRejection } from '../lib/copierArmPreparation';
import { tradovateDisplayTradeDate } from '../lib/tradovateDisplayDay';
import { isLiveAccountReadVerified, liveReadStaleLabel } from '../lib/liveReadFreshness';
import { liveBalanceDisplay, liveCapitalDisplay, liveDailyPnlDisplay, liveGroupDailyPnlDisplay, type LiveBalanceDisplay } from '../lib/liveBalanceDisplay';
import { useCopierDisarmNotice } from '../hooks/useCopierDisarmNotice';
import { useFlipReorder, useIsomorphicLayoutEffect } from '../hooks/useFlipReorder';
import { CopyGroupLibraryRequestFence } from '../lib/copyGroupLibraryRequestFence';
import React, { useSyncExternalStore, useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, Crown, Plus, HelpCircle, Settings2, Eye, MoreVertical,
  RefreshCw, Inbox, RotateCcw, X, Save, Trash2, Power,
  EyeOff, AlertTriangle, CheckCircle2, SlidersHorizontal, ShieldAlert, ShieldCheck, Clock3,
  Lock, Ban, Unplug,
} from 'lucide-react';
import type { LiveAccount, LiveGroup, LiveOrder, LivePosition, LiveSnapshot } from '../services/tradecopiaLiveService';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';
import type { TradovateApiTelemetrySnapshot } from '../lib/tradovateApiTelemetry';
import type { TradovateConnectionUsageRow } from '../lib/tradovateConnectionUsageRows';
import type { CopierAccountEligibility, CopierControllerStatus, CopierStuckOperation } from '../services/copierRuntimeController';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import {
  copyTradeAccountName,
  createCopyTradeAccountLabelResolver,
  formatKnownCopyTradeAccountIds,
  type CopyTradeAccountRole,
} from '../lib/copyTradeAccountLabels';
import { translateCopierRejectReason } from '../lib/copierRejectReason';
import {
  dismissRejection,
  getDismissedRejections,
  rejectedExecutionDismissKey,
  rejectedExecutionResolved,
  rejectedExecutionVisibility,
  subscribeDismissedRejections,
} from '../services/rejectedExecutionVisibility';
import LiveRiskSummaryCard from './LiveRiskSummaryCard';
import CopierCooldownPanel, { useCopierPauseActive } from './CopierCooldownPanel';
import { copierPauseDeadline } from '../services/copierCooldownDisplay';
import {
  copierCopiesOutcomeText,
  type CopierDisarmRecord,
} from '../lib/copierDisarmReason';
import { effectiveCopyTradeAccountEligibility } from '../lib/copyTradeAccountEligibility';
import { stabilizeCopyGroups } from '../lib/stabilizeCopyGroups';
import { useCompactViewport } from '../utils/useCompactViewport';
import { FIRM_LOGOS, firmColor, firmInitials } from '../utils/accountFirm';
import {
  adoptRuntimeCopyGroup,
  copyGroupsFromSnapshot,
  copyGroupValidationMessages,
  createLocalCopyGroupId,
  DEFAULT_COPY_GROUP_SAFETY,
  mergeCopyGroups,
  normalizeMultiplier,
  replaceCopyGroupFollowerAccount,
  unavailableCopyGroupAccounts,
  validateCopyGroup,
  type CopyGroupConfig,
  type CopyFollowerConfig,
  type CopyGroupSafetySettings,
  type CopyReplicationMode,
  type LiveCopyTradingAdapter,
  type LiveCopyTradingCommand,
} from '../services/liveCopyTrading';
import {
  copyGroupLibraryErrorMessage,
  copyGroupForStorage,
  deleteCopyGroup,
  importCopyGroups,
  loadCopyGroupLibrary,
  readCopyGroupCache,
  saveCopyGroup,
  writeCopyGroupCache,
} from '../services/copyGroupLibrary';

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
const moneyWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Režim replikace follower účtu — hodnoty přebírají chování Tradecopie. */
export type ReplicationMode = CopyReplicationMode;

// ─── Sloupce tabulky účtů ────────────────────────────────────────────────────
// Datově řízené, aby šly jednotlivé sloupce skrývat. `locked` sloupce skrýt nelze
// — bez názvu účtu by řádky nešlo rozlišit.

export type AccountColumnKey =
  | 'account' | 'status' | 'broker' | 'firm' | 'balance' | 'positions'
  | 'daily' | 'dllRemaining' | 'unreal' | 'distDd' | 'execLimit' | 'qtyMult' | 'actions';

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
  { key: 'status', label: 'Stav' }, { key: 'leader', label: 'Leader' }, { key: 'firm', label: 'Firma' },
  { key: 'followers', label: 'Followeři' }, { key: 'capital', label: 'Kapitál' }, { key: 'daily', label: 'Denní P&L' }, { key: 'unreal', label: 'Otevřený P&L' },
];
const ORDER_COLUMN_OPTIONS: Array<{ key: OrderColumnKey; label: string }> = [
  { key: 'account', label: 'Účet' }, { key: 'broker', label: 'Broker' }, { key: 'symbol', label: 'Symbol' }, { key: 'action', label: 'Směr' },
  { key: 'type', label: 'Typ' }, { key: 'qty', label: 'Počet' }, { key: 'limit', label: 'Limitní cena' },
  { key: 'stop', label: 'Stop cena' }, { key: 'status', label: 'Stav' }, { key: 'timestamp', label: 'Čas' }, { key: 'orderId', label: 'ID příkazu' },
];
/** Sloupce zarovnané doprava — čísla se čtou od desetinné tečky. */
const ORDER_COLUMNS_RIGHT = new Set<OrderColumnKey>(['qty', 'limit', 'stop', 'orderId']);
const GROUP_COLUMNS_RIGHT = new Set<GroupColumnKey>(['followers', 'capital', 'daily', 'unreal']);

const ACCOUNT_COLUMNS: ColumnDef[] = [
  // Stav nemá vlastní sloupec: 95 % času by nesl „Aktivní“, což už signalizuje
  // tečka u názvu účtu. Odchylky (BREACHED, DLL lock, odpojeno) se vykreslí
  // jako štítek na druhém řádku buňky Účet, kde už žije i jejich důvod.
  { key: 'account', label: 'Účet', locked: true, widthPx: 220 },
  { key: 'broker', label: 'Broker', widthPx: 72 },
  { key: 'firm', label: 'Firma', widthPx: 120 },
  { key: 'balance', label: 'Zůstatek', align: 'right', widthPx: 112 },
  { key: 'positions', label: 'Pozice', align: 'right', widthPx: 200 },
  { key: 'daily', label: 'Denní P&L', align: 'right', widthPx: 96 },
  { key: 'dllRemaining', label: 'DLL zbývá', align: 'right', widthPx: 96 },
  { key: 'unreal', label: 'Otevřený P&L', align: 'right', widthPx: 104 },
  { key: 'distDd', label: 'Rezerva DD', align: 'right', widthPx: 76 },
  { key: 'execLimit', label: 'Exec/Limit', align: 'right', widthPx: 88 },
  { key: 'qtyMult', label: 'Násobek', align: 'right', widthPx: 96 },
  { key: 'actions', label: 'Akce', align: 'right', widthPx: 92 },
];

const ACCOUNT_COLUMN_KEYS = ACCOUNT_COLUMNS.map(column => column.key);
const GROUP_COLUMN_KEYS = GROUP_COLUMN_OPTIONS.map(column => column.key);
const ORDER_COLUMN_KEYS = ORDER_COLUMN_OPTIONS.map(column => column.key);

/** Ochrany kopírování skupiny — pořadí i texty sdílí editor s testy. */
const SAFETY_OPTIONS = [
  ['positionReconciler', 'Kontrola shody pozic',
    'Po každém vyplnění followera ověří, že nová pozice odpovídá směru a symbolu leadera.'],
  ['disableReplicationOnBreach', 'Zastavit skupinu při nesouladu',
    'Povinná fail-closed ochrana: rozdíl na jediném followerovi okamžitě zastaví replikaci celé skupiny.'],
  ['autoCloseFollowerPositions', 'Automaticky zavřít pozice followerů',
    'Jakmile se zavře pozice leadera, automaticky zavře odpovídající pozice followerů.'],
  ['preventHedging', 'Zabránit opačné pozici',
    'Nedovolí opačnému příkazu překlopit follower účet do obráceného směru.'],
] as const satisfies ReadonlyArray<readonly [keyof CopyGroupSafetySettings, string, string]>;

const COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_columns';
const GROUP_COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_group_columns';
const ORDER_COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_order_columns';
const COLUMN_ORDER_STORAGE_KEY = 'alphatrade_live_copytrade_column_order';
const VIEW_SETTINGS_STORAGE_KEY = 'alphatrade_live_copytrade_view_settings';
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

const FirmMark = ({ firm, withLabel = false, size = 'h-6 w-6' }: { firm: string; withLabel?: boolean; size?: string }) => {
  const key = firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return <span className="inline-flex min-w-0 items-center gap-1.5">
    {logo
      ? <img src={logo} alt="" className={`${size} shrink-0 rounded-full border border-black/10 bg-white object-cover`} />
      : <span className={`flex ${size} shrink-0 items-center justify-center rounded-full text-[8px] font-black text-white`} style={{ background: firmColor(key || firm).bg }}>{firmInitials(firm)}</span>}
    {withLabel ? <span className="truncate text-xs leading-none">{firm}</span> : null}
  </span>;
};

/**
 * Firmy celé skupiny, ne jen leaderova. Skupina běžně míchá víc firem
 * (Lucid + Tradeify + FundedNext) a zobrazit jednu z nich je zavádějící —
 * u cross-firm kopírování obzvlášť. Leaderova je vždy první.
 */
export const groupFirmList = (rows: Array<{ firm?: string | null; isLeader?: boolean }>): string[] => {
  const seen = new Set<string>();
  const ordered = [...rows].sort((a, b) => Number(b.isLeader ?? false) - Number(a.isLeader ?? false));
  for (const row of ordered) {
    const firm = row.firm?.trim();
    if (firm) seen.add(firm);
  }
  return [...seen];
};

const firmCountLabel = (count: number): string =>
  count < 5 ? `${count} firmy` : `${count} firem`;

/** Jedna firma = logo s názvem, víc firem = překryv log a počet. */
/**
 * `marksOnly` je pro úzkou buňku souhrnu na telefonu: text „3 firmy“ by se
 * tam nevešel a přetekl by do sousedního čísla. Názvy zůstanou v `title`.
 */
const FirmStack = ({ firms, marksOnly = false }: { firms: string[]; marksOnly?: boolean }) => {
  if (firms.length === 0) return <span className="text-[11px] text-[var(--text-secondary)]">—</span>;
  // Bez popisku musí název nést aspoň `title`, jinak by u neznámé firmy
  // (monogram místo loga) nešlo zjistit, o koho jde.
  if (firms.length === 1) {
    return marksOnly
      ? <span title={firms[0]} className="inline-flex"><FirmMark firm={firms[0]} size="h-5 w-5" /></span>
      : <FirmMark firm={firms[0]} withLabel />;
  }
  const shown = firms.slice(0, 3);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={firms.join(' · ')}>
      <span className="flex shrink-0 items-center">
        {shown.map((firm, index) => (
          <span
            key={firm}
            className={index === 0 ? 'flex' : `${marksOnly ? '-ml-2' : '-ml-2.5'} flex rounded-full ring-2 ring-[var(--bg-card)]`}
            style={{ zIndex: shown.length - index }}
          >
            <FirmMark firm={firm} size={marksOnly ? 'h-5 w-5' : 'h-6 w-6'} />
          </span>
        ))}
      </span>
      {marksOnly ? null : <span className="truncate text-xs leading-none">{firmCountLabel(firms.length)}</span>}
    </span>
  );
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

interface ColumnOrderState {
  accounts: AccountColumnKey[];
  groups: GroupColumnKey[];
  orders: OrderColumnKey[];
}

function loadColumnOrder(): ColumnOrderState {
  let parsed: Partial<Record<keyof ColumnOrderState, unknown>> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMN_ORDER_STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object') parsed = raw as typeof parsed;
  } catch { /* private mode nebo poškozený zápis — jede se na výchozím pořadí */ }
  const stored = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return {
    accounts: pinColumnEdges(applyColumnOrder(ACCOUNT_COLUMN_KEYS, stored(parsed.accounts)), 'account', 'actions'),
    groups: applyColumnOrder(GROUP_COLUMN_KEYS, stored(parsed.groups)),
    orders: applyColumnOrder(ORDER_COLUMN_KEYS, stored(parsed.orders)),
  };
}

function loadViewSettings(): { redaction: RedactionSettings; confirmRearmAfterFlatten: boolean } {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_SETTINGS_STORAGE_KEY) ?? '{}') as Partial<{
      redaction: Partial<RedactionSettings>;
      confirmRearmAfterFlatten: boolean;
    }>;
    return {
      redaction: {
        visibleStart: Number.isFinite(parsed.redaction?.visibleStart) ? Math.max(0, Number(parsed.redaction?.visibleStart)) : DEFAULT_REDACTION.visibleStart,
        visibleEnd: Number.isFinite(parsed.redaction?.visibleEnd) ? Math.max(0, Number(parsed.redaction?.visibleEnd)) : DEFAULT_REDACTION.visibleEnd,
      },
      confirmRearmAfterFlatten: typeof parsed.confirmRearmAfterFlatten === 'boolean' ? parsed.confirmRearmAfterFlatten : true,
    };
  } catch {
    return { redaction: DEFAULT_REDACTION, confirmRearmAfterFlatten: true };
  }
}

interface Props {
  journalHistory?: React.ReactNode;
  userId?: string;
  /** Komu den patří — karta dne se posílá dál, bez jména je anonymní. */
  owner?: { name: string; avatar?: string | null };
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
  /** Bootstrap má čerstvé pozice a balance, ale denní ledger se ještě doplňuje. */
  dailyPnlPending?: boolean;
  /** Přesné current-day broker P&L; null znamená, že broker hodnotu nepotvrdil. */
  brokerDailyPnlByAccount?: Readonly<Record<string, number | null>>;
  /** Durable leader-only copier ledger; never an aggregate of account P&L. */
  dailyStats?: CopierControllerStatus['dailyStats'];
  copierKillSwitch?: boolean;
  runtimeStatus?: CopierControllerStatus | null;
  runtimeAvailable?: boolean;
  riskConfigSupported?: boolean;
  apiTelemetry?: TradovateApiTelemetrySnapshot;
  /** Čerpání limitu Tradovate a stav session workeru po připojení; jen zobrazení. */
  connectionUsage?: TradovateConnectionUsageRow[];
  /** Atomicky vybere čistou skupinu, provede reconciliation a ARM LIVE. */
  onSwitchAndArm?: (group: CopyGroupConfig) => Promise<void> | void;
  onArmLive?: () => Promise<void> | void;
  onDisarm?: () => Promise<void> | void;
  onEmergencyStop?: () => Promise<void> | void;
  onDayLock?: () => Promise<void> | void;
  dayLockUntil?: number;
  pause?: CopierControllerStatus['pause'];
  sessionArmedAt?: number;
  followerCuts?: CopierControllerStatus['followerCuts'];
  accountRisk?: CopierControllerStatus['accountRisk'];
  onOpenRisk?: () => void;
  /** Konec anti-revenge cooldownu (epoch ms); 0 = neběží. */
  cooldownUntil?: number;
  /** Operace čekající na ruční kontrolu — blokují ARM a musí být vidět. */
  stuckOperations?: CopierStuckOperation[];
  accountEligibility?: CopierAccountEligibility[];
  unverifiableFollowerOwnership?: CopierControllerStatus['unverifiableFollowerOwnership'];
  lastDisarm?: CopierDisarmRecord;
  /** Read-only broker reconciliation for a currently unverifiable account. */
  onVerifyEligibility?: (accountId: number) => Promise<void> | void;
  executionGroupId?: string | null;
  /** `marketPrices` z workeru (TradingView) — jen pro zobrazení vzdálenosti k limitu. */
  marketPrices?: readonly unknown[];
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
  /** Informační fail-closed dialog; potvrzení pouze zavře dialog. */
  blocked?: boolean;
  outcomeUnknown?: boolean;
  outcomeRejected?: boolean;
  /** UI-only kontext; audit ani runtime error se nepřepisuje. */
  accountIds?: number[];
}

type ActiveFollowerCut = NonNullable<CopierControllerStatus['followerCuts']>[number];

export interface UnavailableFollowerRemovalPlan {
  group: CopyGroupConfig;
  /**
   * UI důkaz účtů, které z nové topologie mizí. Samotný command formát se
   * nemění; execution agent tentýž seznam znovu autoritativně odvodí z OAuth
   * discovery a předá ho controlleru jako `missingOptionalAccountIds`.
   */
  missingOptionalAccountIds: number[];
  ownershipWarnings: Array<{ accountId: number; epochIds: string[] }>;
}

export interface PendingUnavailableFollowerRemoval {
  source: 'arm' | 'editor' | 'row';
  saved: CopyGroupConfig;
  editGroup: CopyGroupConfig;
  plan: UnavailableFollowerRemovalPlan | null;
  leaderUnavailableAccountId: number | null;
  error: string | null;
  savedSuccessfully: boolean;
  ownershipWaiverStep: boolean;
}

export interface CopyGroupPowerBlockerInput {
  powered: boolean;
  candidateName: string;
  candidateId: string;
  currentGroupId: string | null;
  candidateActivity: string | null;
  currentActivity: string | null;
  validationErrors: string[];
}

export interface CopyGroupPowerBlocker {
  title: string;
  detail: string;
}

/**
 * Čistý ON/OFF nepotřebuje potvrzení. Dialog vzniká pouze tehdy, když
 * autoritativní preflight zjistí konkrétní blokaci, kterou musí uživatel vidět.
 */
export function copyGroupPowerBlocker({
  powered,
  candidateName,
  candidateId,
  currentGroupId,
  candidateActivity,
  currentActivity,
  validationErrors,
}: CopyGroupPowerBlockerInput): CopyGroupPowerBlocker | null {
  if (powered && candidateActivity) {
    return {
      title: 'Skupinu teď nelze vypnout',
      detail: `Skupina ${candidateName} stále obsahuje ${candidateActivity}. Nejprve použij výslovné Flatten All a ověř, že jsou všechny účty flat a bez pracovních příkazů. Copier zůstává ZAPNUTÝ.`,
    };
  }
  if (powered) return null;

  if (validationErrors.length > 0) {
    return {
      title: 'Skupinu nelze zapnout',
      detail: `${validationErrors.join(' ')} Oprav skupinu přes menu ⋮ → Edit group. Copier zůstává VYPNUTÝ.`,
    };
  }

  if (currentActivity || candidateActivity) {
    return {
      title: 'Přepnutí skupiny je zablokované',
      detail: `${currentActivity ? `Současná execution skupina obsahuje ${currentActivity}. ` : ''}${candidateActivity && candidateId !== currentGroupId ? `Cílová skupina obsahuje ${candidateActivity}. ` : ''}AlphaTrade nic nezavře ani nepřepne automaticky. Použij Flatten All, ověř flat stav a potom zapnutí zopakuj.`,
    };
  }

  return null;
}

/**
 * Připraví pouze explicitní odebrání followerů, kteří opravdu chybí v
 * aktuálním OAuth snapshotu. Leader se touto cestou nikdy nemění ani nemaže.
 * Odebírají se vždy všichni nedostupní followeři: skupina, ve které by
 * jediný nedostupný účet zůstal, neprojde validací a uložení by selhalo
 * (18. 9. 2026 — odebrání jednoho FundedNext účtu z řádku, zatímco další
 * čtyři byly také nedostupné).
 */
export function unavailableFollowerRemovalPlan(
  group: CopyGroupConfig,
  availableAccountIds: Iterable<number>,
  ownership: readonly { accountId: number; epochIds: readonly string[] }[] = [],
): UnavailableFollowerRemovalPlan | null {
  const unavailable = unavailableCopyGroupAccounts(group, availableAccountIds);
  const removedIds = unavailable.followerAccountIds;
  if (removedIds.length === 0) return null;
  const removed = new Set(removedIds);
  return {
    group: {
      ...group,
      followers: group.followers.filter(follower => !removed.has(follower.accountId)),
    },
    missingOptionalAccountIds: removedIds,
    ownershipWarnings: ownership
      .filter(item => removed.has(item.accountId))
      .map(item => ({ accountId: item.accountId, epochIds: [...item.epochIds] })),
  };
}

/** Kill switch zastaví nové execution akce, ale nesmí odříznout poslední
 * risk-redukční brzdu. Flatten účtu i skupiny proto zůstává průchozí. */
export const commandBlockedByCopierKillSwitch = (command: LiveCopyTradingCommand) =>
  command.type !== 'flatten-account' && command.type !== 'flatten-group';

const TERMINAL_LIVE_ORDER_STATUSES = new Set([
  'filled', 'canceled', 'cancelled', 'rejected', 'expired',
]);

/**
 * `order.working` je schválně přísný signál pro potvrzenou venue ochranu:
 * PendingNew/Suspended SL se nesmí tvářit jako funkční. Pro vypnutí nebo
 * přepnutí skupiny je ale každý neterminální stav pořád aktivní riziko.
 */
export const liveOrderIsOpenForSafety = (order: Pick<LiveOrder, 'status'>): boolean =>
  !TERMINAL_LIVE_ORDER_STATUSES.has(order.status.trim().toLowerCase());

export const LiveCopyTradeOverview: React.FC<Props> = ({
  journalHistory,
  userId = '',
  owner,
  snapshot,
  accountProfiles = [],
  orders = [],
  onAccount,
  onRefreshOrders,
  commandAdapter,
  copierArmed = false,
  copierObservingOnly = false,
  copierStatusPending = false,
  dailyPnlPending = false,
  brokerDailyPnlByAccount,
  dailyStats = null,
  copierKillSwitch = false,
  runtimeStatus = null,
  runtimeAvailable = false,
  riskConfigSupported = false,
  apiTelemetry,
  connectionUsage = [],
  onSwitchAndArm,
  onArmLive,
  onDisarm,
  onEmergencyStop,
  onDayLock,
  dayLockUntil = 0,
  pause = null,
  sessionArmedAt = 0,
  followerCuts = [],
  accountRisk = [],
  onOpenRisk,
  cooldownUntil = 0,
  stuckOperations = [],
  accountEligibility = [],
  unverifiableFollowerOwnership = [],
  lastDisarm,
  onVerifyEligibility,
  executionGroupId = null,
  runtimeGroup = null,
  marketPrices = [],
  onGroupsChange,
}) => {
  const [initialViewSettings] = useState(loadViewSettings);
  const showDisarmNotice = useCopierDisarmNotice(lastDisarm?.at);
  const pauseActive = useCopierPauseActive(copierPauseDeadline(cooldownUntil, pause?.until));
  const cooldownPanel = <CopierCooldownPanel
    key={executionGroupId}
    cooldownUntil={cooldownUntil}
    cooldownMinutes={runtimeGroup?.safety?.entryCooldownMinutes ?? 0}
    pause={pause}
    status={runtimeStatus}
    known={runtimeAvailable && !copierStatusPending}
  />;
  const effectiveEligibility = useMemo(
    () => effectiveCopyTradeAccountEligibility(snapshot.accounts, accountProfiles, accountEligibility),
    [accountEligibility, accountProfiles, snapshot.accounts],
  );
  const eligibilityByAccount = useMemo(
    () => new Map(effectiveEligibility.map(entry => [entry.accountId, entry])),
    [effectiveEligibility],
  );
  const [groupTab, setGroupTab] = useState<Record<string, 'accounts' | 'orders'>>({});
  // Telefon a úzký viewport dostanou karty místo 900px tabulky; desktop se nemění.
  const compact = useCompactViewport();
  const [apiPanelOpen, setApiPanelOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<AccountColumnKey>>(loadHiddenColumns);
  const [hiddenGroupColumns, setHiddenGroupColumns] = useState<Set<GroupColumnKey>>(() => loadHiddenColumnSet<GroupColumnKey>(GROUP_COLUMNS_STORAGE_KEY));
  const [hiddenOrderColumns, setHiddenOrderColumns] = useState<Set<OrderColumnKey>>(() => loadHiddenColumnSet<OrderColumnKey>(ORDER_COLUMNS_STORAGE_KEY));
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(loadColumnOrder);
  const [groups, setGroups] = useState<CopyGroupConfig[]>(() => {
    const initial = readCopyGroupCache(userId, copyGroupsFromSnapshot(snapshot));
    // Effects běží až po prvním interaktivním renderu. Runtime skupinu proto
    // adoptujeme už zde, aby rychlý ARM po návratu z Risk neposlal starý draft.
    return runtimeGroup
      ? adoptRuntimeCopyGroup(initial, snapshot.accounts.map(account => account.id), runtimeGroup)
      : initial;
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups.map(group => group.id)));
  const didAutoExpandGroups = useRef(groups.length > 0);
  const [groupLibraryState, setGroupLibraryState] = useState<'loading' | 'ready' | 'needs-import' | 'error'>(userId ? 'loading' : 'ready');
  const [groupLibraryError, setGroupLibraryError] = useState<string | null>(null);
  const [groupLibraryBusy, setGroupLibraryBusy] = useState(false);
  const [groupSaveBusy, setGroupSaveBusy] = useState(false);
  const groupSaveInFlight = useRef(false);
  const pendingCloudGroupSaves = useRef(new Map<string, { owner: string; group: CopyGroupConfig }>());
  const [editorGroup, setEditorGroup] = useState<CopyGroupConfig | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [pendingUnavailableFollowerRemoval, setPendingUnavailableFollowerRemoval] = useState<PendingUnavailableFollowerRemoval | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tableSettingsOpen, setTableSettingsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [dayCardOpen, setDayCardOpen] = useState(false);
  const [redactNames, setRedactNames] = useState(false);
  const [redaction, setRedaction] = useState<RedactionSettings>(initialViewSettings.redaction);
  const [confirmRearmAfterFlatten, setConfirmRearmAfterFlatten] = useState(initialViewSettings.confirmRearmAfterFlatten);
  const [templates, setTemplates] = useState<CopyGroupTemplate[]>(loadTemplates);
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [verifyingAccountId, setVerifyingAccountId] = useState<number | null>(null);
  const [copierTransition, setCopierTransition] = useState<'connecting' | 'disconnecting' | null>(null);
  const [transitionGroupId, setTransitionGroupId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'info' | 'error'; text: string; accountIds?: number[] } | null>(null);
  const groupLibraryFence = useRef(new CopyGroupLibraryRequestFence(userId)).current;
  groupLibraryFence.setOwner(userId);
  const runtimeGroupRef = useRef(runtimeGroup);
  const availableAccountIdsRef = useRef(snapshot.accounts.map(account => account.id));
  runtimeGroupRef.current = runtimeGroup;
  availableAccountIdsRef.current = snapshot.accounts.map(account => account.id);

  const refreshGroupLibrary = useCallback(async (showLoading = false) => {
    const token = groupLibraryFence.beginRead();
    if (!token) return;
    if (!userId) {
      setGroupLibraryState('ready');
      setGroupLibraryError(null);
      return;
    }
    if (showLoading) setGroupLibraryState('loading');
    try {
      const loaded = await loadCopyGroupLibrary(userId, [], () => groupLibraryFence.canAcceptRead(token));
      if (!groupLibraryFence.canAcceptRead(token)) return;
      const currentRuntime = runtimeGroupRef.current;
      const next = currentRuntime
        ? adoptRuntimeCopyGroup(loaded.groups, availableAccountIdsRef.current, currentRuntime)
        : loaded.groups;
      setGroups(next);
      setGroupLibraryState(loaded.needsLegacyImport ? 'needs-import' : 'ready');
      setGroupLibraryError(null);
    } catch (reason) {
      if (!groupLibraryFence.canAcceptRead(token)) return;
      setGroupLibraryState('error');
      setGroupLibraryError(copyGroupLibraryErrorMessage(reason));
    }
  }, [groupLibraryFence, userId]);

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
      localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
      localStorage.setItem(VIEW_SETTINGS_STORAGE_KEY, JSON.stringify({ redaction, confirmRearmAfterFlatten }));
    } catch { /* private mode */ }
  }, [columnOrder, confirmRearmAfterFlatten, hiddenGroupColumns, hiddenOrderColumns, redaction]);

  useEffect(() => {
    void refreshGroupLibrary(true);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshGroupLibrary();
    };
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      groupLibraryFence.invalidate();
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [groupLibraryFence, refreshGroupLibrary]);

  useEffect(() => {
    setGroups(current => {
      const merged = mergeCopyGroups(current, snapshot);
      const next = runtimeGroup
        ? adoptRuntimeCopyGroup(merged, snapshot.accounts.map(account => account.id), runtimeGroup)
        : merged;
      return stabilizeCopyGroups(current, next);
    });
  }, [runtimeGroup, snapshot]);

  // `enabled` zde znamená jedinou execution-aktivní skupinu, ne členství
  // účtů v uloženém profilu. Runtime je autoritativní a všechny ostatní
  // uložené skupiny musí zůstat neaktivní i když sdílejí stejné účty.
  useEffect(() => {
    if (!executionGroupId) return;
    setGroups(current => stabilizeCopyGroups(current, current.map(group => {
      const enabled = group.id === executionGroupId
        ? (runtimeGroup?.enabled ?? group.enabled)
        : false;
      return group.enabled === enabled ? group : { ...group, enabled };
    })));
  }, [executionGroupId, runtimeGroup?.enabled]);

  useEffect(() => {
    if (didAutoExpandGroups.current || groups.length === 0) return;
    didAutoExpandGroups.current = true;
    setExpanded(new Set(groups.map(group => group.id)));
  }, [groups]);

  useEffect(() => {
    writeCopyGroupCache(userId, groups);
    onGroupsChange?.(groups);
  }, [groups, onGroupsChange, userId]);

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

  // Úzké okno sloupce nepřebírá. Dřív pod 1100 px tabulka vlastní výběr
  // zahodila a nechala sedm „základních“ sloupců, k tomu přibylo tlačítko na
  // přepnutí zpět — uživatel ale nastavení sloupců dělá právě proto, aby
  // platilo pořád. Širší tabulka se vodorovně odscrolluje v `.live-accounts-scroll`.
  const visibleColumns = useMemo(() => {
    const byKey = new Map(ACCOUNT_COLUMNS.map(column => [column.key, column]));
    return columnOrder.accounts
      .flatMap(key => { const column = byKey.get(key); return column ? [column] : []; })
      .filter(c => !hiddenColumns.has(c.key));
  }, [columnOrder.accounts, hiddenColumns]);

  const visibleGroupColumns = useMemo(() => columnOrder.groups.flatMap(key => {
    const column = GROUP_COLUMN_OPTIONS.find(option => option.key === key);
    return column && !hiddenGroupColumns.has(key) ? [column] : [];
  }), [columnOrder.groups, hiddenGroupColumns]);

  const visibleOrderColumns = useMemo(() => columnOrder.orders.flatMap(key => {
    const column = ORDER_COLUMN_OPTIONS.find(option => option.key === key);
    return column && !hiddenOrderColumns.has(key) ? [column] : [];
  }), [columnOrder.orders, hiddenOrderColumns]);

  const verifyAccountEligibility = async (accountId: number) => {
    if (!onVerifyEligibility || verifyingAccountId != null) return;
    setVerifyingAccountId(accountId);
    try {
      await onVerifyEligibility(accountId);
      setToast({ tone: 'success', text: 'Účet byl autoritativně ověřen u brokera.' });
    } catch (reason) {
      setToast({
        tone: 'error',
        text: reason instanceof Error ? reason.message : 'Účet se u brokera nepodařilo ověřit.',
      });
    } finally {
      setVerifyingAccountId(null);
    }
  };

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
  const tradeCutsByAccount = useMemo(() => new Map(
    (followerCuts ?? [])
      .filter(cut => cut.source === 'manual' && cut.scope === 'trade' && cut.until > Date.now())
      .map(cut => [cut.accountId, cut]),
  ), [followerCuts]);

  const profilesById = useMemo(() => {
    const next = new Map<number, TradovateAccountProfile>();
    for (const profile of accountProfiles) {
      const accountId = Number(profile.externalAccountId);
      if (Number.isSafeInteger(accountId)) next.set(accountId, profile);
    }
    return next;
  }, [accountProfiles]);
  const sourceGroupsById = useMemo(() => new Map(snapshot.groups.map(group => [group.id, group])), [snapshot.groups]);
  const accountLabel = useMemo(() => createCopyTradeAccountLabelResolver({
    accountsById,
    profilesById,
    sourceGroupsById,
  }), [accountsById, profilesById, sourceGroupsById]);
  const knownAccountIds = useMemo(() => [...new Set([
    ...groups.flatMap(group => [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]),
    runtimeGroup?.leaderAccountId,
    ...(runtimeGroup?.followers.map(follower => follower.accountId) ?? []),
  ].filter((accountId): accountId is number => accountId != null))], [groups, runtimeGroup]);
  // Karta dne počítá JEN účty z kopírovacích skupin, ne celý OAuth snapshot.
  // Ten totiž nese i demo účty, které chodí s Tradovate přihlášením — na kartě
  // se pak objevil účet, o kterém uživatel ani nevěděl, a šel ven i ve
  // veřejném odkazu. `LiveAccount` si prostředí nenese, takže se demo nedá
  // odfiltrovat přímo; členství ve skupině je zároveň přesnější odpověď na
  // otázku „které účty vlastně provozuju“.
  const dayAccounts = useMemo(() => {
    const wanted = new Set(knownAccountIds);
    return snapshot.accounts.filter(account => wanted.has(account.id));
  }, [knownAccountIds, snapshot.accounts]);
  // Den se počítá při každém renderu jako u řádků skupin: `Date.now()` v memo
  // by zamrzlo a potvrzená hodnota by nikdy nezestárla.
  const daySummary = buildLiveDaySummary(dayAccounts, Date.now(), dailyPnlPending);

  const rulesGroup = runtimeGroup
    ?? groups.find(group => group.id === executionGroupId)
    ?? groups[0]
    ?? null;
  const tightenOnly = sessionArmedAt > 0;
  const renderAccountMessage = (message: string, accountIds: Iterable<number> = knownAccountIds) =>
    formatKnownCopyTradeAccountIds(message, accountIds, accountId => accountLabel(accountId));
  const connectionByFirm = useMemo(
    () => new Map(snapshot.connections.map(c => [c.firm, c])),
    [snapshot.connections],
  );

  /** Účet je živý jen tehdy, když jeho firma hlásí aktivní připojení. */
  const isLive = (account?: LiveAccount) =>
    !!account && (connectionByFirm.get(account.firm)?.connected ?? false);

  const anyLive = snapshot.accounts.some(isLive);
  const activityForGroup = (candidate: CopyGroupConfig) => {
    const accountIds = new Set([
      candidate.leaderAccountId,
      ...candidate.followers.map(follower => follower.accountId),
    ].filter((accountId): accountId is number => accountId != null));
    const positionAccounts = snapshot.accounts
      .filter(account => accountIds.has(account.id)
        && account.positions.some(position => position.netPosition !== 0))
      .map(account => account.id);
    const workingOrderAccounts = [...new Set(orders
      .filter(order => order.accountId != null
        && accountIds.has(order.accountId)
        && liveOrderIsOpenForSafety(order))
      .map(order => order.accountId as number))];
    return { positionAccounts, workingOrderAccounts };
  };

  const groupActivityDetail = (candidate: CopyGroupConfig): string | null => {
    const activity = activityForGroup(candidate);
    const parts = [
      activity.positionAccounts.length > 0
        ? `otevřená pozice: ${activity.positionAccounts.map(accountId => accountLabel(accountId, candidate.id)).join(', ')}`
        : '',
      activity.workingOrderAccounts.length > 0
        ? `pracovní příkaz/SL/TP: ${activity.workingOrderAccounts.map(accountId => accountLabel(accountId, candidate.id)).join(', ')}`
        : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const requestUnavailableFollowerRemoval = (
    saved: CopyGroupConfig,
    draft: CopyGroupConfig,
    leaderUnavailableAccountId: number | null = null,
    source: PendingUnavailableFollowerRemoval['source'] = 'arm',
  ) => {
    setPendingUnavailableFollowerRemoval({
      source,
      saved: structuredClone(saved),
      editGroup: structuredClone(draft),
      plan: leaderUnavailableAccountId == null
        ? unavailableFollowerRemovalPlan(
          draft,
          snapshot.accounts.map(account => account.id),
          unverifiableFollowerOwnership,
        )
        : null,
      leaderUnavailableAccountId,
      error: null,
      savedSuccessfully: false,
      ownershipWaiverStep: false,
    });
  };

  const runCopierTransition = async (
    groupId: string,
    connecting: boolean,
    action: () => Promise<void> | void,
  ) => {
    if (copierTransition) return;
    setTransitionGroupId(groupId);
    setCopierTransition(connecting ? 'connecting' : 'disconnecting');
    try {
      await action();
      setToast(connecting
        // Připojení znamená ostré odesílání příkazů brokerovi, proto po
        // úspěšném preflightu zůstává výsledek viditelný v jednoznačném toastu.
        ? { tone: 'success', text: 'Copier je připojený — příkazy leadera se kopírují naostro.' }
        : { tone: 'info', text: 'Copier je bezpečně odpojený.' });
    } catch (reason) {
      const rejected = connecting ? copierArmRejection(reason) : null;
      const detail = reason instanceof Error
        ? reason.message
        : connecting ? 'Copier se nepodařilo připojit.' : 'Copier se nepodařilo odpojit.';
      const affectedGroup = groups.find(group => group.id === groupId)
        ?? (runtimeGroup?.id === groupId ? runtimeGroup : null);
      setPendingAction({
        title: rejected ? 'Zapnutí kopírky je zablokované' : connecting ? 'Zapnutí kopírky není potvrzené' : 'Vypnutí kopírky není potvrzené',
        detail: rejected ?? `${detail} AlphaTrade nebude pokračovat bez autoritativního potvrzení runtime. Zkontroluj aktuální stav skupiny a akci zopakuj až po ověření.`,
        confirmLabel: 'Rozumím',
        danger: true,
        blocked: true,
        outcomeUnknown: !rejected,
        outcomeRejected: !!rejected,
        accountIds: affectedGroup
          ? [affectedGroup.leaderAccountId, ...affectedGroup.followers.map(follower => follower.accountId)]
            .filter((accountId): accountId is number => accountId != null)
          : undefined,
      });
    } finally {
      setCopierTransition(null);
      setTransitionGroupId(null);
    }
  };

  /**
   * Smazání skupiny z řádku i z karty. Zapnutou skupinu runtime odmítne sám
   * (`runCommand` volá adaptér dřív, než se sáhne na lokální stav), tady
   * varujeme dopředu, ať uživatel nenaráží do chyby.
   */
  const requestGroupDelete = (candidate: CopyGroupConfig) => {
    const powered = copierArmed && candidate.id === executionGroupId;
    if (powered) {
      setPendingAction({
        title: 'Skupina je zapnutá',
        detail: `Skupinu ${candidate.name} nejde smazat, dokud kopírka jede. Nejdřív ji vypni.`,
        confirmLabel: 'Rozumím',
        danger: true,
        blocked: true,
      });
      return;
    }
    setPendingAction({
      title: 'Smazat skupinu?',
      detail: `Skupina ${candidate.name} bude odstraněna z konfigurace. Otevřené pozice ani příkazy na účtech to nijak nezmění.`,
      confirmLabel: 'Smazat',
      danger: true,
      command: { type: 'delete-group', groupId: candidate.id },
    });
  };

  const requestGroupPower = (candidate: CopyGroupConfig) => {
    if (copierTransition || copierStatusPending) return;
    const powered = copierArmed && candidate.id === executionGroupId;
    if (!powered && pauseActive) {
      setPendingAction({
        title: 'Kopírování je pozastavené',
        detail: 'Ještě běží cooldown nebo pauza pravidel dne. Vyčkej na konec obou pauz; samotný odpočet kopírku nezapne.',
        confirmLabel: 'Rozumím',
        danger: true,
        blocked: true,
      });
      return;
    }
    const currentGroup = runtimeGroup
      ?? groups.find(group => group.id === executionGroupId)
      ?? null;
    const candidateActivity = groupActivityDetail(candidate);
    const currentActivity = currentGroup ? groupActivityDetail(currentGroup) : null;

    const validation = powered
      ? null
      : validateCopyGroup(candidate, snapshot.accounts.map(account => account.id));
    const validationErrors = validation
      ? copyGroupValidationMessages(validation, accountId => accountLabel(accountId, candidate.id))
      : [];
    const validationIssues = validation?.issues ?? [];
    const onlyUnavailableAccounts = validationIssues.length > 0
      && validationIssues.every(issue => issue.code === 'leader-unavailable' || issue.code === 'follower-unavailable');
    if (!powered && validation && onlyUnavailableAccounts) {
      const unavailable = unavailableCopyGroupAccounts(candidate, snapshot.accounts.map(account => account.id));
      requestUnavailableFollowerRemoval(
        candidate,
        candidate,
        unavailable.leaderAccountId,
      );
      return;
    }
    const blocker = copyGroupPowerBlocker({
      powered,
      candidateName: candidate.name,
      candidateId: candidate.id,
      currentGroupId: currentGroup?.id ?? null,
      candidateActivity,
      currentActivity,
      validationErrors,
    });
    if (blocker) {
      setPendingAction({
        ...blocker,
        confirmLabel: 'Rozumím',
        danger: true,
        blocked: true,
        accountIds: validation?.issues?.flatMap(issue => issue.accountId == null ? [] : [issue.accountId]),
      });
      return;
    }

    if (powered) {
      if (!onDisarm) {
        setPendingAction({
          title: 'Copier nelze vypnout',
          detail: 'Execution runtime není dostupný. AlphaTrade nemůže bezpečně potvrdit vypnutí copieru.',
          confirmLabel: 'Rozumím',
          danger: true,
          blocked: true,
        });
        return;
      }
      void runCopierTransition(candidate.id, false, onDisarm);
      return;
    }

    const armAction = onSwitchAndArm ?? (candidate.id === executionGroupId ? onArmLive : undefined);
    if (!armAction) {
      setPendingAction({
        title: 'Copier nelze zapnout',
        detail: 'Execution runtime není dostupný. AlphaTrade nemůže provést autoritativní kontrolu ani zapnutí LIVE.',
        confirmLabel: 'Rozumím',
        danger: true,
        blocked: true,
      });
      return;
    }
    void runCopierTransition(candidate.id, true, () => armAction(candidate));
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

  const runCommand = async (
    command: LiveCopyTradingCommand,
    update?: () => void | Promise<void>,
    onError?: (message: string) => void,
  ): Promise<boolean> => {
    const key = command.type === 'flatten-account' || command.type === 'flatten-follower-trade' || command.type === 'set-replication' || command.type === 'set-multiplier'
      ? `${command.type}-${command.accountId}`
      : 'groupId' in command ? `${command.type}-${command.groupId}` : command.type;
    const brokerWrite = command.type === 'flatten-account' || command.type === 'flatten-follower-trade' || command.type === 'flatten-group' || command.type === 'cancel-order';
    const requiresArmed = command.type === 'cancel-order' || command.type === 'flatten-follower-trade';
    const commandGroupId = command.type === 'create-group' || command.type === 'update-group'
      ? command.group.id
      : 'groupId' in command ? command.groupId : null;
    const targetsExecutionRuntime = commandGroupId != null && commandGroupId === executionGroupId;
    if (busyCommand) return false;
    setBusyCommand(key);
    try {
      if (brokerWrite && copierKillSwitch && commandBlockedByCopierKillSwitch(command)) {
        setToast({ tone: 'error', text: 'Kill switch je aktivní. Brokerový příkaz byl zablokován.' });
        return false;
      }
      if (brokerWrite && (!commandAdapter || !targetsExecutionRuntime || (requiresArmed && !copierArmed))) {
        await update?.();
        setToast({ tone: 'info', text: 'Preview pouze: tato skupina není připojená k připravenému execution runtime.' });
        return true;
      }
      const result = commandAdapter && targetsExecutionRuntime
        ? await commandAdapter.execute(command)
        : undefined;
      if (result && result.type === 'flatten' && !result.flat) {
        throw new Error(
          `Flatten není potvrzen jako flat: positions=${result.remainingPositionAccounts.join(',') || 'none'} working=${result.workingOrderAccounts.join(',') || 'none'}`,
        );
      }
      await update?.();
      const successText = result && result.type === 'flatten'
        ? command.type === 'flatten-follower-trade'
          ? 'Účet je potvrzeně flat a čeká na další obchod. Ostatní účty i kopírka pokračují.'
          : `Flatten potvrzen: ${result.accountIds.length} účtů je flat, zrušeno ${result.canceledOrders} příkazů, odesláno ${result.submittedClosures} close příkazů.`
        : command.type === 'resolve-stuck-operation'
          ? 'Operace označena za vyřešenou. Runtime je VYPNUTO; před zapnutím proběhne nová kontrola pozic.'
          : command.type === 'set-multiplier'
          ? `Násobek ${normalizeMultiplier(command.multiplier)} byl potvrzen lokálním execution runtime. Runtime zůstává VYPNUTO do nového zapnutí.`
          : 'Změna byla potvrzena přes execution adaptér.';
      setToast({
        tone: commandAdapter && targetsExecutionRuntime ? 'success' : 'info',
        text: commandAdapter && targetsExecutionRuntime
          ? successText
          : 'Konfigurace byla uložena pouze lokálně. Tato skupina není připojená k execution runtime.',
      });
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Akci se nepodařilo dokončit.';
      if (onError) onError(message);
      else {
        setToast({
          tone: 'error',
          text: message,
          ...('accountId' in command && typeof command.accountId === 'number'
            ? { accountIds: [command.accountId] }
            : {}),
        });
      }
      return false;
    } finally {
      setBusyCommand(null);
    }
  };

  const saveGroup = async (
    group: CopyGroupConfig,
    onError?: (message: string) => void,
    waiveUnverifiableFollowerOwnership = false,
  ): Promise<boolean> => {
    if (groupSaveInFlight.current) return false;
    const pending = pendingCloudGroupSaves.current.get(group.id);
    const confirmedGroup = pending?.owner === userId ? pending.group : null;
    let exists = groups.some(candidate => candidate.id === group.id);
    const normalizedGroup = group.id === executionGroupId
      ? group
      : { ...group, enabled: false };
    const validation = validateCopyGroup(normalizedGroup, snapshot.accounts.map(account => account.id));
    if (!validation.valid) {
      const message = copyGroupValidationMessages(validation, accountId => accountLabel(accountId, normalizedGroup.id)).join(' ');
      if (onError) onError(message);
      else {
        setToast({
          tone: 'error',
          text: message,
          accountIds: validation.issues?.flatMap(issue => issue.accountId == null ? [] : [issue.accountId]),
        });
      }
      return false;
    }
    // Editor se smí přepnout na nový leader až po potvrzení execution
    // runtime. Když broker preflight změnu odmítne, runCommand callback
    // nespustí a UI tak nikdy nelže o jiné topologii než drží worker.
    if (groupLibraryState === 'needs-import' && !confirmedGroup) {
      const message = 'Nejdřív potvrď jednorázový import lokálních skupin do cloudu.';
      if (onError) onError(message); else setToast({ tone: 'error', text: message });
      return false;
    }
    groupSaveInFlight.current = true;
    setGroupSaveBusy(true);
    const write = groupLibraryFence.beginWrite();
    try {
      if (groupLibraryState !== 'ready') {
        // An explicit save/retry owns this refresh. Focus/online events and old
        // reads cannot supersede it or write stale cache while the draft saves.
        try {
          const loaded = await loadCopyGroupLibrary(userId, [], () => groupLibraryFence.canAcceptWrite(write));
          if (!groupLibraryFence.canAcceptWrite(write)) return false;
          const currentRuntime = runtimeGroupRef.current;
          let refreshed = currentRuntime
            ? adoptRuntimeCopyGroup(loaded.groups, availableAccountIdsRef.current, currentRuntime)
            : loaded.groups;
          // Runtime/local command already succeeded; a failed cloud save must
          // not turn a retry into a second create or make its draft disappear.
          if (confirmedGroup && !refreshed.some(candidate => candidate.id === group.id)) {
            refreshed = [...refreshed, confirmedGroup];
          }
          setGroups(refreshed);
          const needsImport = loaded.needsLegacyImport && !confirmedGroup;
          setGroupLibraryState(needsImport ? 'needs-import' : 'ready');
          setGroupLibraryError(null);
          if (needsImport) {
            const message = 'Nejdřív potvrď jednorázový import lokálních skupin do cloudu.';
            if (onError) onError(message); else setToast({ tone: 'error', text: message });
            return false;
          }
          if (exists && !refreshed.some(candidate => candidate.id === group.id)) {
            const message = 'Tato skupina už v knihovně není. Rozepsané údaje zůstaly ve formuláři; ověř změny na ostatních zařízeních.';
            if (onError) onError(message); else setToast({ tone: 'error', text: message });
            return false;
          }
          exists = refreshed.some(candidate => candidate.id === group.id);
        } catch (reason) {
          if (!groupLibraryFence.canAcceptWrite(write)) return false;
          const message = copyGroupLibraryErrorMessage(reason);
          setGroupLibraryState('error');
          setGroupLibraryError(message);
          if (onError) onError(message); else setToast({ tone: 'error', text: message });
          return false;
        }
      }
      const command: LiveCopyTradingCommand = exists
        ? {
          type: 'update-group', group: normalizedGroup,
          ...(waiveUnverifiableFollowerOwnership ? { waiveUnverifiableFollowerOwnership: true } : {}),
        }
        : { type: 'create-group', group: normalizedGroup };
      const persistConfirmedGroup = async () => {
        if (!groupLibraryFence.canAcceptWrite(write)) return;
        pendingCloudGroupSaves.current.set(group.id, { owner: userId, group: normalizedGroup });
        setGroups(current => exists
          ? current.map(candidate => candidate.id === normalizedGroup.id ? normalizedGroup : candidate)
          : [...current, normalizedGroup]);
        setExpanded(current => new Set(current).add(normalizedGroup.id));
        try {
          await saveCopyGroup(userId, normalizedGroup);
          if (groupLibraryFence.canAcceptWrite(write)) {
            pendingCloudGroupSaves.current.delete(group.id);
            setGroupLibraryState('ready');
            setGroupLibraryError(null);
            setEditorGroup(null);
          }
        } catch (reason) {
          if (groupLibraryFence.canAcceptWrite(write)) {
            const message = copyGroupLibraryErrorMessage(reason);
            setGroupLibraryState('error');
            setGroupLibraryError(message);
          }
          throw reason;
        }
      };
      if (confirmedGroup && JSON.stringify(copyGroupForStorage(confirmedGroup)) === JSON.stringify(copyGroupForStorage(normalizedGroup))) {
        try {
          await persistConfirmedGroup();
          return groupLibraryFence.canAcceptWrite(write);
        } catch (reason) {
          if (groupLibraryFence.canAcceptWrite(write)) {
            const message = copyGroupLibraryErrorMessage(reason);
            if (onError) onError(message); else setToast({ tone: 'error', text: message });
          }
          return false;
        }
      }
      const saved = await runCommand(command, persistConfirmedGroup, message => {
        if (!groupLibraryFence.canAcceptWrite(write)) return;
        if (onError) onError(message); else setToast({ tone: 'error', text: message });
      });
      return saved && groupLibraryFence.canAcceptWrite(write);
    } finally {
      groupLibraryFence.endWrite(write);
      groupSaveInFlight.current = false;
      setGroupSaveBusy(false);
    }
  };

  const updateFollower = async (groupId: string, accountId: number, patch: Partial<{ mode: ReplicationMode; multiplier: number }>) => {
    if (groupLibraryState === 'loading' || groupLibraryState === 'error') {
      throw new Error('Počkej na načtení cloudové knihovny skupin.');
    }
    const previous = groups.find(group => group.id === groupId);
    if (!previous) return;
    const updated = {
      ...previous,
      followers: previous.followers.map(follower => follower.accountId !== accountId ? follower : {
        ...follower,
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.multiplier != null ? { multiplier: normalizeMultiplier(patch.multiplier) } : {}),
      }),
    };
    const write = groupLibraryFence.beginWrite();
    try {
      setGroups(current => current.map(group => group.id === groupId ? updated : group));
      if (groupLibraryState === 'ready') await saveCopyGroup(userId, updated);
    } catch (reason) {
      if (groupLibraryFence.canAcceptWrite(write)) {
        const message = reason instanceof Error ? reason.message : 'Změnu skupiny se nepodařilo synchronizovat.';
        // The worker already acknowledged this change. Preserve its state and
        // expose the failed cloud write instead of restoring stale settings.
        setGroupLibraryState('error');
        setGroupLibraryError(message);
        setToast({ tone: 'error', text: message });
      }
      throw reason;
    } finally {
      groupLibraryFence.endWrite(write);
    }
  };

  const importLocalGroupLibrary = async () => {
    if (groupLibraryBusy || groupLibraryState !== 'needs-import') return;
    const write = groupLibraryFence.beginWrite();
    setGroupLibraryBusy(true);
    try {
      const saved = await importCopyGroups(userId, groups);
      if (!groupLibraryFence.canAcceptWrite(write)) return;
      const currentRuntime = runtimeGroupRef.current;
      setGroups(currentRuntime
        ? adoptRuntimeCopyGroup(saved, availableAccountIdsRef.current, currentRuntime)
        : saved);
      setGroupLibraryState('ready');
      setGroupLibraryError(null);
      setToast({ tone: 'success', text: `${saved.length} skupin je nyní synchronizovaných mezi zařízeními.` });
    } catch (reason) {
      if (groupLibraryFence.canAcceptWrite(write)) {
        setGroupLibraryError(reason instanceof Error ? reason.message : 'Lokální skupiny se nepodařilo nahrát do cloudu.');
      }
    } finally {
      if (groupLibraryFence.canAcceptWrite(write)) setGroupLibraryBusy(false);
      groupLibraryFence.endWrite(write);
    }
  };

  const toggleGroup = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmUnavailableFollowerRemoval = async (plan: UnavailableFollowerRemovalPlan) => {
    if (busyCommand) return;
    if (plan.ownershipWarnings.length > 0 && !pendingUnavailableFollowerRemoval?.ownershipWaiverStep) {
      setPendingUnavailableFollowerRemoval(current => current ? {
        ...current,
        error: null,
        ownershipWaiverStep: true,
      } : current);
      return;
    }
    setPendingUnavailableFollowerRemoval(current => current ? { ...current, error: null } : current);
    const saved = await saveGroup(plan.group, message => {
      setPendingUnavailableFollowerRemoval(current => current ? { ...current, error: message } : current);
    }, plan.ownershipWarnings.length > 0);
    if (saved) {
      setPendingUnavailableFollowerRemoval(current => current ? {
        ...current,
        plan,
        error: null,
        savedSuccessfully: true,
      } : current);
    }
  };

  const orderedGroups = [...groups].sort((left, right) => {
    const leftPowered = copierArmed && left.id === executionGroupId;
    const rightPowered = copierArmed && right.id === executionGroupId;
    return leftPowered === rightPowered ? 0 : leftPowered ? -1 : 1;
  });
  // Zapnutá skupina se řadí nahoru. Bez FLIP by celý seznam přeskočil naráz
  // a nebylo by poznat, co se kam posunulo.
  useFlipReorder(orderedGroups.map(group => group.id).join('|'));

  const requestAccountFlatten = (group: CopyGroupConfig, accountId: number) => {
    const followerInRunningTrade = copierArmed
      && group.id === executionGroupId
      && group.followers.some(follower => follower.accountId === accountId);
    setPendingAction({
      title: followerInRunningTrade ? 'Zavřít účet jen pro tento obchod?' : 'Flatten účet?',
      detail: followerInRunningTrade
        ? 'Zavře pouze potvrzenou kopii a její čekající příkazy na tomto followerovi. Ostatní účty pokračují; účet se automaticky vrátí až po flat celé skupiny bez aktivních příkazů.'
        : 'Připraví uzavření všech otevřených pozic pouze na tomto účtu a kopírku z bezpečnostních důvodů vypne.',
      accountIds: [accountId],
      confirmLabel: followerInRunningTrade ? 'Zavřít jen tento účet' : 'Flatten',
      danger: true,
      command: followerInRunningTrade
        ? { type: 'flatten-follower-trade', groupId: group.id, accountId, operationId: manualOperationId() }
        : { type: 'flatten-account', groupId: group.id, accountId, operationId: manualOperationId() },
    });
  };

  // Stejné akce jako v desktopové tabulce, jen bez vazby na buňky <td>.
  const compactGroupActions = (group: CopyGroupConfig) => ({
    onFlatten: () => setPendingAction({
      title: 'Flatten All?', detail: `Připraví uzavření všech otevřených pozic ve skupině ${group.name}.`,
      confirmLabel: 'Flatten All', danger: true, command: {
        type: 'flatten-group', groupId: group.id, operationId: manualOperationId(),
      },
    }),
    onApplyTemplate: (template: CopyGroupTemplate) => {
      const currentSafety = group.safety ?? DEFAULT_COPY_GROUP_SAFETY;
      const currentFollowers = new Map(group.followers.map(follower => [follower.accountId, follower]));
      const updated: CopyGroupConfig = {
        ...group,
        leaderAccountId: template.leaderAccountId ?? group.leaderAccountId,
        followers: template.followers
          .filter(follower => follower.accountId !== (template.leaderAccountId ?? group.leaderAccountId))
          .map(follower => {
            const current = currentFollowers.get(follower.accountId);
            return current ? {
              ...follower,
              ...(current.dailyLossCutUsd == null ? {} : { dailyLossCutUsd: current.dailyLossCutUsd }),
              onCut: current.onCut ?? 'close-copy',
            } : follower;
          }),
        // Pravidla dne a existující per-account cuty mají jediný
        // editor v Risk; topologická šablona je nesmí tiše přepsat.
        safety: {
          ...template.safety,
          entryCooldownMinutes: currentSafety.entryCooldownMinutes,
          armExpiryFlatten: currentSafety.armExpiryFlatten,
          dailyLossLimitUsd: currentSafety.dailyLossLimitUsd,
          dailyMaxLosingTrades: currentSafety.dailyMaxLosingTrades,
          dailyMaxTrades: currentSafety.dailyMaxTrades,
          tradingWindow: { ...currentSafety.tradingWindow },
          dayRuleActions: structuredClone(
            currentSafety.dayRuleActions ?? DEFAULT_COPY_GROUP_SAFETY.dayRuleActions,
          ),
        },
      };
      void saveGroup(updated);
    },
    onFlattenAccount: (accountId: number) => requestAccountFlatten(group, accountId),
    onCancelOrder: (orderId: number) => setPendingAction({
      title: 'Zrušit příkaz?', detail: 'Připraví zrušení tohoto pracovního příkazu.',
      confirmLabel: 'Zrušit příkaz', danger: true, command: { type: 'cancel-order', groupId: group.id, orderId },
    }),
    onRemoveUnavailableFollower: () => requestUnavailableFollowerRemoval(group, group, null, 'row'),
  });

  // Ostrov popisuje skupinu, která je právě v exekuci; bez ní nemá co hlásit.
  const islandGroup = executionGroupId
    ? groups.find(group => group.id === executionGroupId) ?? null
    : groups.length === 1 ? groups[0] : null;
  const islandModel = useMemo(() => {
    if (!islandGroup) return null;
    const ids = [islandGroup.leaderAccountId, ...islandGroup.followers.map(follower => follower.accountId)]
      .filter((id): id is number => id != null);
    const accounts = ids.map(id => accountsById.get(id)).filter((a): a is LiveAccount => !!a);
    return buildLiveCopierIsland({
      // Fail-closed: dokud worker neodpověděl, ostrov netvrdí, že je vypnuto.
      statusKnown: runtimeAvailable && !copierStatusPending,
      armed: copierArmed,
      killSwitch: copierKillSwitch,
      groupName: islandGroup.name ?? null,
      accounts,
      configuredAccountCount: ids.length,
      orders: orders.filter(order => order.accountId != null && ids.includes(order.accountId)),
      leaderAccountId: islandGroup.leaderAccountId ?? null,
      divergentAccounts: runtimeStatus?.divergentAccounts ?? [],
      armExpiresAt: runtimeStatus?.armExpiresAt ?? 0,
      groupDailyPnl: liveGroupDailyPnlDisplay(accounts, Date.now(), dailyPnlPending),
      tradesToday: dailyStats?.tradesToday ?? null,
      maxTradesPerDay: runtimeGroup?.safety?.dailyMaxTrades ?? null,
      marketPrices,
    });
  }, [islandGroup, accountsById, runtimeAvailable, copierStatusPending, copierArmed, copierKillSwitch,
      orders, runtimeStatus, dailyPnlPending, dailyStats, runtimeGroup, marketPrices]);


  return (
    <div key={userId} className="space-y-5">
      <LiveCopierIsland
        model={islandModel}
        anchorId={islandGroup?.id ?? null}
        onAction={action => {
          // Vypnutí je bezpečný směr, proto jde rovnou. Zásahy do trhu
          // (Flatten, zrušení příkazu) ostrov nespouští — odveze k řádku
          // skupiny, kde je potvrzení i kontext.
          if (action === 'disarm') { void onDisarm?.(); return; }
          document.getElementById('live-copy-groups')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
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

      {groupLibraryState === 'needs-import' ? (
        <div className="flex flex-col gap-3 rounded-lg border border-indigo-500/30 bg-indigo-500/[0.08] p-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-sm font-black text-[var(--text-primary)]">Přenést lokální skupiny do cloudu</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Na tomto zařízení je {groups.length} lokálních skupin. Potvrď je jako výchozí knihovnu pro PC, iPhone a Mac.
            </p>
          </div>
          <button
            type="button"
            disabled={groupLibraryBusy}
            onClick={() => void importLocalGroupLibrary()}
            className="h-9 rounded-md bg-indigo-600 px-4 text-xs font-black text-white disabled:opacity-50"
          >
            {groupLibraryBusy ? 'Přenáším…' : `Synchronizovat ${groups.length} skupin`}
          </button>
        </div>
      ) : null}

      {groupLibraryState === 'error' ? (
        <div className="flex items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.08] p-4 text-rose-500">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="flex-1 text-xs font-bold">{groupLibraryError ?? 'Cloudová knihovna skupin není dostupná.'}</span>
          <button type="button" onClick={() => void refreshGroupLibrary(true)} className="text-xs font-black uppercase">Zkusit znovu</button>
        </div>
      ) : null}

      <section id="live-copy-groups" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-5 lg:px-6 py-4 flex-wrap">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h3 className="text-lg font-black text-[var(--text-primary)]">Kopírovací skupiny</h3>
            <LiveDayTrigger summary={daySummary} onOpen={() => setDayCardOpen(true)} />
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={groupLibraryState !== 'ready'}
              onClick={() => setEditorGroup({
                id: createLocalCopyGroupId(), name: '', enabled: false, leaderAccountId: null,
                followers: [], color: GROUP_COLORS[0], safety: { ...DEFAULT_COPY_GROUP_SAFETY }, localOnly: true,
              })}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2 text-xs font-bold text-[var(--text-secondary)] transition-colors hover:border-indigo-500/30 hover:bg-indigo-500/[0.06] hover:text-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={14} /> Přidat skupinu
            </button>
            {!compact ? (<>
            <button onClick={() => setHelpOpen(true)} title="Nápověda" className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><HelpCircle size={14} /></button>
            <button onClick={() => setTableSettingsOpen(true)} title="Nastavení tabulky" className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><Settings2 size={14} /></button>
            <button onClick={() => setRedactNames(value => !value)} title={redactNames ? 'No redaction' : 'Redact account names'} className={`flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] ${redactNames ? 'bg-indigo-500/10 text-indigo-500' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{redactNames ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </>) : null}
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
        ) : compact ? (
          <div className="space-y-3 px-3 pb-3" data-testid="compact-group-list">
            {orderedGroups.map(group => {
              const rows = groupRows(group, accountsById, sourceGroupsById.get(group.id), profilesById);
              const selected = group.id === executionGroupId;
              const armed = selected && copierArmed;
              return (
                <CompactGroupCard
                  key={group.id}
                  group={group}
                  rows={rows}
                  armed={armed}
                  islandTone={islandModel && islandGroup?.id === group.id && islandModel.tone !== 'muted'
                    ? islandModel.tone
                    : null}
                  observingOnly={selected && copierObservingOnly}
                  statusPending={copierStatusPending && (executionGroupId == null || selected)}
                  runtimeReady={!!onSwitchAndArm || (!!commandAdapter && selected)}
                  transition={transitionGroupId === group.id ? copierTransition : null}
                  connectBlocked={copierKillSwitch || dayLockUntil > Date.now() || pauseActive}
                  dailyPnlPending={dailyPnlPending}
                  eligibility={group.followers
                    .filter(follower => follower.mode !== 'off')
                    .map(follower => eligibilityByAccount.get(follower.accountId))}
                  eligibilityByAccount={eligibilityByAccount}
                  tradeCutsByAccount={tradeCutsByAccount}
                  orders={orders}
                  isLive={isLive}
                  onAccount={onAccount}
                  busyCommand={busyCommand}
                  onVerifyEligibility={verifyAccountEligibility}
                  verifyingAccountId={verifyingAccountId}
                  onConnectionToggle={() => requestGroupPower(group)}
                  onEdit={() => setEditorGroup(structuredClone(group))}
                  onDelete={() => requestGroupDelete(group)}
                  onToggleEnabled={() => requestGroupPower(group)}
                  onRefreshOrders={onRefreshOrders}
                  redactNames={redactNames}
                  redaction={redaction}
                  templates={templates}
                  tightenOnly={tightenOnly}
                  cooldownPanel={selected ? cooldownPanel : null}
                  disarmPanel={selected && !armed && showDisarmNotice && lastDisarm && lastDisarm.trigger !== 'manual'
                    ? <CopierDisarmPanel lastDisarm={lastDisarm} />
                    : null}
                  {...compactGroupActions(group)}
                />
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-left"
              style={{ minWidth: '900px' }}
            >
              <thead>
                <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-y border-[var(--border-subtle)]">
                  <th className="w-8" />
                  <th className="px-3 py-2.5">Skupina</th>
                  {visibleGroupColumns.map(column => (
                    <th key={column.key} className={`px-3 py-2.5${GROUP_COLUMNS_RIGHT.has(column.key) ? ' text-right' : ''}`}>{column.label}</th>
                  ))}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              {orderedGroups.map(group => {
                  const rows = groupRows(group, accountsById, sourceGroupsById.get(group.id), profilesById);
                  const selected = group.id === executionGroupId;
                  // `groups` se po mountu synchronizují efektem, ale už první
                  // render musí respektovat autoritativní runtime `enabled`.
                  // Jinak po reloadu na okamžik svítí vypnutá skupina jako aktivní.
                  // Runtime je jediný autoritativní zdroj ARM stavu. Připojení
                  // účtů, lokální group.enabled ani dostupnost adaptéru nesmí
                  // skutečně armovaný copier v UI zamaskovat jako OFF.
                  const armed = selected && copierArmed;
                  const tab = groupTab[group.id] || 'accounts';
                  return (
                    // Každá skupina má vlastní <tbody> (v HTML jich smí být víc).
                    // Jen tak jde rám nakreslit kolem celé skupiny naráz —
                    // skládání po řádcích ho trhalo na oddělovači i na pozadí
                    // detailu, které inset stín překrývalo.
                    <tbody
                      key={group.id}
                      data-flip-id={group.id}
                      className={islandModel && islandGroup?.id === group.id && islandModel.tone !== 'muted'
                        ? `live-island-group live-island-group-${islandModel.tone}`
                        : undefined}
                    >
                      <GroupRow
                        group={group} rows={rows} armed={armed}
                        dailyPnlPending={dailyPnlPending}
                        eligibility={group.followers
                          .filter(follower => follower.mode !== 'off')
                          .map(follower => eligibilityByAccount.get(follower.accountId))}
                        tradeCutsByAccount={tradeCutsByAccount}
                        observingOnly={selected && copierObservingOnly}
                        // Dokud stav neznáme, neznáme ani execution skupinu —
                        // neznámý stav proto platí pro všechny řádky.
                        statusPending={copierStatusPending && (executionGroupId == null || selected)}
                        runtimeReady={!!onSwitchAndArm || (!!commandAdapter && selected)}
                        transition={transitionGroupId === group.id ? copierTransition : null}
                        connectBlocked={copierKillSwitch || dayLockUntil > Date.now() || pauseActive}
                        onConnectionToggle={() => requestGroupPower(group)}
                        open={expanded.has(group.id)}
                        onToggle={() => toggleGroup(group.id)}
                        onEdit={() => setEditorGroup(structuredClone(group))}
                        onDelete={() => requestGroupDelete(group)}
                        templates={templates}
                        tightenOnly={tightenOnly}
                        onApplyTemplate={template => {
                          const currentSafety = group.safety ?? DEFAULT_COPY_GROUP_SAFETY;
                          const currentFollowers = new Map(group.followers.map(follower => [follower.accountId, follower]));
                          const updated: CopyGroupConfig = {
                            ...group,
                            leaderAccountId: template.leaderAccountId ?? group.leaderAccountId,
                            followers: template.followers
                              .filter(follower => follower.accountId !== (template.leaderAccountId ?? group.leaderAccountId))
                              .map(follower => {
                                const current = currentFollowers.get(follower.accountId);
                                return current ? {
                                  ...follower,
                                  ...(current.dailyLossCutUsd == null ? {} : { dailyLossCutUsd: current.dailyLossCutUsd }),
                                  onCut: current.onCut ?? 'close-copy',
                                } : follower;
                              }),
                            // Pravidla dne a existující per-account cuty mají jediný
                            // editor v Risk; topologická šablona je nesmí tiše přepsat.
                            safety: {
                              ...template.safety,
                              entryCooldownMinutes: currentSafety.entryCooldownMinutes,
                              armExpiryFlatten: currentSafety.armExpiryFlatten,
                              dailyLossLimitUsd: currentSafety.dailyLossLimitUsd,
                              dailyMaxLosingTrades: currentSafety.dailyMaxLosingTrades,
                              dailyMaxTrades: currentSafety.dailyMaxTrades,
                              tradingWindow: { ...currentSafety.tradingWindow },
                              dayRuleActions: structuredClone(
                                currentSafety.dayRuleActions ?? DEFAULT_COPY_GROUP_SAFETY.dayRuleActions,
                              ),
                            },
                          };
                          void saveGroup(updated);
                        }}
                        onToggleEnabled={() => requestGroupPower(group)}
                        onFlatten={() => setPendingAction({
                          title: 'Flatten All?', detail: `Připraví uzavření všech otevřených pozic ve skupině ${group.name}.`,
                          confirmLabel: 'Flatten All', danger: true, command: {
                            type: 'flatten-group', groupId: group.id, operationId: manualOperationId(),
                          },
                        })}
                        redactNames={redactNames}
                        redaction={redaction}
                        groupColumns={visibleGroupColumns}
                      />
                      {selected && !armed && showDisarmNotice && lastDisarm && lastDisarm.trigger !== 'manual' ? (
                        <tr>
                          <td colSpan={3 + GROUP_COLUMN_OPTIONS.length - hiddenGroupColumns.size} className="p-0">
                            <CopierDisarmPanel lastDisarm={lastDisarm} />
                          </td>
                        </tr>
                      ) : null}
                      {selected ? <tr><td colSpan={3 + GROUP_COLUMN_OPTIONS.length - hiddenGroupColumns.size} className="p-0">{cooldownPanel}</td></tr> : null}
                      <tr
                        aria-hidden={!expanded.has(group.id)}
                      >
                        <td colSpan={3 + GROUP_COLUMN_OPTIONS.length - hiddenGroupColumns.size} className="p-0">
                          <div className={`live-group-expand grid overflow-hidden ${expanded.has(group.id) ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}>
                            <div className="min-h-0 overflow-hidden"><GroupDetail
                              rows={rows} tab={tab} isLive={isLive} onAccount={onAccount}
                              dailyPnlPending={dailyPnlPending}
                              columns={visibleColumns}
                              orders={orders}
                              eligibilityByAccount={eligibilityByAccount}
                              tradeCutsByAccount={tradeCutsByAccount}
                              onVerifyEligibility={verifyAccountEligibility}
                              verifyingAccountId={verifyingAccountId}
                              busyCommand={busyCommand}
                              onRefreshOrders={onRefreshOrders}
                              onMultiplier={(accountId, multiplier) => {
                                const follower = group.followers.find(item => item.accountId === accountId);
                                const next = normalizeMultiplier(multiplier);
                                if (!follower || follower.multiplier === next) return;
                                setPendingAction({
                                  title: 'Změnit násobek účtu?',
                                  detail: `Účet ${accountId}: ${follower.multiplier}× → ${next}×. Změna platí pouze pro tento účet; ostatní followeři zůstanou beze změny.`,
                                  confirmLabel: 'Potvrdit násobek',
                                  accountIds: [accountId],
                                  command: { type: 'set-multiplier', groupId: group.id, accountId, multiplier: next },
                                });
                              }}
                              onFlattenAccount={accountId => requestAccountFlatten(group, accountId)}
                              onRemoveUnavailableFollower={() => requestUnavailableFollowerRemoval(
                                group,
                                group,
                                null,
                                'row',
                              )}
                              onCancelOrder={orderId => setPendingAction({
                                title: 'Zrušit příkaz?', detail: 'Připraví zrušení tohoto pracovního příkazu.',
                                confirmLabel: 'Zrušit příkaz', danger: true, command: { type: 'cancel-order', groupId: group.id, orderId },
                              })}
                              onTab={t => setGroupTab(prev => ({ ...prev, [group.id]: t }))}
                              redactNames={redactNames}
                              redaction={redaction}
                              orderColumns={visibleOrderColumns}
                              tightenOnly={tightenOnly}
                            /></div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  );
                })}
            </table>
          </div>
        )}

        <footer className="px-5 lg:px-6 py-3 border-t border-[var(--border-subtle)] text-[11px] font-bold text-[var(--text-secondary)]">
          Celkem skupin: <span className="text-[var(--text-primary)]">{groups.length}</span>
        </footer>
      </section>

      {/* Pozice jsou hlavní i na desktopu: Risk je jeden klepnutelný řádek až pod
          skupinami, detail má vlastní záložku. Stav workeru a snímků je v Událostech. */}
      {(
        <LiveRiskSummaryCard
          status={runtimeStatus}
          runtimeAvailable={runtimeAvailable}
          riskConfigSupported={riskConfigSupported}
          group={rulesGroup}
          dailyStats={dailyStats}
          dayLockUntil={dayLockUntil}
          pause={pause}
          followerCuts={followerCuts}
          accountRisk={accountRisk}
          accounts={snapshot.accounts}
          brokerDailyPnlByAccount={brokerDailyPnlByAccount}
          brokerDailyPnlPending={dailyPnlPending}
          onOpenRisk={onOpenRisk}
          compact
        />
      )}
      {journalHistory}
      {!compact ? (
        <LivePnlPanel
          open={apiPanelOpen}
          onToggle={() => setApiPanelOpen(v => !v)}
          dataActive={anyLive}
          apiReady={!!commandAdapter}
          onHelp={() => setHelpOpen(true)}
          telemetry={apiTelemetry}
          connectionUsage={connectionUsage}
        />
      ) : null}

      {editorGroup && (
        <GroupEditorDialog
          group={editorGroup}
          isNew={!groups.some(group => group.id === editorGroup.id)}
          tightenOnly={tightenOnly}
          accounts={snapshot.accounts}
          accountLabel={(accountId, role) => accountLabel(accountId, editorGroup.id, role)}
          onClose={() => setEditorGroup(null)}
          onSave={(group, onError) => saveGroup(group, message => onError(copyGroupLibraryErrorMessage(new Error(message))))}
          libraryState={groupLibraryState === 'needs-import' && pendingCloudGroupSaves.current.get(editorGroup.id)?.owner === userId ? 'error' : groupLibraryState}
          libraryError={groupLibraryError}
          onRemoveUnavailableFollowers={draft => requestUnavailableFollowerRemoval(
            editorGroup,
            draft,
            null,
            'editor',
          )}
          onDelete={groups.some(group => group.id === editorGroup.id) ? () => {
            setEditorGroup(null);
            setPendingAction({
              title: 'Smazat skupinu?', detail: `Skupina ${editorGroup.name} bude odstraněna z konfigurace.`,
              confirmLabel: 'Smazat', danger: true, command: { type: 'delete-group', groupId: editorGroup.id },
            });
          } : undefined}
          saving={busyCommand != null || groupSaveBusy}
        />
      )}
      {pendingUnavailableFollowerRemoval && (
        <UnavailableFollowerRemovalDialogPortal
          state={pendingUnavailableFollowerRemoval}
          accountLabel={(accountId, role) => accountLabel(
            accountId,
            pendingUnavailableFollowerRemoval.saved.id,
            role,
          )}
          busy={busyCommand != null}
          onClose={() => setPendingUnavailableFollowerRemoval(null)}
          onEdit={() => {
            const editGroup = structuredClone(pendingUnavailableFollowerRemoval.editGroup);
            setPendingUnavailableFollowerRemoval(null);
            setEditorGroup(editGroup);
          }}
          onConfirm={plan => void confirmUnavailableFollowerRemoval(plan)}
          onArm={pendingUnavailableFollowerRemoval.source === 'arm'
            && pendingUnavailableFollowerRemoval.savedSuccessfully
            && pendingUnavailableFollowerRemoval.plan
            && (!!onSwitchAndArm || (pendingUnavailableFollowerRemoval.plan.group.id === executionGroupId && !!onArmLive))
            ? () => {
                const updatedGroup = pendingUnavailableFollowerRemoval.plan?.group;
                setPendingUnavailableFollowerRemoval(null);
                if (updatedGroup) requestGroupPower(updatedGroup);
              }
            : undefined}
        />
      )}
      {pendingAction && (
        <ConfirmActionDialog
          action={{
            ...pendingAction,
            detail: renderAccountMessage(pendingAction.detail, pendingAction.accountIds ?? knownAccountIds),
          }}
          busy={busyCommand != null}
          apiReady={!!commandAdapter}
          onClose={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            if (action.blocked) {
              setPendingAction(null);
              return;
            }
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
                  setToast({
                    tone: 'error',
                    text: reason instanceof Error ? reason.message : 'Akci se nepodařilo dokončit.',
                    accountIds: action.accountIds,
                  });
                })
                .finally(() => setBusyCommand(null));
              return;
            }
            const command = action.command;
            if (!command) return;
            if (command.type === 'delete-group' && (groupLibraryState === 'loading' || groupLibraryState === 'error')) {
              setToast({ tone: 'error', text: 'Cloudová knihovna skupin není připravená pro smazání.' });
              return;
            }
            const write = command.type === 'delete-group' ? groupLibraryFence.beginWrite() : null;
            void runCommand(command, async () => {
              if (write && !groupLibraryFence.canAcceptWrite(write)) return;
              if (command.type === 'set-group-enabled') {
                const { groupId, enabled } = command;
                setGroups(current => current.map(group => group.id === groupId ? { ...group, enabled } : group));
              } else if (command.type === 'set-multiplier') {
                await updateFollower(command.groupId, command.accountId, { multiplier: command.multiplier });
              } else if (command.type === 'delete-group') {
                const { groupId } = command;
                setGroups(current => current.filter(group => group.id !== groupId));
                if (groupLibraryState === 'ready') {
                  try {
                    await deleteCopyGroup(userId, groupId);
                  } catch (reason) {
                    if (write && groupLibraryFence.canAcceptWrite(write)) {
                      const message = reason instanceof Error ? reason.message : 'Smazání skupiny se nepodařilo synchronizovat.';
                      setGroupLibraryState('error');
                      setGroupLibraryError(message);
                    }
                    throw reason;
                  }
                }
                if (write && !groupLibraryFence.canAcceptWrite(write)) return;
              }
              if (command.type === 'flatten-group' && confirmRearmAfterFlatten && onArmLive && !copierKillSwitch) {
                setPendingAction({
                  title: 'Pokračovat v kopírování?',
                  detail: 'Flatten je potvrzen: všechny účty jsou flat. Zapnutí spustí novou kontrolu pozic a kopírování pojede dál.',
                  confirmLabel: 'Zapnout a pokračovat',
                  run: async () => { await onArmLive(); },
                  successText: 'Copier je znovu zapnutý — kopírování pokračuje.',
                });
              } else {
                setPendingAction(null);
              }
            }).finally(() => { if (write) groupLibraryFence.endWrite(write); });
          }}
        />
      )}
      {helpOpen && <CopyTradingHelpDialog onClose={() => setHelpOpen(false)} apiReady={!!commandAdapter} />}
      {tableSettingsOpen && (
        <TableSettingsDialog
          hiddenColumns={hiddenColumns}
          hiddenGroupColumns={hiddenGroupColumns}
          hiddenOrderColumns={hiddenOrderColumns}
          columnOrder={columnOrder}
          redaction={redaction}
          confirmRearmAfterFlatten={confirmRearmAfterFlatten}
          onMoveColumn={(table, from, to) => setColumnOrder(current => {
            const moved = moveColumn(current[table] as string[], from, to);
            return table === 'accounts'
              ? { ...current, accounts: pinColumnEdges(moved as AccountColumnKey[], 'account', 'actions') }
              : { ...current, [table]: moved } as ColumnOrderState;
          })}
          onRedaction={setRedaction}
          onConfirmRearmAfterFlatten={setConfirmRearmAfterFlatten}
          onToggleColumn={toggleColumn}
          onToggleGroupColumn={key => setHiddenGroupColumns(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
          onToggleOrderColumn={key => setHiddenOrderColumns(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
          onReset={() => {
            setHiddenColumns(new Set());
            setHiddenGroupColumns(new Set());
            setHiddenOrderColumns(new Set());
            setColumnOrder({ accounts: [...ACCOUNT_COLUMN_KEYS], groups: [...GROUP_COLUMN_KEYS], orders: [...ORDER_COLUMN_KEYS] });
            setRedaction(DEFAULT_REDACTION);
            setConfirmRearmAfterFlatten(true);
          }}
          onClose={() => setTableSettingsOpen(false)}
        />
      )}
      {templatesOpen && <GroupTemplatesDialog templates={templates} accounts={snapshot.accounts} onChange={setTemplates} onClose={() => setTemplatesOpen(false)} />}
      {dayCardOpen && <LiveDayCardDialog
        summary={daySummary}
        owner={owner ?? { name: 'Trader' }}
        tradeDate={tradovateDisplayTradeDate()}
        trades={dailyStats?.tradesToday ?? null}
        losingTrades={dailyStats?.losingTrades ?? null}
        formatName={name => redactAccountName(name, redactNames, redaction)}
        onClose={() => setDayCardOpen(false)}
      />}
      {toast && <StatusToast tone={toast.tone} text={renderAccountMessage(toast.text, toast.accountIds ?? knownAccountIds)} />}
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
  brokerCalls: {},
};

const usageTone = (level: TradovateConnectionUsageRow['level']) => level === 'over' ? 'text-rose-500' : level === 'warn' ? 'text-amber-500' : 'text-emerald-500';
const formatRemaining = (ms: number) => ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1_000)} s`;
const formatClockTime = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Věta o stavu session workeru na jednom loginu; penalizace a close kód jsou to, co dnes rozhodovalo. */
export const describeConnectionSession = (row: TradovateConnectionUsageRow): { text: string; tone: string } => {
  const { session } = row;
  if (!session.known) return { text: 'worker nehlásí', tone: 'text-[var(--text-muted)]' };
  if (session.penaltyRemainingMs != null) {
    return { text: `penalizace Tradovate, sync za ${formatRemaining(session.penaltyRemainingMs)}`, tone: 'text-rose-500' };
  }
  const close = session.lastClose;
  const closeText = close
    ? ` · poslední zavření ${formatClockTime(close.at)} (${close.initiatedBy === 'remote' ? 'Tradovate' : 'worker'}${close.code != null ? `, kód ${close.code}` : ''})`
    : '';
  if (session.streamConnected) return { text: `session připojená${closeText}`, tone: 'text-emerald-500' };
  const timeouts = session.consecutiveSyncTimeouts > 0 ? `, ${session.consecutiveSyncTimeouts}× sync timeout` : '';
  return { text: `bez streamu (${session.phase}${timeouts})${closeText}`, tone: 'text-amber-500' };
};

const LivePnlPanel = ({ open, onToggle, dataActive, apiReady, onHelp, telemetry = EMPTY_API_TELEMETRY, connectionUsage = [] }: { open: boolean; onToggle: () => void; dataActive: boolean; apiReady: boolean; onHelp: () => void; telemetry?: TradovateApiTelemetrySnapshot; connectionUsage?: TradovateConnectionUsageRow[] }) => {
  const rows = [
    { label: 'Za minutu', usage: telemetry.minute },
    { label: 'Za hodinu', usage: telemetry.hour },
    { label: 'Za 24 hodin', usage: telemetry.day },
  ];
  return (
  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
    <header className="flex items-center justify-between px-5 lg:px-6 py-4">
      <h3 className="font-black text-[var(--text-primary)]">Diagnostika dat a API</h3>
      <div className="flex items-center gap-2">
        <button onClick={onHelp} title="Jak funguje Live P&L" className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center">
          <HelpCircle size={14} />
        </button>
        <button onClick={onToggle} aria-label={open ? 'Sbalit diagnostiku' : 'Rozbalit diagnostiku'} aria-expanded={open} className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
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
              ? apiReady ? 'Read-only broker data i execution adaptér jsou připojené.' : 'Read-only broker snapshot je dostupný. Copier zůstává VYPNUTO.'
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
          {connectionUsage.length > 0 ? (
            <div className="mt-4">
              <p className="text-[11px] font-bold text-[var(--text-secondary)] mb-2">Tradovate na login: 5 000 volání/h na uživatele, syncrequest 300/h na IP</p>
              <div className="space-y-2">
                {connectionUsage.map(row => {
                  const session = describeConnectionSession(row);
                  return (
                    <div key={row.connectionId} className="rounded-md border border-[var(--border-subtle)] px-3 py-2" data-testid={`tradovate-usage-${row.connectionId}`}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-xs font-black text-[var(--text-primary)]">{row.label}</span>
                        <span className={`text-xs font-bold tabular-nums ${usageTone(row.level)}`}>
                          {row.total.hour}/{row.hourLimit} za hodinu · {row.total.minute}/min (tempo limitu {row.minutePace}/min)
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] tabular-nums text-[var(--text-muted)]">
                        web (tato aplikace) {row.web.minute}/min · worker {row.worker ? `${row.worker.rest.minute}/min REST + ${row.worker.ws.minute}/min WS` : 'nehlásí'}
                        {row.worker?.syncRequests ? ` · syncrequest ${row.worker.syncRequests.hour}/${row.syncRequestHourLimit} za hodinu (limit na IP, sdílený s celou sítí)` : ''}
                      </div>
                      <div className={`mt-0.5 text-[10px] ${session.tone}`}>{session.text}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
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
        <span className="hidden text-[10px] text-[var(--text-secondary)] sm:block">Blokují zapnutí. Ověř stav v Tradovate a teprve pak označ za vyřešené.</span>
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
  const sourceGroupsById = new Map(source ? [[group.id, source]] : []);
  rows.push({
    account: leader,
    accountId: group.leaderAccountId,
    name: group.leaderAccountId == null
      ? 'Bez leadera'
      : copyTradeAccountName({
          accountId: group.leaderAccountId,
          groupId: group.id,
          role: 'leader',
          accountsById: byId,
          profilesById,
          sourceGroupsById,
        }),
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
      name: copyTradeAccountName({
        accountId: follower.accountId,
        groupId: group.id,
        role: 'follower',
        accountsById: byId,
        profilesById,
        sourceGroupsById,
      }),
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
  const title = statusPending
    ? 'Zjišťuji stav copieru…'
    : !runtimeReady
      ? 'Execution runtime není pro tuto skupinu dostupný.'
      : !connected && connectBlocked
        ? 'Zapnutí blokuje kill switch, denní zámek, cooldown nebo pauza pravidel dne.'
        : connected ? 'Kliknutím bezpečně vypnout copier.' : 'Kliknutím zapnout copier naostro.';

  // Dokud stav neznáme, nesmí přepínač tvrdit OFF — armovaný copier by se
  // tvářil jako odpojený. Neutrální „?" místo toho přiznává, že se ptáme.
  if (statusPending) {
    return (
      <span
        role="status"
        title={title}
        className="flex h-7 w-[108px] items-center justify-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-secondary)]"
      >
        <RefreshCw size={12} className="animate-spin" />
        Neověřeno
      </span>
    );
  }

  // Jeden a tentýž přepínač v tabulce i na mobilní kartě, aby se ovládání
  // nechovalo na dvou místech jinak.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={connected}
      aria-busy={busy || undefined}
      aria-label={connected ? 'Vypnout kopírovací skupinu' : 'Zapnout kopírovací skupinu'}
      title={title}
      disabled={disabled}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
      className={`copier-switch${busy ? ' copier-switch-busy' : ''}`}
    >
      <span className="copier-switch-label copier-switch-on" aria-hidden="true">ON</span>
      <span className="copier-switch-label copier-switch-off" aria-hidden="true">OFF</span>
      <span className="copier-switch-knob">
        {busy ? <span className="copier-switch-spinner" aria-hidden="true"><RefreshCw size={10} strokeWidth={2.8} className="animate-spin" /></span> : null}
      </span>
    </button>
  );
};

const GroupRow = ({ group, rows, armed, dailyPnlPending, eligibility, tradeCutsByAccount, observingOnly, statusPending, runtimeReady, transition, connectBlocked, onConnectionToggle, open, onToggle, onEdit, onToggleEnabled, onFlatten, redactNames, redaction, templates, tightenOnly, onApplyTemplate, onDelete, groupColumns }: {
  group: CopyGroupConfig; rows: Row[]; armed: boolean; open: boolean; onToggle: () => void;
  dailyPnlPending: boolean;
  eligibility: (CopierAccountEligibility | undefined)[];
  tradeCutsByAccount: ReadonlyMap<number, ActiveFollowerCut>;
  observingOnly: boolean;
  statusPending: boolean;
  runtimeReady: boolean;
  transition: 'connecting' | 'disconnecting' | null;
  connectBlocked: boolean;
  onConnectionToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onFlatten: () => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  templates: CopyGroupTemplate[];
  tightenOnly: boolean;
  onApplyTemplate: (template: CopyGroupTemplate) => void;
  groupColumns: Array<{ key: GroupColumnKey; label: string }>;
}) => {
  const capital = liveCapitalDisplay(rows.map(row => row.account));
  const daily = liveGroupDailyPnlDisplay(rows.map(row => row.account), Date.now(), dailyPnlPending);
  const unreal = rows.reduce((s, r) => s + (r.account?.unrealizedPnl || 0), 0);
  const unrealSource = rows.some(row => row.account?.unrealizedPnlSource === 'stale')
    ? 'stale'
    : rows.some(row => row.account?.unrealizedPnlSource === 'estimated') ? 'estimated' : 'broker';
  const firms = groupFirmList(rows);
  const enabledFollowerCount = group.followers.filter(follower => follower.mode !== 'off').length;
  const enabledFollowerRows = rows.filter(row => !row.isLeader && row.mode !== 'off');
  const unavailableLeader = rows.some(row => row.isLeader && row.accountId != null && !row.account);
  const unavailableFollowerCount = enabledFollowerRows.filter((row, index) =>
    !row.account && (eligibility[index]?.state ?? 'active') === 'active').length;
  const inactiveFollowerCount = enabledFollowerRows.filter((row, index) =>
    !row.account
    || (eligibility[index]?.state != null && eligibility[index]?.state !== 'active')
    || (row.accountId != null && tradeCutsByAccount.has(row.accountId))).length;
  const activeFollowerCount = Math.max(0, enabledFollowerCount - inactiveFollowerCount);
  const dllCount = eligibility.filter(entry => entry?.state === 'dll-locked').length;
  const breachedCount = eligibility.filter(entry => entry?.state === 'breached').length;

  // Buňky se skládají podle uživatelova pořadí, ne podle pořadí v kódu.
  const cells: Record<GroupColumnKey, React.ReactNode> = {
    status: <td className="px-3 py-0">
            <div className="flex items-center gap-1.5">
              <CopierConnectionSwitch
                connected={armed}
                statusPending={statusPending}
                runtimeReady={runtimeReady}
                transition={transition}
                connectBlocked={connectBlocked}
                onToggle={onConnectionToggle}
              />
              {observingOnly ? (
                <span title="Shadow režim pouze sleduje a nic neodesílá." className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 text-[8px] font-black uppercase text-amber-600">
                  <ShieldAlert size={10} /> Shadow
                </span>
              ) : null}
            </div>
          </td>,
    leader: <td className="px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
              <Crown size={13} className="text-amber-400 shrink-0" />
              <span className="truncate max-w-[180px]">{redactAccountName(rows.find(r => r.isLeader)?.name ?? '—', redactNames, redaction)}</span>
            </span>
          </td>,
    firm: <td className="max-w-[150px] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]"><FirmStack firms={firms} /></td>,
    followers: <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--text-primary)]">{group.followers.length}</td>,
    capital: <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--text-primary)]"><BalanceValue display={capital} /></td>,
    daily: <td className={`px-3 py-1.5 text-right text-xs tabular-nums font-bold ${daily == null ? 'text-[var(--text-secondary)]' : pnlClass(daily)}`}>{daily == null ? '—' : money.format(daily)}</td>,
    unreal: <td className={`px-3 py-1.5 text-right text-xs tabular-nums font-bold ${pnlClass(unreal)}`} title={unrealSource === 'estimated' ? 'Součet obsahuje live odhady.' : unrealSource === 'stale' ? 'Některý účet čeká na nový snapshot.' : 'Potvrzeno broker snapshotem.'}><span className="inline-flex items-center justify-end gap-1.5">{money.format(unreal)}{unrealSource === 'stale' ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}</span></td>,
  };
  return (
    <tr
      onClick={onToggle}
      className="h-10 cursor-pointer border-b border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-page)]"
    >
      <td className="pl-3">
        <button onClick={event => { event.stopPropagation(); onToggle(); }} className="w-6 h-6 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
          <ChevronRight size={14} className={`transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </button>
      </td>
      <td className="px-3 py-1.5">
        {/* Barvu skupiny nese tečka, ne text: obarvený název měl proti bílé
            kontrast 3,46 : 1, tedy pod normou 4,5 : 1 pro 12px písmo.
            Tečka je mimo zalamovanou část, jinak při zúžení vyskočila nad název. */}
        <span className="flex items-start gap-1.5">
          <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: group.color ?? GROUP_COLORS[0] }} />
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
          {group.name}
          {/* Plný počet nic neříká; chip se ukáže, teprve když někdo vypadne. */}
          {activeFollowerCount < enabledFollowerCount ? (
            <span
              title="Způsobilých followerů z těch, co mají kopírování zapnuté"
              className="whitespace-nowrap rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-black text-amber-600"
            >
              {activeFollowerCount}/{enabledFollowerCount} zařazených
            </span>
          ) : null}
          {dllCount > 0 ? <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-black text-amber-600">{dllCount}× DLL</span> : null}
          {breachedCount > 0 ? <span className="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[9px] font-black text-rose-600">{breachedCount}× BREACHED</span> : null}
          {unavailableFollowerCount > 0 ? <span className="rounded-full bg-slate-500/15 px-1.5 py-0.5 text-[9px] font-black text-slate-600">{unavailableFollowerCount}× nedostupný</span> : null}
          {unavailableLeader ? <span className="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[9px] font-black text-rose-600">leader nedostupný</span> : null}
          </span>
        </span>
      </td>
      {groupColumns.map(column => <React.Fragment key={column.key}>{cells[column.key]}</React.Fragment>)}
      <td className="px-3 py-0">
        <div className="flex items-center justify-end gap-1.5" onClick={event => event.stopPropagation()}>
          <button onClick={onFlatten} title="Uzavřít všechny pozice ve skupině"
            className="group flex h-11 items-center whitespace-nowrap text-[10px] font-bold text-rose-500">
            <span className="flex h-7 items-center rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-2.5 transition-colors group-hover:border-rose-500/40 group-hover:bg-rose-500/12">Flatten All</span>
          </button>
          <GroupActionMenu active={armed} onToggleEnabled={onToggleEnabled} onEdit={onEdit} onDelete={onDelete} templates={templates} tightenOnly={tightenOnly} onApplyTemplate={onApplyTemplate} />
        </div>
      </td>
    </tr>
  );
};

// ─── Kompaktní karty skupin (telefon / úzký viewport) ───────────────────────

export const BalanceValue = ({ display, compact = false }: { display: LiveBalanceDisplay; compact?: boolean }) => {
  if (display.value == null) return <span className="text-xs text-[var(--text-secondary)]">—</span>;
  const confirmation = display.confirmedAt ? ` · poslední potvrzení ${new Date(display.confirmedAt).toLocaleString('cs-CZ')}` : '';
  return <span
    data-balance-state={display.stale ? 'last-known' : 'confirmed'}
    title={display.stale ? `Poslední známý zůstatek${confirmation}. Čeká na ověření, není aktuálním podkladem pro risk.` : `Potvrzený zůstatek${confirmation}`}
    className="inline-flex flex-wrap items-center justify-end gap-x-1.5 text-xs tabular-nums text-[var(--text-primary)]"
  >
    {(compact ? moneyWhole : money).format(display.value)}
  </span>;
};

const CompactStat = ({ label, value, className = 'text-[var(--text-primary)]' }: {
  label: string; value: React.ReactNode; className?: string;
}) => (
  <div className="min-w-0 px-2 py-2.5">
    <div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">{label}</div>
    <div className={`mt-0.5 truncate text-[13px] font-black tabular-nums ${className}`}>{value}</div>
  </div>
);

/**
 * Účet je „v trhu“, když drží otevřenou pozici nebo má čekající vstupní
 * příkaz. Obojí patří do stejné sekce, protože obojí kreslí sloupec Pozice —
 * stejně jako na počítači.
 */
const accountInMarket = (row: Row, orders: LiveOrder[]): boolean => {
  if (row.account?.positions.some(position => position.netPosition !== 0)) return true;
  if (row.accountId == null) return false;
  return orders.some(order => order.accountId === row.accountId && order.working && isPendingEntryOrder(order));
};

/**
 * Pilulka způsobilosti se na telefonu ukazuje jen tehdy, když něco není
 * v pořádku. Zelené „Aktivní“ u každého účtu jen ujídalo šířku jménu, a to
 * je u propek, kde se účty liší až posledními číslicemi, to podstatné.
 */
const eligibilityNeedsAttention = (eligibility: CopierAccountEligibility | undefined, live: boolean, unavailable: boolean): boolean =>
  unavailable || !live || (eligibility?.state != null && eligibility.state !== 'active');

const TradeCutPill = () => (
  <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-2 py-1 text-[10px] font-black leading-none text-amber-600">
    <Clock3 aria-hidden="true" size={10} strokeWidth={2.5} /> ČEKÁ NA DALŠÍ OBCHOD
  </span>
);

const CompactAccountRow = ({ row, variant, live, eligibility, tradeCut, orders, dailyPnlPending, busyCommand, verifying, onVerifyEligibility, onAccount, onFlatten, onRemoveUnavailableFollower, redactNames, redaction, style }: {
  row: Row;
  /** Jen zpoždění náběhu při rozbalení seznamu. */
  style?: React.CSSProperties;
  /** `market` = sloupce Pozice a Otevřený, `flat` = jen Dnes. */
  variant: 'market' | 'flat';
  live: boolean;
  eligibility?: CopierAccountEligibility;
  tradeCut?: ActiveFollowerCut;
  orders: LiveOrder[];
  dailyPnlPending: boolean;
  busyCommand: string | null;
  verifying: boolean;
  onVerifyEligibility?: (accountId: number) => void;
  onAccount?: (a: LiveAccount) => void;
  onFlatten: (accountId: number) => void;
  onRemoveUnavailableFollower: (accountId: number) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
}) => {
  const a = row.account;
  const accountId = row.accountId;
  const dismissedRejections = useDismissedRejections();
  const compactFlat = live && a != null && a.positions.every(position => position.netPosition === 0);
  const compactRejection = visibleRejectedExecution(accountId, eligibility, compactFlat, dismissedRejections);
  const hasOpenPositions = a?.positions.some(position => position.netPosition !== 0) ?? false;
  const unavailableFollower = !a && accountId != null && !row.isLeader;
  const daily = a ? liveDailyPnlDisplay(a, Date.now(), dailyPnlPending).value : null;
  // Prokázaný klid je nula, ne neznámo. Pomlčka by tvrdila „nevím“ u účtu,
  // který se do celkového součtu nahoře započítává jako nula — a součet
  // s pomlčkami pod sebou vypadá jako rozbitá data.
  const quiet = daily == null && a != null && liveDayReadAnswered(a, Date.now(), dailyPnlPending);
  const attention = eligibilityNeedsAttention(eligibility, live, !a && accountId != null) || tradeCut != null;
  const note = tradeCut
    ? <p className="text-[10px] font-semibold leading-tight text-amber-600">Ručně zavřeno · znovu se připojí po flat skupiny</p>
    : compactRejection
    ? <RejectedExecutionStatus
        execution={compactRejection}
        accountAuthoritativelyFlat={compactFlat}
        onDismiss={accountId != null ? () => dismissRejection(rejectedExecutionDismissKey(accountId, compactRejection)) : undefined}
      />
    : eligibility && eligibility.state !== 'active' && eligibility.reason
      ? <p className="text-[10px] leading-tight text-[var(--text-muted)]">
          {eligibility.reason}{!a ? ' · účet není v aktuálním OAuth snapshotu' : ''}
        </p>
      : unavailableFollower
        ? <p className="text-[10px] font-bold leading-tight text-slate-500">Účet není v aktuálním OAuth snapshotu.</p>
        : null;

  return (
    <li className={`px-3 ${tradeCut ? 'bg-amber-500/[0.035] opacity-80' : ''}`} style={style}>
      <div
        role={a ? 'button' : undefined}
        onClick={() => a && onAccount?.(a)}
        className="grid min-h-9 grid-cols-[minmax(0,1fr)_84px] items-center gap-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-emerald-500' : 'bg-rose-500'}`} />
          <span className={`truncate text-[12px] font-semibold leading-tight tracking-tight ${live ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
            {redactAccountName(row.name, redactNames, redaction)}
          </span>
          {row.isLeader
            ? <span title="Leader účet" className="flex shrink-0 text-amber-500"><Crown aria-label="Leader účet" size={12} strokeWidth={2.6} /></span>
            /* Násobek je risk parametr, ne dekorace — zůstává i u ×1, aby
               se jeho nepřítomnost nedala splést s „nevím“. */
            : <span title="Násobek množství" className="shrink-0 rounded bg-[var(--bg-page)] px-1 text-[9.5px] font-bold tabular-nums text-[var(--text-secondary)]">×{row.scale}</span>}
          {!row.synced && <span title="Nesedí s leaderem" className="shrink-0 text-amber-500">⚠</span>}
        </span>
        <span className={`truncate text-right text-[12px] font-bold tabular-nums ${variant === 'market'
          ? (a ? pnlClass(a.unrealizedPnl) : 'text-[var(--text-secondary)]')
          : (daily != null ? pnlClass(daily) : 'text-[var(--text-secondary)]')}`}>
          {variant === 'market'
            ? (a ? money.format(a.unrealizedPnl) : '—')
            : daily != null ? money.format(daily)
              : quiet ? <span title="Broker dnes u tohoto účtu nehlásí uzavřený obchod">{money.format(0)}</span>
                : '—'}
        </span>
      </div>
      {/* Druhý řádek existuje jen tam, kde je co říct. Pilulky pozice na něm
          jedou s tlačítkem Flatten účet, takže účet v trhu nestojí ani
          o pixel víc — a jméno má na prvním řádku plnou šířku. Ve sloupci
          o 86 px mu zbývalo 70 px a zkracovalo se na „TDF0000…“. */}
      {variant === 'market' || attention || note || unavailableFollower ? (
        <div className="flex flex-wrap items-center gap-2 pb-2">
          {variant === 'market' && a ? (
            <CopyTradePositionsCell accountId={accountId} positions={a.positions} orders={orders} />
          ) : null}
          {attention ? (
            tradeCut ? <TradeCutPill /> : <AccountEligibilityPill
              eligibility={eligibility}
              live={live}
              unavailable={!a && accountId != null}
              verifying={verifying}
              onVerify={(eligibility?.state === 'unverifiable' || eligibility?.state === 'breached') && accountId != null && onVerifyEligibility
                ? () => onVerifyEligibility(accountId)
                : undefined}
            />
          ) : null}
          {hasOpenPositions && a ? (
            <button
              type="button"
              disabled={busyCommand != null}
              onClick={() => onFlatten(a.id)}
              className="h-8 rounded-lg border border-rose-500/25 bg-rose-500/[0.04] px-3 text-[11px] font-bold text-rose-500 disabled:opacity-40"
            >
              Flatten účet
            </button>
          ) : null}
          {unavailableFollower && accountId != null ? (
            <button
              type="button"
              disabled={busyCommand != null}
              onClick={() => onRemoveUnavailableFollower(accountId)}
              className="h-8 rounded-lg border border-[var(--border-subtle)] px-3 text-[11px] font-bold text-[var(--text-secondary)] disabled:opacity-40"
            >
              Odebrat ze skupiny
            </button>
          ) : null}
          {note ? <div className="w-full">{note}</div> : null}
        </div>
      ) : null}
    </li>
  );
};

/**
 * Hlavička sekce účtů. Nese jen popisky sloupců — ty samy o sobě říkají,
 * čím se sekce liší (`Otevřený` u účtů v trhu, `Dnes` u ostatních), takže
 * pruh s názvem sekce nad nimi byl druhý řádek chrome, který nic nepřidal.
 */
/**
 * Kolik účtů bez pozice se ukáže před rozbalením. Účty v trhu se nesbalují
 * nikdy — kvůli nim se na telefon člověk dívá. Nic naléhavého se sbalením
 * neztratí: neaktivní účty hlásí štítky v hlavičce skupiny (`N/M aktivních`,
 * DLL, BREACHED) bez ohledu na to, jestli je jejich řádek vidět.
 */
const COMPACT_FLAT_PREVIEW = 6;

const CompactAccountSectionHead = ({ columns }: { columns: 'market' | 'flat' }) => (
  <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-page)]/60 px-3 py-1 text-[9px] font-black uppercase tracking-[0.1em] text-[var(--text-secondary)]">
    <span>Účet</span>
    <span className="text-right">{columns === 'market' ? 'Otevřený' : 'Dnes'}</span>
  </div>
);

const CompactGroupCard = ({ group, rows, armed, observingOnly, statusPending, runtimeReady, transition, connectBlocked, dailyPnlPending, eligibility, eligibilityByAccount, tradeCutsByAccount, orders, isLive, onAccount, busyCommand, onVerifyEligibility, verifyingAccountId, onConnectionToggle, onEdit, onDelete, onToggleEnabled, onFlatten, onFlattenAccount, onCancelOrder, onRefreshOrders, onRemoveUnavailableFollower, onApplyTemplate, redactNames, redaction, templates, tightenOnly, disarmPanel, cooldownPanel, islandTone = null }: {
  group: CopyGroupConfig;
  /** Fáze ze stavového ostrova. Karta je jeden box, takže tu rám obepne
   *  celou skupinu včetně účtů — na rozdíl od tabulkového rozložení. */
  islandTone?: 'ok' | 'active' | 'danger' | null;
  rows: Row[];
  armed: boolean;
  observingOnly: boolean;
  statusPending: boolean;
  runtimeReady: boolean;
  transition: 'connecting' | 'disconnecting' | null;
  connectBlocked: boolean;
  dailyPnlPending: boolean;
  eligibility: (CopierAccountEligibility | undefined)[];
  eligibilityByAccount: Map<number, CopierAccountEligibility>;
  tradeCutsByAccount: ReadonlyMap<number, ActiveFollowerCut>;
  orders: LiveOrder[];
  isLive: (a?: LiveAccount) => boolean;
  onAccount?: (a: LiveAccount) => void;
  busyCommand: string | null;
  onVerifyEligibility?: (accountId: number) => void;
  verifyingAccountId: number | null;
  onConnectionToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onFlatten: () => void;
  onFlattenAccount: (accountId: number) => void;
  onCancelOrder: (orderId: number) => void;
  onRefreshOrders?: () => Promise<void> | void;
  onRemoveUnavailableFollower: (accountId: number) => void;
  onApplyTemplate: (template: CopyGroupTemplate) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  templates: CopyGroupTemplate[];
  tightenOnly: boolean;
  disarmPanel?: React.ReactNode;
  cooldownPanel?: React.ReactNode;
}) => {
  const [showAllFlat, setShowAllFlat] = useState(false);
  const capital = liveCapitalDisplay(rows.map(row => row.account));
  const daily = liveGroupDailyPnlDisplay(rows.map(row => row.account), Date.now(), dailyPnlPending);
  const unreal = rows.reduce((sum, row) => sum + (row.account?.unrealizedPnl || 0), 0);
  const enabledFollowerRows = rows.filter(row => !row.isLeader && row.mode !== 'off');
  const inactiveFollowerCount = enabledFollowerRows.filter((row, index) =>
    !row.account
    || (eligibility[index]?.state != null && eligibility[index]?.state !== 'active')
    || (row.accountId != null && tradeCutsByAccount.has(row.accountId))).length;
  const activeFollowerCount = Math.max(0, enabledFollowerRows.length - inactiveFollowerCount);
  const dllCount = eligibility.filter(entry => entry?.state === 'dll-locked').length;
  const breachedCount = eligibility.filter(entry => entry?.state === 'breached').length;
  const unavailableLeader = rows.some(row => row.isLeader && row.accountId != null && !row.account);
  const accountIds = new Set(rows.flatMap(row => row.accountId != null ? [row.accountId] : []));
  const groupOrders = orders.filter(order => order.accountId != null && accountIds.has(order.accountId));
  const workingCount = groupOrders.filter(order => order.working).length;
  const color = group.color ?? GROUP_COLORS[0];
  // V obchodu se hýbe otevřený P&L, kapitál stojí — a na 375 px si o čtvrtou
  // buňku konkurují. Čekající vstup se nepočítá: dokud není fill, není co
  // sledovat a kapitál je pořád ta užitečnější informace.
  const hasOpenExposure = rows.some(row => row.account?.positions.some(position => position.netPosition !== 0));
  // Pořadí uvnitř sekcí zůstává původní (leader první), jen se rozdělí.
  const accountRows = rows.reduce<{ market: Array<{ row: Row; index: number }>; flat: Array<{ row: Row; index: number }> }>(
    (split, row, index) => {
      split[accountInMarket(row, groupOrders) ? 'market' : 'flat'].push({ row, index });
      return split;
    },
    { market: [], flat: [] },
  );

  return (
    <article
      data-flip-id={group.id}
      data-testid="compact-group-card"
      className={`overflow-hidden rounded-xl border bg-[var(--bg-card)] ${islandTone
        ? `live-island-card live-island-card-${islandTone}`
        : armed ? 'border-emerald-500/40' : 'border-[var(--border-subtle)]'}`}
    >
      {/* Název, Flatten a vypínač na jednom řádku. Název je jediný pružný
          prvek, takže se zkrátí on a nikdy nevytlačí ovládání ze řádku.
          Kolečka firem se přesunula do pruhu s čísly — čtou se při zakládání
          skupiny, ne každou minutu, a tady by ujídala šířku názvu. */}
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <h4 className="min-w-0 flex-1 truncate text-[15px] font-black" style={{ color }}>{group.name}</h4>
        <button
          type="button"
          onClick={onFlatten}
          title="Uzavřít všechny pozice ve skupině"
          className="h-8 shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 text-[11px] font-black text-rose-500"
        >
          Flatten All
        </button>
        <CopierConnectionSwitch
          connected={armed}
          statusPending={statusPending}
          runtimeReady={runtimeReady}
          transition={transition}
          connectBlocked={connectBlocked}
          onToggle={onConnectionToggle}
        />
      </header>

      {/* Varovné štítky mají vlastní řádek, ale jen když nějaké jsou; v klidu
          zůstane hlavička jednořádková. */}
      {activeFollowerCount < enabledFollowerRows.length || dllCount > 0 || breachedCount > 0 || unavailableLeader || observingOnly ? (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
          {activeFollowerCount < enabledFollowerRows.length ? (
            <span
              title="Způsobilých followerů z těch, co mají kopírování zapnuté"
              className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-black text-amber-600"
            >
              {activeFollowerCount}/{enabledFollowerRows.length} aktivních
            </span>
          ) : null}
          {dllCount > 0 ? <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-black text-amber-600">{dllCount}× DLL</span> : null}
          {breachedCount > 0 ? <span className="rounded-full bg-rose-500/12 px-2 py-0.5 text-[10px] font-black text-rose-600">{breachedCount}× BREACHED</span> : null}
          {unavailableLeader ? <span className="rounded-full bg-rose-500/12 px-2 py-0.5 text-[10px] font-black text-rose-600">leader nedostupný</span> : null}
          {observingOnly ? (
            <span title="Shadow režim pouze sleduje a nic neodesílá." className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black uppercase text-amber-600">
              <ShieldAlert size={10} /> Shadow
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={`grid divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] bg-[var(--bg-page)]/60 ${hasOpenExposure
        ? 'grid-cols-[62px_repeat(2,minmax(0,1fr))]'
        : 'grid-cols-[62px_repeat(3,minmax(0,1fr))]'}`}
      >
        <div className="min-w-0 overflow-hidden px-2 py-2.5">
          <div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Firmy</div>
          <div className="mt-1 flex"><FirmStack firms={groupFirmList(rows)} marksOnly /></div>
        </div>
        {hasOpenExposure ? null : <CompactStat label="Kapitál" value={<BalanceValue display={capital} compact />} />}
        {/* Bez haléřů: „$2,906.00“ se do buňky na 375 px nevejde a ořízlo se
            na „$2,90…“, což je horší než zaokrouhlení. */}
        <CompactStat
          label="Denní P&L"
          value={daily == null ? '—' : moneyWhole.format(daily)}
          className={daily == null ? 'text-[var(--text-secondary)]' : pnlClass(daily)}
        />
        <CompactStat label="Otevřený" value={moneyWhole.format(unreal)} className={pnlClass(unreal)} />
      </div>

      {disarmPanel}
      {cooldownPanel}

      {/* Dvě sekce místo jedné tabulky se čtyřmi sloupci: popisek nad každou
          platí pro všechny řádky pod sebou, takže žádný sloupec nemá dva
          významy. Účty bez pozice — většina dne — mají jen dva sloupce, a
          jméno účtu se tak vejde celé. */}
      {([['market', accountRows.market], ['flat', accountRows.flat]] as const).map(([variant, sectionRows]) => (
        sectionRows.length === 0 ? null : (
          <section key={variant}>
            <CompactAccountSectionHead columns={variant} />
            <ul className="divide-y divide-[var(--border-subtle)]">
              {(variant === 'flat' ? sectionRows.slice(0, COMPACT_FLAT_PREVIEW) : sectionRows).map(({ row, index }) => (
                <CompactAccountRow
                  key={`${row.name}-${index}`}
                  row={row}
                  variant={variant}
                  live={isLive(row.account)}
                  eligibility={row.accountId != null ? eligibilityByAccount.get(row.accountId) : undefined}
                  tradeCut={row.accountId != null ? tradeCutsByAccount.get(row.accountId) : undefined}
                  orders={groupOrders}
                  dailyPnlPending={dailyPnlPending}
                  busyCommand={busyCommand}
                  verifying={row.accountId != null && verifyingAccountId === row.accountId}
                  onVerifyEligibility={onVerifyEligibility}
                  onAccount={onAccount}
                  onFlatten={onFlattenAccount}
                  onRemoveUnavailableFollower={onRemoveUnavailableFollower}
                  redactNames={redactNames}
                  redaction={redaction}
                />
              ))}
            </ul>
            {variant === 'flat' && sectionRows.length > COMPACT_FLAT_PREVIEW ? (<>
              {/* Skryté řádky zůstávají v DOMu a jen se sroluje výška obalu
                  (mřížka 0fr → 1fr), takže se výška nemusí měřit v JS.
                  Řádky pak naskakují postupně, ať rozbalení není skok. */}
              <div className="live-accounts-more" data-open={showAllFlat}>
                {/* `inert` vyřadí sbalené řádky z tab pořadí i ze čtečky —
                    samotná nulová výška je jen schová očima a tlačítka
                    „Flatten účet“ uvnitř by zůstala dosažitelná tabem. */}
                <div inert={!showAllFlat}>
                  <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                    {sectionRows.slice(COMPACT_FLAT_PREVIEW).map(({ row, index }, position) => (
                      <CompactAccountRow
                        key={`${row.name}-${index}`}
                        style={{ animationDelay: `${Math.min(position, 8) * 28}ms` }}
                        row={row}
                        variant={variant}
                        live={isLive(row.account)}
                        eligibility={row.accountId != null ? eligibilityByAccount.get(row.accountId) : undefined}
                        orders={groupOrders}
                        dailyPnlPending={dailyPnlPending}
                        busyCommand={busyCommand}
                        verifying={row.accountId != null && verifyingAccountId === row.accountId}
                        onVerifyEligibility={onVerifyEligibility}
                        onAccount={onAccount}
                        onFlatten={onFlattenAccount}
                        onRemoveUnavailableFollower={onRemoveUnavailableFollower}
                        redactNames={redactNames}
                        redaction={redaction}
                      />
                    ))}
                  </ul>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAllFlat(value => !value)}
                aria-expanded={showAllFlat}
                className="flex h-9 w-full items-center justify-center gap-1.5 border-t border-[var(--border-subtle)] text-[11px] font-bold text-[var(--text-secondary)]"
              >
                {showAllFlat ? 'Sbalit' : `Zobrazit dalších ${sectionRows.length - COMPACT_FLAT_PREVIEW}`}
                <ChevronDown size={13} className={`transition-transform duration-300 ${showAllFlat ? 'rotate-180' : ''}`} />
              </button>
            </>) : null}
          </section>
        )
      ))}

      {groupOrders.length > 0 ? (
        <section className="border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Příkazy · {workingCount} working</span>
            <button
              type="button"
              onClick={() => void onRefreshOrders?.()}
              title="Obnovit příkazy"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)]"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <ul className="divide-y divide-[var(--border-subtle)]">
            {groupOrders.map(order => (
              <li key={`${order.accountId}-${order.id}`} className="flex items-center gap-3 px-4 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <b className={order.action.toLowerCase().includes('buy') ? 'text-emerald-500' : 'text-rose-500'}>{order.action}</b>
                    <span className="font-bold text-[var(--text-primary)]">{order.symbol}</span>
                    <span className="text-[var(--text-secondary)]">{order.orderType} × {order.quantity}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-[var(--text-secondary)]">
                    <span className="truncate">{redactAccountName(order.accountName, redactNames, redaction)}</span>
                    <span>·</span>
                    <span className="tabular-nums">{order.price ?? order.stopPrice ?? '—'}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-black uppercase ${order.working ? 'bg-blue-500/10 text-blue-500' : 'bg-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>{order.status}</span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!order.working || busyCommand != null}
                  onClick={() => onCancelOrder(order.id)}
                  className="h-9 rounded-lg border border-rose-500/20 px-3 font-bold text-rose-500 disabled:opacity-35"
                >
                  Zrušit
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Flatten se přestěhoval nahoru k vypínači, aby byl vidět i při dvaceti
          účtech bez scrollování; dole zbyla jen správa skupiny. */}
      <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5">
        <button
          type="button"
          onClick={onEdit}
          className="flex h-10 flex-1 items-center justify-center rounded-lg border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)]"
        >
          Upravit
        </button>
        <GroupActionMenu active={armed} onToggleEnabled={onToggleEnabled} onEdit={onEdit} onDelete={onDelete} templates={templates} tightenOnly={tightenOnly} onApplyTemplate={onApplyTemplate} />
      </footer>
    </article>
  );
};

export const GroupActionMenu = ({ active, onToggleEnabled, onEdit, onDelete, templates, tightenOnly, onApplyTemplate }: {
  active: boolean;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
  templates: CopyGroupTemplate[];
  tightenOnly: boolean;
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
    <button ref={triggerRef} onClick={toggle} title="Další akce" className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]"><MoreVertical size={14} /></button>
    {open ? createPortal(<>
      <button aria-label="Close group actions" className="fixed inset-0 z-[139] cursor-default" onClick={() => setOpen(false)} />
      <div className="fixed z-[140] w-52 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] py-1 shadow-xl" style={position}>
        <button onClick={() => { setOpen(false); onEdit(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-page)]"><Settings2 size={13} />Upravit skupinu</button>
        <button onClick={() => { setOpen(false); onToggleEnabled(); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-[var(--bg-page)] ${active ? 'text-amber-600' : 'text-emerald-600'}`}><Power size={13} />{active ? 'Vypnout skupinu' : 'Zapnout skupinu'}</button>
        {templates.length ? <>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <div className="px-3 pb-1 pt-1 text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">Použít šablonu</div>
          {templates.map(template => <button key={template.id} disabled={tightenOnly} title={tightenOnly ? 'dnes jen zpřísnit' : undefined} onClick={() => { setOpen(false); onApplyTemplate(template); }} className="w-full truncate px-3 py-2 text-left text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-page)] disabled:cursor-not-allowed disabled:opacity-45">{template.name}</button>)}
        </> : null}
        {/* Mazání stojí pod čarou a úplně dole, aby se na něj nedalo trefit
            cestou k něčemu jinému. Potvrzení řeší dialog, běžící runtime
            smazání odmítne sám. */}
        <div className="my-1 border-t border-[var(--border-subtle)]" />
        <button onClick={() => { setOpen(false); onDelete(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-rose-600 hover:bg-rose-500/10"><Trash2 size={13} />Smazat skupinu</button>
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
/** 1 kontrakt · 2–4 kontrakty · 5 a víc kontraktů. */
export const contractsLabel = (quantity: number): string => {
  const count = Math.abs(quantity);
  if (!Number.isFinite(count)) return '— kontraktů';
  const whole = Number.isInteger(count) ? count : null;
  if (whole === 1) return '1 kontrakt';
  if (whole != null && whole >= 2 && whole <= 4) return `${whole} kontrakty`;
  return `${contractQuantity(count)} kontraktů`;
};

const workingQuantity = (order: LiveOrder) => Number.isFinite(order.quantity) ? Math.max(0, Math.abs(order.quantity)) : 0;
const hasProtectiveAction = (order: LiveOrder, netPosition: number) => {
  const action = order.action.trim().toLowerCase();
  return netPosition > 0 ? action.includes('sell') : action.includes('buy');
};

/**
 * Bublina s podrobnostmi po najetí. Nativní `title` naskočí až po sekundě,
 * kreslí ho operační systém a na dotyku nefunguje — proto vlastní.
 *
 * Vykresluje se portálem s `position: fixed`: tabulka účtů má vlastní
 * posuvník (`.live-accounts-scroll`), který by absolutně umístěnou bublinu
 * ořízl na svém okraji.
 */
const HoverCard = ({ label, children, card }: {
  label: string;
  children: React.ReactNode;
  card: React.ReactNode;
}) => {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const open = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    // U horního okraje se bublina překlopí pod kotvu, ať nevyjede z obrazovky.
    const below = rect.top < 220;
    setPlacement({
      left: Math.min(Math.max(8, rect.left), window.innerWidth - HOVER_CARD_WIDTH - 8),
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
  };
  const close = () => setPlacement(null);

  useEffect(() => {
    if (!placement) return;
    // Po odscrollování by bublina zůstala viset u prázdného místa.
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [placement]);

  return (
    <span
      ref={anchorRef} tabIndex={0} aria-label={label}
      onPointerEnter={open} onPointerLeave={close} onFocus={open} onBlur={close}
      className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      {children}
      {placement ? createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed', left: placement.left, top: placement.top,
            width: HOVER_CARD_WIDTH, transform: placement.below ? undefined : 'translateY(-100%)',
          }}
          className="live-hovercard"
        >{card}</div>,
        document.body,
      ) : null}
    </span>
  );
};

const HOVER_CARD_WIDTH = 252;

/** Řádek bubliny: popisek vlevo, hodnota vpravo. */
const HoverRow = ({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'miss' | 'bad' }) => (
  <div className="flex items-baseline justify-between gap-2.5 py-0.5 text-[10.5px]">
    <span className="font-semibold text-[var(--text-secondary)]">{label}</span>
    <span className={`font-bold tabular-nums ${tone === 'ok' ? 'text-emerald-500' : tone === 'miss' ? 'text-amber-500' : tone === 'bad' ? 'text-rose-500' : 'text-[var(--text-primary)]'}`}>{value}</span>
  </div>
);

const priceLabel = (price: number | null) => price == null
  ? '—'
  : price.toLocaleString('cs-CZ', { maximumFractionDigits: 2 });

/** „v 10:04 · před 6 min“ — absolutní čas i odstup, ať se nemusí počítat. */
const placedLabel = (at: string | null, now: number) => {
  if (!at) return '—';
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return '—';
  const minutes = Math.max(0, Math.round((now - parsed) / 60_000));
  const ago = minutes < 1 ? 'právě teď' : minutes < 60 ? `před ${minutes} min` : `před ${Math.floor(minutes / 60)} h`;
  return `v ${timeLabel(parsed)} · ${ago}`;
};

export interface PendingEntryProtection {
  quantity: number;
  stopCoverage: number;
  targetCoverage: number;
}

/**
 * Ochrana čekajícího vstupu: co by pozici zajistilo, kdyby se příkaz vyplnil.
 *
 * Stejné pravidlo jako u otevřené pozice — jen working příkaz na opačnou
 * stranu a na přesně stejný kontrakt. Broker nám vazbu mezi příkazy (bracket,
 * OCO) neposílá, takže se odvozuje; sám vstup se do ochrany nikdy nepočítá.
 */
export const pendingEntryProtection = (entry: LiveOrder, workingOrders: LiveOrder[]): PendingEntryProtection => {
  const direction = entry.action.trim().toLowerCase().includes('buy') ? 1 : -1;
  const guards = workingOrders.filter(order => order.id !== entry.id
    && fullSymbolKey(order.symbol) === fullSymbolKey(entry.symbol)
    && hasProtectiveAction(order, direction));
  const coverage = (matches: (order: LiveOrder) => boolean) =>
    guards.filter(matches).reduce((total, order) => total + workingQuantity(order), 0);
  return {
    quantity: workingQuantity(entry),
    stopCoverage: coverage(isStopOrder),
    targetCoverage: coverage(isLimitOrder),
  };
};

/**
 * Compact position/order status for one account. Protection is intentionally
 * conservative: only a working opposite-side order on the exact contract can
 * protect a position. The shortened futures root is display-only.
 */
export const CopyTradePositionsCell = ({ accountId, positions, orders, positionsVerified = true, ordersVerified = true, staleLabel = null }: {
  accountId: number | null;
  positions: LivePosition[];
  orders: LiveOrder[];
  positionsVerified?: boolean;
  ordersVerified?: boolean;
  /**
   * Poslední známý stav zůstává vidět; štítek se objeví jen u čtení staršího
   * než LIVE_READ_STALE_MS nebo nedostupného (např. „před 3 min").
   */
  staleLabel?: string | null;
}) => {
  const stale = (!positionsVerified || !ordersVerified) && staleLabel
    ? <span className="ml-1 text-[10px] font-semibold text-amber-600" title="Poslední známý stav; broker čtení není čerstvé">{staleLabel}</span>
    : null;
  // Neověřené čtení nikdy netvrdí „flat" ani nehodnotí ochranu: prázdná
  // buňka dostane tichý otazník a pilulka místo štítu/varování neutrální „?".
  const unverifiedMark = !positionsVerified || !ordersVerified
    ? <span className="ml-0.5 text-[10px] font-semibold text-[var(--text-secondary)]" title="Poslední známý stav, čtení u brokera není čerstvě ověřené">?</span>
    : null;
  const openPositions = positions.filter(position => position.netPosition !== 0);
  const workingOrders = accountId == null
    ? []
    : orders.filter(order => order.accountId === accountId && order.working);
  const openSymbols = new Set(openPositions.map(position => fullSymbolKey(position.symbol)));
  const entryOrders = workingOrders.filter(order =>
    isPendingEntryOrder(order) && !openSymbols.has(fullSymbolKey(order.symbol)));

  if (openPositions.length === 0 && entryOrders.length === 0) {
    return <span className="text-xs tabular-nums text-[var(--text-secondary)]">—{unverifiedMark}{stale}</span>;
  }

  return <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">{stale}
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
      // Ochrana musí být přesná. SL 6/11 je díra, ale SL 12/11 je také
      // nebezpečný: po fillu by mohl účet otočit do protipozice.
      const stopCoverageExact = stopCoverage === positionQuantity;
      const targetCoverageExact = targetCoverage === positionQuantity;
      const protectionComplete = stopCoverageExact && targetCoverageExact;
      const signedQuantity = `${position.netPosition > 0 ? '+' : '−'}${contractQuantity(position.netPosition)}`;
      const positionLabel = `${symbol} ${position.netPosition > 0 ? 'long' : 'short'} ${contractQuantity(position.netPosition)}`;
      const protectionLabel = !ordersVerified
        ? 'ochrana neověřena'
        : protectionComplete
        ? 'working SL a target'
        : !hasStop
          ? 'bez working SL'
          : stopCoverageExact
            ? 'working SL'
            : stopCoverage < positionQuantity
              ? `working SL kryje jen ${contractQuantity(stopCoverage)} z ${contractQuantity(positionQuantity)}`
              : `working SL překrývá pozici ${contractQuantity(stopCoverage)}/${contractQuantity(positionQuantity)}`;

      return <span key={`${fullSymbolKey(position.symbol)}-${index}`} className="inline-flex items-center gap-1">
        <HoverCard
          label={`${positionLabel}, ${protectionLabel}`}
          card={<>
            <div className="text-[11px] font-black text-[var(--text-primary)]">{position.netPosition > 0 ? 'Long' : 'Short'} {contractsLabel(position.netPosition)}</div>
            <div className="mt-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
              {fullSymbolKey(position.symbol)}{position.netPrice != null ? ` · průměrná cena ${priceLabel(position.netPrice)}` : ''}
            </div>
            <hr className="-mx-2.5 my-2 border-t border-[var(--border-subtle)]" />
            {/* Neověřené čtení příkazů nesmí vypadat jako „ochrana chybí". */}
            <HoverRow
              label="Stop loss"
              value={!ordersVerified ? 'neověřeno' : !hasStop ? 'žádný' : stopCoverageExact ? `kryje ${contractQuantity(positionQuantity)}` : `kryje ${contractQuantity(stopCoverage)}/${contractQuantity(positionQuantity)}`}
              tone={!ordersVerified ? undefined : !hasStop ? 'miss' : stopCoverageExact ? 'ok' : 'bad'}
            />
            <HoverRow
              label="Target"
              value={!ordersVerified ? 'neověřeno' : targetCoverage > 0 ? `kryje ${contractQuantity(targetCoverage)}` : 'žádný'}
              tone={!ordersVerified ? undefined : targetCoverageExact ? 'ok' : 'miss'}
            />
            <HoverRow
              label="Otevřený P&L"
              value={money.format(position.unrealizedPnl)}
              tone={position.unrealizedPnl > 0 ? 'ok' : position.unrealizedPnl < 0 ? 'bad' : undefined}
            />
          </>}
        >
        <span
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-black leading-none tabular-nums ${position.netPosition > 0
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600'
            : 'border-rose-500/25 bg-rose-500/10 text-rose-600'}`}
        >
          <span>{symbol}</span><span>{signedQuantity}</span>
          {ordersVerified && protectionComplete ? <ShieldCheck aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" /> : null}
          {!ordersVerified ? <span aria-hidden="true">?</span> : null}
        </span>
        </HoverCard>
        {ordersVerified && !hasStop ? <span
          aria-label={`${symbol} bez working stop lossu`}
          title={`${symbol}: pozice nemá working stop loss`}
          className="inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-1 text-[9px] font-black leading-none text-amber-600"
        ><AlertTriangle aria-hidden="true" size={9} strokeWidth={2.8} className="shrink-0" />bez SL</span> : null}
        {ordersVerified && hasStop && !stopCoverageExact ? <span
          aria-label={`${symbol} nebezpečné krytí stop lossem ${contractQuantity(stopCoverage)} z ${contractQuantity(positionQuantity)}`}
          title={`${symbol}: working SL ${stopCoverage < positionQuantity ? 'nepokrývá celou pozici' : 'překrývá pozici a může ji otočit'}`}
          className="inline-flex items-center gap-0.5 rounded-md border border-rose-500/45 bg-rose-500/15 px-1.5 py-1 text-[9px] font-black leading-none text-rose-600"
        ><AlertTriangle aria-hidden="true" size={9} strokeWidth={2.8} className="shrink-0" />SL {contractQuantity(stopCoverage)}/{contractQuantity(positionQuantity)}</span> : null}
      </span>;
    })}
    {entryOrders.map(order => {
      const symbol = displaySymbol(order.symbol);
      const buy = order.action.trim().toLowerCase().includes('buy');
      const triggered = isStopOrder(order);
      const protection = pendingEntryProtection(order, workingOrders);
      const hasStop = protection.stopCoverage > 0;
      const stopExact = protection.stopCoverage === protection.quantity;
      const sideLabel = buy ? 'BUY' : 'SELL';
      const coverageText = `${contractQuantity(protection.stopCoverage)}/${contractQuantity(protection.quantity)}`;
      const stopValue = !hasStop
        ? 'žádný'
        : stopExact ? `kryje ${contractQuantity(protection.quantity)}` : `kryje jen ${coverageText}`;
      const targetValue = protection.targetCoverage > 0
        ? `kryje ${contractQuantity(protection.targetCoverage)}`
        : 'žádný';
      const warning = !ordersVerified
        ? 'ochrana neověřena'
        : !hasStop
          ? 'bez stop lossu'
          : !stopExact ? `stop loss kryje jen ${coverageText}` : 'stop loss kryje celý vstup';

      return (
        <HoverCard
          key={`${order.accountId}-${order.id}`}
          label={`Čekající ${sideLabel} ${order.orderType} ${symbol}, ${contractsLabel(order.quantity)}, ${warning}`}
          card={<>
            <div className="flex items-center gap-1.5">
              <span className={`rounded px-1 py-px text-[8.5px] font-black tracking-wider ${buy ? 'bg-emerald-500/20 text-emerald-500' : 'bg-rose-500/20 text-rose-500'}`}>{sideLabel}</span>
              <span className="text-[11px] font-black text-[var(--text-primary)]">{order.orderType} · {triggered ? 'čeká na spuštění' : 'čeká na fill'}</span>
            </div>
            <div className="mt-0.5 text-[10px] font-semibold text-[var(--text-muted)]">{fullSymbolKey(order.symbol)} · {contractsLabel(order.quantity)}</div>
            <hr className="-mx-2.5 my-2 border-t border-[var(--border-subtle)]" />
            <HoverRow label={triggered ? 'Spouštěcí cena' : 'Vstupní cena'} value={priceLabel(order.stopPrice ?? order.price)} />
            <HoverRow label="Stop loss" value={ordersVerified ? stopValue : 'neověřeno'} tone={!ordersVerified ? undefined : !hasStop ? 'miss' : stopExact ? 'ok' : 'bad'} />
            <HoverRow label="Target" value={ordersVerified ? targetValue : 'neověřeno'} tone={!ordersVerified ? undefined : protection.targetCoverage > 0 ? 'ok' : 'miss'} />
            <HoverRow label="Zadáno" value={placedLabel(order.placedAt, Date.now())} />
          </>}
        >
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold leading-none text-[var(--text-secondary)] tabular-nums">
            <Clock3 aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />
            <span>{symbol}</span>
            <span className={`rounded-[3px] px-[3px] py-px text-[8.5px] font-black tracking-wider ${buy ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'}`}>{sideLabel}</span>
            <span>{contractQuantity(order.quantity)}</span>
            {/* Varování sedí uvnitř chipu: samostatný štítek jako u pozice by
                buňku roztáhl na 224 px a sloupec má 200. Bez ověřených příkazů
                se ochrana nehodnotí — stejně jako u otevřené pozice. */}
            {!ordersVerified ? <span aria-hidden="true">?</span> : null}
            {ordersVerified && !hasStop ? <AlertTriangle aria-hidden="true" size={10} strokeWidth={2.8} className="shrink-0 text-amber-600" /> : null}
            {ordersVerified && hasStop && !stopExact ? <>
              <AlertTriangle aria-hidden="true" size={10} strokeWidth={2.8} className="shrink-0 text-rose-600" />
              <span className="text-rose-600">{coverageText}</span>
            </> : null}
          </span>
        </HoverCard>
      );
    })}
  </span>;
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const timeWithSecondsLabel = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});


/**
 * Panel jen pro automatické odzbrojení (fail-closed, expirace, kill switch,
 * výpadek): jedna věta co se stalo, výsledek kopií a další krok. Ruční
 * vypnutí panel nemá; technický detail i historie jsou v záložce Události.
 */
export const CopierDisarmPanel = ({ lastDisarm }: { lastDisarm: CopierDisarmRecord }) => {
  const dangerous = lastDisarm.copiesOutcome === 'left-open-unprotected'
    || lastDisarm.copiesOutcome === 'unknown';
  const tone = dangerous
    ? 'border-rose-500/35 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300'
    : 'border-amber-500/35 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300';

  return (
    <section
      aria-live="polite"
      data-copier-disarm-panel="true"
      data-tone={dangerous ? 'rose' : 'amber'}
      className={`mx-4 my-3 rounded-lg border px-4 py-2.5 ${tone}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle aria-hidden="true" size={15} className="mt-0.5 shrink-0" />
        <p className="min-w-0 flex-1 text-xs font-bold leading-relaxed" title={lastDisarm.detail}>
          <span className="block text-[var(--text-secondary)]">Poslední zaznamenané vypnutí · {new Date(lastDisarm.at).toLocaleDateString('cs-CZ')} {timeWithSecondsLabel(lastDisarm.at)}</span>
          {lastDisarm.title}
          {' · '}Výsledek při incidentu: {copierCopiesOutcomeText(lastDisarm.copiesOutcome)}
          {' · '}<span className="font-black">Další krok: {lastDisarm.nextStep}</span>
          <span className="block font-medium text-[var(--text-secondary)]">Historický záznam — neověřuje aktuální stav pozic. Podrobnosti najdeš v Událostech.</span>
        </p>
      </div>
    </section>
  );
};

type RejectedExecution = NonNullable<CopierAccountEligibility['lastExecution']>;

const rejectedOrderLabel = (execution: RejectedExecution): string | null => {
  const type = execution.orderType === 'Stop' || execution.orderType === 'StopLimit'
    ? 'SL'
    : execution.orderType ?? null;
  const price = execution.stopPrice ?? execution.limitPrice;
  const parts = [type, execution.side, price != null ? `@ ${price}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
};

/** Zavřená odmítnutí (jen toto zařízení, do konce session) pro řádky účtů. */
const useDismissedRejections = () => useSyncExternalStore(subscribeDismissedRejections, getDismissedRejections, getDismissedRejections);

/**
 * Odmítnutí k zobrazení pod účtem, nebo null, když už nemá být vidět
 * (vyřešené a zavřené křížkem / z minulé session). Nevyřešené se vrací vždy.
 */
const visibleRejectedExecution = (
  accountId: number | null | undefined,
  eligibility: CopierAccountEligibility | undefined,
  accountAuthoritativelyFlat: boolean,
  dismissed: ReadonlySet<string>,
): RejectedExecution | null => {
  const execution = eligibility?.lastExecution;
  if (!execution) return null;
  if (accountId == null) return execution;
  const visibility = rejectedExecutionVisibility({
    accountId, execution, accountAuthoritativelyFlat, dismissed, now: Date.now(),
  });
  return visibility === 'visible' ? execution : null;
};

export const RejectedExecutionStatus = ({ execution, accountAuthoritativelyFlat, onDismiss, className = '' }: {
  execution: RejectedExecution;
  accountAuthoritativelyFlat: boolean;
  /** Křížek: zavřít vyřešené odmítnutí do konce session. Nevyřešené křížek nemá. */
  onDismiss?: () => void;
  className?: string;
}) => {
  const translated = translateCopierRejectReason(execution.reason);
  const order = rejectedOrderLabel(execution);
  const resolution = execution.resolution;
  const dangerous = (!resolution || resolution.kind === 'unresolved') && !accountAuthoritativelyFlat;
  const dismissible = Boolean(onDismiss) && rejectedExecutionResolved(execution, accountAuthoritativelyFlat);
  const rejection = translated.category === 'price-through' && order
    ? `${order} odmítnut: cena už byla za zadanou úrovní`
    : [order, translated.message].filter(Boolean).join(' · ');
  const resolutionLabel = resolution?.kind === 'guard-flattened'
    ? `kopie zavřena guardem ${timeWithSecondsLabel(resolution.at)}`
    : resolution?.kind === 'auto-closed'
      ? `kopie automaticky zavřena ${timeWithSecondsLabel(resolution.at)}`
      : resolution?.kind === 'follower-flat'
        ? `follower je flat ${timeWithSecondsLabel(resolution.at)}`
        : accountAuthoritativelyFlat
          ? 'follower je nyní flat'
          : null;
  return (
    <span
      title={`Původní broker důvod: ${translated.original}`}
      data-rejected-execution={dangerous ? 'unresolved' : 'resolved'}
      className={`flex items-start gap-1 pl-3.5 text-[10px] leading-tight ${dangerous
        ? 'text-rose-500/90'
        : 'text-[var(--text-muted)]'} ${className}`}
    >
      <span className="min-w-0 flex-1">{rejection} · {resolutionLabel ?? timeLabel(execution.at)}</span>
      {dismissible ? (
        <button
          type="button"
          aria-label="Skrýt odmítnutí do konce session"
          title="Skrýt do konce session (jen na tomto zařízení)"
          onClick={event => { event.stopPropagation(); onDismiss?.(); }}
          className="-my-0.5 shrink-0 rounded px-1 text-[11px] leading-none text-[var(--text-muted)] transition hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]"
        >
          ×
        </button>
      ) : null}
    </span>
  );
};

/**
 * Eligibility pill. Connection status (tečka), způsobilost účtu (pill)
 * a poslední execution událost (řádek pod jménem) jsou tři různé věci —
 * záměrně se neslučují do jednoho zašedlého řádku.
 */
type AccountStateTone = {
  dotClass: string;
  accentClass: string;
  label: string;
  detail: string;
};

/** Stav účtu jako interaktivní tečka u názvu: barva nese stav, hover/fokus
 *  vysvětlí, co znamená. Tooltip jde do portálu, protože tabulka účtů má
 *  vlastní `overflow`, který by absolutně pozicovanou bublinu ořízl. */
const AccountStateDot = ({ tone, reason, confirmedAt }: {
  tone: AccountStateTone;
  reason?: string | null;
  confirmedAt?: string | null;
}) => {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const showTip = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 260;
    setTip({
      top: rect.bottom + 8,
      // U pravého okraje by bublina vytekla z okna.
      left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
    });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);
  return (
    <>
      <span
        ref={anchorRef}
        tabIndex={0}
        role="img"
        aria-label={`Stav účtu: ${tone.label}. ${tone.detail}`}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        // Vizuální tečka zůstává 6px, ale zápornou marží dostane hmatatelný
        // 20px cíl, aby se na ni dalo najet i myší bez mikrometru.
        className="-m-1.5 inline-flex shrink-0 cursor-help items-center justify-center p-1.5 outline-none"
      >
        <span className={`h-1.5 w-1.5 rounded-full transition-transform duration-150 ${tone.dotClass} ${tip ? 'scale-[1.9]' : ''}`} />
      </span>
      {tip ? createPortal(
        <div
          role="tooltip"
          style={{ top: tip.top, left: tip.left, width: 260 }}
          className="pointer-events-none fixed z-[10050] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
        >
          <span className={`flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide ${tone.accentClass}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dotClass}`} />{tone.label}
          </span>
          <p className="mt-1.5 text-[10px] leading-snug text-[var(--text-secondary)]">{tone.detail}</p>
          {reason ? (
            <p className="mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[10px] leading-snug text-[var(--text-muted)]">
              <span className="font-bold text-[var(--text-secondary)]">Důvod: </span>{reason}
            </p>
          ) : null}
          {confirmedAt ? (
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              Potvrzeno {new Date(confirmedAt).toLocaleTimeString('cs-CZ')}
            </p>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
};

export const AccountEligibilityPill = ({ eligibility, live, unavailable = false, onVerify, verifying = false }: {
  eligibility?: CopierAccountEligibility;
  live: boolean;
  unavailable?: boolean;
  onVerify?: () => void;
  verifying?: boolean;
}) => {
  const state = eligibility?.state ?? 'active';
  if (state === 'dll-locked') {
    return <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-black leading-none text-amber-600">
      <Lock aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />DLL · do konce session</span>;
  }
  if (state === 'breached') {
    // BREACHED je trvalý; tlačítko spouští jen read-only broker důkaz (účet
    // aktivní, equity nad floorem propky). Bez důkazu worker vyřazení nezruší.
    return <span className="inline-flex items-center gap-1.5">
      <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[10px] font-black leading-none text-rose-600">
        <Ban aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />BREACHED</span>
      {onVerify ? <button
        type="button"
        disabled={verifying}
        title="Read-only kontrola u brokera: vyřazení se zruší jen když je účet aktivní a equity nad floorem propky"
        aria-label="Znovu ověřit BREACHED účet u brokera"
        onClick={event => { event.stopPropagation(); onVerify(); }}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-indigo-500/25 bg-indigo-500/[0.06] px-2 text-[10px] font-black text-indigo-600 transition-colors hover:bg-indigo-500/12 disabled:cursor-wait disabled:opacity-55"
      >
        <RefreshCw aria-hidden="true" size={10} strokeWidth={2.6} className={verifying ? 'animate-spin' : ''} />
        {verifying ? 'Ověřuji…' : 'Ověřit'}
      </button> : null}
    </span>;
  }
  if (state === 'unverifiable') {
    return <span className="inline-flex items-center gap-1.5">
      <span title={eligibility?.reason} className="inline-flex items-center gap-1 rounded-md border border-slate-500/40 bg-slate-500/20 px-2 py-1 text-[10px] font-black leading-none text-slate-500">
        <HelpCircle aria-hidden="true" size={10} strokeWidth={2.7} className="shrink-0" />Stav nelze ověřit
      </span>
      {onVerify ? <button
        type="button"
        disabled={verifying}
        title="Spustí pouze read-only broker kontrolu; neodešle žádný příkaz"
        aria-label="Ověřit stav účtu u brokera"
        onClick={event => { event.stopPropagation(); onVerify(); }}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-indigo-500/25 bg-indigo-500/[0.06] px-2 text-[10px] font-black text-indigo-600 transition-colors hover:bg-indigo-500/12 disabled:cursor-wait disabled:opacity-55"
      >
        <RefreshCw aria-hidden="true" size={10} strokeWidth={2.6} className={verifying ? 'animate-spin' : ''} />
        {verifying ? 'Ověřuji…' : 'Ověřit'}
      </button> : null}
    </span>;
  }
  if (unavailable) {
    return <span title="Účet není v aktuálním OAuth snapshotu" className="inline-flex items-center gap-1 rounded-md border border-slate-500/40 bg-slate-500/15 px-2 py-1 text-[10px] font-black leading-none text-slate-600">
      <Unplug aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Nedostupný účet</span>;
  }
  if (!live) {
    return <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold leading-none text-[var(--text-secondary)]">
      <Unplug aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Odpojeno</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold leading-none text-emerald-600">
    <CheckCircle2 aria-hidden="true" size={10} strokeWidth={2.5} className="shrink-0" />Aktivní</span>;
};

const GroupDetail = ({ rows, tab, isLive, onTab, onAccount, columns, orders, eligibilityByAccount, tradeCutsByAccount, busyCommand, onRefreshOrders, onVerifyEligibility, verifyingAccountId, dailyPnlPending, onMultiplier, onFlattenAccount, onRemoveUnavailableFollower, onCancelOrder, redactNames, redaction, orderColumns, tightenOnly }: {
  rows: Row[];
  tab: 'accounts' | 'orders';
  isLive: (a?: LiveAccount) => boolean;
  onTab: (t: 'accounts' | 'orders') => void;
  onAccount?: (a: LiveAccount) => void;
  columns: ColumnDef[];
  orders: LiveOrder[];
  eligibilityByAccount: Map<number, CopierAccountEligibility>;
  tradeCutsByAccount: ReadonlyMap<number, ActiveFollowerCut>;
  busyCommand: string | null;
  onRefreshOrders?: () => Promise<void> | void;
  onVerifyEligibility?: (accountId: number) => void;
  verifyingAccountId: number | null;
  dailyPnlPending: boolean;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlattenAccount: (accountId: number) => void;
  onRemoveUnavailableFollower: (accountId: number) => void;
  onCancelOrder: (orderId: number) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  orderColumns: Array<{ key: OrderColumnKey; label: string }>;
  tightenOnly: boolean;
}) => {
  const accountIds = new Set(rows.flatMap(row => row.accountId != null ? [row.accountId] : []));
  const groupOrders = orders.filter(order => order.accountId != null && accountIds.has(order.accountId));
  // Tabulka účtů dostala vlastní svislý posuvník, aby sticky hlavička měla
  // ke komu přilnout: nejbližší scrollovatelný předek (animační obal detailu)
  // svisle nescrolluje, takže `sticky top-0` by se bez něj nikdy nepohnul.
  const accountsScrollRef = useRef<HTMLDivElement>(null);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  // Překlopení Účty/Příkazy: obsah se přelije do strany podle směru a karta
  // přejede na novou výšku. Bez toho by přepínač pod obsahem uskočil zpod
  // kurzoru — u dvaceti účtů skoro o 400 px.
  const morphRef = useRef<HTMLDivElement>(null);
  const heightBeforeSwitch = useRef<number | null>(null);
  const [switchDirection, setSwitchDirection] = useState<'forward' | 'back'>('forward');
  const selectTab = (next: 'accounts' | 'orders') => {
    if (next === tab) return;
    heightBeforeSwitch.current = morphRef.current?.getBoundingClientRect().height ?? null;
    setSwitchDirection(next === 'orders' ? 'forward' : 'back');
    onTab(next);
  };
  useIsomorphicLayoutEffect(() => {
    const node = morphRef.current;
    const from = heightBeforeSwitch.current;
    heightBeforeSwitch.current = null;
    if (!node || from == null) return;
    const to = node.scrollHeight;
    node.style.height = `${from}px`;
    const frame = requestAnimationFrame(() => { node.style.height = `${to}px`; });
    // Po doběhu zpátky na auto, ať se karta dál přizpůsobuje obsahu.
    const timer = setTimeout(() => { node.style.height = ''; }, 320);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); node.style.height = ''; };
  }, [tab]);
  const [accountsScroll, setAccountsScroll] = useState({ above: false, below: false });
  const syncAccountsScroll = useCallback(() => {
    const element = accountsScrollRef.current;
    if (!element) return;
    setAccountsScroll({
      above: element.scrollTop > 4,
      below: element.scrollTop + element.clientHeight < element.scrollHeight - 4,
    });
  }, []);
  useEffect(() => {
    syncAccountsScroll();
    const element = accountsScrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Rozbalení detailu i změna počtu účtů mění výšku bez scroll události.
    const observer = new ResizeObserver(syncAccountsScroll);
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncAccountsScroll, rows.length, tab, accountsExpanded]);
  return (
  <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-app)]/40">
    <div ref={morphRef} className="live-detail-morph">
    <div key={tab} className={`live-detail-pane${switchDirection === 'back' ? ' live-detail-pane-back' : ''}`}>
    {tab === 'accounts' ? (
      // Rozbalený detail leží v animačním obalu `overflow-hidden`; bez vlastního
      // vodorovného posuvníku by se širší tabulka jen ořízla (3.–6. 9. 2026).
      <div className="group/accounts relative">
      <div
        ref={accountsScrollRef}
        onScroll={syncAccountsScroll}
        className={`live-accounts-scroll overflow-x-auto ${accountsExpanded ? 'live-accounts-scroll-expanded' : ''}`}
      >
        <table
          // Kompaktní šířka = součet sloupců: roztažení na celou kartu
          // rozhazovalo Stav/Broker/Firma daleko od sebe (uživatel 6. 9. 2026).
          className="table-fixed text-left"
          style={{ width: `${columns.reduce((total, column) => total + column.widthPx, 0)}px` }}
        >
          <colgroup>
            {columns.map(column => <col key={column.key} style={{ width: `${column.widthPx}px` }} />)}
          </colgroup>
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 whitespace-nowrap ${col.key === 'qtyMult' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}`}
                >
                  {col.key === 'actions' ? '' : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <AccountRow
                key={row.accountId ?? `unavailable-${i}`} row={row} live={isLive(row.account)} onAccount={onAccount} columns={columns}
                dailyPnlPending={dailyPnlPending}
                orders={groupOrders}
                eligibility={row.accountId != null ? eligibilityByAccount.get(row.accountId) : undefined}
                tradeCut={row.accountId != null ? tradeCutsByAccount.get(row.accountId) : undefined}
                busyCommand={busyCommand}
                onVerifyEligibility={onVerifyEligibility}
                verifying={row.accountId != null && verifyingAccountId === row.accountId}
                onMultiplier={onMultiplier} onFlatten={onFlattenAccount}
                onRemoveUnavailableFollower={onRemoveUnavailableFollower}
                redactNames={redactNames} redaction={redaction}
                tightenOnly={tightenOnly}
              />
            ))}
          </tbody>
        </table>
      </div>
        {accountsScroll.above ? <div aria-hidden className="pointer-events-none absolute inset-x-0 top-7 h-6 bg-gradient-to-b from-[var(--bg-card)] to-transparent" /> : null}
        {accountsScroll.below ? (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--bg-card)] via-[var(--bg-card)]/75 to-transparent" />
        ) : null}
        {accountsScroll.below || accountsExpanded ? (
          <button
            type="button"
            onClick={() => setAccountsExpanded(current => !current)}
            title={accountsExpanded ? 'Vrátit tabulku na pevnou výšku s posuvníkem' : 'Roztáhnout tabulku a zobrazit všechny účty najednou'}
            className="absolute bottom-1.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2.5 py-0.5 text-[10px] font-bold text-[var(--text-secondary)] opacity-75 shadow-sm transition-all hover:border-indigo-500/40 hover:text-indigo-500 hover:opacity-100 group-hover/accounts:opacity-100"
          >
            <ChevronDown
              size={11}
              strokeWidth={2.6}
              className={accountsExpanded ? 'rotate-180' : 'animate-bounce'}
            />
            {accountsExpanded ? 'Sbalit' : `Zobrazit všech ${rows.length}`}
          </button>
        ) : null}
      </div>
    ) : (
      groupOrders.length === 0 ? (
        <div className="py-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3"><Inbox size={22} /></div>
          <p className="text-sm font-bold text-[var(--text-primary)]">No orders for this group</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-sm mx-auto leading-snug">Ordery se objeví, jakmile leader zadá obchod, který se replikuje na followery.</p>
        </div>
      ) : (
        <div className="pt-2 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead><tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
              {orderColumns.map(column => <th key={column.key} className={`px-3 py-1.5${ORDER_COLUMNS_RIGHT.has(column.key) ? ' text-right' : ''}`}>{column.label}</th>)}
              <th className="px-3 py-1.5" />
            </tr></thead>
            <tbody>{groupOrders.map(order => (
              <tr key={`${order.accountId}-${order.id}`} className="border-b border-[var(--border-subtle)] last:border-0 text-xs">
                {(() => {
                  // Stejné buňky, jen v pořadí, které si uživatel nastavil.
                  const cells: Record<OrderColumnKey, React.ReactNode> = {
                    account: <td className="px-3 py-1.5 font-bold text-[var(--text-primary)]">{redactAccountName(order.accountName, redactNames, redaction)}</td>,
                    broker: <td className="px-3 py-1.5"><TradovateMark size="h-4 w-4" /></td>,
                    symbol: <td className="px-3 py-1.5 text-[var(--text-secondary)]">{order.symbol}</td>,
                    action: <td className={`px-3 py-1.5 font-bold ${order.action.toLowerCase().includes('buy') ? 'text-emerald-500' : 'text-rose-500'}`}>{order.action}</td>,
                    type: <td className="px-3 py-1.5 text-[var(--text-secondary)]">{order.orderType}</td>,
                    qty: <td className="px-3 py-1.5 text-right tabular-nums">{order.quantity}</td>,
                    limit: <td className="px-3 py-1.5 text-right tabular-nums">{order.price ?? '—'}</td>,
                    stop: <td className="px-3 py-1.5 text-right tabular-nums">{order.stopPrice ?? '—'}</td>,
                    status: <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${order.working ? 'bg-blue-500/10 text-blue-500' : 'bg-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>{order.status}</span></td>,
                    timestamp: <td className="px-3 py-1.5 text-[var(--text-secondary)]">{order.placedAt ? new Date(order.placedAt).toLocaleString() : '—'}</td>,
                    orderId: <td className="px-3 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{order.id}</td>,
                  };
                  return orderColumns.map(column => <React.Fragment key={column.key}>{cells[column.key]}</React.Fragment>);
                })()}
                <td className="px-3 py-1.5 text-right"><button disabled={!order.working || busyCommand != null} onClick={() => onCancelOrder(order.id)} className="h-6 rounded-md border border-rose-500/20 px-2 text-[10px] font-bold text-rose-500 disabled:opacity-35">Cancel</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )
    )}
    </div>
    </div>
    {/* Přepínač až pod obsahem: nekoliduje s hlavičkou tabulky („Účty“ nad
        „ÚČET“) a jako málo užívaná funkce nemá tahat oči. */}
    <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-3 lg:px-4">
      <div className="flex items-center gap-0.5">
        {(['accounts', 'orders'] as const).map(key => (
          <button
            key={key} type="button" aria-pressed={tab === key} onClick={() => selectTab(key)}
            className={`live-detail-tab inline-flex items-center gap-1.5 px-2 py-[7px] text-[10px] font-bold transition-colors ${
              tab === key ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {key === 'accounts' ? 'Účty' : 'Příkazy'}
            <span className="text-[9.5px] font-semibold tabular-nums opacity-60">{key === 'accounts' ? rows.length : groupOrders.length}</span>
          </button>
        ))}
      </div>
      {tab === 'orders' ? (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-[var(--text-muted)]">{groupOrders.filter(order => order.working).length} working</span>
          <button onClick={() => void onRefreshOrders?.()} title="Obnovit příkazy" aria-label="Obnovit příkazy" className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-indigo-500"><RefreshCw size={11} /></button>
        </div>
      ) : null}
    </div>
  </div>
  );
};

const MultiplierEditor = ({ accountId, accountName, value, tightenOnly, disabled, onCommit }: {
  accountId: number;
  accountName: string;
  value: number;
  tightenOnly: boolean;
  disabled: boolean;
  onCommit: (accountId: number, multiplier: number) => void;
}) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [accountId, value]);
  const parsed = Number(draft);
  const valid = Number.isFinite(parsed)
    && parsed >= 0.01
    && parsed <= 100
    && (!tightenOnly || parsed <= value);
  const next = valid ? normalizeMultiplier(parsed) : null;
  const changed = next != null && next !== value;
  const commit = () => {
    if (!changed || next == null || disabled) return;
    onCommit(accountId, next);
    // Hodnota se v řádku změní až po explicitním potvrzení dialogu. Tady
    // draft vrátíme na poslední potvrzený stav, aby zrušený dialog nikdy
    // nevypadal jako uložená změna.
    setDraft(String(value));
  };

  return (
    <div onClick={event => event.stopPropagation()} className="inline-flex items-center justify-end gap-1">
      <input
        aria-label={`Násobek ${accountName}`}
        type="number"
        min="0.01"
        max={tightenOnly ? value : 100}
        step="0.25"
        value={draft}
        disabled={disabled}
        title={tightenOnly ? 'dnes jen zpřísnit' : 'Změnu potvrď tlačítkem Uložit'}
        onFocus={event => event.currentTarget.select()}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(String(value));
        }}
        className={`w-14 rounded-md border bg-[var(--bg-card)] px-1.5 py-1 text-center tabular-nums outline-none focus:border-indigo-500 ${valid ? 'border-[var(--border-subtle)]' : 'border-rose-500'}`}
      />
      <button
        type="button"
        aria-label={`Uložit násobek ${accountName}`}
        title={changed ? `Potvrdit změnu ${value}× → ${next}×` : 'Nejdřív změň násobek'}
        disabled={disabled || !changed}
        onClick={commit}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border-subtle)] text-indigo-500 hover:border-indigo-500/40 hover:bg-indigo-500/10 disabled:cursor-default disabled:opacity-25"
      >
        <Save size={11} />
      </button>
    </div>
  );
};

const AccountRow = ({ row, live, onAccount, columns, orders, eligibility, tradeCut, busyCommand, onVerifyEligibility, verifying, dailyPnlPending, onMultiplier, onFlatten, onRemoveUnavailableFollower, redactNames, redaction, tightenOnly }: {
  row: Row; live: boolean; onAccount?: (a: LiveAccount) => void; columns: ColumnDef[];
  orders: LiveOrder[];
  eligibility?: CopierAccountEligibility;
  tradeCut?: ActiveFollowerCut;
  busyCommand: string | null;
  onVerifyEligibility?: (accountId: number) => void;
  verifying: boolean;
  dailyPnlPending: boolean;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlatten: (accountId: number) => void;
  onRemoveUnavailableFollower: (accountId: number) => void;
  redactNames: boolean;
  redaction: RedactionSettings;
  tightenOnly: boolean;
}) => {
  const a = row.account;
  const accountId = row.accountId;
  const dismissedRejections = useDismissedRejections();
  const rowFlat = live && a != null && a.positions.every(position => position.netPosition === 0);
  const rowRejection = visibleRejectedExecution(accountId, eligibility, rowFlat, dismissedRejections);
  const cushion = a?.cushion ?? null;
  const cashKnown = !!a && isLiveAccountReadVerified(a, 'cash');
  const rawDaily = liveDailyPnlDisplay(a ? { ...a, displayValues: undefined } : undefined, Date.now(), dailyPnlPending);
  const dllRemaining = a && rawDaily.value != null ? copyTradeDailyLossRemaining(a) : null;
  const riskKey = `${accountId}:${a?.riskDisplayConfigKey ?? "legacy"}:${tradovateDisplayTradeDate()}`;
  const dllAt = [a?.cashUpdatedAt, rawDaily.confirmedAt, a?.unrealizedPnlUpdatedAt].filter((at): at is string => !!at);
  const dllConfirmedAt = dllAt.length === 3 ? dllAt.sort((x,y)=>Date.parse(x)-Date.parse(y))[0] : null;
  // Both columns share the same value, freshness and cache identity. A missing
  // broker DLL alone must never be interpreted as a plan without a daily limit.
  const eligibilityState = eligibility?.state ?? 'active';
  const accountUnavailable = !a && accountId != null;
  // Odchylka = cokoli, co není „živý a způsobilý účet“. Jen ta se vykreslí.
  const stateIsDeviation = tradeCut != null || eligibilityState !== 'active' || accountUnavailable || !live;
  const stateTone: AccountStateTone = eligibilityState === 'breached'
    ? { dotClass: 'bg-rose-500', accentClass: 'text-rose-500', label: 'Breached',
        detail: 'Účet je trvale vyřazen z kopírování. Zrušit to může jen read-only důkaz od brokera — že je účet aktivní a equity nad floorem propky.' }
    : eligibilityState === 'dll-locked'
    ? { dotClass: 'bg-amber-500', accentClass: 'text-amber-500', label: 'Zamčeno denním limitem',
        detail: 'Účet vyčerpal denní limit ztráty. Do konce session se na něj nekopíruje; zámek se sám uvolní až další obchodní den.' }
    : eligibilityState === 'unverifiable'
    ? { dotClass: 'bg-slate-400', accentClass: 'text-slate-400', label: 'Stav nelze ověřit',
        detail: 'Broker nevrátil dost dat na potvrzení způsobilosti. Kopírka s účtem fail-closed nepracuje, dokud ověření neprojde.' }
    : accountUnavailable
    ? { dotClass: 'bg-slate-400', accentClass: 'text-slate-400', label: 'Chybí v OAuth snapshotu',
        detail: 'Účet se v aktuálním snapshotu připojení neobjevil. Zkontroluj připojení firmy v záložce Připojení.' }
    : live
    ? { dotClass: 'bg-emerald-500', accentClass: 'text-emerald-500', label: 'Aktivní',
        detail: 'Účet je v aktuálním OAuth snapshotu a je způsobilý ke kopírování. Hodnoty v řádku pocházejí z potvrzeného broker snapshotu.' }
    : { dotClass: 'bg-rose-500', accentClass: 'text-rose-500', label: 'Odpojeno',
        detail: 'Z účtu nepřicházejí živá data. Zobrazené hodnoty jsou poslední známé, ne aktuální.' };
  const showDrawdownInDll = !!a?.riskDisplayDailyLossDisabled
    && (a.dailyLossLimit == null || a.dailyLossLimit === 0);
  const drawdownValue = () => <LiveRiskValue identity={`${riskKey}:dd`} label="Rezerva DD" storageScope={a?.riskDisplayStorageScope} legacy={!!a && a.cashAvailability == null}
    enabled={!!a && a.cashAvailability !== 'denied' && !a.riskDisplayDrawdownDisabled}
    value={dailyPnlPending || a?.riskDisplayPending ? null : cushion} confirmedAt={a?.cashUpdatedAt ?? null}
    verified={cashKnown && a?.unrealizedPnlSource !== 'stale'} color={cushionClass} />;

  const cell = (key: AccountColumnKey): React.ReactNode => {
    switch (key) {
      case 'account':
        return (
          <span className="block">
            <span className="flex items-center gap-2 text-xs">
            <AccountStateDot tone={stateTone} reason={eligibility?.reason} confirmedAt={a?.cashUpdatedAt ?? null} />
            <span className={`truncate max-w-[190px] ${live ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{redactAccountName(row.name, redactNames, redaction)}</span>
            {row.isLeader && (
              <span title="Leader účet" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-amber-400/35 bg-amber-400/12 text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.12)]">
                <Crown size={14} strokeWidth={2.4} />
              </span>
            )}
            {!row.synced && <span title="Nesedí s leaderem" className="text-amber-500">⚠</span>}
            </span>
            {stateIsDeviation ? (
              <span className="mt-1 flex flex-wrap items-center gap-1.5 pl-3.5">
                {tradeCut ? <TradeCutPill /> : <AccountEligibilityPill
                  eligibility={eligibility}
                  live={live}
                  unavailable={accountUnavailable}
                  verifying={verifying}
                  onVerify={(eligibilityState === 'unverifiable' || eligibilityState === 'breached') && accountId != null && onVerifyEligibility
                    ? () => onVerifyEligibility(accountId)
                    : undefined}
                />}
              </span>
            ) : null}
            {tradeCut ? (
              <span className="block pl-3.5 text-[10px] font-semibold leading-tight text-amber-600">
                Ručně zavřeno · znovu se připojí po flat skupiny
              </span>
            ) : rowRejection ? (
              <RejectedExecutionStatus
                execution={rowRejection}
                accountAuthoritativelyFlat={rowFlat}
                onDismiss={accountId != null ? () => dismissRejection(rejectedExecutionDismissKey(accountId, rowRejection)) : undefined}
              />
            ) : eligibility && eligibility.state !== 'active' && eligibility.reason ? (
              <span className="block pl-3.5 text-[10px] leading-tight text-[var(--text-muted)]">
                {eligibility.reason}{!a ? ' · účet není v aktuálním OAuth snapshotu' : ''}
              </span>
            ) : !a && accountId != null ? (
              <span className="block pl-3.5 text-[10px] font-bold leading-tight text-slate-500">
                Aktuální data účtu nejsou dostupná. Ověř připojení firmy v záložce Připojení.
              </span>
            ) : null}
          </span>
        );
      case 'status':
        return tradeCut ? <TradeCutPill /> : <AccountEligibilityPill
          eligibility={eligibility}
          live={live}
          unavailable={!a && accountId != null}
          verifying={verifying}
          onVerify={(eligibility?.state === 'unverifiable' || eligibility?.state === 'breached') && accountId != null && onVerifyEligibility
            ? () => onVerifyEligibility(accountId)
            : undefined}
        />;
      case 'broker':
        return <TradovateMark size="h-5 w-5" />;
      case 'firm':
        return row.firm ? <FirmMark firm={row.firm} withLabel /> : <span className="text-[11px] text-[var(--text-secondary)]">—</span>;
      case 'balance':
        return <BalanceValue display={liveBalanceDisplay(a)} />;
      case 'positions':
        return a
          ? <CopyTradePositionsCell accountId={accountId} positions={a.positions} orders={orders} positionsVerified={isLiveAccountReadVerified(a, 'positions')} ordersVerified={isLiveAccountReadVerified(a, 'orders')} staleLabel={liveReadStaleLabel(a, 'positions') ?? liveReadStaleLabel(a, 'orders')} />
          : <span className="text-xs tabular-nums text-[var(--text-secondary)]">—</span>;
      case 'daily':
        return <span className={`text-xs tabular-nums ${a && liveDailyPnlDisplay(a, Date.now(), dailyPnlPending).value != null ? pnlClass(liveDailyPnlDisplay(a, Date.now(), dailyPnlPending).value!) : 'text-[var(--text-secondary)]'}`}>{a && liveDailyPnlDisplay(a, Date.now(), dailyPnlPending).value != null ? money.format(liveDailyPnlDisplay(a, Date.now(), dailyPnlPending).value!) : '—'}</span>;
      case 'dllRemaining':
        if (showDrawdownInDll) return <span className="inline-flex items-center justify-end whitespace-nowrap"
          title="Účet nemá denní limit ztráty. Zobrazuje se zbývající rezerva drawdownu (DD).">
          {drawdownValue()}
        </span>;
        return <LiveRiskValue identity={`${riskKey}:dll`} label="DLL zbývá" storageScope={a?.riskDisplayStorageScope} legacy={!!a && a.cashAvailability == null}
          enabled={!!a && a.cashAvailability !== 'denied' && (a.dailyLossLimit == null || a.dailyLossLimit > 0)}
          value={dailyPnlPending || a?.riskDisplayPending || dllRemaining == null ? null : Math.max(0,dllRemaining)} confirmedAt={dllConfirmedAt}
          verified={cashKnown && !dailyPnlPending && a?.unrealizedPnlSource !== 'stale'}
          color={value=>dllRemainingClass(value,a?.dailyLossLimit)} />;
      case 'unreal':
        return a ? <span
          className={`inline-flex items-center justify-end gap-1.5 text-xs tabular-nums ${pnlClass(a.unrealizedPnl)}`}
          title={a.unrealizedPnlSource === 'estimated'
            ? 'Live odhad podle skutečné vstupní ceny účtu a posledního broker snapshotu.'
            : a.unrealizedPnlSource === 'stale' ? `Poslední známý údaj${a.unrealizedPnlUpdatedAt ? ' · ' + new Date(a.unrealizedPnlUpdatedAt).toLocaleTimeString('cs-CZ') : ''}. Čeká na ověření.` : 'Potvrzeno broker snapshotem.'}
        >
          {money.format(a.unrealizedPnl)}
          {a.unrealizedPnlSource === 'stale' ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label="Čeká na snapshot" /> : null}
        </span> : <span className="text-xs text-[var(--text-secondary)]">—</span>;
      case 'distDd':
        return drawdownValue();
      case 'execLimit':
        return <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">—</span>;
      case 'qtyMult':
        return row.isLeader || accountId == null
          ? <span className="mx-auto flex w-full items-center justify-center text-center text-[11px] text-[var(--text-secondary)]">—</span>
          : <MultiplierEditor
              accountId={accountId}
              accountName={row.name}
              value={row.scale}
              tightenOnly={tightenOnly}
              disabled={busyCommand != null}
              onCommit={onMultiplier}
            />;
      case 'actions':
        return null;
    }
  };

  return (
    <tr
      onClick={() => a && onAccount?.(a)}
      className={`border-b border-[var(--border-subtle)] last:border-0 transition-colors ${tradeCut ? 'bg-amber-500/[0.035] opacity-80' : ''} ${a ? 'cursor-pointer hover:bg-[var(--bg-card)]' : ''}`}
    >
      {columns.map(col => (
        <td key={col.key} className={`px-3 ${col.key === 'actions' ? 'py-0' : 'py-1.5'} ${col.key === 'qtyMult' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}`}>
          {col.key === 'actions' && a ? (
            <button
              disabled={busyCommand != null}
              onClick={event => { event.stopPropagation(); onFlatten(a.id); }}
              className="group flex h-11 items-center whitespace-nowrap text-[10px] font-bold text-[var(--text-secondary)] hover:text-rose-500 disabled:opacity-40"
            ><span className="flex h-7 items-center rounded-md border border-[var(--border-subtle)] px-2.5 group-hover:border-rose-500/25">Flatten</span></button>
          ) : col.key === 'actions' && !a && !row.isLeader && accountId != null ? (
            <button
              type="button"
              disabled={busyCommand != null}
              onClick={event => { event.stopPropagation(); onRemoveUnavailableFollower(accountId); }}
              className="inline-flex min-h-7 items-center rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1 text-[9px] font-black leading-tight text-amber-700 hover:bg-amber-500/12 disabled:opacity-40"
            >Odebrat ze skupiny</button>
          ) : cell(col.key)}
        </td>
      ))}
    </tr>
  );
};

// ─── Dialogy a lokální command režim ────────────────────────────────────────

/**
 * Volba leadera mění jen roli zvoleného účtu. Předchozí leader se **nikdy**
 * nepřesune mezi followery automaticky: dřív se tak dělo a proklikání seznamu
 * postupně označilo všechny účty jako followery. Přidat obchodující účet do
 * skupiny je rozhodnutí, které musí padnout vědomě — omylem nikdy.
 *
 * Účet, který se stal leaderem, z followerů vypadne; leader sám sebe nekopíruje.
 */
export const changeCopyGroupLeader = (
  group: CopyGroupConfig,
  nextLeaderAccountId: number,
): CopyGroupConfig => {
  if (group.leaderAccountId === nextLeaderAccountId) return group;
  return {
    ...group,
    leaderAccountId: nextLeaderAccountId,
    followers: group.followers.filter(follower => follower.accountId !== nextLeaderAccountId),
  };
};

type CopyGroupFollowerChangeKind = 'added' | 'removed' | 'updated';
type CopyGroupFollowerChangedField = 'mode' | 'multiplier' | 'maxContracts';

export interface CopyGroupFollowerChange {
  accountId: number;
  kind: CopyGroupFollowerChangeKind;
  before?: CopyFollowerConfig;
  after?: CopyFollowerConfig;
  changedFields: CopyGroupFollowerChangedField[];
}

export interface CopyGroupEditDiff {
  leaderChanged: boolean;
  previousLeaderAccountId: number | null;
  nextLeaderAccountId: number | null;
  followerChanges: CopyGroupFollowerChange[];
}

export const copyGroupEditDiff = (
  saved: CopyGroupConfig,
  draft: CopyGroupConfig,
): CopyGroupEditDiff => {
  const savedFollowers = new Map(saved.followers.map(follower => [follower.accountId, follower]));
  const draftFollowers = new Map(draft.followers.map(follower => [follower.accountId, follower]));
  const accountIds = [
    ...saved.followers.map(follower => follower.accountId),
    ...draft.followers
      .map(follower => follower.accountId)
      .filter(accountId => !savedFollowers.has(accountId)),
  ];

  const followerChanges = accountIds.flatMap<CopyGroupFollowerChange>(accountId => {
    const before = savedFollowers.get(accountId);
    const after = draftFollowers.get(accountId);
    if (!before && after) return [{ accountId, kind: 'added', after, changedFields: [] }];
    if (before && !after) return [{ accountId, kind: 'removed', before, changedFields: [] }];
    if (!before || !after) return [];

    const changedFields: CopyGroupFollowerChangedField[] = [];
    if (before.mode !== after.mode) changedFields.push('mode');
    if (before.multiplier !== after.multiplier) changedFields.push('multiplier');
    if (before.maxContracts !== after.maxContracts) changedFields.push('maxContracts');
    return changedFields.length > 0
      ? [{ accountId, kind: 'updated', before, after, changedFields }]
      : [];
  });

  return {
    leaderChanged: saved.leaderAccountId !== draft.leaderAccountId,
    previousLeaderAccountId: saved.leaderAccountId,
    nextLeaderAccountId: draft.leaderAccountId,
    followerChanges,
  };
};

const replicationModeLabel = (mode: CopyReplicationMode): string => (
  mode === 'on-fill' ? 'Při vyplnění' : mode === 'off' ? 'Vypnuto' : 'Při zadání'
);

const MultiplierValue = ({ value }: { value: number }) => (
  <span
    data-risk-multiplier={value > 1 ? 'true' : undefined}
    className={value > 1
      ? 'rounded bg-amber-500/15 px-1 font-black text-amber-700 ring-1 ring-inset ring-amber-500/30'
      : 'font-bold text-[var(--text-primary)]'}
  >{value}×</span>
);

const followerSettings = (follower: CopyFollowerConfig) => (
  <>
    <span>Režim: {replicationModeLabel(follower.mode)}</span>
    <span>Násobek: <MultiplierValue value={follower.multiplier} /></span>
    <span>Max: {follower.maxContracts ?? 'bez limitu'}</span>
  </>
);

export const CopyGroupChangePreview = ({ saved, draft, accountLabel }: {
  saved: CopyGroupConfig;
  draft: CopyGroupConfig;
  accountLabel: (accountId: number, role?: CopyTradeAccountRole) => string;
}) => {
  const diff = copyGroupEditDiff(saved, draft);
  const hasChanges = diff.leaderChanged || diff.followerChanges.length > 0;

  return (
    <section aria-label="Přehled změn před uložením" className="rounded-lg border border-indigo-500/25 bg-indigo-500/[0.045] p-4">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-indigo-500" />
        <div className="min-w-0 flex-1">
          <h5 className="text-xs font-black text-[var(--text-primary)]">Přehled změn před uložením</h5>
          <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Porovnání leadera a followerů s uloženou skupinou.</p>
        </div>
      </div>

      {!hasChanges ? <p className="mt-3 text-xs text-[var(--text-secondary)]">Leader a followeři beze změny.</p> : null}

      <div className="mt-3 space-y-2">
        {diff.leaderChanged ? (
          <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs text-[var(--text-primary)]">
            <b>Leader:</b>{' '}
            {diff.previousLeaderAccountId == null ? 'Nevybrán' : accountLabel(diff.previousLeaderAccountId, 'leader')}
            {' → '}
            {diff.nextLeaderAccountId == null ? 'Nevybrán' : accountLabel(diff.nextLeaderAccountId, 'leader')}
          </div>
        ) : null}

        {diff.followerChanges.map(change => (
          <div key={`${change.kind}-${change.accountId}`} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <b className="text-[var(--text-primary)]">{accountLabel(change.accountId, 'follower')}</b>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${change.kind === 'added' ? 'bg-emerald-500/12 text-emerald-700' : change.kind === 'removed' ? 'bg-rose-500/12 text-rose-600' : 'bg-amber-500/12 text-amber-700'}`}>
                {change.kind === 'added' ? 'Přidán' : change.kind === 'removed' ? 'Odebrán' : 'Změněn'}
              </span>
            </div>

            {change.kind === 'added' && change.after ? (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">{followerSettings(change.after)}</div>
            ) : null}
            {change.kind === 'removed' && change.before ? (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">{followerSettings(change.before)}</div>
            ) : null}
            {change.kind === 'updated' && change.before && change.after ? (
              <div className="mt-1.5 space-y-1 text-[11px] text-[var(--text-secondary)]">
                {change.changedFields.includes('mode') ? <div>Režim: {replicationModeLabel(change.before.mode)} → {replicationModeLabel(change.after.mode)}</div> : null}
                {change.changedFields.includes('multiplier') ? <div className="flex flex-wrap items-center gap-1">Násobek: <MultiplierValue value={change.before.multiplier} /> → <MultiplierValue value={change.after.multiplier} /></div> : null}
                {change.changedFields.includes('maxContracts') ? <div>Max: {change.before.maxContracts ?? 'bez limitu'} → {change.after.maxContracts ?? 'bez limitu'}</div> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
};

const REPLICATION_MODES: Array<{ value: ReplicationMode; label: string }> = [
  { value: 'off', label: 'Vypnuto' },
  { value: 'on-submit', label: 'Při zadání' },
  { value: 'on-fill', label: 'Při vyplnění' },
];

/**
 * Číselník se šipkami od prohlížeče je v husté tabulce cizí těleso a na dotyku
 * se do něj skoro nedá trefit. Hodnota jde pořád psát; tlačítka jen krokují.
 *
 * `nullable` znamená „bez limitu“: krok pod minimum se vrátí na prázdno (∞),
 * takže se limit ruší stejným ovládáním, jakým se nastavuje.
 */
const NumberStepper = ({ value, onChange, step, min, max, nullable = false, disabled = false, ariaLabel, title, suffix }: {
  value: number | null;
  onChange: (next: number | null) => void;
  step: number;
  min: number;
  max?: number;
  nullable?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  suffix?: string;
}) => {
  const commit = (next: number | null) => {
    if (next == null) return nullable ? onChange(null) : undefined;
    if (next < min) return nullable ? onChange(null) : onChange(min);
    // Strop drží režim „dnes jen zpřísnit“ — přes něj se nesmí ani krokem.
    if (max != null && next > max) return;
    onChange(Math.round(next * 100) / 100);
  };
  const bump = (delta: number) => commit(value == null ? (delta > 0 ? min : null) : value + delta);
  const atCeiling = max != null && value != null && value + step > max;

  return (
    <span
      title={title}
      className={`inline-flex h-7 w-[74px] items-center overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] ${disabled ? 'opacity-35' : ''}`}
    >
      <button
        type="button" disabled={disabled || (value == null && nullable)} onClick={() => bump(-step)}
        aria-label={`Snížit ${ariaLabel}`}
        className="h-full w-[19px] shrink-0 text-xs font-black leading-none text-[var(--text-muted)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
      >−</button>
      <span className="flex min-w-0 flex-1 items-center justify-center">
        <input
          type="number" inputMode="decimal" aria-label={ariaLabel} disabled={disabled}
          min={min} max={max} step={step} placeholder={nullable ? '∞' : undefined}
          value={value ?? ''}
          onChange={event => commit(event.target.value === '' ? null : Number(event.target.value))}
          className="w-full min-w-0 bg-transparent text-center text-[11px] font-bold tabular-nums text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && value != null ? <span className="pr-0.5 text-[10px] font-bold text-[var(--text-muted)]">{suffix}</span> : null}
      </span>
      <button
        type="button" disabled={disabled || atCeiling} onClick={() => bump(step)}
        aria-label={`Zvýšit ${ariaLabel}`}
        className="h-full w-[19px] shrink-0 text-xs font-black leading-none text-[var(--text-muted)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
      >+</button>
    </span>
  );
};

export const GroupEditorDialog = ({ group, isNew, tightenOnly, accounts, accountLabel, saving, libraryState, libraryError, onClose, onSave, onRemoveUnavailableFollowers, onDelete }: {
  group: CopyGroupConfig;
  isNew: boolean;
  tightenOnly: boolean;
  accounts: LiveAccount[];
  accountLabel: (accountId: number, role?: CopyTradeAccountRole) => string;
  saving: boolean;
  libraryState: 'loading' | 'ready' | 'needs-import' | 'error';
  libraryError: string | null;
  onClose: () => void;
  onSave: (group: CopyGroupConfig, onError: (message: string) => void) => Promise<boolean>;
  onRemoveUnavailableFollowers: (group: CopyGroupConfig, accountIds: number[]) => void;
  onDelete?: () => void;
}) => {
  const [draft, setDraft] = useState<CopyGroupConfig>(() => ({
    ...structuredClone(group),
    color: group.color ?? GROUP_COLORS[0],
    safety: group.safety ?? { ...DEFAULT_COPY_GROUP_SAFETY },
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const [replacementNotice, setReplacementNotice] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const baselineFollowers = useMemo(
    () => new Map(group.followers.map(follower => [follower.accountId, follower])),
    [group.followers],
  );
  const baselineHasFollowerCut = useMemo(
    () => group.followers.some(follower => (follower.dailyLossCutUsd ?? 0) > 0),
    [group.followers],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      if (paletteOpen) return setPaletteOpen(false);
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, paletteOpen, saving]);

  /**
   * Followeři, které z tabulky vytlačilo povýšení na leadera. Prohazování rolí
   * se nekoná — ale ani se nesmí stát, že proklikáním seznamu leaderů tiše
   * zmizí nastavený follower i s násobkem. Jakmile účet přestane být leaderem,
   * vrátí se přesně tam, odkud byl vzat.
   */
  const displacedFollowers = useRef(new Map<number, CopyFollowerConfig>());
  const chooseLeader = (accountId: number) => setDraft(current => {
    if (current.leaderAccountId === accountId) return current;
    const promoted = current.followers.find(follower => follower.accountId === accountId);
    if (promoted) displacedFollowers.current.set(accountId, promoted);
    const returning = current.leaderAccountId != null
      ? displacedFollowers.current.get(current.leaderAccountId)
      : undefined;
    if (returning) displacedFollowers.current.delete(current.leaderAccountId!);
    const next = changeCopyGroupLeader(current, accountId);
    return returning ? { ...next, followers: [...next.followers, returning] } : next;
  });

  const followerById = new Map(draft.followers.map(follower => [follower.accountId, follower]));
  const availableAccountIds = useMemo(() => accounts.map(account => account.id), [accounts]);
  const unavailable = unavailableCopyGroupAccounts(draft, availableAccountIds);
  const unavailableFollowers = draft.followers.filter(follower => unavailable.followerAccountIds.includes(follower.accountId));
  const followerCandidates = accounts.filter(account => account.id !== draft.leaderAccountId);
  const followerAdditionBlocked = (accountId: number) => (
    tightenOnly && baselineHasFollowerCut && !baselineFollowers.has(accountId)
  );
  const selectableFollowerCandidates = followerCandidates.filter(account => !followerAdditionBlocked(account.id));
  const selectedCount = followerCandidates.filter(account => followerById.has(account.id)).length;
  const allFollowersSelected = selectableFollowerCandidates.length > 0
    && selectableFollowerCandidates.every(account => followerById.has(account.id));

  const newFollower = (accountId: number): CopyFollowerConfig => structuredClone(
    baselineFollowers.get(accountId) ?? { accountId, mode: 'on-submit' as const, multiplier: 1 },
  );
  const toggleFollower = (accountId: number) => {
    if (!followerById.has(accountId) && followerAdditionBlocked(accountId)) return;
    setDraft(current => ({
      ...current,
      followers: current.followers.some(follower => follower.accountId === accountId)
        ? current.followers.filter(follower => follower.accountId !== accountId)
        : [...current.followers, newFollower(accountId)],
    }));
  };
  /** Hromadný výběr nikdy nepřepíše už nastaveného followera a nesáhne na leadera. */
  const selectAllFollowers = (select: boolean) => {
    const candidateIds = new Set(selectableFollowerCandidates.map(account => account.id));
    setDraft(current => ({
      ...current,
      followers: select
        ? [
          ...current.followers,
          ...selectableFollowerCandidates
            .filter(account => !current.followers.some(follower => follower.accountId === account.id))
            .map(account => newFollower(account.id)),
        ]
        : current.followers.filter(follower => !candidateIds.has(follower.accountId)),
    }));
  };
  const patchFollower = (accountId: number, patch: Partial<CopyFollowerConfig>) => setDraft(current => ({
    ...current,
    followers: current.followers.map(follower => follower.accountId === accountId ? { ...follower, ...patch } : follower),
  }));

  const submit = () => {
    if (saving) return;
    const validation = validateCopyGroup(draft, accounts.map(account => account.id));
    if (!validation.valid) {
      setErrors(copyGroupValidationMessages(validation, accountId => accountLabel(accountId)));
      return;
    }
    setErrors([]);
    void onSave({ ...draft, name: draft.name.trim() }, message => setErrors([message]))
      .catch(reason => setErrors([copyGroupLibraryErrorMessage(reason)]));
  };

  const safety = draft.safety ?? DEFAULT_COPY_GROUP_SAFETY;
  const updateSafety = <K extends keyof CopyGroupSafetySettings>(key: K, value: CopyGroupSafetySettings[K]) => setDraft(current => ({
    ...current,
    safety: { ...(current.safety ?? DEFAULT_COPY_GROUP_SAFETY), [key]: value },
  }));
  const enabledSafetyCount = SAFETY_OPTIONS.filter(([key]) => key === 'disableReplicationOnBreach' || safety[key]).length;
  const sectionLabel = 'text-[9.5px] font-black uppercase tracking-[.1em] text-[var(--text-muted)]';

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="Nastavení kopírovací skupiny" className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-black text-[var(--text-primary)]">{isNew ? 'Vytvořit skupinu' : 'Upravit skupinu'}</h3>
              {tightenOnly ? <span title="dnes jen zpřísnit" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/[0.07] px-2 py-0.5 text-[9px] font-bold text-amber-600"><Lock size={9} /> jen zpřísnit</span> : null}
            </div>
            <div className={`${sectionLabel} mt-2`}>Název skupiny</div>
            {/* Barva patří k názvu — v tabulce LIVE je to jeho tečka. Proto sedí
                v poli, ne jako osm samostatných koleček vedle. */}
            <div className="relative mt-1">
              <div className="relative flex w-[264px] items-center">
                <button
                  type="button" aria-label="Barva skupiny" aria-expanded={paletteOpen}
                  onClick={() => setPaletteOpen(open => !open)}
                  style={{ backgroundColor: draft.color ?? GROUP_COLORS[0] }}
                  className="absolute left-1.5 h-6 w-6 rounded-md"
                />
                <input
                  autoFocus={isNew} value={draft.name} aria-label="Název skupiny"
                  onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                  placeholder="např. Tradeify 50K"
                  className="h-[34px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] pl-[38px] pr-3 text-[13px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500"
                />
              </div>
              {paletteOpen ? (
                <>
                  <button aria-label="Zavřít paletu" className="fixed inset-0 z-[9] cursor-default" onClick={() => setPaletteOpen(false)} />
                  <div className="absolute left-0 top-[calc(100%+6px)] z-10 grid grid-cols-4 gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2 shadow-xl">
                    {GROUP_COLORS.map(color => (
                      <button
                        key={color} type="button" aria-label={`Barva ${color}`} aria-pressed={draft.color === color}
                        onClick={() => { setDraft(current => ({ ...current, color })); setPaletteOpen(false); }}
                        style={{ backgroundColor: color }}
                        className={`h-6 w-6 rounded-full border-2 ${draft.color === color ? 'border-[var(--text-primary)]' : 'border-transparent'}`}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Zavřít" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] disabled:opacity-40"><X size={17} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Leader je jedna volba, tak stojí zvlášť — ne jako šestá možnost v řádku. */}
          <div className="w-full shrink-0 overflow-y-auto border-b border-[var(--border-subtle)] bg-[var(--bg-page)] p-3 md:max-h-none md:w-[250px] md:border-b-0 md:border-r">
            <div className={sectionLabel}>Leader</div>
            <p className="mt-1 text-[10.5px] font-semibold leading-relaxed text-[var(--text-muted)]">Jeden účet, jehož obchody se kopírují. Sám sebe nekopíruje.</p>
            {unavailable.leaderAccountId != null ? (
              <div className="mt-2 flex gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.08] p-2.5 text-amber-700">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <b className="block text-[11px]">Uložený leader {accountLabel(unavailable.leaderAccountId, 'leader')} není dostupný</b>
                  <span className="mt-0.5 block text-[10px] leading-relaxed">Vyber aktuální účet. AlphaTrade náhradu nikdy nehádá.</span>
                </div>
              </div>
            ) : null}
            <div className="mt-2 space-y-1">
              {accounts.map(account => {
                const active = draft.leaderAccountId === account.id;
                const blocked = tightenOnly && baselineHasFollowerCut && !active;
                return (
                  <button
                    key={account.id} type="button" disabled={blocked} aria-pressed={active}
                    title={blocked ? 'dnes jen zpřísnit' : undefined}
                    onClick={() => chooseLeader(account.id)}
                    className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
                      active ? 'border-amber-500/55 bg-amber-500/[0.12]' : 'border-transparent hover:bg-[var(--bg-card)]'
                    }`}
                  >
                    {/* V kolečku je firma účtu — ta ho odliší na první pohled.
                        Korunka je odznak role, ne ikona účtu, tak sedí v rohu
                        a svítí jen u vybraného leadera. */}
                    <span className="relative shrink-0">
                      <FirmMark firm={account.firm} />
                      {active ? (
                        <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-amber-950 ring-2 ring-[var(--bg-page)]">
                          <Crown size={8} />
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0">
                      <b className="block truncate text-[11px] font-bold text-[var(--text-primary)]">{account.name}</b>
                      <span className="block truncate text-[9.5px] text-[var(--text-secondary)]">{account.firm} · {money.format(account.balance)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 pb-2">
              <span className={sectionLabel}>
                Followeři — {selectedCount} vybráno{draft.leaderAccountId != null ? ` · expozice ${copyGroupExposureMultiple(draft)}× leadera` : ''}
              </span>
              <span className="flex gap-1">
                <button
                  type="button" disabled={allFollowersSelected || selectableFollowerCandidates.length === 0}
                  title={tightenOnly && baselineHasFollowerCut ? 'dnes jen zpřísnit' : undefined}
                  onClick={() => selectAllFollowers(true)}
                  className="rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[10.5px] font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                >Označit vše</button>
                <button
                  type="button" disabled={selectedCount === 0} onClick={() => selectAllFollowers(false)}
                  className="rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[10.5px] font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                >Odebrat vše</button>
              </span>
            </div>

            {unavailableFollowers.length > 0 ? (
              <div className="mb-2.5 rounded-lg border border-amber-500/35 bg-amber-500/[0.07] p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex gap-2.5">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                    <div>
                      <b className="block text-xs text-amber-700">Nedostupné účty v uložené skupině</b>
                      <span className="mt-0.5 block text-[11px] text-amber-700/80">Vyber přesnou náhradu z OAuth snapshotu, nebo starý účet odeber. Nic se nepáruje automaticky.</span>
                    </div>
                  </div>
                  <button type="button" disabled={saving} onClick={() => onRemoveUnavailableFollowers(draft, unavailableFollowers.map(follower => follower.accountId))} className="h-9 rounded-md bg-amber-600 px-3 text-xs font-black text-white hover:bg-amber-500 disabled:opacity-50">Odebrat všechny nedostupné</button>
                </div>
                <div className="mt-3 space-y-2">
                  {unavailableFollowers.map(follower => {
                    const replacementCandidates = accounts.filter(account => account.id !== draft.leaderAccountId && !draft.followers.some(item => item.accountId === account.id));
                    return (
                      <div key={follower.accountId} className="grid gap-2 rounded-md border border-amber-500/20 bg-[var(--bg-card)] p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(190px,1fr)_auto] sm:items-center">
                        <span>
                          <b className="block text-xs text-[var(--text-primary)]">{accountLabel(follower.accountId, 'follower')}</b>
                          <span className="block text-[10px] text-[var(--text-secondary)]">{REPLICATION_MODES.find(mode => mode.value === follower.mode)?.label ?? follower.mode} · násobek {follower.multiplier}</span>
                        </span>
                        <select
                          aria-label={`Nahradit nedostupný účet ${follower.accountId}`} defaultValue=""
                          disabled={tightenOnly && baselineHasFollowerCut}
                          title={tightenOnly && baselineHasFollowerCut ? 'dnes jen zpřísnit' : undefined}
                          onChange={event => {
                            const replacementId = Number(event.target.value);
                            if (!Number.isSafeInteger(replacementId)) return;
                            setDraft(current => replaceCopyGroupFollowerAccount(current, follower.accountId, replacementId));
                            if (follower.multiplier !== 1 || follower.maxContracts != null) setReplacementNotice(`Náhradní účet ${accountLabel(replacementId, 'follower')} dostal bezpečný násobek 1× bez Max limitu. Původní nastavení účtu ${accountLabel(follower.accountId, 'follower')} se záměrně nepřeneslo; případnou změnu nastav ručně a zkontroluj v přehledu před uložením.`);
                          }}
                          className="h-9 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <option value="">Vyber náhradu…</option>
                          {replacementCandidates.map(account => <option key={account.id} value={account.id}>{account.name} · {account.firm}</option>)}
                        </select>
                        <button type="button" onClick={() => setDraft(current => ({ ...current, followers: current.followers.filter(item => item.accountId !== follower.accountId) }))} className="h-9 rounded-md border border-rose-500/25 px-3 text-xs font-bold text-rose-500 hover:bg-rose-500/10">Odebrat</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
              <div className="grid min-w-[416px] grid-cols-[minmax(0,1fr)_132px_74px_74px] gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 py-2 text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">
                <span>Účet</span><span>Replikace</span><span className="text-right">Násobek</span>
                <span className="text-right" title="Tvrdý strop expozice; překročení odmítne celý příkaz a odzbrojí copier">Max</span>
              </div>
              {followerCandidates.map(account => {
                const follower = followerById.get(account.id);
                const baselineFollower = baselineFollowers.get(account.id);
                const addBlocked = !follower && followerAdditionBlocked(account.id);
                return (
                  <div key={account.id} className={`grid min-w-[416px] grid-cols-[minmax(0,1fr)_132px_74px_74px] items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5 last:border-0 ${follower ? 'bg-indigo-500/[0.035]' : ''}`}>
                    <label title={addBlocked ? 'dnes jen zpřísnit' : undefined} className={`flex min-w-0 items-center gap-2.5 ${addBlocked ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={!!follower} disabled={addBlocked} onChange={() => toggleFollower(account.id)} className="h-3.5 w-3.5 shrink-0 accent-indigo-600" />
                      <span className="min-w-0">
                        <b className="block truncate text-[11.5px] text-[var(--text-primary)]">{account.name}</b>
                        <span className="block truncate text-[10px] text-[var(--text-secondary)]">{account.firm} · {money.format(account.balance)}</span>
                      </span>
                    </label>
                    {/* Nativní šipka selectu je jediný prvek, který v tabulce
                        vypadá jako z jiné appky; kreslíme si ji sami. */}
                    <span className={`relative inline-flex items-center ${follower ? '' : 'opacity-35'}`}>
                      <select
                        disabled={!follower} aria-label={`Replikace ${account.name}`}
                        value={follower?.mode ?? 'on-submit'}
                        onChange={event => patchFollower(account.id, { mode: event.target.value as ReplicationMode })}
                        className="h-7 w-full appearance-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] pl-2 pr-6 text-[11px] font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500"
                      >
                        {REPLICATION_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                      </select>
                      <ChevronDown size={11} className="pointer-events-none absolute right-2 text-[var(--text-muted)]" />
                    </span>
                    <span className="flex justify-end">
                      <NumberStepper
                        ariaLabel={`Násobek ${account.name}`} disabled={!follower}
                        title={tightenOnly && baselineFollower ? 'dnes jen zpřísnit' : undefined}
                        value={follower?.multiplier ?? 1} step={0.25} min={0.25}
                        max={tightenOnly && baselineFollower ? baselineFollower.multiplier : undefined}
                        suffix="×"
                        onChange={next => patchFollower(account.id, { multiplier: next ?? 0.25 })}
                      />
                    </span>
                    <span className="flex justify-end">
                      <NumberStepper
                        ariaLabel={`Max kontrakty ${account.name}`} disabled={!follower} nullable
                        title={tightenOnly && baselineFollower?.maxContracts != null ? 'dnes jen zpřísnit' : 'Tvrdý strop expozice na symbol; překročení odmítne celý příkaz a odzbrojí copier; ∞ = bez limitu'}
                        value={follower?.maxContracts ?? null} step={1} min={1}
                        max={tightenOnly ? baselineFollower?.maxContracts : undefined}
                        onChange={next => patchFollower(account.id, { maxContracts: next ?? undefined })}
                      />
                    </span>
                  </div>
                );
              })}
            </div>

            <details className="mt-3">
              <summary className={`${sectionLabel} cursor-pointer`}>Ochrany kopírování — {enabledSafetyCount}/{SAFETY_OPTIONS.length} zapnuto</summary>
              <div className="mt-2 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg border border-[var(--border-subtle)]">
                {SAFETY_OPTIONS.map(([key, title, detail]) => {
                  const mandatory = key === 'disableReplicationOnBreach';
                  return (
                    <label key={key} className={`flex items-start gap-3 px-3.5 py-2.5 ${mandatory ? 'cursor-not-allowed bg-emerald-500/[0.025]' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={mandatory ? true : safety[key]} disabled={mandatory} onChange={event => updateSafety(key, event.target.checked)} className="mt-0.5 accent-indigo-600" />
                      <span>
                        <b className="block text-[11.5px] text-[var(--text-primary)]">{title}{mandatory ? <span className="ml-2 text-[9px] uppercase text-emerald-600">Povinné</span> : null}</b>
                        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[var(--text-secondary)]">{detail}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045] px-3.5 py-2.5">
                <Clock3 size={14} className="mt-0.5 shrink-0 text-indigo-500" />
                <span>
                  <b className="block text-[11.5px] text-[var(--text-primary)]">Pravidla dne jsou v záložce Risk</b>
                  <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[var(--text-secondary)]">Denní limity, akce pravidel, obchodní okno, cooldown a expiraci LIVE session nastavíš na jedné kartě. Po prvním ARM v session jdou pravidla už jen zpřísnit.</span>
                </span>
              </div>
            </details>

            <details open className="mt-2.5">
              <summary className={`${sectionLabel} cursor-pointer`}>Změny proti uložené skupině</summary>
              <div className="mt-2"><CopyGroupChangePreview saved={group} draft={draft} accountLabel={accountLabel} /></div>
              <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045] px-3.5 py-2.5">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-indigo-500" />
                <span className="text-[10.5px] leading-relaxed text-[var(--text-secondary)]">Uložením se kopírka nezapíná. Skupinu můžeš z jejího menu zvolit jako jedinou execution skupinu; runtime po přepnutí zůstane VYPNUTO až do samostatného zapnutí.</span>
              </div>
            </details>

            {replacementNotice ? <div role="status" className="mt-2.5 rounded-md border border-amber-500/30 bg-amber-500/[0.08] p-3 text-[11px] font-bold leading-relaxed text-amber-700"><AlertTriangle size={14} className="mr-2 inline-block align-text-bottom" />{replacementNotice}</div> : null}
            {errors.length > 0 ? (
              <div className="mt-2.5 flex gap-2.5 rounded-md border border-rose-500/25 bg-rose-500/8 p-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-500" />
                <div className="space-y-1">{errors.map(error => <div key={error} className="text-[11px] font-bold text-rose-500">{error}</div>)}</div>
              </div>
            ) : null}
          </div>
        </div>

        {libraryState !== 'ready' ? (
          <div role="status" className="mx-5 mb-3 rounded-md border border-amber-500/30 bg-amber-500/[0.08] p-3 text-xs leading-relaxed text-[var(--text-primary)]">
            <p className="font-bold">{libraryState === 'needs-import'
              ? 'Nejdřív potvrď import lokálních skupin do cloudu.'
              : libraryError ?? 'Cloudová knihovna se ještě načítá.'}</p>
            <p className="mt-1 text-[var(--text-secondary)]">Rozepsané údaje zůstávají v tomto formuláři. Stránku nemusíš obnovovat.</p>
          </div>
        ) : null}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-5 py-3.5">
          <div>{onDelete ? <button onClick={onDelete} disabled={saving} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-rose-500 hover:bg-rose-500/10"><Trash2 size={14} /> Smazat skupinu</button> : null}</div>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="h-9 rounded-lg border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zrušit</button>
            <button onClick={submit} disabled={saving || libraryState === 'needs-import'} className="flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Save size={14} /> {saving ? (libraryState === 'ready' ? 'Ukládám…' : 'Obnovuji a ukládám…') : libraryState === 'error' || libraryState === 'loading' ? 'Znovu načíst a uložit' : isNew ? 'Vytvořit skupinu' : 'Uložit změny'}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
};

type SettingsSection = 'accounts' | 'groups' | 'orders' | 'privacy' | 'safety';

const REDACTION_SAMPLE = 'APEX-184920';

export const TableSettingsDialog = ({ hiddenColumns, hiddenGroupColumns, hiddenOrderColumns, columnOrder, redaction, confirmRearmAfterFlatten, onMoveColumn, onRedaction, onConfirmRearmAfterFlatten, onToggleColumn, onToggleGroupColumn, onToggleOrderColumn, onReset, onClose }: {
  hiddenColumns: Set<AccountColumnKey>;
  hiddenGroupColumns: Set<GroupColumnKey>;
  hiddenOrderColumns: Set<OrderColumnKey>;
  columnOrder: ColumnOrderState;
  redaction: RedactionSettings;
  confirmRearmAfterFlatten: boolean;
  onMoveColumn: (table: keyof ColumnOrderState, from: number, to: number) => void;
  onRedaction: (value: RedactionSettings) => void;
  onConfirmRearmAfterFlatten: (value: boolean) => void;
  onToggleColumn: (key: AccountColumnKey) => void;
  onToggleGroupColumn: (key: GroupColumnKey) => void;
  onToggleOrderColumn: (key: OrderColumnKey) => void;
  onReset: () => void;
  onClose: () => void;
}) => {
  const [section, setSection] = useState<SettingsSection>('accounts');

  const accountLabels = new Map(ACCOUNT_COLUMNS.map(column => [column.key, column]));
  const accountItems: ColumnOrderItem[] = columnOrder.accounts.flatMap(key => {
    const column = accountLabels.get(key);
    if (!column) return [];
    const locked = column.locked === true || key === 'actions';
    return [{ key, label: column.label, visible: locked || !hiddenColumns.has(key), locked }];
  });

  // Název skupiny je kotva řádku — v tabulce stojí před volitelnými sloupci
  // a nikam se nepřesouvá. V seznamu je vidět, aby nebylo záhadou, proč chybí.
  const groupItems: ColumnOrderItem[] = [
    { key: 'name', label: 'Skupina', visible: true, locked: true },
    ...columnOrder.groups.flatMap(key => {
      const column = GROUP_COLUMN_OPTIONS.find(option => option.key === key);
      return column ? [{ key, label: column.label, visible: !hiddenGroupColumns.has(key) }] : [];
    }),
  ];

  const orderItems: ColumnOrderItem[] = columnOrder.orders.flatMap(key => {
    const column = ORDER_COLUMN_OPTIONS.find(option => option.key === key);
    return column ? [{ key, label: column.label, visible: !hiddenOrderColumns.has(key) }] : [];
  });

  const tables = {
    accounts: { label: 'Účty', items: accountItems, offset: 0, toggle: (key: string) => onToggleColumn(key as AccountColumnKey) },
    groups: { label: 'Skupiny', items: groupItems, offset: 1, toggle: (key: string) => onToggleGroupColumn(key as GroupColumnKey) },
    orders: { label: 'Příkazy', items: orderItems, offset: 0, toggle: (key: string) => onToggleOrderColumn(key as OrderColumnKey) },
  } as const;

  const showAll = (table: keyof typeof tables) => {
    for (const item of tables[table].items) {
      if (!item.locked && !item.visible) tables[table].toggle(item.key);
    }
  };

  const railButton = (key: SettingsSection, label: string, badge?: string) => (
    <button
      key={key}
      type="button"
      aria-current={section === key}
      onClick={() => setSection(key)}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-[7px] text-left text-xs transition-colors ${
        section === key
          ? 'bg-indigo-500/12 font-black text-indigo-500'
          : 'font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span>{label}</span>
      {badge ? <span className="text-[9.5px] font-bold tabular-nums opacity-75">{badge}</span> : null}
    </button>
  );

  const table = section === 'privacy' || section === 'safety' ? null : tables[section];
  const redacted = redactAccountName(REDACTION_SAMPLE, true, redaction);

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="Nastavení tabulky" className="flex max-h-[90vh] w-full max-w-[700px] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div>
            <h3 className="text-base font-black text-[var(--text-primary)]">Nastavení tabulky</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Co vidíš na záložce LIVE a v jakém pořadí.</p>
          </div>
          <button aria-label="Zavřít" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-page)]"><X size={17} /></button>
        </header>

        {/* Pevná výška: přepnutí sekce nemá dialogem poskočit pod kurzorem. */}
        <div className="grid h-[388px] grid-cols-[168px_1fr]">
          <nav className="border-r border-[var(--border-subtle)] bg-[var(--bg-page)] p-2">
            <div className="px-2.5 pb-1 pt-2 text-[9px] font-black uppercase tracking-[.12em] text-[var(--text-muted)]">Sloupce</div>
            {(['accounts', 'groups', 'orders'] as const).map(key => railButton(
              key,
              tables[key].label,
              `${tables[key].items.filter(item => item.visible).length}/${tables[key].items.length}`,
            ))}
            <div className="px-2.5 pb-1 pt-3 text-[9px] font-black uppercase tracking-[.12em] text-[var(--text-muted)]">Ostatní</div>
            {railButton('privacy', 'Soukromí')}
            {railButton('safety', 'Bezpečnost')}
          </nav>

          <div className="flex min-w-0 flex-col p-3">
            {table ? (
              <>
                <div className="flex items-center justify-between gap-3 px-1.5 pb-2">
                  <span className="text-[10.5px] font-semibold text-[var(--text-muted)]">Pořadí změníš přetažením za úchyt</span>
                  <button type="button" onClick={() => showAll(section as keyof typeof tables)} className="rounded-md px-2 py-1 text-[11px] font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]">Zobrazit vše</button>
                </div>
                <div className="max-h-[336px] overflow-y-auto px-1.5">
                  <ColumnOrderList
                    tableKey={section}
                    items={table.items}
                    onMove={(from, to) => onMoveColumn(section as keyof ColumnOrderState, from - table.offset, to - table.offset)}
                    onToggle={table.toggle}
                  />
                </div>
              </>
            ) : section === 'privacy' ? (
              <div className="space-y-3 p-1.5">
                <div className="rounded-lg border border-[var(--border-subtle)] p-3">
                  <div className="text-xs font-black text-[var(--text-primary)]">Skrývání názvů účtů</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">Kolik znaků zůstane vidět na začátku a na konci, když si zapneš skrývání. Zbytek nahradí tečky.</p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="space-y-1.5"><span className="block text-[10px] font-bold text-[var(--text-secondary)]">Znaků na začátku</span><input aria-label="Viditelné znaky na začátku" type="number" min="0" max="12" value={redaction.visibleStart} onChange={event => onRedaction({ ...redaction, visibleStart: Math.max(0, Number(event.target.value)) })} className="h-8 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]" /></label>
                    <label className="space-y-1.5"><span className="block text-[10px] font-bold text-[var(--text-secondary)]">Znaků na konci</span><input aria-label="Viditelné znaky na konci" type="number" min="0" max="12" value={redaction.visibleEnd} onChange={event => onRedaction({ ...redaction, visibleEnd: Math.max(0, Number(event.target.value)) })} className="h-8 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2 text-xs font-bold text-[var(--text-primary)]" /></label>
                  </div>
                  <div className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-2.5 py-2 font-mono text-[11px] text-[var(--text-secondary)]">{REDACTION_SAMPLE} → {redacted}</div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-1.5">
                <label className="flex items-start gap-2.5 rounded-lg border border-[var(--border-subtle)] p-3">
                  <input type="checkbox" checked={confirmRearmAfterFlatten} onChange={event => onConfirmRearmAfterFlatten(event.target.checked)} className="mt-0.5 accent-indigo-600" />
                  <span>
                    <span className="block text-xs font-black text-[var(--text-primary)]">Po Flatten All nabídnout zapnutí a pokračovat</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-secondary)]">Flatten All kopírku vždy vypne. S touhle volbou se po uzavření pozic zeptáme, jestli ji rovnou zapnout zpátky — bez ní zůstane vypnutá, dokud ji nezapneš sám.</span>
                  </span>
                </label>
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] px-5 py-3.5">
          <button onClick={onReset} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-page)]"><RotateCcw size={13} /> Obnovit výchozí</button>
          <button onClick={onClose} className="h-9 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white">Hotovo</button>
        </footer>
      </section>
    </div>, document.body,
  );
};

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
                <p className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  Pravidla dne nejsou součástí topologické šablony. Upravují se pouze v záložce Risk, aby je použití šablony tiše nepřepsalo.
                </p>
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

export const UnavailableFollowerRemovalDialog = ({ state, accountLabel, busy, onClose, onEdit, onConfirm, onArm }: {
  state: PendingUnavailableFollowerRemoval;
  accountLabel: (accountId: number, role?: CopyTradeAccountRole) => string;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onConfirm: (plan: UnavailableFollowerRemovalPlan) => void;
  onArm?: () => void;
}) => {
  const title = state.ownershipWaiverStep
    ? 'Převzít odpovědnost za neověřenou kopii?'
    : state.source === 'arm' ? 'Skupinu nelze zapnout' : 'Odebrat nedostupné účty?';
  const removedLabels = state.plan?.missingOptionalAccountIds
    .map(accountId => accountLabel(accountId, 'follower')) ?? [];
  const leaderLabel = state.leaderUnavailableAccountId == null
    ? null
    : accountLabel(state.leaderUnavailableAccountId, 'leader');

  return (
    <section role="alertdialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-2xl">
      <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${state.savedSuccessfully ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
        {state.savedSuccessfully ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}
      </div>
      <h3 className="mt-4 text-lg font-black text-[var(--text-primary)]">{state.savedSuccessfully ? 'Nedostupné účty byly odebrány' : title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
        {state.savedSuccessfully
          ? 'Skupina je uložená a copier zůstává VYPNUTÝ. Zapnutí je vždy samostatný krok.'
          : state.ownershipWaiverStep && state.plan
            ? state.plan.ownershipWarnings.flatMap(item => item.epochIds.map(epochId => (
              `Účet ${item.accountId} může držet neověřenou kopii z epochy ${epochId}; potvrď převzetí odpovědnosti.`
            ))).join(' ')
          : leaderLabel
            ? `Leader ${leaderLabel} není v aktuálním OAuth snapshotu. Leader se jedním klikem nikdy nemění ani nemaže; vyber ho ručně v editoru skupiny.`
            : `Ze skupiny ${state.saved.name} se odebere ${removedLabels.join(', ')}. Žádný náhradní účet se nebude automaticky hledat a copier se nezapne.`}
      </p>

      {state.plan ? (
        <div className="mt-4">
          <CopyGroupChangePreview saved={state.saved} draft={state.plan.group} accountLabel={accountLabel} />
        </div>
      ) : null}

      {state.error ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2.5 text-xs font-bold leading-relaxed text-rose-600">
          {state.error} Změna nebyla uložena. Spusť Kontrolu pozic a zkus znovu.
        </div>
      ) : null}

      {!state.savedSuccessfully && state.plan ? (
        <div className={`mt-4 rounded-xl border px-3 py-2.5 text-[11px] font-bold ${state.ownershipWaiverStep ? 'border-rose-500/30 bg-rose-500/[0.07] text-rose-600' : 'border-blue-500/15 bg-blue-500/[0.055] text-blue-600'}`}>
          {state.ownershipWaiverStep
            ? 'Stav tohoto účtu nelze přes OAuth ověřit. Odebrání ukončí durable ownership marker bez potvrzení, že je broker účet flat. AlphaTrade neodešle žádný obchod.'
            : 'Po potvrzení se odešle stejný příkaz Update group jako z editoru. Execution agent chybějící odebírané followery předá do reconfigure jako missingOptionalAccountIds.'}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {state.savedSuccessfully ? (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zavřít</button>
            {onArm ? <button type="button" onClick={onArm} disabled={busy} className="h-10 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white hover:bg-emerald-500 disabled:opacity-50">Zapnout</button> : null}
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zavřít</button>
            <button type="button" onClick={onEdit} disabled={busy} className="h-10 rounded-xl border border-indigo-500/25 px-4 text-xs font-black text-indigo-600 hover:bg-indigo-500/[0.06] disabled:opacity-50">Otevřít Edit group</button>
            {state.plan ? <button type="button" onClick={() => onConfirm(state.plan as UnavailableFollowerRemovalPlan)} disabled={busy} className={`h-10 rounded-xl px-4 text-xs font-black text-white disabled:opacity-50 ${state.ownershipWaiverStep ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>{busy ? 'Ukládám…' : state.ownershipWaiverStep ? 'Přebírám odpovědnost a odebírám' : 'Odebrat nedostupné účty a uložit'}</button> : null}
          </>
        )}
      </div>
    </section>
  );
};

const UnavailableFollowerRemovalDialogPortal = (props: React.ComponentProps<typeof UnavailableFollowerRemovalDialog>) => createPortal(
  <div className="fixed inset-0 z-[165] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !props.busy) props.onClose(); }}>
    <UnavailableFollowerRemovalDialog {...props} />
  </div>,
  document.body,
);

const ConfirmActionDialog = ({ action, busy, apiReady, onClose, onConfirm }: { action: PendingAction; busy: boolean; apiReady: boolean; onClose: () => void; onConfirm: () => void }) => createPortal(
  <div className="fixed inset-0 z-[160] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl p-5">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${action.danger ? 'bg-rose-500/10 text-rose-500' : 'bg-indigo-500/10 text-indigo-500'}`}>{action.danger ? <AlertTriangle size={21} /> : <Power size={21} />}</div>
      <h3 className="text-lg font-black text-[var(--text-primary)] mt-4">{action.title}</h3><p className="text-sm text-[var(--text-secondary)] mt-1.5 leading-relaxed">{action.detail}</p>
      {action.blocked ? (
        <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5 text-[11px] font-bold text-rose-600">
          {action.outcomeRejected
            ? 'Tímto požadavkem se kopírka nezapnula. Požadavek se automaticky neopakuje.'
            : action.outcomeUnknown
            ? 'Výsledek akce není ověřený. Příkaz se automaticky neopakuje; zkontroluj aktuální stav kopírky.'
            : 'Žádný brokerový příkaz ani změna runtime nebyly odeslány.'}
        </div>
      ) : !action.run ? (
        <div className={`rounded-xl border px-3 py-2.5 text-[11px] font-bold mt-4 ${apiReady ? 'border-emerald-500/15 bg-emerald-500/[0.055] text-emerald-600' : 'border-blue-500/15 bg-blue-500/[0.055] text-blue-500'}`}>
          {apiReady
            ? 'Execution adaptér je připojen. Potvrzená akce bude předána lokálnímu DEMO runtime.'
            : 'Bez připojeného execution adaptéru se akce pouze uloží lokálně a žádný brokerový příkaz se neodešle.'}
        </div>
      ) : null}
      <div className="flex justify-end gap-2 mt-5">
        {!action.blocked ? <button onClick={onClose} disabled={busy} className="h-10 px-4 rounded-xl border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)]">Zrušit</button> : null}
        <button onClick={onConfirm} disabled={busy} className={`h-10 px-4 rounded-xl text-white text-xs font-bold disabled:opacity-50 ${action.danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>{busy ? 'Připravuji…' : action.confirmLabel}</button>
      </div>
    </section>
  </div>, document.body,
);

const CopyTradingHelpDialog = ({ onClose, apiReady }: { onClose: () => void; apiReady: boolean }) => createPortal(
  <div className="fixed inset-0 z-[150] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" className="w-full max-w-lg rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl overflow-hidden">
      <header className="p-5 border-b border-[var(--border-subtle)] flex items-center justify-between"><div><div className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-500">LIVE CONTROL</div><h3 className="text-lg font-black text-[var(--text-primary)] mt-1">Připravenost funkcí</h3></div><button onClick={onClose} className="w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-page)] flex items-center justify-center"><X size={18} /></button></header>
      <div className="p-5 space-y-3">
        {[['Skupiny a účty', 'Vytvoření, leader, followeři, režim On Submit / On Fill a multiplier.'], ['Řízení rizika', 'Enable/Disable, Flatten účtu a Flatten All s povinným potvrzením.'], ['Příkazy', 'Skupinové ordery, refresh a příprava zrušení pracovního příkazu.'], ['Pohled', 'Skrývání sloupců, offline skupin, rozbalení a lokální uložení konfigurace.']].map(([title, detail]) => <div key={title} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-3.5 flex gap-3"><CheckCircle2 size={17} className="text-emerald-500 shrink-0 mt-0.5" /><div><div className="text-xs font-black text-[var(--text-primary)]">{title}</div><div className="text-[11px] text-[var(--text-secondary)] mt-1 leading-relaxed">{detail}</div></div></div>)}
        <div className={`rounded-md border p-3.5 flex gap-3 ${apiReady ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}><SlidersHorizontal size={17} className={apiReady ? 'text-emerald-500' : 'text-amber-500'} /><div><div className="text-xs font-black text-[var(--text-primary)]">{apiReady ? 'Execution adapter připojen' : 'Lokální přípravný režim'}</div><div className="text-[11px] text-[var(--text-secondary)] mt-1">{apiReady ? 'Příkazy lze předat připojenému broker adaptéru až po explicitním zapnutí.' : 'UI je kompletní, ale žádné akce se neposílají brokerovi.'}</div></div></div>
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

/** Zbývající prostor k uživatelsky potvrzenému DLL, včetně otevřeného P&L. */
/**
 * Kolikanásobek leaderovy pozice skupina otevře. Follower s replikací
 * „Vypnuto“ se nepočítá — je ve skupině, ale nic neodešle.
 *
 * Číslo je jen orientační součet pro uživatele; o skutečné velikosti rozhoduje
 * runtime podle Max limitů a způsobilosti účtů.
 */
export const copyGroupExposureMultiple = (group: Pick<CopyGroupConfig, 'followers'>): number =>
  Math.round(group.followers.reduce(
    (sum, follower) => sum + (follower.mode === 'off' ? 0 : follower.multiplier), 0,
  ) * 100) / 100;

export const copyTradeDailyLossRemaining = (account: Pick<LiveAccount, 'dailyLossLimit' | 'realizedPnl' | 'unrealizedPnl'>): number | null => {
  const limit = account.dailyLossLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null;
  const currentDailyPnl = account.realizedPnl + account.unrealizedPnl;
  return Number.isFinite(currentDailyPnl) ? limit + currentDailyPnl : null;
};

const dllRemainingClass = (remaining: number, limit: number | null | undefined) => {
  if (remaining <= 0) return 'text-rose-500';
  if (limit != null && Number.isFinite(limit) && remaining <= limit * 0.25) return 'text-amber-500';
  return 'text-emerald-500/80';
};

/** Vzdálenost k drawdownu: nízká = blízko limitu, proto červená. */
const cushionClass = (v: number | null) => {
  if (v == null) return 'text-[var(--text-secondary)]';
  if (v < 1000) return 'text-rose-500';
  return 'text-emerald-500/80';
};

export default LiveCopyTradeOverview;
