import { describe, expect, it } from 'vitest';
import {
  LocalCopierAgentCommandError,
  type SnapshotRepairBlockedIssue,
} from '../lib/localCopierAgentProtocol';
import {
  formatSnapshotRepairError,
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
