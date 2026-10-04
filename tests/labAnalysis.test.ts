import { describe, expect, it } from 'vitest';
import { labDays, labInvalidReasons, labPlanComparison, labSimulateRule, labStats } from '../lib/labAnalysis';
import type { LabDecision } from '../lib/labDataset';

let seq = 0;
/** Rozhodnutí jednoho dne v pořadí; čas = HH:MM Praha (letní čas, UTC+2). */
function day(dayKey: string, rows: Array<{ t: string; pnl: number; size?: number; dir?: 'Long' | 'Short'; r?: number | null; plan?: 'yes' | 'no'; reasons?: string[]; hold?: number }>): LabDecision[] {
  const out: LabDecision[] = [];
  for (const row of rows) {
    const [h, m] = row.t.split(':').map(Number);
    const entryAt = Date.parse(`${dayKey}T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
    const exitAt = entryAt + (row.hold ?? 2) * 60_000;
    const previous = out[out.length - 1];
    out.push({
      id: `d${++seq}`, leaderTradeId: `t${seq}`, memberTradeIds: [`t${seq}`], accountIds: ['a'], leaderAccountId: 'a', leaderKnown: true,
      instrument: 'MNQ', pointValue: 2, direction: row.dir ?? 'Long', entryAt, exitAt, holdMs: exitAt - entryAt,
      dayKey, weekday: 2, entryMinute: h * 60 + m, session: 'NY open',
      orderInDay: out.length + 1, minutesSincePrevExit: previous ? (entryAt - previous.exitAt) / 60_000 : null,
      afterLoss: previous ? previous.pnlUsd < 0 : false, directionFlip: previous ? previous.direction !== (row.dir ?? 'Long') : false,
      size: row.size ?? 2, entryPrice: 30000, exitPrice: 30010, points: 10, pnlUsd: row.pnl, feesUsd: null, groupPnlUsd: row.pnl,
      sl: null, slSource: null, tp: null, riskPoints: null, riskUsd: null, r: row.r === undefined ? row.pnl / 100 : row.r, plannedRR: null,
      exitKind: 'manual', plan: row.plan ?? null, reviewed: row.plan != null, invalidReasons: row.reasons ?? [],
      htf: [], ltf: [], emotions: [], mistakes: [], management: null,
    });
  }
  return out;
}

// 2. 9. (podle deníku): čisté dopoledne, večer dohánění — rychlé návraty, otočení, větší velikost.
const tiltDay = day('2026-09-02', [
  { t: '09:42', pnl: 160 }, { t: '10:15', pnl: 120 }, { t: '10:58', pnl: 220 }, { t: '11:40', pnl: -80 },
  { t: '17:48', pnl: -240, size: 8 }, { t: '17:51', pnl: -320, size: 17, dir: 'Short' },
  { t: '18:26', pnl: -180, size: 18 }, { t: '18:31', pnl: -220, size: 20, dir: 'Short' }, { t: '18:36', pnl: 60, size: 19 },
]);
const calmDay = day('2026-09-03', [{ t: '15:35', pnl: 200 }, { t: '15:58', pnl: -100 }, { t: '16:40', pnl: 150 }]);

describe('labStats', () => {
  it('counts R only where a stop exists and leaves break-even out of the win rate', () => {
    const stats = labStats(day('2026-10-01', [{ t: '15:35', pnl: 100, r: 1 }, { t: '15:50', pnl: 0, r: 0 }, { t: '16:10', pnl: -50, r: null }]), 'r');
    expect(stats).toMatchObject({ count: 3, covered: 2, wins: 1, losses: 0, winRate: 1, total: 1, average: 0.5 });
    expect(labStats(day('2026-10-01', [{ t: '15:35', pnl: 100 }, { t: '16:10', pnl: -50 }]), 'usd').equity.map(p => p.value)).toEqual([100, 50]);
  });
});

describe('labPlanComparison + labInvalidReasons', () => {
  it('splits reviewed decisions by plan and prices the reasons', () => {
    const decisions = day('2026-10-01', [
      { t: '15:35', pnl: 300, plan: 'yes' }, { t: '15:50', pnl: -200, plan: 'no', reasons: ['Revenge'] },
      { t: '16:10', pnl: -100, plan: 'no', reasons: ['Revenge', 'Pozdní vstup'] }, { t: '16:30', pnl: -50, plan: 'no' }, { t: '16:45', pnl: 80 },
    ]);
    const plan = labPlanComparison(decisions, 'usd');
    expect(plan.reviewed).toBe(4);
    expect([plan.yes.total, plan.no.total, plan.unreviewed.total]).toEqual([300, -350, 80]);
    expect(labInvalidReasons(decisions, 'usd').map(r => [r.reason, r.count, r.total])).toEqual([
      ['Revenge', 2, -300], ['Pozdní vstup', 1, -100], ['Bez důvodu', 1, -50],
    ]);
  });
});

describe('labDays', () => {
  it('flags the day where the size escalated after a loss', () => {
    const [tilt, calm] = labDays([...calmDay, ...tiltDay]);
    expect(tilt).toMatchObject({ dayKey: '2026-09-02', tilt: true, baseSize: 2, breakIndex: 4 }); // 17:48 po ztrátě 8 ks = 4× úvodní
    expect(tilt.signals[5]).toEqual(['quick', 'flip', 'escalation']);
    expect(calm.tilt).toBe(false);
  });

  it('does not call quick re-entries and a flip a tilt without the size (1. 10.)', () => {
    const [oct1] = labDays(day('2026-10-01', [
      { t: '09:25', pnl: -105, size: 7 }, { t: '09:44', pnl: -253, size: 6, dir: 'Short' }, { t: '10:05', pnl: 1353, size: 8, dir: 'Short' },
    ]));
    expect(oct1.tilt).toBe(false);
    expect(oct1.signals[1]).toEqual(['flip']);
  });
});

describe('labSimulateRule', () => {
  const days = labDays([...tiltDay, ...calmDay]);

  it('stops the day after the second loss', () => {
    const result = labSimulateRule(days, { kind: 'maxLosses', count: 2 });
    const tilt = result.days.find(d => d.dayKey === '2026-09-02')!;
    expect(tilt.actual).toBe(-480);
    expect(tilt.simulated).toBe(180); // 160+120+220−80−240, pak konec
    expect(tilt.stopAt?.entryMinute).toBe(17 * 60 + 51);
    expect(result.days.find(d => d.dayKey === '2026-09-03')!.affected).toEqual([]);
    expect(result).toMatchObject({ affectedDays: 1, added: 660, taken: 0, net: 660 });
  });

  it('shrinks a bigger size after a loss instead of skipping it', () => {
    const result = labSimulateRule(labDays(day('2026-09-04', [{ t: '15:35', pnl: -100, size: 2 }, { t: '15:40', pnl: 400, size: 8 }])), { kind: 'noSizeUp' });
    expect(result.days[0].simulated).toBe(0); // −100 + 400 × 2/8
    expect(result.taken).toBe(-300);
  });

  it('pauses after a loss and ends the day at a time', () => {
    const cooldown = labSimulateRule(days, { kind: 'cooldown', minutes: 15 }).days.find(d => d.dayKey === '2026-09-02')!;
    expect(cooldown.affected.map(d => d.entryMinute)).toEqual([17 * 60 + 51, 18 * 60 + 31, 18 * 60 + 36]);
    const end = labSimulateRule(days, { kind: 'endAt', minute: 17 * 60 }).days.find(d => d.dayKey === '2026-09-02')!;
    expect(end.simulated).toBe(420);
  });
});
