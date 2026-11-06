import type { LocalCopierAgentStatus } from './localCopierAgentProtocol.js';
import { sanitizeCopyGroups, type CopyGroupConfig } from '../services/liveCopyTrading.js';

export const COPIER_RISK_CONFIG_CAPABILITY = 'risk-config-v1';
/** Worker vyžaduje u ON po incidentu výslovné potvrzení (8. 10. 2026). */
export const COPIER_INCIDENT_ACK_CAPABILITY = 'incident-ack-v1';

/** Worker umí vyřadit followera i s jeho vlastní pozicí (10. 10. 2026). */
export const COPIER_FOLLOWER_EXCLUDE_EXPOSURE_CAPABILITY = 'follower-exclude-exposure-v1';

export const supportsCopierFollowerExcludeWithExposure = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_FOLLOWER_EXCLUDE_EXPOSURE_CAPABILITY);

/** Worker po výpadku spojení sám pokračuje (10. 10. 2026; jen se serverovou pojistkou). */
export const COPIER_TRANSPORT_AUTO_RESUME_CAPABILITY = 'transport-auto-resume-v1';

export const supportsCopierTransportAutoResume = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_TRANSPORT_AUTO_RESUME_CAPABILITY);

/** Worker umí odeslat ruční vstup z grafu na leadera (fáze 1b, 29. 10. 2026). */
export const COPIER_MANUAL_ENTRY_CAPABILITY = 'manual-entry-v1';

export const supportsCopierManualEntry = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_CAPABILITY);

/**
 * Worker umí nativní Market ručního vstupu (`orderType: 'Market'` bez ceny,
 * 2. 11. 2026). Bez ní panel Market nenabídne — žádný převod na Limit.
 */
export const COPIER_MANUAL_ENTRY_MARKET_CAPABILITY = 'manual-entry-market-v1';

export const supportsCopierManualEntryMarket = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_MARKET_CAPABILITY);

/**
 * Worker umí holý Market bez SL/TP (telefonní lišta) a doplnění SL/TP k němu
 * (`attach-brackets`), 2. 11. 2026 — jen manual-only DEMO skupina.
 */
export const COPIER_MANUAL_ENTRY_BARE_CAPABILITY = 'manual-entry-bare-v1';

export const supportsCopierManualEntryBare = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_BARE_CAPABILITY);

/**
 * Worker umí přikoupení do otevřené pozice a správu celé pozice (3. 11. 2026,
 * docs/reviews/scale-in-design-20261102.md) — jen manual-only DEMO s opt-inem instalace.
 */
export const COPIER_MANUAL_ENTRY_SCALE_IN_CAPABILITY = 'manual-entry-scale-in-v1';

export const supportsCopierManualEntryScaleIn = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_SCALE_IN_CAPABILITY);

/** Worker umí spravovat vlastní ruční vstup z grafu (fáze 2a, 29. 10. 2026). */
export const COPIER_MANUAL_ORDER_MANAGE_CAPABILITY = 'manual-order-manage-v1';

export const supportsCopierManualOrderManage = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_MANAGE_CAPABILITY);

/** Worker umí posunout SL/TP nevyplněného vstupu a TP blíž k trhu (5. 11. 2026, sólo DEMO s `--pending-legs on`). */
export const COPIER_MANUAL_ORDER_MOVE_LIMIT_CAPABILITY = 'manual-order-move-limit-v2';
export const supportsCopierManualOrderMoveLimit = (status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined): boolean =>
  Array.isArray(status?.capabilities) && status.capabilities.includes(COPIER_MANUAL_ORDER_MOVE_LIMIT_CAPABILITY);

export const COPIER_MANUAL_ORDER_PENDING_LEGS_CAPABILITY = 'manual-order-pending-legs-v1';

export const supportsCopierManualOrderPendingLegs = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_PENDING_LEGS_CAPABILITY);

/** Worker umí zavřít obchod leadera z grafu (fáze 2d, 30. 10. 2026). */
export const COPIER_MANUAL_ORDER_CLOSE_CAPABILITY = 'manual-order-close-v1';

export const supportsCopierManualOrderClose = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_CLOSE_CAPABILITY);

/**
 * Worker umí × zavřít holý Market bez SL/TP (`close-position` holého záznamu, C8, 3. 11. 2026)
 * — jen sólo skupina (manual-only local-only DEMO bez followerů), zatím jen za zapnuté kopírky.
 * Bez ní UI × u holé pozice nenabídne (zůstává Flatten). Starý worker stejný payload odmítne
 * (`not-own-entry` — `resolveManagedTrade` chce obě nohy), nic neodešle.
 */
export const COPIER_MANUAL_ORDER_CLOSE_BARE_CAPABILITY = 'manual-order-close-bare-v1';

export const supportsCopierManualOrderCloseBare = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_CLOSE_BARE_CAPABILITY);

