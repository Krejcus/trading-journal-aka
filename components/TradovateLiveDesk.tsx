import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmActionDialog, { type ConfirmActionOptions } from './ConfirmActionDialog';
import { syncCopierNativeNotifications } from '../services/nativeCopierNotifications';
import {
  buildNativeLiveWidgetState,
  syncNativeLiveWidgetSnapshot,
} from '../services/nativeWidgetSnapshot';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock3,
  Database,
  Gauge,
  Layers3,
  KeyRound,
  Link2,
  ListRestart,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  WalletCards,
  X,
} from 'lucide-react';
import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import {
  accountDisplayName,
  accountRiskCushion,
  accountRiskFloor,
  buildTradovateLiveActivity,
  isWorkingTradovateOrder,
  profileMap,
  type TradovateLiveActivityKind,
} from '../lib/tradovateLiveView';
import {
  createTradovatePilotLease,
  executeTradovateCopierRelayCommand,
  loadTradovateCopierRelayStatus,
  pairTradovateCopierDevice,
  type TradovateOAuthStatus,
  type TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';
import { FIRM_LOGOS, firmColor, firmInitials } from '../utils/accountFirm';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { effectiveCopyTradeAccountEligibility } from '../lib/copyTradeAccountEligibility';
import {
  createCopyTradeAccountLabelResolver,
  formatKnownCopyTradeAccountIds,
} from '../lib/copyTradeAccountLabels';
import LiveCopyTradeOverview from './LiveCopyTradeOverview';
import MacCompanionSettings from './MacCompanionSettings';
import TradovateAccountProfileSetup from './TradovateAccountProfileSetup';
import TradovateAddConnectionModal from './TradovateAddConnectionModal';
import type { TradovateLiveData } from './useTradovateLiveData';
import type { TradovateConnectionSummary } from '../lib/tradovateLiveConnectionCache';
import { tradovateAccountProfileNeedsPlan } from '../lib/tradovateAccountOnboarding';
import { tradovateLiveTabFromSearch, type TradovateLiveTab } from '../lib/tradovateLiveTab';
import {
  resolveLocalExecutionGroup,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
import { canUseDirectLocalCopierAgent, createLocalCopierAgentClient } from '../services/localCopierAgentClient';
import {
  type CopyGroupConfig,
  type LiveCopyTradingAdapter,
} from '../services/liveCopyTrading';

interface TradovateLiveDeskProps {
  theme: 'dark' | 'light' | 'oled';
  live: TradovateLiveData;
  onCopierJournalRefresh?: (group: CopyGroupConfig | null) => void;
  macCompanionPairingIntent?: boolean;
  onMacCompanionPairingIntentHandled?: () => void;
}

const money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 4 });
const dateTime = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money.format(value)}`;
const optionalMoney = (value: number | null) => value == null ? 'nedostupné' : money.format(value);
const pnlColor = (value: number | null) => value == null ? 'text-[var(--text-secondary)]' : value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : 'text-[var(--text-secondary)]';
const TRADOVATE_OFFICIAL_LOGO = 'https://www.tradovate.com/favicon-48.png';

const TradovateCircleLogo = () => (
  <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm" title="Tradovate">
    <img src={TRADOVATE_OFFICIAL_LOGO} alt="Tradovate" className="h-5 w-5 object-contain" />
  </span>
);

const OrganizationBrand = ({ name }: { name: string }) => {
  const key = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {logo ? <img src={logo} alt="" className="h-7 w-7 shrink-0 rounded-full border border-black/10 bg-white object-cover" /> : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[8px] font-black text-white" style={{ background: firmColor(key || name).bg }}>{firmInitials(name)}</span>
      )}
      <b className="truncate">{name}</b>
    </span>
  );
};

const LiveDashboardSkeleton = () => (
  <div className="space-y-4" aria-label="Načítání čerstvých dat LIVE dashboardu" aria-busy="true">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {[0, 1, 2].map(index => (
        <div key={index} className="h-20 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
          <div className="m-4 h-3 w-20 rounded bg-[var(--border-subtle)]" />
          <div className="mx-4 h-5 w-28 rounded bg-[var(--border-subtle)]" />
        </div>
      ))}
    </div>
    <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
      <div className="h-10 border-b border-[var(--border-subtle)] bg-[var(--bg-page)]/60" />
      {[0, 1, 2, 3].map(index => (
        <div key={index} className="grid h-12 animate-pulse grid-cols-[2fr_1fr_1fr] items-center gap-6 border-b border-[var(--border-subtle)] px-4 last:border-b-0">
          <div className="h-3 w-36 rounded bg-[var(--border-subtle)]" />
          <div className="h-3 w-20 justify-self-end rounded bg-[var(--border-subtle)]" />
          <div className="h-3 w-16 justify-self-end rounded bg-[var(--border-subtle)]" />
        </div>
      ))}
    </div>
  </div>
);

const TradovateLiveDesk: React.FC<TradovateLiveDeskProps> = ({
  live,
  onCopierJournalRefresh,
  macCompanionPairingIntent = false,
  onMacCompanionPairingIntentHandled,
}) => {
  const [tab, setTab] = useState<TradovateLiveTab>(() => tradovateLiveTabFromSearch(
    typeof window === 'undefined' ? '' : window.location.search,
  ));
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [copyGroups, setCopyGroups] = useState<CopyGroupConfig[]>([]);
  const [agentStatus, setAgentStatus] = useState<LocalCopierAgentStatus | null>(null);
  // Než doběhne první dotaz, `agentStatus` je null a armovaný copier by se
  // v přepínači ukázal jako OFF. Do té doby se stav zobrazuje jako neznámý.
  const [agentStatusResolved, setAgentStatusResolved] = useState(false);
  // Dev háček (konvence at:dev:*): `localStorage['at:dev:copier-ui-demo']='1'`
  // podstrčí běžící cooldown a dvě stuck operace, aby šly stavové UI prvky
  // vidět bez čekání na reálnou situaci. Jen v dev buildu, prod ho neobsahuje.
  const copierUiDemo = useMemo(() => {
    if (!import.meta.env.DEV) return null;
    try {
      if (localStorage.getItem('at:dev:copier-ui-demo') !== '1') return null;
    } catch {
      return null;
    }
    return {
      cooldownUntil: Date.now() + 6 * 60_000 + 24_000,
      stuckOperations: [
        {
          kind: 'oso' as const, key: 'oso:demo:625378680572:62364057', status: 'rejected' as const,
          leaderSequence: 112, updatedAt: Date.now() - 4 * 60_000, accountId: 62364057,
          reason: 'maxContracts blokoval účet 62364057: request=Sell:4, cap=1',
        },
        {
          kind: 'cancel-or-modify' as const, key: 'cm:demo:625378680560:62364060', status: 'unknown' as const,
          leaderSequence: 113, updatedAt: Date.now() - 90_000, accountId: 62364060,
          operation: 'cancel' as const,
          reason: 'Cancel bez autoritativního potvrzení order streamem; čeká na dohledání',
        },
      ],
    };
  }, []);

  // Deterministické copier notifikace v nativní appce: konec ARM/cooldownu/
  // day-locku se plánuje dopředu (iOS doručí i zavřené appce), incidenty se
  // hlásí hned, dokud appka běží. Mimo nativní build no-op.
  useEffect(() => {
    void syncCopierNativeNotifications(agentStatus?.controller ?? null);
  }, [agentStatus]);
  const [agentTransport, setAgentTransport] = useState<'local' | 'relay' | null>(null);
  const [relayConnectionId, setRelayConnectionId] = useState<string | null>(null);
  const [pairingNotice, setPairingNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!macCompanionPairingIntent) return;

    setTab('connections');
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const section = document.getElementById('mac-companion-pairing');
        const input = document.getElementById('mac-companion-pairing-code') as HTMLInputElement | null;
        section?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
        input?.focus({ preventScroll: true });
        onMacCompanionPairingIntentHandled?.();
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [macCompanionPairingIntent, onMacCompanionPairingIntentHandled]);
  // Nativní window.confirm ve WKWebView (iOS shell) tiše vrací false;
  // potvrzení execution akcí proto kreslí aplikace sama.
  const [confirmState, setConfirmState] = useState<(ConfirmActionOptions & { resolve: (confirmed: boolean) => void }) | null>(null);
  const confirmAction = useCallback((options: ConfirmActionOptions) => new Promise<boolean>(resolve => {
    setConfirmState(current => {
      // Nový dotaz ruší případný předchozí — nikdy dva dialogy naráz.
      current?.resolve(false);
      return { ...options, resolve };
    });
  }), []);
  const agentClient = useMemo(() => createLocalCopierAgentClient(), []);
  const connectedConnectionIds = useMemo(
    () => live.status?.connections.filter(connection => connection.connected).map(connection => connection.id) ?? [],
    [live.status?.connections],
  );
  const pilotDevices = useMemo(
    () => agentStatus?.devices ?? (agentStatus?.device ? [agentStatus.device] : []),
    [agentStatus],
  );
  const selectedAccount = live.data?.accounts.find(account => account.id === selectedAccountId) ?? null;
  const accountsWithoutPlan = useMemo(() => {
    if (!live.data) return [];
    const profilesById = profileMap(live.profiles);
    return live.data.accounts.filter(account => (
      tradovateAccountProfileNeedsPlan(profilesById.get(String(account.id)), account.name)
    ));
  }, [live.data, live.profiles]);
  const copyTradeSnapshot = useMemo(
    () => live.data ? tradovateCopyTradeSnapshot(live.data, live.profiles) : null,
    [live.data, live.profiles],
  );
  const accountLabel = useMemo(() => createCopyTradeAccountLabelResolver({
    accountsById: new Map(copyTradeSnapshot?.accounts.map(account => [account.id, account]) ?? []),
    profilesById: new Map(live.profiles.flatMap(profile => {
      const accountId = Number(profile.externalAccountId);
      return Number.isSafeInteger(accountId) ? [[accountId, profile] as const] : [];
    })),
    sourceGroupsById: new Map(copyTradeSnapshot?.groups.map(group => [group.id, group]) ?? []),
  }), [copyTradeSnapshot, live.profiles]);
  const knownCopierAccountIds = useMemo(() => [...new Set([
    ...copyGroups.flatMap(group => [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]),
    agentStatus?.group.leaderAccountId,
    ...(agentStatus?.group.followers.map(follower => follower.accountId) ?? []),
  ].filter((accountId): accountId is number => accountId != null))], [agentStatus?.group, copyGroups]);
  const renderedLiveError = live.error
    ? formatKnownCopyTradeAccountIds(live.error, knownCopierAccountIds, accountLabel)
    : null;
  const copyTradeOrders = useMemo(
    () => live.data ? tradovateCopyTradeOrders(live.data) : [],
    [live.data],
  );
  const effectiveAccountEligibility = useMemo(
    () => copyTradeSnapshot && !live.dataEnrichmentPending
      ? effectiveCopyTradeAccountEligibility(
          copyTradeSnapshot.accounts,
          live.profiles,
          agentStatus?.controller.accountEligibility ?? [],
        )
      : (agentStatus?.controller.accountEligibility ?? []),
    [agentStatus?.controller.accountEligibility, copyTradeSnapshot, live.dataEnrichmentPending, live.profiles],
  );
  const accountEligibilityExclusions = useMemo(
    () => effectiveAccountEligibility
      .filter((entry): entry is typeof entry & { state: 'dll-locked' | 'breached' } =>
        entry.state === 'dll-locked' || entry.state === 'breached')
      .map(entry => ({
        accountId: entry.accountId,
        state: entry.state,
        reason: entry.reason ?? `LIVE účet je ${entry.state}`,
      })),
    [effectiveAccountEligibility],
  );

  // Jeden autoritativní read-only snapshot pro Home/Lock Screen widgety a
  // Live Activity. Neobsahuje OAuth token ani žádnou broker akci.
  useEffect(() => {
    if (!live.data) return;
    const state = buildNativeLiveWidgetState({
      accounts: live.data.accounts,
      profiles: live.profiles,
      controller: agentStatus?.controller ?? null,
      followerCount: agentStatus?.group.followers.length ?? 0,
    });
    void syncNativeLiveWidgetSnapshot(state);
  }, [agentStatus, live.data, live.profiles]);
  const executionGroup = useMemo(() => {
    if (!agentStatus) return null;
    return resolveLocalExecutionGroup(copyGroups, agentStatus.group);
  }, [agentStatus, copyGroups]);
  useEffect(() => {
    onCopierJournalRefresh?.(agentStatus?.group ?? executionGroup ?? null);
  }, [agentStatus?.group, executionGroup, live.data?.capturedAt, onCopierJournalRefresh]);
  const executeAgent = useCallback(async (command: Parameters<typeof agentClient.execute>[0]) => {
    if (agentTransport === 'local') return agentClient.execute(command);
    if (!relayConnectionId) throw new Error('Chybí aktivní Tradovate připojení pro Mac worker relay.');
    const result = await executeTradovateCopierRelayCommand(relayConnectionId, command);
    setAgentStatus(result.status);
    return result;
  }, [agentClient, agentTransport, relayConnectionId]);
  const armLiveGroup = useCallback(async (targetGroup: CopyGroupConfig) => {
    if (!targetGroup.enabled) {
      targetGroup = { ...targetGroup, enabled: true, localOnly: true };
    }
    const leaderEligibility = effectiveAccountEligibility.find(entry =>
      entry.accountId === targetGroup.leaderAccountId && entry.state !== 'active');
    if (leaderEligibility) {
      throw new Error(`ARM blokován: leader není způsobilý (${leaderEligibility.state}: ${leaderEligibility.reason ?? 'bez důvodu'}).`);
    }
    const enabledFollowers = targetGroup.followers.filter(follower => follower.mode !== 'off');
    const enabledFollowerIds = new Set(enabledFollowers.map(follower => follower.accountId));
    const ineligible = effectiveAccountEligibility.filter(entry =>
      entry.state !== 'active' && enabledFollowerIds.has(entry.accountId));
    const participating = enabledFollowers.length - ineligible.length;
    if (participating <= 0) {
      throw new Error('ARM blokován: skupina nemá žádný způsobilý follower účet.');
    }
    const memberIds = new Set([
      targetGroup.leaderAccountId,
      ...targetGroup.followers.map(follower => follower.accountId),
    ]);
    const exclusions = accountEligibilityExclusions.filter(entry => memberIds.has(entry.accountId));
    setAgentStatus((await executeAgent({
      type: 'arm-live',
      group: targetGroup,
      accountEligibilityExclusions: exclusions,
    })).status);
  }, [accountEligibilityExclusions, effectiveAccountEligibility, executeAgent]);
  const commandAdapter = useMemo<LiveCopyTradingAdapter | undefined>(() => {
    if (!executionGroup) return undefined;
    return {
      async execute(command) {
        const groupId = command.type === 'create-group' || command.type === 'update-group'
          ? command.group.id
          : 'groupId' in command ? command.groupId : null;
        if (groupId !== executionGroup.id) {
          throw new Error('Příkaz nemíří na skupinu připojenou k lokálnímu execution agentovi');
        }
        const payload = await executeAgent({ type: 'copy-command', command });
        return payload.result;
      },
    };
  }, [executeAgent, executionGroup]);

  // Přímý loopback agent zkoušíme i z produkčního HTTPS webu: na Macu
  // s běžícím workerem to sráží ARM/Flatten z relay sekund na stovky ms
  // (agent má produkční origin v CORS allowlistu + private-network header).
  // Na telefonu / bez workeru první pokus selže a napořád se přejde na
  // relay; na localhostu se zkouší vždy (dev worker může startovat později).
  const directAgentProbe = useRef<'unknown' | 'available' | 'unavailable'>('unknown');
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      if (canUseDirectLocalCopierAgent(window.location) || directAgentProbe.current !== 'unavailable') {
        try {
          const next = await agentClient.status();
          if (!stopped) {
            directAgentProbe.current = 'available';
            setAgentStatus(next);
            setAgentStatusResolved(true);
            setAgentTransport('local');
            setRelayConnectionId(next.device?.connectionId ?? next.devices?.[0]?.connectionId ?? null);
            timer = window.setTimeout(poll, 2_000);
          }
          return;
        } catch {
          // Lokální dev může pokračovat přes relay, pokud přímý agent neběží.
          // Mimo localhost: první neúspěch = zařízení bez workeru (telefon),
          // dál nezkoušíme; ztráta dříve fungujícího agenta (restart workeru)
          // dostane ještě šanci v příštím cyklu.
          directAgentProbe.current = directAgentProbe.current === 'available' ? 'unknown' : 'unavailable';
        }
      }
      try {
        const candidates = await Promise.all(connectedConnectionIds.map(async connectionId => ({
          connectionId,
          remote: await loadTradovateCopierRelayStatus(connectionId).catch(() => null),
        })));
        const active = candidates.find(candidate => candidate.remote?.connected) ?? null;
        if (!stopped) {
          setAgentStatus(active?.remote?.status ?? null);
          setAgentTransport(active ? 'relay' : null);
          setRelayConnectionId(active?.connectionId ?? null);
        }
      } catch {
        if (!stopped) { setAgentStatus(null); setAgentTransport(null); setRelayConnectionId(null); }
      } finally {
        if (!stopped) {
          setAgentStatusResolved(true);
          timer = window.setTimeout(poll, 2_000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [agentClient, connectedConnectionIds]);

  useEffect(() => {
    const prefix = '#copier-pair=';
    if (!window.location.hash.startsWith(prefix)) return;
    const encoded = window.location.hash.slice(prefix.length);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void (async () => {
      const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
      const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
        character => character.charCodeAt(0),
      ))) as Partial<NonNullable<LocalCopierAgentStatus['device']>>;
      if (
        decoded.state !== 'pairing-required'
        || !decoded.deviceId
        || !decoded.connectionId
        || !decoded.deviceName
        || !decoded.deviceSecret
        || !decoded.publicKey
      ) throw new Error('Neplatná Mac worker pairing žádost');
      if (!(await confirmAction({
        title: 'Spárovat Mac worker',
        message: `Spárovat ${decoded.deviceName} s DEMO připojením? Zařízení získá pouze odvolatelnou obnovu krátkého copier lease.`,
        confirmLabel: 'Spárovat',
      }))) {
        setPairingNotice('Párování Mac workeru bylo zrušeno.');
        return;
      }
      await pairTradovateCopierDevice({
        connectionId: decoded.connectionId,
        deviceId: decoded.deviceId,
        deviceSecret: decoded.deviceSecret,
        publicKey: decoded.publicKey,
        deviceName: decoded.deviceName,
      });
      setPairingNotice('Mac worker je spárovaný. Po bezpečném restartu zůstane DISARMED.');
    })().catch(error => {
      live.setError(error instanceof Error ? error.message : String(error));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmAction]);

  const tabs: Array<{ id: TradovateLiveTab; label: string; icon: React.ElementType }> = [
    { id: 'connections', label: 'Connections', icon: Link2 },
    { id: 'overview', label: 'Live Dashboard', icon: Gauge },
    { id: 'accounts', label: 'Účty', icon: WalletCards },
    { id: 'orders', label: 'Pozice a příkazy', icon: ListRestart },
    { id: 'events', label: 'Události', icon: Clock3 },
  ];

  const checkingConnection = live.status == null;
  const requiresConnection = tab !== 'connections' && live.status != null && !live.status.connected;

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 animate-in fade-in duration-300">
      <nav className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] no-scrollbar" aria-label="LIVE navigace">
        {tabs.map(item => {
          const Icon = item.icon;
          return <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${tab === item.id ? 'border-indigo-500 text-indigo-500' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}><Icon size={14} />{item.label}</button>;
        })}
      </nav>

      {renderedLiveError && (
        <div className="flex items-center gap-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-rose-500">
          <AlertTriangle size={18} className="shrink-0" /><span className="flex-1 text-sm font-semibold">{renderedLiveError}</span>
          <button type="button" onClick={() => void live.refreshStatus()} className="text-xs font-black uppercase">Zkusit znovu</button>
        </div>
      )}

      {pairingNotice && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-bold text-emerald-600">
          {pairingNotice}
        </div>
      )}

      {live.historyError && (
        <div className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600">
          <Database size={16} className="shrink-0" />
          <span className="flex-1 text-xs font-semibold">Historický backfill čeká na dostupné úložiště: {live.historyError}</span>
        </div>
      )}

      {accountsWithoutPlan.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-4 text-amber-700 sm:flex-row sm:items-center dark:text-amber-400">
          <ShieldAlert size={19} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <b className="block text-sm">{accountsWithoutPlan.length === 1 ? '1 účet nemá dokončený plán' : `${accountsWithoutPlan.length} účtů nemá dokončený plán`}</b>
            <span className="mt-0.5 block truncate text-xs font-semibold">
              {accountsWithoutPlan.map(account => account.name).join(', ')} · záložní výpočet drawdownu a limitů bez plánu nemusí být úplný.
            </span>
          </div>
          <button type="button" onClick={() => live.setProfileSetupOpen(true)} className="h-9 shrink-0 rounded-md bg-amber-500 px-4 text-xs font-black text-slate-950">
            Přiřadit plán
          </button>
        </div>
      )}

      {tab === 'connections' ? (
        <>
          <Connections
            status={live.status}
            connectionData={live.connectionData}
            connectionSummaries={live.connectionSummaries}
            profiles={live.profiles}
            busy={live.busy}
            onAdd={() => setAddConnectionOpen(true)}
            onRefreshStatus={() => void live.refreshStatus()}
            onProfiles={() => live.setProfileSetupOpen(true)}
            onDisconnect={connectionId => void (async () => {
              if (await confirmAction({
                title: 'Odpojit Tradovate připojení',
                message: 'Odpojit toto Tradovate připojení? Uložené názvy a pravidla účtů zůstanou zachované.',
                confirmLabel: 'Odpojit',
                tone: 'danger',
              })) {
                void live.disconnect(connectionId);
              }
            })()}
            onReconnect={connectionId => void live.connect(connectionId)}
            pilotDevices={pilotDevices}
            onPilotLease={connectionId => void (async () => {
              const device = pilotDevices.find(item => item.connectionId === connectionId);
              if (device?.state === 'pairing-required') {
                if (device.connectionId !== connectionId || !device.deviceSecret || !device.publicKey) {
                  throw new Error('Mac worker čeká na jiné Tradovate připojení nebo má neúplnou pairing žádost.');
                }
                if (!(await confirmAction({
                  title: 'Spárovat Mac worker',
                  message: `Spárovat ${device.deviceName} s tímto DEMO připojením? Zařízení dostane pouze odvolatelný přístup k obnově krátkého copier lease.`,
                  confirmLabel: 'Spárovat',
                }))) return;
                await pairTradovateCopierDevice({
                  connectionId,
                  deviceId: device.deviceId,
                  deviceSecret: device.deviceSecret,
                  publicKey: device.publicKey,
                  deviceName: device.deviceName,
                });
                setAgentStatus((await agentClient.execute({ type: 'device-paired', deviceId: device.deviceId })).status);
                return;
              }
              await downloadPilotLease(connectionId);
            })().catch(error => {
              live.setError(error instanceof Error ? error.message : String(error));
            })}
          />
          <MacCompanionSettings confirmAction={confirmAction} />
        </>
      ) : checkingConnection ? (
        <LiveDashboardSkeleton />
      ) : requiresConnection ? (
        <ConnectionRequired onConnect={() => setAddConnectionOpen(true)} />
      ) : !live.data ? (
        <LiveDashboardSkeleton />
      ) : (
        <>
          {tab === 'overview' && copyTradeSnapshot ? (
            <LiveCopyTradeOverview
              snapshot={copyTradeSnapshot}
              accountProfiles={live.profiles}
              orders={copyTradeOrders}
              onRefreshOrders={async () => { await live.refreshData(); }}
              onAccount={account => setSelectedAccountId(account.id)}
              apiTelemetry={live.apiTelemetry}
              snapshotHealth={agentStatus?.snapshotHealth}
              onRepairSnapshots={async () => {
                if (!(await confirmAction({
                  title: 'Obnovit TradingView snímky',
                  message: 'Ulož nejdřív případné změny v TradingView. AlphaTrade aplikaci standardně ukončí a znovu spustí s připojením pro ENTRY/EXIT snímky. Kopírka ani brokerové příkazy se nezmění.',
                  confirmLabel: 'Ukončit a znovu spustit',
                }))) return;
                setAgentStatus((await executeAgent({
                  type: 'snapshot-test',
                  requestId: crypto.randomUUID(),
                  repairCamera: true,
                })).status);
              }}
              commandAdapter={commandAdapter}
              copierArmed={copierUiDemo ? false : agentStatus?.controller.armed === true}
              copierStatusPending={!copierUiDemo && (!agentStatusResolved || live.dataEnrichmentPending)}
              dailyPnlPending={live.dataEnrichmentPending}
              dailyStats={agentStatus?.controller.dailyStats ?? null}
              copierObservingOnly={!copierUiDemo && agentStatus?.controller.armed === true && agentStatus.controller.shadowMode === true}
              copierKillSwitch={agentStatus?.controller.killSwitch === true}
              dayLockUntil={agentStatus?.controller.dayLockUntil ?? 0}
              cooldownUntil={copierUiDemo ? copierUiDemo.cooldownUntil : agentStatus?.controller.entryCooldownUntil ?? 0}
              stuckOperations={copierUiDemo ? copierUiDemo.stuckOperations : agentStatus?.controller.stuckOperations ?? []}
              accountEligibility={effectiveAccountEligibility}
              unverifiableFollowerOwnership={agentStatus?.controller.unverifiableFollowerOwnership ?? []}
              lastDisarm={copierUiDemo ? undefined : agentStatus?.controller.lastDisarm}
              disarmHistory={copierUiDemo ? [] : agentStatus?.controller.disarmHistory ?? []}
              onVerifyEligibility={async accountId => {
                const result = await executeAgent({ type: 'verify-account-eligibility', accountId });
                setAgentStatus(result.status);
                await live.refreshData();
                const remaining = result.status.controller.accountEligibility
                  ?.find(entry => entry.accountId === accountId && entry.state !== 'active');
                if (remaining) {
                  throw new Error(`Broker účet stále nepotvrdil jako způsobilý: ${remaining.reason ?? remaining.state}`);
                }
              }}
              executionGroupId={executionGroup?.id ?? null}
              runtimeGroup={agentStatus?.group ?? null}
              onGroupsChange={setCopyGroups}
              onSwitchAndArm={armLiveGroup}
              onArmLive={executionGroup ? async () => armLiveGroup(executionGroup) : undefined}
              onDisarm={async () => setAgentStatus((await executeAgent({ type: 'disarm' })).status)}
              onEmergencyStop={async () => setAgentStatus((await executeAgent({ type: 'kill-switch' })).status)}
              onDayLock={async () => {
                if (!(await confirmAction({
                  title: 'Zamknout den',
                  message: 'Opravdu zablokovat ostrý ARM až do konce aktuální broker session? Restart Mac workeru tento lock nezruší.',
                  confirmLabel: 'Zamknout den',
                  tone: 'danger',
                }))) return;
                setAgentStatus((await executeAgent({
                  type: 'lock-until-session-end',
                  reason: 'Ruční denní lock z AlphaTrade LIVE UI',
                })).status);
              }}
            />
          ) : null}
          {tab === 'accounts' ? <Accounts data={live.data} profiles={live.profiles} onAccount={setSelectedAccountId} /> : null}
          {tab === 'orders' ? <PositionsAndOrders data={live.data} profiles={live.profiles} /> : null}
          {tab === 'events' ? <ActivityView data={live.data} profiles={live.profiles} /> : null}
        </>
      )}

      {confirmState ? (
        <ConfirmActionDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          tone={confirmState.tone}
          onResolve={confirmed => {
            confirmState.resolve(confirmed);
            setConfirmState(null);
          }}
        />
      ) : null}
      {addConnectionOpen ? <TradovateAddConnectionModal environment={live.status?.environment ?? 'demo'} connecting={live.busy === 'connect'} onClose={() => setAddConnectionOpen(false)} onConnect={() => void live.connect()} /> : null}
      {live.profileSetupOpen && live.data ? (
        <TradovateAccountProfileSetup
          accounts={live.data.accounts}
          profiles={live.profiles}
          onClose={() => live.setProfileSetupOpen(false)}
          onSaved={profiles => {
            live.setProfiles(profiles);
            live.setProfileSetupOpen(false);
            live.setError(null);
          }}
        />
      ) : null}
      {selectedAccount ? <AccountDetail account={selectedAccount} profile={profileMap(live.profiles).get(String(selectedAccount.id))} onClose={() => setSelectedAccountId(null)} /> : null}
    </div>
  );
};

const Connections = ({ status, connectionData, connectionSummaries, profiles, busy, onAdd, onRefreshStatus, onProfiles, onDisconnect, onReconnect, onPilotLease, pilotDevices }: {
  status: TradovateOAuthStatus | null;
  connectionData: Record<string, TradovatePreflightResult>;
  connectionSummaries: Record<string, TradovateConnectionSummary>;
  profiles: TradovateAccountProfile[];
  busy: 'status' | 'connect' | 'data' | 'disconnect' | null;
  onAdd: () => void;
  onRefreshStatus: () => void;
  onProfiles: () => void;
  onDisconnect: (connectionId: string) => void;
  onReconnect: (connectionId: string) => void;
  onPilotLease: (connectionId: string) => void;
  pilotDevices: NonNullable<LocalCopierAgentStatus['devices']>;
}) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const profilesById = profileMap(profiles);
  const connections = status?.connections ?? [];
  const activeConnections = connections.filter(connection => connection.connected).length;
  const totalAccounts = connections.reduce((sum, connection) => (
    sum + (connectionData[connection.id]?.accounts.length ?? connectionSummaries[connection.id]?.accountCount ?? 0)
  ), 0);
  return (
    <>
      <SafetyBanner />
      <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div><h2 className="text-base font-black text-[var(--text-primary)]">Connections</h2><div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-secondary)]"><span className={`h-1.5 w-1.5 rounded-full ${activeConnections > 0 ? 'bg-emerald-500' : busy === 'status' ? 'bg-amber-500' : 'bg-[var(--text-secondary)]'}`} /><span className={activeConnections > 0 ? 'font-bold text-emerald-500' : ''}>{activeConnections > 0 ? `${activeConnections} aktivní · ${connections.length} uložených${busy === 'status' ? ' · obnovuji' : ''}` : busy === 'status' ? 'Ověřuji stav…' : connections.length > 0 ? `${activeConnections} aktivní · ${connections.length} uložených` : 'Žádné připojení'}</span></div></div>
          <div className="flex items-center gap-2"><button type="button" onClick={onAdd} disabled={busy != null} className="flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"><Plus size={15} /> Add connection</button><IconButton label="Obnovit stav" onClick={onRefreshStatus} disabled={busy != null}><RefreshCw size={15} className={busy === 'status' || busy === 'data' ? 'animate-spin' : ''} /></IconButton></div>
        </div>
        <div className="hidden grid-cols-[48px_90px_90px_1.15fr_1fr_130px_180px] gap-3 bg-[var(--bg-page)] px-4 py-2.5 text-[9px] font-black uppercase tracking-[0.13em] text-[var(--text-secondary)] lg:grid"><span /><span>Broker</span><span>Type</span><span>Connection</span><span>Organization</span><span>Status</span><span /></div>
        {connections.length === 0 && busy !== 'status' ? <EmptyConnection onAdd={onAdd} /> : connections.length > 0 ? (
          connections.map(connection => {
            const pilotDevice = pilotDevices.find(device => device.connectionId === connection.id);
            const dataset = connectionData[connection.id];
            const summary = connectionSummaries[connection.id];
            const accountIds = new Set(dataset?.accounts.map(account => String(account.id)) ?? []);
            const propFirms = Array.from(new Set(profiles.filter(profile => accountIds.has(profile.externalAccountId)).map(profile => profile.propFirm).filter(Boolean)));
            const organization = propFirms.join(', ') || connection.organizationName || summary?.organizationName || '—';
            const connectionName = connection.tradovateEmail || (connection.tradovateUserId != null ? `Tradovate user ${connection.tradovateUserId}` : 'Tradovate OAuth');
            const accountCount = dataset?.accounts.length ?? summary?.accountCount ?? 0;
            const isExpanded = connection.connected && (expanded[connection.id] ?? false);
            return <React.Fragment key={connection.id}>
              <div className="grid min-h-12 items-stretch border-b border-[var(--border-subtle)] text-xs transition-colors hover:bg-indigo-500/[0.035] lg:grid-cols-[minmax(0,1fr)_180px]">
                <button
                  type="button"
                  onClick={() => connection.connected && setExpanded(current => ({ ...current, [connection.id]: !isExpanded }))}
                  disabled={!connection.connected || !dataset}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? `Sbalit ${accountCount} účtů` : `Rozbalit ${accountCount} účtů`}
                  className="grid w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors focus-visible:bg-indigo-500/[0.06] disabled:cursor-default lg:grid-cols-[48px_90px_90px_1.15fr_1fr_130px]"
                >
                  <span className="flex items-center gap-2 text-[var(--text-secondary)]"><ChevronRight size={15} className={`transition-transform duration-300 ease-out ${isExpanded ? 'rotate-90' : ''} ${connection.connected && dataset ? '' : 'opacity-30'}`} /><span className="text-xs font-bold">{accountCount}</span></span>
                  <MobileMetric label="Broker"><TradovateCircleLogo /></MobileMetric><MobileMetric label="Type"><b className="text-[var(--text-secondary)]">{connection.environment.toUpperCase()}</b></MobileMetric><MobileMetric label="Connection"><span className="truncate font-mono font-bold">{connectionName}</span></MobileMetric><MobileMetric label="Organization"><OrganizationBrand name={organization} /></MobileMetric><MobileMetric label="Status"><span className={`inline-flex items-center gap-2 font-bold ${connection.connected ? 'text-emerald-500' : 'text-amber-500'}`}><span className={`h-2 w-2 rounded-full ${connection.connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />{connection.connected ? 'Connected' : 'Disconnected'}</span></MobileMetric>
                </button>
              <div className="flex flex-nowrap items-center justify-end gap-1 px-4 py-2 lg:px-0 lg:pr-4">
                {connection.connected ? <>
                  <button type="button" onClick={() => onDisconnect(connection.id)} disabled={busy != null} className="h-7 shrink-0 whitespace-nowrap rounded-md border border-[var(--border-subtle)] px-2 text-[10px] font-bold leading-none text-[var(--text-primary)] disabled:opacity-50">Disconnect</button>
                  <button type="button" disabled title="Flatten All bude aktivní až po samostatném schválení DEMO execution testu." className="h-7 shrink-0 cursor-not-allowed whitespace-nowrap rounded-md bg-rose-500 px-2 text-[10px] font-black leading-none text-white opacity-45">Flatten All</button>
                  <IconButton
                    label={pilotDevice?.state === 'pairing-required' && pilotDevice.connectionId === connection.id ? 'Spárovat tento Mac worker' : 'Připravit lokální pilot lease'}
                    onClick={() => onPilotLease(connection.id)}
                    disabled={busy != null}
                    small
                  ><KeyRound size={13} /></IconButton>
                  <IconButton label="Nastavit účty" onClick={onProfiles} disabled={!dataset?.accounts.length} small><Settings2 size={13} /></IconButton>
                </> : <button type="button" onClick={() => onReconnect(connection.id)} disabled={busy != null} className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-indigo-600 px-3 text-[10px] font-black leading-none text-white disabled:opacity-50"><RotateCcw size={12} /> Reconnect</button>}
                </div>
              </div>
              {dataset ? (
                <div aria-hidden={!isExpanded} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}>
                  <div className="min-h-0 overflow-hidden"><ConnectionAccounts data={dataset} profilesById={profilesById} /></div>
                </div>
              ) : null}
            </React.Fragment>;
          })
        ) : <div className="flex min-h-32 items-center justify-center"><Loader2 size={22} className="animate-spin text-indigo-500" /></div>}
        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-3 text-xs"><span className="font-bold text-[var(--text-secondary)]">Total Accounts: <b className="text-[var(--text-primary)]">{totalAccounts}</b></span><span className="font-black text-[var(--text-secondary)]">AlphaTrade</span></div>
      </section>
    </>
  );
};

