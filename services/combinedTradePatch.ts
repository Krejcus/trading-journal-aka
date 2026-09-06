import type { Trade } from '../types';
import { changedTradeFields } from './tradePatch';

export interface CombinedTradeChange { id: string; before: Trade; patch: Partial<Trade> }
/** Each member keeps its own economics and optimistic rollback baseline. */
export const combinedTradeChanges = (members: readonly Trade[], proposed: Partial<Trade>): CombinedTradeChange[] => {
  const { pnl, riskAmount, targetAmount, positionSize, id: _id, ...rest } = proposed;
  const safe: Partial<Trade> = { ...rest };
  if (typeof safe.notes === 'string') safe.notes = safe.notes.replace(/\s*\(Kombinováno z \d+ účtů\)\s*$/, '').trim();
  const master = members.find(member => member.isMaster) ?? members[0];
  const ratio = (a?: number | null, b?: number | null): number | null =>
    a != null && b != null && Math.abs(b) > 0.009 && Number.isFinite(a / b) ? a / b : null;
  const round2 = (value: number) => Math.round(value * 100) / 100;
  return members.flatMap(member => {
    if (typeof member.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(member.id)) return [];
    const factor = master ? ratio(member.pnl, master.pnl) ?? ratio(member.riskAmount, master.riskAmount) ?? ratio(member.positionSize, master.positionSize) ?? 1 : 1;
    const payload: Partial<Trade> = { ...safe };
    if (pnl != null) payload.pnl = round2(pnl * factor);
    if (riskAmount != null) payload.riskAmount = round2(riskAmount * factor);
    if (targetAmount != null) payload.targetAmount = round2(targetAmount * factor);
    if (positionSize != null) payload.positionSize = Math.max(1, Math.round(positionSize * factor));
    const patch = changedTradeFields(member, payload);
    return Object.keys(patch).length ? [{ id: member.id, before: member, patch }] : [];
  });
};