/**
 * Worker hlásí vlastní čekající vstupy leadera (`controller.pendingOwnEntries` + `pendingCancelContext`)
 * a výsledek `cancel-entry` ověřuje stavem u brokera (C7, 3. 11. 2026): vyplnění během rušení =
 * `rejected` s kódem `entry-filled` / `entry-partially-filled`, nikdy „zrušeno“. Bez ní UI „Zrušit
 * čekající“ ani Dashboard „Zrušit příkaz“ nenabídne. Žádný nový příkaz: N× existující `cancel-entry`.
 * Starý worker pole nepošle (UI nic nenabídne) a `cancel-order` z Dashboardu dál odmítá.
 */
export const COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY = 'manual-order-cancel-pending-v1';

export const supportsCopierManualOrderCancelPending = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY);

/**
 * Worker sám zruší vlastní čekající vstup z appky (z flat i přikoupení) jedním cíleným pokusem, když
 * nesmí dál existovat (vypnutí, kill, denní zámek / pauza, jen správa, konec okna, denní pauza CME
 * 15:55–17:00 CT, konec session, vypršení ARM; pozice mimo appku jen upozorní), výsledek ověří stavem
 * u brokera a hlásí ho v `controller.manualEntries[]` (`cancelVerified`, `cancelReason`, `autoCancelAt`,
 * `autoCancelReason`) — C12, 4. 11. 2026. Bez ní UI netvrdí „zruší se sám v …“ a „zrušen“ (starý worker
 * přikoupení ruší, vstup z flat ne). Žádný nový příkaz ani payload; nic zobrazovacího nic neautorizuje.
 */
export const COPIER_MANUAL_ENTRY_AUTO_CANCEL_CAPABILITY = 'manual-entry-auto-cancel-v1';

export const supportsCopierManualEntryAutoCancel = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_AUTO_CANCEL_CAPABILITY);

/** Worker umí smazat svou skupinu a běžet bez skupiny (11. 10. 2026). */
export const COPIER_GROUP_DELETE_CAPABILITY = 'group-delete-v1';

export const supportsCopierGroupDelete = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_GROUP_DELETE_CAPABILITY);

/**
 * Execution skupina workeru, nebo `null`, když ji operátor smazal a worker
 * běží bez skupiny (`group` ve statusu je pak jen poslední známý zástupce).
 */
export const copierWorkerExecutionGroup = (
  status: Pick<LocalCopierAgentStatus, 'group' | 'controller'> | null | undefined,
): CopyGroupConfig | null => {
  if (!status) return null;
  const retired = status.controller?.retiredGroup;
  return retired && retired.groupId === status.group.id ? null : status.group;
};

export const supportsCopierIncidentAck = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_INCIDENT_ACK_CAPABILITY);

export const supportsCopierRiskConfig = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_RISK_CONFIG_CAPABILITY);

/**
 * A transport ACK does not prove that a worker understood every setting.
 * Legacy workers accepted update-group but stripped unknown risk fields.
 * Check capability and the returned configuration before announcing a save.
 * Defaults and follower order have no effect on the comparison.
 */
export const assertCopierRiskConfigAcknowledged = (
  requested: CopyGroupConfig,
  acknowledged: LocalCopierAgentStatus,
): void => {
  if (!supportsCopierRiskConfig(acknowledged)) {
    throw new Error('Mac worker nepodporuje nová Risk pravidla. Nejdřív aktualizuj worker; uložení nebylo potvrzeno.');
  }
  const expected = sanitizeCopyGroups([requested])?.[0];
  const actual = sanitizeCopyGroups([acknowledged.group])?.[0];
  if (!expected || !actual) {
    throw new Error('Worker nevrátil platnou konfiguraci Risk. Uložení nebylo potvrzeno.');
  }

  const differences: string[] = [];
  if (expected.id !== actual.id || expected.leaderAccountId !== actual.leaderAccountId) {
    differences.push('skupina');
  }
  for (const key of Object.keys(expected.safety!) as Array<keyof NonNullable<CopyGroupConfig['safety']>>) {
    if (JSON.stringify(expected.safety![key]) !== JSON.stringify(actual.safety![key])) {
      differences.push(`safety.${key}`);
    }
  }
  const actualFollowers = new Map(actual.followers.map(follower => [follower.accountId, follower]));
  if (actualFollowers.size !== actual.followers.length
    || new Set(expected.followers.map(follower => follower.accountId)).size !== expected.followers.length
    || expected.followers.length !== actual.followers.length) {
    differences.push('účty skupiny');
  }
  for (const follower of expected.followers) {
    const returned = actualFollowers.get(follower.accountId);
    if (!returned) {
      differences.push(`účet ${follower.accountId}`);
      continue;
    }
    for (const key of ['maxContracts', 'dailyLossCutUsd', 'onCut'] as const) {
      const fallback = key === 'onCut' ? 'close-copy' : undefined;
      if ((follower[key] ?? fallback) !== (returned[key] ?? fallback)) {
        differences.push(`účet ${follower.accountId}: ${key}`);
      }
    }
  }
  if (differences.length > 0) {
    throw new Error(`Worker nepotvrdil požadované Risk nastavení (${differences.join(', ')}). Zkontroluj skutečný stav workeru před dalším použitím.`);
  }
};
