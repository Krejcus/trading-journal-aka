import React, { useRef, useState } from 'react';
import { AlertTriangle, Pause } from 'lucide-react';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import type {
  CopyFollowerConfig,
  CopyGroupConfig,
  CopyGroupSafetySettings,
} from '../services/liveCopyTrading';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';
import LiveAccountRiskTable from './LiveAccountRiskTable';
import LiveDayRulesCard, { DayLockBanner } from './LiveDayRulesCard';

const time = new Intl.DateTimeFormat('cs-CZ', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Prague',
});

type PauseRule = NonNullable<CopierControllerStatus['pause']>['rule'];

const PAUSE_RULE_LABELS: Record<PauseRule, string> = {
  'losing-trades': 'Max ztrátových obchodů za den',
  'daily-loss': 'Denní ztrátový limit',
  'max-trades': 'Max obchodů za den',
  'window-end': 'Konec obchodního okna',
};

export interface LiveRiskTabProps {
  snapshot: LiveSnapshot;
  accountProfiles?: TradovateAccountProfile[];
  group: CopyGroupConfig | null;
  status: CopierControllerStatus | null;
  brokerDailyPnlByAccount?: Readonly<Record<string, number | null>>;
  brokerDailyPnlPending?: boolean;
  disabled?: boolean;
  runtimeAvailable?: boolean;
  riskConfigSupported?: boolean;
  now?: number;
  onSaveGroup?: (group: CopyGroupConfig) => Promise<void> | void;
}

export const LiveRiskTab = ({
  snapshot,
  accountProfiles = [],
  group,
  status,
  brokerDailyPnlByAccount,
  brokerDailyPnlPending = false,
  disabled = false,
  runtimeAvailable = false,
  riskConfigSupported = false,
  now = Date.now(),
  onSaveGroup,
}: LiveRiskTabProps) => {
  const savePendingRef = useRef(false);
  const [savePending, setSavePending] = useState(false);
  const dayLockUntil = runtimeAvailable ? status?.dayLockUntil ?? 0 : 0;
  const dayLocked = dayLockUntil > now;
  const pause = runtimeAvailable && !dayLocked && status?.pause && status.pause.until > now
    ? status.pause
    : null;
  const writesDisabled = disabled || !runtimeAvailable || !riskConfigSupported || savePending || status == null || group == null || onSaveGroup == null;
  // lastError is diagnostic history, not evidence that a fault is still active.
  // Only fresh runtime flags describe the current blocker; stale flags are unknown.
  const runtimeKnown = runtimeAvailable && status != null;
  const blockers = !runtimeKnown
    ? ['Aktuální stav workeru není ověřený. Počkej na obnovení spojení; poslední uložená chyba nemusí být aktuální.']
    : [
      status.killSwitch ? 'Je aktivní nouzové zastavení.' : null,
      status.started === false ? 'Worker nemá spuštěný běh kopírky.' : null,
      !status.connected ? 'Worker není připojený k brokerovi. Počkej na obnovení spojení.' : null,
      status.reconciliationRequired ? `Worker vyžaduje kontrolu stavu účtů. ${status.connected ? 'Spusť Kontrolu pozic.' : 'Po obnovení spojení spusť Kontrolu pozic.'}` : null,
      status.divergentAccounts?.length ? 'Pozice účtů nejsou v souladu. Před dalším kopírováním je potřeba ověření.' : null,
      status.stuckOutbox ? 'Výsledek odeslaných příkazů není potvrzený. Je potřeba prověřit nevyřešené operace.' : null,
      status.unverifiableFollowerOwnership?.length ? 'Vlastnictví kopií není ověřené. Je potřeba kontrola účtů.' : null,
    ].filter((message): message is string => message !== null);

  const saveAuthoritativeGroup = group && onSaveGroup
    ? async (nextGroup: CopyGroupConfig) => {
      if (!runtimeAvailable || !riskConfigSupported || disabled) {
        throw new Error('Worker nepotvrdil podporu Risk nastavení nebo není dostupný.');
      }
      if (savePendingRef.current) {
        throw new Error('Jiná změna Risk nastavení čeká na potvrzení workeru.');
      }
      savePendingRef.current = true;
      setSavePending(true);
      try {
        await onSaveGroup(nextGroup);
      } finally {
        savePendingRef.current = false;
        setSavePending(false);
      }
    }
    : undefined;

  const saveSafety = group && saveAuthoritativeGroup
    ? async (safety: CopyGroupSafetySettings) => {
      await saveAuthoritativeGroup({ ...group, safety });
    }
    : undefined;
  const saveFollowers = group && saveAuthoritativeGroup
    ? async (followers: CopyFollowerConfig[]) => {
      await saveAuthoritativeGroup({ ...group, followers });
    }
    : undefined;

  return (
    <div data-live-risk-tab="true" className="space-y-3">
      <DayLockBanner
        until={dayLockUntil}
        at={status?.dayLockAt ?? null}
        trigger={status?.dayLockTrigger ?? null}
        reason={status?.dayLockReason ?? null}
        now={now}
      />

      {pause ? (
        <section
          data-rule-pause-banner="true"
          className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-amber-600"
        >
          <Pause size={18} className="shrink-0" />
          <p className="text-xs font-bold leading-relaxed">
            Pauza do {time.format(pause.until)} · {PAUSE_RULE_LABELS[pause.rule]} · vstupy se nekopírují
          </p>
        </section>
      ) : null}

      {blockers.length > 0 ? (
        <section
          role={runtimeKnown ? 'alert' : 'status'}
          data-copier-current-blocker="true"
          className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <b className="block text-xs font-black">{runtimeKnown ? 'Kopírování blokováno' : 'Stav workeru není ověřený'}</b>
            {blockers.map(message => <p key={message} className="mt-0.5 text-[11px] font-semibold leading-relaxed">{message}</p>)}
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Technické podrobnosti a poslední chyby najdeš v Událostech.</p>
          </div>
        </section>
      ) : null}

      <LiveDayRulesCard
        groupId={group?.id}
        groupName={group?.name}
        safety={group?.safety}
        dailyStats={status?.dailyStats ?? null}
        dayLockUntil={dayLockUntil}
        dayLockTrigger={status?.dayLockTrigger ?? null}
        dayLockAt={status?.dayLockAt ?? null}
        pause={pause}
        sessionArmedAt={status?.sessionArmedAt ?? 0}
        cooldownUntil={status?.entryCooldownUntil ?? 0}
        armedAt={status?.armedAt ?? 0}
        armExpiresAt={status?.armExpiresAt ?? 0}
        runtimeAvailable={runtimeAvailable}
        riskConfigSupported={riskConfigSupported}
        disabled={writesDisabled}
        onSave={saveSafety}
      />

      <LiveAccountRiskTable
        group={group}
        status={status}
        runtimeAvailable={runtimeAvailable}
        riskConfigSupported={riskConfigSupported}
        accounts={snapshot.accounts}
        accountProfiles={accountProfiles}
        accountRisk={status?.accountRisk ?? []}
        followerCuts={status?.followerCuts ?? []}
        brokerDailyPnlByAccount={brokerDailyPnlByAccount}
        brokerDailyPnlPending={brokerDailyPnlPending}
        sessionArmedAt={status?.sessionArmedAt ?? 0}
        disabled={writesDisabled}
        now={now}
        onSave={saveFollowers}
      />
    </div>
  );
};

export default LiveRiskTab;