async function downloadPilotLease(connectionId: string): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pem,text/plain';
  const file = await new Promise<File>((resolveFile, rejectFile) => {
    input.onchange = () => {
      const selected = input.files?.[0];
      if (selected) resolveFile(selected);
      else rejectFile(new Error('Nebyl vybrán pilot-public.pem.'));
    };
    input.click();
  });
  const publicKey = await file.text();
  if (!publicKey.includes('BEGIN PUBLIC KEY')) throw new Error('Vybraný soubor není pilot-public.pem.');
  const lease = await createTradovatePilotLease(connectionId, publicKey);
  const blob = new Blob([`${JSON.stringify(lease.envelope, null, 2)}\n`], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `alphatrade-pilot-${connectionId}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

const SafetyBanner = () => <section className="overflow-hidden rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045]"><div className="flex items-center gap-2.5 border-b border-indigo-500/15 px-4 py-3"><ShieldAlert size={16} className="text-indigo-500" /><h2 className="text-sm font-black text-[var(--text-primary)]">Bezpečné připojení účtů</h2></div><div className="grid gap-2 px-4 py-3 text-xs leading-5 text-[var(--text-secondary)] lg:grid-cols-3 lg:gap-5"><p><b className="text-[var(--text-primary)]">Přihlášení probíhá u Tradovate.</b> AlphaTrade nevidí ani neukládá tvoje heslo.</p><p><b className="text-[var(--text-primary)]">LIVE je zatím read-only.</b> Copier zůstává DISARMED a nic neodesílá.</p><p><b className="text-[var(--text-primary)]">Jeden vlastní datový tok.</b> Všechny LIVE záložky používají stejné OAuth spojení.</p></div></section>;

const EmptyConnection = ({ onAdd }: { onAdd: () => void }) => <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500"><Link2 size={22} /></span><h3 className="mt-4 text-sm font-black text-[var(--text-primary)]">Žádné připojení</h3><p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-secondary)]">Přidej Tradovate přes OAuth. Po návratu načteme dostupné účty.</p><button type="button" onClick={onAdd} className="mt-4 flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white"><Plus size={15} /> Add connection</button></div>;

const ConnectionAccounts = ({ data, profilesById }: { data: TradovatePreflightResult; profilesById: Map<string, TradovateAccountProfile> }) => {
  const historical = data.historicalSync;
  const historicalAvailable = historical.status === 'available';
  const diagnostic = historical.status === 'invalid-response'
    ? `Struktura: ${historical.responseShape.kind}${historical.responseShape.topLevelKeys.length ? ` · ${historical.responseShape.topLevelKeys.join(', ')}` : ''}`
    : null;
  return <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-page)]"><div className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2 text-[10px] ${historicalAvailable ? 'text-emerald-600' : historical.status === 'unauthorized' || historical.status === 'forbidden' ? 'text-amber-600' : 'text-[var(--text-secondary)]'}`}><span className="font-bold">Historický sync: {historicalAvailable ? `dostupný · ${historical.definitionCount} reportů` : `${historical.status}${historical.httpStatus ? ` · HTTP ${historical.httpStatus}` : ''}`}</span><span>{historicalAvailable ? [historical.supportsPerformance && 'Performance', historical.supportsOrders && 'Orders', historical.supportsCashHistory && 'Cash History', historical.supportsAccountBalanceHistory && 'Account Balance History'].filter(Boolean).join(' · ') || 'Report definitions dostupné' : diagnostic || 'Fallback: průběžné ukládání + CSV import'}</span></div>{historicalAvailable ? <details className="border-b border-[var(--border-subtle)] px-4 py-2 text-[10px] text-[var(--text-secondary)]"><summary className="cursor-pointer font-bold text-[var(--text-primary)]">Parametry historických reportů</summary><div className="mt-2 grid gap-1 md:grid-cols-2">{historical.reports.map(report => <div key={report.name}><b>{report.name}</b>: {report.parameters.length ? report.parameters.map(parameter => `${parameter.name}${parameter.paramType ? ` (${parameter.paramType})` : ''}${parameter.optional === false ? '*' : ''}`).join(', ') : 'bez parametrů'}</div>)}</div></details> : null}{data.accounts.length === 0 ? <div className="px-4 py-4 text-xs font-bold text-amber-600">API nevrátilo žádný viditelný účet.</div> : <div className="overflow-x-auto"><div className="min-w-[850px]"><div className="grid grid-cols-[1.4fr_1.1fr_.8fr_1fr_.55fr_.55fr] gap-3 border-b border-[var(--border-subtle)] px-4 py-2 text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]"><span>Account</span><span>Organization / plan</span><span>Status</span><span>Net liq</span><span>Positions</span><span>Working</span></div>{data.accounts.map(account => { const profile = profilesById.get(String(account.id)); return <div key={account.id} className="grid grid-cols-[1.4fr_1.1fr_.8fr_1fr_.55fr_.55fr] items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs last:border-0"><b>{profile?.displayName || account.name}</b><span className="text-[var(--text-secondary)]">{[profile?.propFirm, profile?.planName].filter(Boolean).join(' · ') || '—'}</span><span className={account.active ? 'font-bold text-emerald-500' : 'font-bold text-amber-500'}>{account.active ? 'Active' : 'Inactive'}</span><b>{optionalMoney(account.balance.netLiq)}</b><span>{account.netPositionCount}</span><span>{account.workingOrderCount}</span></div>; })}</div></div>}</div>;
};

