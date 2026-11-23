/**
 * Parametry prop účtu pro kokpit (drawdown, denní limit, consistency, cíl).
 * Dřív je plnil Tradovate onboarding (`tradovate_account_profiles`, odstraněno 23. 11. 2026);
 * typ zůstává obecný pro budoucí účty z Rithmicu.
 */
export type PropAccountDrawdownType = 'trailing' | 'eod_trailing' | 'static' | 'none';

export interface PropAccountProfile {
  planName: string | null;
  accountSize: number | null;
  drawdownType: PropAccountDrawdownType | null;
  maxLoss: number | null;
  dailyLossLimit: number | null;
  consistencyPct: number | null;
  profitTarget: number | null;
}
