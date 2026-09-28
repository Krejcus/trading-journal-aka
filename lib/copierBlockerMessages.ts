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

const rawMessage = (reason: unknown): string => (
  reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
).replace(/\s+/g, ' ').trim();

const accountNamesFromMessage = (
  message: string,
  accountName: (accountId: number) => string | null,
): string[] => [...new Set(
  (message.match(/\b\d{4,}\b/g) ?? [])
    .map(value => accountName(Number(value)))
    .filter((value): value is string => Boolean(value)),
)];

/**
 * UI-only překlad známých odmítnutí execution workeru. Audit a původní Error
 * se nemění; uživatel dostane konkrétní další krok místo interního kódu.
 */
export function formatCopierCommandError(
  reason: unknown,
  accountName: (accountId: number) => string | null = () => null,
): string {
  const message = rawMessage(reason);
  const names = accountNamesFromMessage(message, accountName);
  const namedAccounts = names.length > 0 ? names.join(', ') : 'Vybraný účet';

  if (/stav se (?:během .* )?změnil|stav se změnil během (?:kontroly|read-only preflightu)/i.test(message)) {
    return 'Stav se změnil během kontroly. Počkej pár sekund a změnu zopakuj.';
  }
  if (/nevyřešený durable outbox|stuck[- ]outbox/i.test(message)) {
    return 'Změnu blokuje nevyřešená operace. Otevři Události, ověř její výsledek a vyřeš ji; potom změnu ulož znovu.';
  }
  if (/group-config-armed|copier-armed|kopírk\w* (?:je )?(?:zapnut|armed)|\barmed\b.*(?:group|config|změn)/i.test(message)) {
    return 'Kopírka je zapnutá. Nejdřív ji bezpečně vypni, potom změnu skupiny ulož znovu.';
  }
  if (/ne(?:ní|jsou) viditeln(?:ý|é) v žádném připojeném OAuth|není zapojené do běžící kopírky|neaktivní\/read-only účty/i.test(message)) {
    const multiple = names.length > 1;
    return `${namedAccounts} ${multiple ? 'nejsou' : 'není'} ve Mac workeru. Přidej ${multiple ? 'jejich' : 'jeho'} OAuth připojení do manifestu workeru a proveď bezpečný reinstall; samotné připojení v Connections nestačí.`;
  }
  if (/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/i.test(message)) {
    return 'Mac worker změnu odmítl. Otevři Události, zkontroluj konkrétní blokaci a změnu zopakuj až po jejím vyřešení.';
  }
  return message || 'Akci se nepodařilo dokončit. Ověř stav workeru a zkus ji znovu.';
}
