import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, Crown, Plus, HelpCircle, Settings2, Eye, MoreVertical,
  RefreshCw, Inbox, Check, Columns3, RotateCcw, X, Save, Trash2, Power,
  EyeOff, AlertTriangle, CheckCircle2, Users, SlidersHorizontal,
} from 'lucide-react';
import type { LiveAccount, LiveGroup, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';
import {
  copyGroupsFromSnapshot,
  createLocalCopyGroupId,
  mergeCopyGroups,
  normalizeMultiplier,
  sanitizeCopyGroups,
  validateCopyGroup,
  type CopyGroupConfig,
  type CopyReplicationMode,
  type LiveCopyTradingAdapter,
  type LiveCopyTradingCommand,
} from '../services/liveCopyTrading';

// Přehled kopírování 1:1 podle obrazovky Copy Trade v Tradecopii — stejné rozvržení,
// stejné sloupce, stejné akce. Dokud nejsou účty připojené přes OAuth, jsou řádky
// tlumené a akce neaktivní; po připojení se rozsvítí bez dalších zásahů do UI.

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Režim replikace follower účtu — hodnoty přebírají chování Tradecopie. */
export type ReplicationMode = CopyReplicationMode;
const REPLICATION_LABEL: Record<ReplicationMode, string> = {
  'off': 'Off',
  'on-submit': 'On Submit',
  'on-fill': 'On Fill',
};

// ─── Sloupce tabulky účtů ────────────────────────────────────────────────────
// Datově řízené, aby šly jednotlivé sloupce skrývat. `locked` sloupce skrýt nelze
// — bez názvu účtu by řádky nešlo rozlišit.

export type AccountColumnKey =
  | 'replication' | 'account' | 'broker' | 'firm' | 'balance' | 'positions'
  | 'daily' | 'unreal' | 'distDd' | 'execLimit' | 'qtyMult' | 'actions';

interface ColumnDef {
  key: AccountColumnKey;
  label: string;
  align?: 'right';
  locked?: boolean;
  width?: string;
}

const ACCOUNT_COLUMNS: ColumnDef[] = [
  { key: 'replication', label: 'Replication', width: 'w-[130px]' },
  { key: 'account', label: 'Account', locked: true },
  { key: 'broker', label: 'Broker' },
  { key: 'firm', label: 'Firm' },
  { key: 'balance', label: 'Balance', align: 'right' },
  { key: 'positions', label: 'Positions', align: 'right' },
  { key: 'daily', label: 'Daily P&L', align: 'right' },
  { key: 'unreal', label: 'Unreal P&L', align: 'right' },
  { key: 'distDd', label: 'Dist DD', align: 'right' },
  { key: 'execLimit', label: 'Exec/Limit', align: 'right' },
  { key: 'qtyMult', label: 'Qty/Mult', align: 'right' },
  { key: 'actions', label: 'Akce', align: 'right' },
];

const COLUMNS_STORAGE_KEY = 'alphatrade_live_copytrade_columns';
const GROUPS_STORAGE_KEY = 'alphatrade_live_copytrade_draft_groups';

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

interface Props {
  snapshot: LiveSnapshot;
  orders?: LiveOrder[];
  onAccount?: (account: LiveAccount) => void;
  onRefreshOrders?: () => Promise<void> | void;
  commandAdapter?: LiveCopyTradingAdapter;
}

interface PendingAction {
  title: string;
  detail: string;
  confirmLabel: string;
  danger?: boolean;
  command: LiveCopyTradingCommand;
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
  orders = [],
  onAccount,
  onRefreshOrders,
  commandAdapter,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(snapshot.groups.map(g => g.id)));
  const [groupTab, setGroupTab] = useState<Record<string, 'accounts' | 'orders'>>({});
  const [apiPanelOpen, setApiPanelOpen] = useState(true);
  const [hiddenColumns, setHiddenColumns] = useState<Set<AccountColumnKey>>(loadHiddenColumns);
  const [groups, setGroups] = useState<CopyGroupConfig[]>(() => loadDraftGroups(snapshot));
  const [editorGroup, setEditorGroup] = useState<CopyGroupConfig | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [hideOffline, setHideOffline] = useState(false);
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Volba sloupců přežívá reload — je to nastavení pohledu, ne stav relace.
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...hiddenColumns]));
    } catch { /* private mode */ }
  }, [hiddenColumns]);

  useEffect(() => {
    setGroups(current => mergeCopyGroups(current, snapshot));
  }, [snapshot]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
    } catch { /* private mode */ }
  }, [groups]);

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
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const accountsById = useMemo(
    () => new Map(snapshot.accounts.map(a => [a.id, a])),
    [snapshot.accounts],
  );
  const connectionByFirm = useMemo(
    () => new Map(snapshot.connections.map(c => [c.firm, c])),
    [snapshot.connections],
  );

  /** Účet je živý jen tehdy, když jeho firma hlásí aktivní připojení. */
  const isLive = (account?: LiveAccount) =>
    !!account && (connectionByFirm.get(account.firm)?.connected ?? false);

  const anyLive = snapshot.accounts.some(isLive);
  const sourceGroupsById = useMemo(() => new Map(snapshot.groups.map(group => [group.id, group])), [snapshot.groups]);

  const runCommand = async (command: LiveCopyTradingCommand, update?: () => void) => {
    const key = command.type === 'flatten-account' || command.type === 'set-replication' || command.type === 'set-multiplier'
      ? `${command.type}-${command.accountId}`
      : 'groupId' in command ? `${command.type}-${command.groupId}` : command.type;
    if (busyCommand) return;
    setBusyCommand(key);
    try {
      if (commandAdapter) await commandAdapter.execute(command);
      update?.();
      setToast({
        tone: commandAdapter ? 'success' : 'info',
        text: commandAdapter ? 'Změna byla potvrzena přes API.' : 'Změna je připravená lokálně. Po OAuth se odešle přes stejné rozhraní.',
      });
    } catch (reason) {
      setToast({ tone: 'error', text: reason instanceof Error ? reason.message : 'Akci se nepodařilo dokončit.' });
    } finally {
      setBusyCommand(null);
    }
  };

  const saveGroup = async (group: CopyGroupConfig) => {
    const exists = groups.some(candidate => candidate.id === group.id);
    const command: LiveCopyTradingCommand = exists ? { type: 'update-group', group } : { type: 'create-group', group };
    await runCommand(command, () => {
      setGroups(current => exists ? current.map(candidate => candidate.id === group.id ? group : candidate) : [...current, group]);
      setExpanded(current => new Set(current).add(group.id));
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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="space-y-5">
      <LivePnlPanel
        open={apiPanelOpen}
        onToggle={() => setApiPanelOpen(v => !v)}
        dataActive={anyLive}
        apiReady={!!commandAdapter}
        onHelp={() => setHelpOpen(true)}
      />

      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-5 lg:px-6 py-4 flex-wrap">
          <h3 className="text-lg font-black text-[var(--text-primary)]">Copy Trading Groups</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditorGroup({
                id: createLocalCopyGroupId(), name: '', enabled: true, leaderAccountId: null,
                followers: [], localOnly: true,
              })}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-500 transition-colors"
            >
              <Plus size={14} /> Add Trading Group
            </button>
            <button onClick={() => setHelpOpen(true)} title="Nápověda" className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center"><HelpCircle size={14} /></button>
            <button onClick={() => setHiddenColumns(new Set())} title="Obnovit sloupce" className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center"><Settings2 size={14} /></button>
            <button onClick={() => setHideOffline(value => !value)} title={hideOffline ? 'Zobrazit offline skupiny' : 'Skrýt offline skupiny'} className={`w-8 h-8 rounded-lg border border-[var(--border-subtle)] flex items-center justify-center ${hideOffline ? 'bg-indigo-500/10 text-indigo-500' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{hideOffline ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button onClick={() => setExpanded(new Set(groups.map(group => group.id)))} title="Rozbalit vše" className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center"><MoreVertical size={14} /></button>
          </div>
        </header>

        {groups.length === 0 ? (
          <div className="px-6 pb-8 pt-2 text-center">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto mb-3">
              <Inbox size={22} />
            </div>
            <p className="text-sm font-bold text-[var(--text-primary)]">Žádné kopírovací skupiny</p>
            <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-md mx-auto">
              Skupiny se načtou z Tradecopie, jakmile budou účty připojené.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead>
                <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-y border-[var(--border-subtle)]">
                  <th className="w-8" />
                  <th className="px-3 py-2.5">Group</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Leader</th>
                  <th className="px-3 py-2.5">Firm</th>
                  <th className="px-3 py-2.5 text-right">Followers</th>
                  <th className="px-3 py-2.5 text-right">Capital</th>
                  <th className="px-3 py-2.5 text-right">Daily P&amp;L</th>
                  <th className="px-3 py-2.5 text-right">Unreal P&amp;L</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {groups.map(group => {
                  const rows = groupRows(group, accountsById, sourceGroupsById.get(group.id));
                  const live = group.enabled && rows.some(r => isLive(r.account));
                  if (hideOffline && !live) return null;
                  const tab = groupTab[group.id] || 'accounts';
                  return (
                    <React.Fragment key={group.id}>
                      <GroupRow
                        group={group} rows={rows} live={live}
                        open={expanded.has(group.id)}
                        onToggle={() => toggleGroup(group.id)}
                        hiddenColumns={hiddenColumns}
                        onToggleColumn={toggleColumn}
                        onResetColumns={() => setHiddenColumns(new Set())}
                        onEdit={() => setEditorGroup(structuredClone(group))}
                        onToggleEnabled={() => setPendingAction({
                          title: group.enabled ? 'Vypnout kopírování skupiny?' : 'Zapnout kopírování skupiny?',
                          detail: group.enabled ? 'Nové příkazy leadera se followerům nezkopírují.' : 'Po připojení API se nové příkazy leadera začnou kopírovat.',
                          confirmLabel: group.enabled ? 'Vypnout' : 'Zapnout',
                          danger: group.enabled,
                          command: { type: 'set-group-enabled', groupId: group.id, enabled: !group.enabled },
                        })}
                        onFlatten={() => setPendingAction({
                          title: 'Flatten All?', detail: `Připraví uzavření všech otevřených pozic ve skupině ${group.name}.`,
                          confirmLabel: 'Flatten All', danger: true, command: { type: 'flatten-group', groupId: group.id },
                        })}
                      />
                      {expanded.has(group.id) && (
                        <tr>
                          <td colSpan={10} className="p-0">
                            <GroupDetail
                              rows={rows} tab={tab} isLive={isLive} onAccount={onAccount}
                              columns={visibleColumns}
                              groupId={group.id}
                              orders={orders}
                              busyCommand={busyCommand}
                              onRefreshOrders={onRefreshOrders}
                              onReplication={(accountId, mode) => {
                                void runCommand({ type: 'set-replication', groupId: group.id, accountId, mode }, () => updateFollower(group.id, accountId, { mode }));
                              }}
                              onMultiplier={(accountId, multiplier) => {
                                void runCommand({ type: 'set-multiplier', groupId: group.id, accountId, multiplier }, () => updateFollower(group.id, accountId, { multiplier }));
                              }}
                              onFlattenAccount={accountId => setPendingAction({
                                title: 'Flatten účet?', detail: 'Připraví uzavření všech otevřených pozic pouze na tomto účtu.',
                                confirmLabel: 'Flatten', danger: true, command: { type: 'flatten-account', groupId: group.id, accountId },
                              })}
                              onCancelOrder={orderId => setPendingAction({
                                title: 'Zrušit příkaz?', detail: 'Připraví zrušení tohoto pracovního příkazu.',
                                confirmLabel: 'Zrušit příkaz', danger: true, command: { type: 'cancel-order', groupId: group.id, orderId },
                              })}
                              onTab={t => setGroupTab(prev => ({ ...prev, [group.id]: t }))}
                            />
                          </td>
                        </tr>
                      )}
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
          onClose={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            const command = action.command;
            void runCommand(command, () => {
              if (command.type === 'set-group-enabled') {
                const { groupId, enabled } = command;
                setGroups(current => current.map(group => group.id === groupId ? { ...group, enabled } : group));
              } else if (command.type === 'delete-group') {
                const { groupId } = command;
                setGroups(current => current.filter(group => group.id !== groupId));
              }
              setPendingAction(null);
            });
          }}
        />
      )}
      {helpOpen && <CopyTradingHelpDialog onClose={() => setHelpOpen(false)} apiReady={!!commandAdapter} />}
      {toast && <StatusToast tone={toast.tone} text={toast.text} />}
    </div>
  );
};

// ─── Live P&L & API Usage ────────────────────────────────────────────────────

const API_LIMITS = [
  { label: 'Per Minute', used: 0, limit: 80, reset: 'Resets every min' },
  { label: 'Hourly', used: 0, limit: 5000, reset: 'Resets 7:00 AM' },
  { label: 'Daily', used: 0, limit: 120000, reset: 'Resets 5:00 PM' },
];

const LivePnlPanel = ({ open, onToggle, dataActive, apiReady, onHelp }: { open: boolean; onToggle: () => void; dataActive: boolean; apiReady: boolean; onHelp: () => void }) => (
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
            {dataActive ? 'Živá data aktivní' : 'Živá data nepřipojena'}
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] mt-1.5 leading-snug">
            {dataActive
              ? apiReady ? 'Real-time P&L i OAuth ovládání jsou aktivní.' : 'Real-time P&L běží. Ovládací OAuth adaptér zatím není připojen.'
              : 'Po připojení účtů poběží real-time P&L a hlídání rizika pro všechny skupiny.'}
          </p>
        </div>

        <div>
          <p className="text-[11px] font-bold text-[var(--text-secondary)] mb-2">tradovate</p>
          <div className="space-y-2.5">
            {API_LIMITS.map(row => (
              <div key={row.label} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-secondary)] w-20 shrink-0">{row.label}</span>
                <div className="flex-1 h-1 rounded-full bg-[var(--border-subtle)] overflow-hidden">
                  <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, (row.used / row.limit) * 100)}%` }} />
                </div>
                <span className="text-xs font-bold tabular-nums text-[var(--text-primary)] w-24 text-right shrink-0">
                  {apiReady ? `${row.used}/${plain.format(row.limit)}` : `—/${plain.format(row.limit)}`}
                </span>
                <span className="text-[10px] text-[var(--text-muted)] w-28 text-right shrink-0 hidden sm:block">{apiReady ? row.reset : 'Čeká na OAuth'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
  </section>
);

// ─── Řádek skupiny ───────────────────────────────────────────────────────────

interface Row {
  account?: LiveAccount;
  name: string;
  isLeader: boolean;
  mode: ReplicationMode;
  scale: number;
  synced: boolean;
}

/** Poskládá leadera a followery do pořadí, v jakém je zobrazuje Tradecopia. */
function groupRows(group: CopyGroupConfig, byId: Map<number, LiveAccount>, source?: LiveGroup): Row[] {
  const rows: Row[] = [];
  const leader = group.leaderAccountId != null ? byId.get(group.leaderAccountId) : undefined;
  rows.push({
    account: leader,
    name: leader?.name || source?.leaderName || 'Bez leadera',
    isLeader: true,
    mode: 'off',
    scale: 1,
    synced: true,
  });
  for (const follower of group.followers) {
    const acc = byId.get(follower.accountId);
    const sourceFollower = source?.followers.find(candidate => candidate.accountId === follower.accountId);
    rows.push({
      account: acc,
      name: acc?.name || sourceFollower?.accountName || `Účet ${follower.accountId}`,
      isLeader: false,
      mode: follower.mode,
      scale: follower.multiplier,
      synced: sourceFollower?.synced ?? true,
    });
  }
  return rows;
}

const GroupRow = ({ group, rows, live, open, onToggle, hiddenColumns, onToggleColumn, onResetColumns, onEdit, onToggleEnabled, onFlatten }: {
  group: CopyGroupConfig; rows: Row[]; live: boolean; open: boolean; onToggle: () => void;
  hiddenColumns: Set<AccountColumnKey>;
  onToggleColumn: (key: AccountColumnKey) => void;
  onResetColumns: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onFlatten: () => void;
}) => {
  const capital = rows.reduce((s, r) => s + (r.account?.balance || 0), 0);
  const daily = rows.reduce((s, r) => s + (r.account?.realizedPnl || 0), 0);
  const unreal = rows.reduce((s, r) => s + (r.account?.unrealizedPnl || 0), 0);
  const firm = rows.find(r => r.isLeader)?.account?.firm;

  return (
    <tr className={`border-b border-[var(--border-subtle)] ${live ? '' : 'opacity-60'}`}>
      <td className="pl-3">
        <button onClick={onToggle} className="w-6 h-6 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </td>
      <td className="px-3 py-3">
        <span className="text-sm font-bold text-indigo-500">{group.name}</span>
      </td>
      <td className="px-3 py-3">
        <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide ${live ? 'bg-emerald-500/12 text-emerald-500' : 'bg-[var(--border-subtle)] text-[var(--text-muted)]'}`}>
          {live ? 'Active' : 'Offline'}
        </span>
      </td>
      <td className="px-3 py-3">
        <span className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
          <Crown size={13} className="text-amber-400 shrink-0" />
          <span className="truncate max-w-[180px]">{rows.find(r => r.isLeader)?.name}</span>
        </span>
      </td>
      <td className="px-3 py-3 text-xs text-[var(--text-secondary)] truncate max-w-[110px]">{firm || '—'}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums text-[var(--text-primary)]">{group.followers.length}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums text-[var(--text-primary)]">{money.format(capital)}</td>
      <td className={`px-3 py-3 text-right text-sm tabular-nums font-bold ${pnlClass(daily)}`}>{money.format(daily)}</td>
      <td className={`px-3 py-3 text-right text-sm tabular-nums font-bold ${pnlClass(unreal)}`}>{money.format(unreal)}</td>
      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <button onClick={onToggleEnabled} title={group.enabled ? 'Vypnout kopírování' : 'Zapnout kopírování'}
            className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-colors ${group.enabled ? 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-amber-500' : 'border-emerald-500/25 text-emerald-500 bg-emerald-500/5'}`}>
            {group.enabled ? 'Disable' : 'Enable'}
          </button>
          <button onClick={onFlatten} title="Uzavřít všechny pozice ve skupině"
            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold transition-colors">
            Flatten All
          </button>
          <button onClick={onEdit} title="Upravit skupinu" className="w-7 h-7 rounded-lg text-[var(--text-secondary)] hover:text-indigo-500 hover:bg-indigo-500/10 flex items-center justify-center"><Settings2 size={14} /></button>
          <ColumnMenu
            hiddenColumns={hiddenColumns}
            onToggleColumn={onToggleColumn}
            onReset={onResetColumns}
          />
        </div>
      </td>
    </tr>
  );
};