const ConnectionRequired = ({ onConnect }: { onConnect: () => void }) => <section className="flex min-h-[45vh] flex-col items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 text-center"><Link2 size={28} className="text-indigo-500" /><h2 className="mt-4 text-lg font-black text-[var(--text-primary)]">Nejdřív připoj Tradovate</h2><p className="mt-2 max-w-md text-sm text-[var(--text-secondary)]">Všechny LIVE záložky používají přímo naše Tradovate OAuth data.</p><button type="button" onClick={onConnect} className="mt-5 flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white"><Plus size={15} /> Add connection</button></section>;

const Accounts = ({ data, profiles, onAccount }: { data: TradovatePreflightResult; profiles: TradovateAccountProfile[]; onAccount: (id: number) => void }) => <AccountsTable accounts={data.accounts} profilesById={profileMap(profiles)} onAccount={onAccount} />;

const AccountsTable = ({ accounts, profilesById, onAccount, compact = false }: { accounts: TradovateAccountDataAccount[]; profilesById: Map<string, TradovateAccountProfile>; onAccount: (id: number) => void; compact?: boolean }) => <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"><div className="border-b border-[var(--border-subtle)] px-4 py-3"><h3 className="text-sm font-black text-[var(--text-primary)]">ÚČTY ({accounts.length})</h3><p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Přímo z Tradovate OAuth · balance, net liq, P&L, pozice a zadaná prop pravidla</p></div><div className="hidden grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] gap-3 bg-[var(--bg-page)] px-4 py-2.5 text-[9px] font-black uppercase tracking-[0.13em] text-[var(--text-secondary)] lg:grid"><span>Účet</span><span>Balance / net liq</span><span>Realized</span><span>Open P&L</span><span>Rezerva</span><span /></div><div className="divide-y divide-[var(--border-subtle)]">{accounts.map(account => { const profile = profilesById.get(String(account.id)); const cushion = accountRiskCushion(account, profile); const historical = account.historicalBackfill; return <button key={account.id} type="button" onClick={() => onAccount(account.id)} className={`grid w-full items-center gap-3 px-4 text-left text-xs transition-colors hover:bg-indigo-500/[0.035] lg:grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] ${compact ? 'py-2' : 'py-3 lg:min-h-11 lg:py-1'}`}><div className="min-w-0"><b className="block truncate text-[var(--text-primary)]">{profile?.displayName || account.name}</b><span className="mt-0.5 block truncate text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{[profile?.propFirm, profile?.planName, profile?.accountType].filter(Boolean).join(' · ') || `Tradovate ${account.id}`}</span>{historical ? <span className={`mt-0.5 block truncate text-[9px] font-bold ${historical.status === 'complete' ? 'text-emerald-500' : historical.status === 'error' ? 'text-rose-500' : 'text-indigo-500'}`}>Historie {historical.status === 'complete' ? `načtena · ${historical.tradeCount} obchodů` : historical.status === 'error' ? 'chyba' : `synchronizace · ${historical.pendingRangeCount} částí`}</span> : null}</div><MobileMetric label="Balance / net liq"><b>{optionalMoney(account.balance.totalCashValue)}</b><span className="block text-[10px] text-[var(--text-secondary)]">{optionalMoney(account.balance.netLiq)}</span></MobileMetric><MobileMetric label="Realized"><b className={pnlColor(account.balance.realizedPnL)}>{account.balance.realizedPnL == null ? 'nedostupné' : signedMoney(account.balance.realizedPnL)}</b></MobileMetric><MobileMetric label="Open P&L"><b className={pnlColor(account.balance.openPnL)}>{account.balance.openPnL == null ? 'nedostupné' : signedMoney(account.balance.openPnL)}</b></MobileMetric><MobileMetric label="Rezerva"><b className={cushion != null && cushion <= 500 ? 'text-rose-500' : ''}>{cushion == null ? '—' : money.format(cushion)}</b></MobileMetric><ChevronRight size={16} className="hidden text-[var(--text-secondary)] lg:block" /></button>; })}</div></section>;

