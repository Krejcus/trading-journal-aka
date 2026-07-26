import type { Account, DailyReview, TradingIncidentAllocation } from '../types';
import { firmOf } from '../utils/accountFirm';

export interface FinancialAdjustment {
  id: string;
  incidentId: string;
  date: string;
  timestamp: number;
  amount: number;
  label: string;
  scopeType: TradingIncidentAllocation['scopeType'];
  scopeId?: string;
  accountId?: string;
  firm?: string;
}

/** Incident je jediný zdroj pravdy; nevytváříme pseudo-trade ani druhý DB záznam. */
export function getFinancialAdjustments(reviews: DailyReview[]): FinancialAdjustment[] {
  return reviews.flatMap(review => (review.incidents || []).flatMap(incident =>
    (incident.allocations || []).map(allocation => ({
      id: `${incident.id}:${allocation.id}`,
      incidentId: incident.id,
      date: review.date,
      timestamp: incident.timestamp || new Date(`${review.date}T12:00:00`).getTime(),
      amount: -Math.abs(Number(allocation.lossAmount) || 0),
      label: allocation.label,
      scopeType: allocation.scopeType,
      scopeId: allocation.scopeId,
      accountId: allocation.scopeType === 'account' ? allocation.scopeId : undefined,
      firm: allocation.scopeType === 'firm' ? (allocation.scopeId || allocation.label) : undefined,
    }))
  )).filter(adjustment => adjustment.amount !== 0);
}

export const adjustmentTotal = (adjustments: FinancialAdjustment[]): number =>
  adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);

export const adjustmentForAccount = (adjustments: FinancialAdjustment[], account: Account): number =>
  adjustmentTotal(adjustments.filter(adjustment => adjustment.accountId === account.id));

/** Korekce zadaná přímo na firmu (ne na konkrétní účet). Účtové korekce už nese
 *  pnlByAccount, takže se tímhle sčítat nesmí — jinak by se započítaly dvakrát. */
export const directAdjustmentForFirm = (adjustments: FinancialAdjustment[], firm: string): number =>
  adjustmentTotal(adjustments.filter(adjustment =>
    adjustment.scopeType === 'firm' &&
    firmOf({ name: adjustment.firm || adjustment.label } as Account) === firm
  ));
