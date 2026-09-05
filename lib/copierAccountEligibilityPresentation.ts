import type { CopierControllerStatus } from '../services/copierRuntimeController';

export function copierAccountEligibilityPresentation(
  status: CopierControllerStatus | null | undefined,
  accountId: number,
): { key: string; title: string; detail: string; active: boolean } {
  if (!Array.isArray(status?.accountEligibility)) {
    return { key: 'eligibility-unknown', title: 'Způsobilost neověřena', detail: 'Worker neposkytl stav způsobilosti účtů.', active: false };
  }
  // The worker reports exceptions only; an explicit empty array means all active.
  const entry = status.accountEligibility.find(candidate => candidate.accountId === accountId);
  if (!entry || entry.state === 'active') return { key: 'active', title: '', detail: '', active: true };
  const title = entry.state === 'breached'
    ? 'Vyřazen · BREACHED'
    : entry.state === 'dll-locked'
      ? 'Vyřazen · denní limit propky'
      : 'Způsobilost neověřena';
  return { key: entry.state, title, detail: entry.reason ?? '', active: false };
}
