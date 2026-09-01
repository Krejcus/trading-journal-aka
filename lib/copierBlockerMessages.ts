import {
  localCopierAgentErrorDetails,
  type LocalCopierAgentRestartBlocker,
  type SnapshotRepairBlockedIssue,
} from './localCopierAgentProtocol';

const accountList = (accountIds: readonly number[], label: (accountId: number) => string) =>
  accountIds.map(accountId => label(accountId)).join(', ');

export function snapshotRepairBlockedMessage(
  issue: SnapshotRepairBlockedIssue,
  accountLabel: (accountId: number) => string,
): string {
  const parts: string[] = [];
  const handled = new Set<LocalCopierAgentRestartBlocker>();
  const add = (blocker: LocalCopierAgentRestartBlocker, message: string) => {
    if (!issue.blockers.includes(blocker) || handled.has(blocker)) return;
    handled.add(blocker);
    parts.push(message);
  };

  add('status-unavailable', 'stav workeru není dostupný');
  add('not-started', 'worker není spuštěný');
  add('armed', 'copier je ARMED');
  add('kill-switch', 'kill switch je aktivní');
  add('disconnected', 'worker není připojený');
  add('reconciliation-required', 'reconciliation je nutná');
  add('group-not-flat', 'skupina není flat');
  add('divergent-accounts', issue.divergentAccounts.length > 0
    ? `${issue.divergentAccounts.length === 1 ? 'divergentní účet' : 'divergentní účty'} ${accountList(issue.divergentAccounts, accountLabel)}`
    : 'účty mají rozdílné pozice');
  add('working-orders', issue.workingOrderAccounts.length > 0
    ? `pracovní příkazy na ${accountList(issue.workingOrderAccounts, accountLabel)}`
    : 'existují pracovní příkazy');
  add('stuck-outbox', 'outbox obsahuje nevyřešenou operaci');
  add('stuck-operations', 'existují operace čekající na ruční kontrolu');
  add('preflight-missing', issue.missingAccounts.length > 0
    ? `v OAuth chybí ${accountList(issue.missingAccounts, accountLabel)}`
    : 'OAuth preflight hlásí chybějící účet');
  add('preflight-inactive', issue.inactiveAccounts.length > 0
    ? `neaktivní ${accountList(issue.inactiveAccounts, accountLabel)}`
    : 'OAuth preflight hlásí neaktivní účet');
  add('preflight-read-only-followers', issue.readOnlyFollowerAccounts.length > 0
    ? `bez execution oprávnění ${accountList(issue.readOnlyFollowerAccounts, accountLabel)}`
    : 'follower nemá execution oprávnění');

  for (const blocker of issue.blockers) {
    if (!handled.has(blocker)) parts.push(blocker);
  }
  return `Obnova snímků blokována: ${parts.join('; ') || 'worker není v bezpečném stavu'}.`;
}

/** Nový worker dostane konkrétní český rozpis; starý zachová původní text. */
export function formatSnapshotRepairError(
  reason: unknown,
  accountLabel: (accountId: number) => string,
): string {
  const details = localCopierAgentErrorDetails(reason);
  if (details?.code === 'snapshot-repair-blocked') {
    return snapshotRepairBlockedMessage(details, accountLabel);
  }
  return reason instanceof Error ? reason.message : String(reason);
}