// ─── Menu pro skrývání sloupců ───────────────────────────────────────────────

const ColumnMenu = ({ hiddenColumns, onToggleColumn, onReset }: {
  hiddenColumns: Set<AccountColumnKey>;
  onToggleColumn: (key: AccountColumnKey) => void;
  onReset: () => void;
}) => {
  const [open, setOpen] = useState(false);
  // Pozice se počítá z tlačítka a menu se vykresluje portálem do body — uvnitř
  // tabulky ho ořezával kontejner s horizontálním scrollem.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  // Zavření kliknutím mimo — menu je uvnitř řádku tabulky, takže bez toho
  // by zůstávalo otevřené i po kliknutí jinam.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const hiddenCount = hiddenColumns.size;

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        onClick={e => { e.stopPropagation(); open ? setOpen(false) : openMenu(); }}
        title="Nastavení sloupců"
        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${open || hiddenCount > 0
          ? 'text-indigo-500 bg-indigo-500/10'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
      >
        <MoreVertical size={14} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-[120] w-60 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-xl overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[var(--border-subtle)]">
            <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">
              <Columns3 size={12} /> Sloupce
            </span>
            {hiddenCount > 0 && (
              <button
                onClick={onReset}
                className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-400 transition-colors"
              >
                <RotateCcw size={10} /> Obnovit
              </button>
            )}
          </div>

          <div className="py-1 max-h-80 overflow-y-auto">
            {ACCOUNT_COLUMNS.map(col => {
              const hidden = hiddenColumns.has(col.key);
              return (
                <button
                  key={col.key}
                  disabled={col.locked}
                  onClick={() => onToggleColumn(col.key)}
                  title={col.locked ? 'Název účtu nelze skrýt' : undefined}
                  className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors ${col.locked
                    ? 'text-[var(--text-muted)] cursor-not-allowed'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-app)]'}`}
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${hidden || col.locked
                    ? col.locked ? 'bg-[var(--border-subtle)] border-[var(--border-subtle)]' : 'border-[var(--border-subtle)]'
                    : 'bg-indigo-600 border-indigo-600'}`}>
                    {(!hidden || col.locked) && <Check size={11} className="text-white" strokeWidth={3} />}
                  </span>
                  {col.label}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

// ─── Detail skupiny: Accounts / Orders ───────────────────────────────────────

const GroupDetail = ({ rows, tab, isLive, onTab, onAccount, columns, groupId, orders, busyCommand, onRefreshOrders, onReplication, onMultiplier, onFlattenAccount, onCancelOrder }: {
  rows: Row[];
  tab: 'accounts' | 'orders';
  isLive: (a?: LiveAccount) => boolean;
  onTab: (t: 'accounts' | 'orders') => void;
  onAccount?: (a: LiveAccount) => void;
  columns: ColumnDef[];
  groupId: string;
  orders: LiveOrder[];
  busyCommand: string | null;
  onRefreshOrders?: () => Promise<void> | void;
  onReplication: (accountId: number, mode: ReplicationMode) => void;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlattenAccount: (accountId: number) => void;
  onCancelOrder: (orderId: number) => void;
}) => {
  const accountIds = new Set(rows.flatMap(row => row.account ? [row.account.id] : []));
  const groupOrders = orders.filter(order => order.accountId != null && accountIds.has(order.accountId));
  return (
  <div className="bg-[var(--bg-app)]/40 border-b border-[var(--border-subtle)] px-3 lg:px-5 pb-4">
    <div className="flex items-center justify-between gap-3 pt-3">
      <div className="flex items-center gap-1">
        {(['accounts', 'orders'] as const).map(t => (
          <button
            key={t} onClick={() => onTab(t)}
            className={`px-3 py-2 text-xs font-bold border-b-2 transition-colors ${tab === t
              ? 'border-indigo-500 text-indigo-500'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {t === 'accounts' ? 'Accounts' : 'Orders'}
          </button>
        ))}
      </div>
      {tab === 'orders' && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-[var(--text-muted)]">{groupOrders.filter(order => order.working).length} working</span>
          <button onClick={() => void onRefreshOrders?.()} title="Obnovit příkazy" className="w-7 h-7 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-indigo-500 flex items-center justify-center"><RefreshCw size={13} /></button>
        </div>
      )}
    </div>

    {tab === 'accounts' ? (
      <div className="overflow-x-auto">
        <table className="w-full text-left" style={{ minWidth: `${Math.max(420, columns.length * 92)}px` }}>
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`px-3 py-2 whitespace-nowrap ${col.align === 'right' ? 'text-right' : ''} ${col.width || ''}`}
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
                busyCommand={busyCommand}
                onReplication={onReplication} onMultiplier={onMultiplier} onFlatten={onFlattenAccount}
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
        <div className="overflow-x-auto pt-2">
          <table className="w-full min-w-[760px] text-left">
            <thead><tr className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
              <th className="px-3 py-2">Account</th><th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Side</th><th className="px-3 py-2">Type</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>{groupOrders.map(order => (
              <tr key={`${order.accountId}-${order.id}`} className="border-b border-[var(--border-subtle)] last:border-0 text-xs">
                <td className="px-3 py-2.5 font-bold text-[var(--text-primary)]">{order.accountName}</td>
                <td className="px-3 py-2.5 text-[var(--text-secondary)]">{order.symbol}</td>
                <td className={`px-3 py-2.5 font-bold ${order.action.toLowerCase().includes('buy') ? 'text-emerald-500' : 'text-rose-500'}`}>{order.action}</td>
                <td className="px-3 py-2.5 text-[var(--text-secondary)]">{order.orderType}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{order.quantity}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{order.stopPrice ?? order.price ?? '—'}</td>
                <td className="px-3 py-2.5"><span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase ${order.working ? 'bg-blue-500/10 text-blue-500' : 'bg-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>{order.status}</span></td>
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

const AccountRow = ({ row, live, onAccount, columns, busyCommand, onReplication, onMultiplier, onFlatten }: {
  row: Row; live: boolean; onAccount?: (a: LiveAccount) => void; columns: ColumnDef[];
  busyCommand: string | null;
  onReplication: (accountId: number, mode: ReplicationMode) => void;
  onMultiplier: (accountId: number, multiplier: number) => void;
  onFlatten: (accountId: number) => void;
}) => {
  const a = row.account;
  const cushion = a?.cushion ?? null;

  const cell = (key: AccountColumnKey): React.ReactNode => {
    switch (key) {
      case 'replication':
        return row.isLeader || !a ? (
          <Crown size={15} className="text-amber-400" />
        ) : (
          <label onClick={event => event.stopPropagation()} className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold whitespace-nowrap ${live ? 'border-[var(--border-subtle)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-muted)]'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${row.mode === 'off' ? 'bg-slate-400' : 'bg-rose-500'}`} />
            <select
              aria-label={`Replication ${row.name}`}
              value={row.mode}
              disabled={busyCommand != null}
              onChange={event => onReplication(a.id, event.target.value as ReplicationMode)}
              className="appearance-none bg-transparent pr-3 outline-none cursor-pointer disabled:cursor-wait"
            >
              {Object.entries(REPLICATION_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <ChevronDown size={11} className="opacity-50" />
          </label>
        );
      case 'account':
        return (
          <span className="flex items-center gap-2 text-xs">
            {/* Korunka jen když je sloupec Replication skrytý — jinak by leader
                nešel poznat. */}
            {row.isLeader && !columns.some(c => c.key === 'replication') && (
              <Crown size={12} className="text-amber-400 shrink-0" />
            )}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <span className={`truncate max-w-[190px] ${live ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{row.name}</span>
            {!row.synced && <span title="Nesedí s leaderem" className="text-amber-500">⚠</span>}
          </span>
        );
      case 'broker':
        return <span className="text-[11px] text-[var(--text-secondary)]">Tradovate</span>;
      case 'firm':
        return <span className="text-[11px] text-[var(--text-secondary)] truncate max-w-[110px] inline-block align-middle">{a?.firm || '—'}</span>;
      case 'balance':
        return <span className="text-xs tabular-nums text-[var(--text-primary)]">{a ? money.format(a.balance) : '—'}</span>;
      case 'positions':
        return <span className="text-xs tabular-nums text-[var(--text-secondary)]">{a?.positions.length ? a.positions.length : '—'}</span>;
      case 'daily':
        return <span className={`text-xs tabular-nums ${a ? pnlClass(a.realizedPnl) : ''}`}>{a ? money.format(a.realizedPnl) : '—'}</span>;
      case 'unreal':
        return <span className={`text-xs tabular-nums ${a?.unrealizedPnl ? pnlClass(a.unrealizedPnl) : 'text-[var(--text-secondary)]'}`}>{a?.unrealizedPnl ? money.format(a.unrealizedPnl) : '—'}</span>;
      case 'distDd':
        return <span className={`text-xs tabular-nums font-bold ${cushionClass(cushion)}`}>{cushion != null ? plain.format(cushion) : '—'}</span>;
      case 'execLimit':
        return <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">0/∞</span>;
      case 'qtyMult':
        return row.isLeader || !a
          ? <span className="text-[11px] text-[var(--text-secondary)]">—</span>
          : <label onClick={event => event.stopPropagation()} className="inline-flex items-center justify-end gap-1 text-[11px] text-[var(--text-secondary)]">
              <input
                aria-label={`Multiplier ${row.name}`}
                key={`${a.id}-${row.scale}`}
                type="number" min="0.01" max="100" step="0.25" defaultValue={row.scale}
                disabled={busyCommand != null}
                onBlur={event => onMultiplier(a.id, Number(event.target.value))}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                className="w-14 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-1.5 py-1 text-right tabular-nums outline-none focus:border-indigo-500"
              />
              <span className="text-[9px] uppercase tracking-wide opacity-70">Standard</span>
            </label>;
      case 'actions':
        return null;
    }
  };

  return (
    <tr
      onClick={() => a && onAccount?.(a)}
      className={`border-b border-[var(--border-subtle)] last:border-0 transition-colors ${a ? 'cursor-pointer hover:bg-[var(--bg-card)]' : ''} ${live ? '' : 'opacity-55'}`}
    >
      {columns.map(col => (
        <td key={col.key} className={`px-3 py-2.5 ${col.align === 'right' ? 'text-right' : ''}`}>
          {col.key === 'actions' && a ? (
            <button
              disabled={busyCommand != null}
              onClick={event => { event.stopPropagation(); onFlatten(a.id); }}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] text-[11px] font-bold text-[var(--text-secondary)] hover:text-rose-500 hover:border-rose-500/25 disabled:opacity-40"
            >Flatten</button>
          ) : cell(col.key)}
        </td>
      ))}
    </tr>
  );
};

// ─── Dialogy a lokální command režim ────────────────────────────────────────

const GroupEditorDialog = ({ group, accounts, saving, onClose, onSave, onDelete }: {
  group: CopyGroupConfig;
  accounts: LiveAccount[];
  saving: boolean;
  onClose: () => void;
  onSave: (group: CopyGroupConfig) => void;
  onDelete?: () => void;
}) => {
  const [draft, setDraft] = useState<CopyGroupConfig>(() => structuredClone(group));
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const followerById = new Map(draft.followers.map(follower => [follower.accountId, follower]));
  const toggleFollower = (accountId: number) => {
    setDraft(current => ({
      ...current,
      followers: current.followers.some(follower => follower.accountId === accountId)
        ? current.followers.filter(follower => follower.accountId !== accountId)
        : [...current.followers, { accountId, mode: 'on-submit', multiplier: 1 }],
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

  return createPortal(
    <div className="fixed inset-0 z-[150] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="Nastavení kopírovací skupiny" className="w-full max-w-3xl max-h-[92vh] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl flex flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
          <div><div className="text-[10px] uppercase tracking-[0.18em] font-black text-indigo-500">Copy Trading Group</div><h3 className="text-lg font-black text-[var(--text-primary)] mt-1">{group.localOnly ? 'Nová skupina' : 'Upravit skupinu'}</h3></div>
          <button onClick={onClose} disabled={saving} className="w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] flex items-center justify-center disabled:opacity-40"><X size={18} /></button>
        </header>

        <div className="p-5 overflow-y-auto custom-scrollbar space-y-5">
          <div className="grid sm:grid-cols-[1fr_210px] gap-4">
            <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Název skupiny</span><input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="Např. Hlavní NQ" className="w-full h-11 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-sm font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500" /></label>
            <label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Stav</span><button type="button" onClick={() => setDraft(current => ({ ...current, enabled: !current.enabled }))} className={`w-full h-11 rounded-xl border px-3 flex items-center justify-between text-sm font-bold ${draft.enabled ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-500' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}><span>{draft.enabled ? 'Enabled' : 'Disabled'}</span><span className={`w-9 h-5 rounded-full p-0.5 flex ${draft.enabled ? 'bg-emerald-500 justify-end' : 'bg-[var(--border-subtle)] justify-start'}`}><span className="w-4 h-4 rounded-full bg-white shadow" /></span></button></label>
          </div>

          <label className="space-y-1.5 block"><span className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Leader účet</span><select value={draft.leaderAccountId ?? ''} onChange={event => { const leaderAccountId = event.target.value ? Number(event.target.value) : null; setDraft(current => ({ ...current, leaderAccountId, followers: current.followers.filter(follower => follower.accountId !== leaderAccountId) })); }} className="w-full h-11 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 text-sm font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500"><option value="">Vyber leader účet</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.firm}</option>)}</select></label>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2"><div><div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Follower účty</div><div className="text-[11px] text-[var(--text-muted)] mt-0.5">Vyber účty, režim kopírování a velikost.</div></div><span className="text-[10px] font-black text-indigo-500">{draft.followers.length} vybráno</span></div>
            <div className="rounded-md border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
              {accounts.filter(account => account.id !== draft.leaderAccountId).map(account => {
                const follower = followerById.get(account.id);
                return <div key={account.id} className={`p-3 grid sm:grid-cols-[minmax(0,1fr)_145px_105px] gap-3 items-center ${follower ? 'bg-indigo-500/[0.035]' : ''}`}>
                  <label className="flex items-center gap-2.5 min-w-0 cursor-pointer"><input type="checkbox" checked={!!follower} onChange={() => toggleFollower(account.id)} className="accent-indigo-600" /><span className="min-w-0"><span className="block text-xs font-bold text-[var(--text-primary)] truncate">{account.name}</span><span className="block text-[10px] text-[var(--text-secondary)] truncate">{account.firm} · {money.format(account.balance)}</span></span></label>
                  <select disabled={!follower} value={follower?.mode ?? 'on-submit'} onChange={event => setDraft(current => ({ ...current, followers: current.followers.map(item => item.accountId === account.id ? { ...item, mode: event.target.value as ReplicationMode } : item) }))} className="h-9 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-xs font-bold text-[var(--text-primary)] disabled:opacity-35"><option value="off">Off</option><option value="on-submit">On Submit</option><option value="on-fill">On Fill</option></select>
                  <label className="flex items-center gap-1"><input disabled={!follower} type="number" min="0.01" max="100" step="0.25" value={follower?.multiplier ?? 1} onChange={event => setDraft(current => ({ ...current, followers: current.followers.map(item => item.accountId === account.id ? { ...item, multiplier: Number(event.target.value) } : item) }))} className="w-full h-9 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-right text-xs font-bold text-[var(--text-primary)] disabled:opacity-35" /><span className="text-[10px] text-[var(--text-muted)]">×</span></label>
                </div>;
              })}
            </div>
          </div>

          {errors.length > 0 && <div className="rounded-md border border-rose-500/25 bg-rose-500/8 p-3.5 flex gap-2.5"><AlertTriangle size={17} className="text-rose-500 shrink-0 mt-0.5" /><div className="space-y-1">{errors.map(error => <div key={error} className="text-xs font-bold text-rose-500">{error}</div>)}</div></div>}
        </div>

        <footer className="px-5 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <div>{onDelete && <button onClick={onDelete} disabled={saving} className="h-10 px-3 rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-500/10 flex items-center gap-1.5"><Trash2 size={14} /> Smazat</button>}</div>
          <div className="flex gap-2"><button onClick={onClose} disabled={saving} className="h-10 px-4 rounded-xl border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)]">Zrušit</button><button onClick={submit} disabled={saving} className="h-10 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"><Save size={14} /> {saving ? 'Ukládám…' : 'Uložit skupinu'}</button></div>
        </footer>
      </section>
    </div>,
    document.body,
  );
};

const ConfirmActionDialog = ({ action, busy, onClose, onConfirm }: { action: PendingAction; busy: boolean; onClose: () => void; onConfirm: () => void }) => createPortal(
  <div className="fixed inset-0 z-[160] bg-slate-950/35 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl p-5">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${action.danger ? 'bg-rose-500/10 text-rose-500' : 'bg-indigo-500/10 text-indigo-500'}`}>{action.danger ? <AlertTriangle size={21} /> : <Power size={21} />}</div>
      <h3 className="text-lg font-black text-[var(--text-primary)] mt-4">{action.title}</h3><p className="text-sm text-[var(--text-secondary)] mt-1.5 leading-relaxed">{action.detail}</p>
      <div className="rounded-xl bg-blue-500/[0.055] border border-blue-500/15 px-3 py-2.5 text-[11px] text-blue-500 font-bold mt-4">Bez OAuth se akce pouze připraví lokálně a žádný brokerový příkaz se neodešle.</div>
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
        <div className={`rounded-md border p-3.5 flex gap-3 ${apiReady ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}><SlidersHorizontal size={17} className={apiReady ? 'text-emerald-500' : 'text-amber-500'} /><div><div className="text-xs font-black text-[var(--text-primary)]">{apiReady ? 'OAuth adapter připojen' : 'Lokální přípravný režim'}</div><div className="text-[11px] text-[var(--text-secondary)] mt-1">{apiReady ? 'Příkazy se předávají připojenému API adaptéru.' : 'UI je kompletní, ale žádné akce se neposílají brokerovi.'}</div></div></div>
      </div>
    </section>
  </div>, document.body,
);

const StatusToast = ({ tone, text }: { tone: 'success' | 'info' | 'error'; text: string }) => createPortal(
  <div role="status" className={`fixed z-[180] right-5 bottom-5 max-w-sm rounded-lg border bg-[var(--bg-card)] shadow-xl px-4 py-3 flex items-start gap-2.5 ${tone === 'error' ? 'border-rose-500/30' : tone === 'success' ? 'border-emerald-500/30' : 'border-blue-500/30'}`}>
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
