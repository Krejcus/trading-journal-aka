// 12. 11. 2026: posun SL/TP čekajícího vstupu ve skupině se v appce nabízí jen s capability workeru.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { supportsCopierGroupPendingLegs } from '../lib/copierWorkerCapabilities';
import { liveLineMoveBlockReason } from '../lib/liveChartOrderLines';

describe('skupinový posun SL/TP před vyplněním: nabídka v appce', () => {
  it('capability se čte přesně', () => {
    expect(supportsCopierGroupPendingLegs({ capabilities: ['manual-group-limit-pending-legs-v1'] })).toBe(true);
    expect(supportsCopierGroupPendingLegs({ capabilities: ['manual-group-limit-move-v1'] })).toBe(false);
    expect(supportsCopierGroupPendingLegs(undefined)).toBe(false);
  });
  it('bez povolení se čára nohy čekajícího vstupu táhnout nedá, s povolením se kontroluje jen strana', () => {
    const summary = { kind: 'pending', side: 'long', entry: 29_500, entryType: 'Limit', stop: 29_480, target: 29_560, quantity: 2 } as never;
    expect(liveLineMoveBlockReason(summary, 'stopLoss', 29_470, {})).toBe('Posun jde až u vyplněné pozice.');
    expect(liveLineMoveBlockReason(summary, 'stopLoss', 29_470, { pendingLegs: true })).toBeNull();
    expect(liveLineMoveBlockReason(summary, 'stopLoss', 29_510, { pendingLegs: true })).not.toBeNull();
  });
  it('desk posílá posun čekajících nohou skupiny s množstvím vstupu a jen s capability', () => {
    const desk = readFileSync(new URL('../components/TradovateLiveDesk.tsx', import.meta.url), 'utf8');
    expect(desk).toContain('supportsCopierGroupPendingLegs(current.status)');
    expect(desk).toContain("action === 'move-limit' || pendingLegMove ? groupLeader?.entry?.quantity");
  });
});
