import { describe, expect, it } from 'vitest';
import {
  LocalCopierAgentCommandError,
  type SnapshotRepairBlockedIssue,
} from '../lib/localCopierAgentProtocol';
import {
  formatSnapshotRepairError,
  formatCopierCommandError,
  snapshotRepairBlockedMessage,
} from '../lib/copierBlockerMessages';

const issue: SnapshotRepairBlockedIssue = {
  code: 'snapshot-repair-blocked',
  blockers: [
    'reconciliation-required',
    'divergent-accounts',
    'preflight-missing',
    'preflight-inactive',
  ],
  divergentAccounts: [57],
  workingOrderAccounts: [],
  missingAccounts: [58],
  inactiveAccounts: [59],
  readOnlyFollowerAccounts: [],
};

const label = (accountId: number) => ({
  57: 'TDFYG50335049318 (ID 57)',
  58: 'Missing profile (ID 58)',
  59: 'Inactive profile (ID 59)',
}[accountId] ?? `Účet ${accountId}`);

describe('snapshot repair UI blockers', () => {
  it('přeloží reconciliation, divergence a OAuth preflight účty do českých názvů', () => {
    expect(snapshotRepairBlockedMessage(issue, label)).toBe(
      'Obnova snímků blokována: reconciliation je nutná; divergentní účet TDFYG50335049318 (ID 57); v OAuth chybí Missing profile (ID 58); neaktivní Inactive profile (ID 59).',
    );
  });

  it('ze strukturované chyby nového workeru vykreslí konkrétní blokery', () => {
    const error = new LocalCopierAgentCommandError('legacy fallback', issue);
    expect(formatSnapshotRepairError(error, label)).toContain('divergentní účet TDFYG50335049318 (ID 57)');
  });

  it('u starého workeru bez struktury zachová původní obecný text', () => {
    const fallback = 'TradingView lze obnovit pouze při připojeném, reconciled, DISARMED a flat workeru bez pracovních příkazů.';
    expect(formatSnapshotRepairError(new Error(fallback), label)).toBe(fallback);
  });
});

describe('group change rejection messages', () => {
  const accountName = (accountId: number) => ({
    67409592: 'FundedNext 50K A',
    67409600: 'FundedNext 50K B',
  }[accountId] ?? null);

  it('přeloží race, zapnutou kopírku a outbox na konkrétní další krok bez raw kódu', () => {
    expect(formatCopierCommandError(new Error('Změnu skupiny: stav se změnil během kontroly; opakuj ověření'), accountName))
      .toBe('Stav se změnil během kontroly. Počkej pár sekund a změnu zopakuj.');
    expect(formatCopierCommandError(new Error('group-config-armed'), accountName))
      .toBe('Kopírka je zapnutá. Nejdřív ji bezpečně vypni, potom změnu skupiny ulož znovu.');
    expect(formatCopierCommandError(new Error('Změnu skupiny blokuje nevyřešený durable outbox'), accountName))
      .toContain('Otevři Události');
  });

  it('místo ID ukáže jméno a vysvětlí, že samotné Connections bez manifestu nestačí', () => {
    const message = formatCopierCommandError(
      new Error('Účty 67409592, 67409600 nejsou viditelné v žádném připojeném OAuth'),
      accountName,
    );
    expect(message).toContain('FundedNext 50K A, FundedNext 50K B');
    expect(message).toContain('nejsou ve Mac workeru');
    expect(message).toContain('manifestu workeru');
    expect(message).toContain('bezpečný reinstall');
    expect(message).not.toContain('67409592');
    expect(message).toContain('samotné připojení v Connections nestačí');
  });
});