const PositionsAndOrders = ({ data, profiles }: { data: TradovatePreflightResult; profiles: TradovateAccountProfile[] }) => {
  const profilesById = profileMap(profiles);
  const positions = data.accounts.flatMap(account => account.positions.filter(position => position.netPosition !== 0).map(position => ({ account, position })));
  const orders = data.accounts.flatMap(account => account.orders.map(order => ({ account, order }))).sort((a, b) => Number(isWorkingTradovateOrder(b.order)) - Number(isWorkingTradovateOrder(a.order)) || Date.parse(b.order.timestamp ?? '') - Date.parse(a.order.timestamp ?? ''));
  return <div className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><MetricCard label="Otevřené pozice" value={String(positions.length)} sub="Napříč Tradovate účty" icon={Layers3} /><MetricCard label="Pracující příkazy" value={String(orders.filter(item => isWorkingTradovateOrder(item.order)).length)} sub="Dle order statusu" icon={Activity} /><MetricCard label="Načtené příkazy" value={String(orders.length)} sub={`Coverage: ${data.coverage.orders.availability}`} icon={Database} /></div><section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5"><h3 className="font-black text-[var(--text-primary)]">OTEVŘENÉ POZICE</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Net pozice z Tradovate /position/list</p><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{positions.map(({ account, position }) => <div key={`${account.id}-${position.id ?? position.contractId}`} className="rounded-md border border-indigo-500/20 bg-indigo-500/[0.045] p-4"><div className="flex justify-between gap-3"><div><b>{position.symbol ?? `Contract ${position.contractId}`}</b><div className="mt-1 text-xs text-[var(--text-secondary)]">{accountDisplayName(account, profilesById)}</div></div><span className={`h-fit rounded-md px-2 py-1 text-[10px] font-black ${position.netPosition > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{position.netPosition > 0 ? 'LONG' : 'SHORT'} {Math.abs(position.netPosition)}</span></div><div className="mt-4 grid grid-cols-2 gap-3"><DetailMetric label="Průměrná cena" value={position.averagePrice == null ? '—' : number.format(position.averagePrice)} /><DetailMetric label="Trade date" value={position.tradeDate ?? '—'} /></div></div>)}{positions.length === 0 ? <Empty text="Všechny účty jsou aktuálně flat." /> : null}</div></section><section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]"><div className="border-b border-[var(--border-subtle)] px-5 py-4"><h3 className="font-black text-[var(--text-primary)]">PŘÍKAZY</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Pracující příkazy jsou nahoře</p></div><div className="divide-y divide-[var(--border-subtle)]">{orders.map(({ account, order }) => { const working = isWorkingTradovateOrder(order); return <div key={`${account.id}-${order.id}`} className={`grid gap-3 px-5 py-3 text-xs md:grid-cols-[1.5fr_.7fr_.7fr_.7fr_.8fr] ${working ? 'bg-indigo-500/[0.045]' : ''}`}><div><b>{accountDisplayName(account, profilesById)}</b><div className="mt-1 text-[var(--text-secondary)]">{order.symbol ?? 'Kontrakt'} · {order.action ?? '—'} {order.quantity ?? ''}</div></div><MobileMetric label="Typ"><b>{order.orderType ?? '—'}</b></MobileMetric><MobileMetric label="Cena"><b>{order.stopPrice ?? order.price ?? '—'}</b></MobileMetric><MobileMetric label="Stav"><span className={`inline-flex rounded-md px-2 py-1 text-[10px] font-black uppercase ${working ? 'bg-indigo-500/10 text-indigo-500' : (order.status ?? '').toLowerCase() === 'filled' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-[var(--text-secondary)]'}`}>{order.status ?? '—'}</span></MobileMetric><MobileMetric label="Čas"><span className="text-[var(--text-secondary)]">{order.timestamp ? dateTime.format(new Date(order.timestamp)) : '—'}</span></MobileMetric></div>; })}{orders.length === 0 ? <Empty text="Žádné příkazy nebyly načteny." /> : null}</div></section></div>;
};

const ActivityView = ({ data, profiles }: { data: TradovatePreflightResult; profiles: TradovateAccountProfile[] }) => {
  const ACTIVITY_BATCH_SIZE = 100;
  const [filter, setFilter] = useState<'all' | TradovateLiveActivityKind>('trade');
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_BATCH_SIZE);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const profilesById = useMemo(() => profileMap(profiles), [profiles]);
  // Neomezovat společný stream před aplikací filtru. Jinak novější filly,
  // příkazy a cash položky vytlačí starší obchody, přestože uživatel zvolil
  // pouze „Přehled obchodů“.
  const activity = useMemo(() => buildTradovateLiveActivity(data.accounts, Number.POSITIVE_INFINITY), [data.accounts]);
  const filtered = filter === 'all' ? activity : activity.filter(event => event.kind === filter);
  const visible = filtered.slice(0, visibleLimit);
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || visibleLimit >= filtered.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleLimit(current => Math.min(current + ACTIVITY_BATCH_SIZE, filtered.length));
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length, visibleLimit]);
  const labels: Array<{ id: 'all' | TradovateLiveActivityKind; label: string }> = [{ id: 'trade', label: 'Přehled obchodů' }, { id: 'fill', label: 'Filly' }, { id: 'order', label: 'Příkazy' }, { id: 'cash', label: 'Cash' }, { id: 'all', label: 'Vše' }];
  const evidence = {
    'broker-confirmed': { label: 'Broker potvrzeno', color: 'bg-emerald-500/10 text-emerald-600' },
    'fillpair-derived': { label: 'Odvozeno z fillPair', color: 'bg-indigo-500/10 text-indigo-500' },
    'historical-limited': { label: 'SL/TP nelze určit', color: 'bg-amber-500/10 text-amber-600' },
  } as const;
  return (
    <div className="space-y-3">
      <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h3 className="text-sm font-black text-[var(--text-primary)]">UDÁLOSTI A LIFECYCLE OBCHODŮ</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Spárované obchody, jednotlivé filly, snapshoty příkazů a cash ledger přímo z Tradovate</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {labels.map(item => (
              <button key={item.id} type="button" onClick={() => { setFilter(item.id); setVisibleLimit(ACTIVITY_BATCH_SIZE); }} className={`rounded-md px-2.5 py-1.5 text-[10px] font-black ${filter === item.id ? 'bg-indigo-600 text-white' : 'bg-[var(--bg-page)] text-[var(--text-secondary)]'}`}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-px bg-[var(--border-subtle)] text-[11px] lg:grid-cols-3">
          <div className="bg-[var(--bg-page)] px-4 py-3"><b className="text-[var(--text-primary)]">Entry a exit</b><p className="mt-1 leading-4 text-[var(--text-secondary)]">FillPair potvrzuje směr, vstup, výstup a množství.</p></div>
          <div className="bg-[var(--bg-page)] px-4 py-3"><b className="text-[var(--text-primary)]">SL / TP pouze z order vazby</b><p className="mt-1 leading-4 text-[var(--text-secondary)]">Stop order nebo propojený OCO/bracket limit je označen jako broker potvrzený.</p></div>
          <div className="bg-[var(--bg-page)] px-4 py-3"><b className="text-[var(--text-primary)]">Historie bez domýšlení</b><p className="mt-1 leading-4 text-[var(--text-secondary)]">Performance report zná ceny a P&amp;L, ale bez closing orderu nehádáme SL ani TP.</p></div>
        </div>
        <div className="hidden grid-cols-[minmax(260px,1.4fr)_minmax(180px,1fr)_150px_140px] gap-4 border-y border-[var(--border-subtle)] bg-[var(--bg-page)] px-4 py-2 text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)] lg:grid">
          <span>Událost</span><span>Účet a data</span><span>Důkaz</span><span className="text-right">Čas</span>
        </div>
        <div className="divide-y divide-[var(--border-subtle)]">
          {visible.map(event => {
            const account = data.accounts.find(candidate => candidate.id === event.accountId);
            const proof = evidence[event.evidence];
            return (
              <div key={event.id} className="grid gap-2 px-4 py-3 text-xs transition-colors hover:bg-indigo-500/[0.025] lg:grid-cols-[minmax(260px,1.4fr)_minmax(180px,1fr)_150px_140px] lg:items-center lg:gap-4">
                <div className="min-w-0">
                  <div className="flex items-start gap-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${event.kind === 'trade' ? 'bg-emerald-500' : event.kind === 'fill' ? 'bg-indigo-500' : event.kind === 'order' ? 'bg-blue-500' : 'bg-amber-500'}`} />
                    <div className="min-w-0">
                      <b className="block text-[var(--text-primary)]">{event.title}</b>
                      <span className="mt-0.5 block leading-4 text-[var(--text-secondary)]">{event.detail}</span>
                      {event.pnl != null ? <b className={`mt-1 block ${pnlColor(event.pnl)}`}>{event.pnlLabel ? `${event.pnlLabel}: ` : ''}{signedMoney(event.pnl)}</b> : null}
                    </div>
                  </div>
                </div>
                <div className="min-w-0 text-[var(--text-secondary)]">
                  <b className="block truncate text-[var(--text-primary)]">{account ? accountDisplayName(account, profilesById) : event.accountName}</b>
                  <span className="mt-0.5 block truncate">{[event.symbol, event.side, event.orderId != null && `order #${event.orderId}`].filter(Boolean).join(' · ') || 'Cash ledger'}</span>
                </div>
                <div>
                  <span title={event.evidenceDetail} className={`inline-flex rounded-md px-2 py-1 text-[9px] font-black ${proof.color}`}>{proof.label}</span>
                  <p className="mt-1 line-clamp-2 text-[9px] leading-3 text-[var(--text-secondary)]" title={event.evidenceDetail}>{event.evidenceDetail}</p>
                </div>
                <div className="whitespace-nowrap text-[10px] font-bold text-[var(--text-secondary)] lg:text-right">{dateTime.format(new Date(event.timestamp))}</div>
              </div>
            );
          })}
          {visible.length === 0 ? <Empty text="Pro vybraný filtr nejsou dostupné události." /> : null}
        </div>
        {visible.length < filtered.length ? (
          <div ref={loadMoreRef} className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-page)] px-4 py-3 text-[10px] text-[var(--text-secondary)]">
            <span>Zobrazeno {visible.length} z {filtered.length} událostí</span>
            <button type="button" onClick={() => setVisibleLimit(current => Math.min(current + ACTIVITY_BATCH_SIZE, filtered.length))} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 font-black text-[var(--text-primary)] hover:border-indigo-500/40">
              Načíst dalších {Math.min(ACTIVITY_BATCH_SIZE, filtered.length - visible.length)}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
};

const AccountDetail = ({ account, profile, onClose }: { account: TradovateAccountDataAccount; profile?: TradovateAccountProfile; onClose: () => void }) => {
  const floor = accountRiskFloor(account, profile);
  const cushion = accountRiskCushion(account, profile);
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 p-0 backdrop-blur-md sm:items-center sm:p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="max-h-[92vh] w-full overflow-y-auto rounded-t-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl custom-scrollbar sm:max-w-4xl sm:rounded-xl"><div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] p-5"><div><div className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-500">Tradovate detail účtu</div><h3 className="mt-1 text-xl font-black text-[var(--text-primary)]">{profile?.displayName || account.name}</h3><div className="mt-1 text-xs text-[var(--text-secondary)]">{[profile?.propFirm, profile?.planName, profile?.accountType].filter(Boolean).join(' · ') || `Tradovate ${account.id}`}</div></div><button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg-page)] text-[var(--text-secondary)] hover:text-rose-500"><X size={19} /></button></div><div className="space-y-5 p-5"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><DetailMetric label="Balance" value={optionalMoney(account.balance.totalCashValue)} /><DetailMetric label="Net liq" value={optionalMoney(account.balance.netLiq)} /><DetailMetric label="Realized P&L" value={account.balance.realizedPnL == null ? 'nedostupné' : signedMoney(account.balance.realizedPnL)} color={pnlColor(account.balance.realizedPnL)} /><DetailMetric label="Open P&L" value={account.balance.openPnL == null ? 'nedostupné' : signedMoney(account.balance.openPnL)} color={pnlColor(account.balance.openPnL)} /></div><div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4"><div className="mb-4 flex items-center justify-between"><div><b className="text-xs">RISK A PROP PRAVIDLA</b><div className="mt-1 text-[10px] text-[var(--text-secondary)]">API hodnoty, případně ručně zadaný profil</div></div><ShieldAlert size={19} className={cushion != null && cushion <= 500 ? 'text-rose-500' : 'text-indigo-500'} /></div><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><DetailMetric label="Account size" value={optionalMoney(profile?.accountSize ?? null)} /><DetailMetric label="Max loss" value={optionalMoney(profile?.maxLoss ?? null)} /><DetailMetric label="Floor" value={optionalMoney(floor)} /><DetailMetric label="Rezerva" value={optionalMoney(cushion)} color={cushion != null && cushion <= 500 ? 'text-rose-500' : undefined} /><DetailMetric label="Daily loss" value={optionalMoney(profile?.dailyLossLimit ?? account.risk.dailyLossAutoLiq)} /><DetailMetric label="Profit target" value={optionalMoney(profile?.profitTarget ?? null)} /><DetailMetric label="Realized DD" value={optionalMoney(account.history.realizedBalanceDrawdown)} /><DetailMetric label="Poplatky" value={money.format(account.activity.knownFees)} /></div></div><div><h4 className="mb-3 text-xs font-black uppercase tracking-wider text-[var(--text-secondary)]">Denní historie z Tradovate</h4><div className="overflow-x-auto rounded-md border border-[var(--border-subtle)]"><table className="w-full min-w-[560px] text-left text-xs"><thead className="bg-[var(--bg-page)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)]"><tr><th className="px-3 py-2">Trade date</th><th className="px-3 py-2 text-right">EOD balance</th><th className="px-3 py-2 text-right">Reported P&L</th><th className="px-3 py-2 text-right">Cash delta</th><th className="px-3 py-2 text-right">Trades</th></tr></thead><tbody>{account.daily.map(day => <tr key={day.tradeDate} className="border-t border-[var(--border-subtle)]"><td className="px-3 py-2 font-bold">{day.tradeDate}</td><td className="px-3 py-2 text-right">{optionalMoney(day.endingBalance)}</td><td className={`px-3 py-2 text-right font-bold ${pnlColor(day.reportedRealizedPnl)}`}>{day.reportedRealizedPnl == null ? '—' : signedMoney(day.reportedRealizedPnl)}</td><td className={`px-3 py-2 text-right ${pnlColor(day.cashDelta)}`}>{signedMoney(day.cashDelta)}</td><td className="px-3 py-2 text-right">{day.pairedTradeCount}</td></tr>)}{account.daily.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-center text-[var(--text-secondary)]">Tradovate nevrátil žádný denní záznam.</td></tr> : null}</tbody></table></div></div><div><h4 className="mb-3 text-xs font-black uppercase tracking-wider text-[var(--text-secondary)]">Pozice</h4><div className="space-y-2">{account.positions.map(position => <div key={position.id ?? position.contractId} className="grid grid-cols-2 gap-3 rounded-md border border-[var(--border-subtle)] p-4 sm:grid-cols-4"><DetailMetric label="Symbol" value={position.symbol ?? String(position.contractId)} /><DetailMetric label="Net pozice" value={String(position.netPosition)} /><DetailMetric label="Průměr" value={position.averagePrice == null ? '—' : number.format(position.averagePrice)} /><DetailMetric label="Trade date" value={position.tradeDate ?? '—'} /></div>)}{account.positions.length === 0 ? <Empty text="Účet nemá načtenou pozici." /> : null}</div></div><div className="text-[10px] text-[var(--text-secondary)]">Historie: {account.history.coverage.availability} · fills {account.activity.fillCount} · příkazy {account.activity.orderCount}</div></div></div></div>;
};

const MetricCard = ({ label, value, sub, icon: Icon, color = 'text-[var(--text-primary)]' }: { label: string; value: string; sub: string; icon: React.ElementType; color?: string }) => <div className="flex min-h-[132px] flex-col justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5"><div className="flex items-start justify-between"><span className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--text-secondary)]">{label}</span><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500"><Icon size={17} /></span></div><div><div className={`text-2xl font-black tabular-nums ${color}`}>{value}</div><div className="mt-1 text-xs text-[var(--text-secondary)]">{sub}</div></div></div>;
const DetailMetric = ({ label, value, color = 'text-[var(--text-primary)]' }: { label: string; value: string; color?: string }) => <div><div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">{label}</div><div className={`mt-1 text-sm font-black tabular-nums lg:text-base ${color}`}>{value}</div></div>;
const MobileMetric = ({ label, children }: { label: string; children: React.ReactNode }) => <div><div className="mb-1 text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)] lg:hidden">{label}</div>{children}</div>;
const IconButton = ({ label, onClick, disabled, small = false, children }: { label: string; onClick: () => void; disabled?: boolean; small?: boolean; children: React.ReactNode }) => <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className={`flex items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40 ${small ? 'h-7 w-7' : 'h-9 w-9'}`}>{children}</button>;
const Empty = ({ text }: { text: string }) => <div className="col-span-full py-8 text-center text-sm text-[var(--text-secondary)]">{text}</div>;

export default TradovateLiveDesk;
