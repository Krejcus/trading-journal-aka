import { describe, it, expect } from 'vitest';
import { buildLabDatasetFromTrades, computeOverview, computeCfSummary, computeBiasSummary } from '../services/labAnalytics';
import type { Trade } from '../types';

// Minimální validní Trade pro Lab — přepíšeš jen co test potřebuje.
let seq = 0;
const mk = (p: Partial<Trade>): Trade => ({
  id: `t${seq++}`, accountId: 'acc', signal: 'sig', pnl: 0, runUp: 0, drawdown: 0,
  date: '2026-01-05T16:00:00.000Z', direction: 'Long', riskAmount: 100,
  ...p,
} as Trade);

describe('dedupeDecisions — fan-out kopie = 1 rozhodnutí', () => {
  // REGRESE: AlphaBridge fan-out dává masteru groupId (bez masterTradeId) a kopiím
  // groupId + masterTradeId (JINÉ UUID). Klíčování masterTradeId>groupId je dřív
  // rozdělilo do dvou skupin → každé rozhodnutí se počítalo 2×.
  it('AlphaBridge mix (master: groupId+isMaster, kopie: groupId+masterTradeId) → 1 datapoint', () => {
    const master = mk({ id: 'M', groupId: 'G', isMaster: true, pnl: 100 });
    const copy = mk({ id: 'C', groupId: 'G', masterTradeId: 'M', pnl: 200 });
    const ds = buildLabDatasetFromTrades([master, copy]);
    expect(ds.coverage.total).toBe(1);
  });

  it('tradesyncer styl (master: isMaster, kopie: masterTradeId, bez groupId) → 1 datapoint', () => {
    const master = mk({ id: 'M2', isMaster: true, pnl: 50 });
    const copy = mk({ id: 'C2', masterTradeId: 'M2', pnl: 50 });
    const ds = buildLabDatasetFromTrades([master, copy]);
    expect(ds.coverage.total).toBe(1);
  });

  it('$ rozhodnutí = součet přes kopie (jako collapseCopies u coache), R zachováno', () => {
    const master = mk({ id: 'M3', groupId: 'G3', isMaster: true, pnl: 100, riskAmount: 100 });
    const copy = mk({ id: 'C3', groupId: 'G3', masterTradeId: 'M3', pnl: 200, riskAmount: 200 });
    const ds = buildLabDatasetFromTrades([master, copy]);
    expect(ds.trades[0].pnl).toBe(300);
    expect(ds.trades[0].r).toBeCloseTo(1); // 300/300 = R jedné kopie
  });
});

describe('computeOverview — konvence appky', () => {
  it('winRate = wins/(wins+losses), BE mimo jmenovatel', () => {
    const ds = buildLabDatasetFromTrades([
      mk({ pnl: 100 }), mk({ pnl: 100 }), mk({ pnl: 100 }), mk({ pnl: 100 }), mk({ pnl: 100 }),
      mk({ pnl: -100 }), mk({ pnl: -100 }),
      mk({ pnl: 0 }), mk({ pnl: 0 }), mk({ pnl: 0 }),
    ]);
    const ov = computeOverview(ds);
    expect(ov.winRate).toBeCloseTo(5 / 7 * 100, 5); // ne 50 % (5/10)
  });

  it('avgWinR klasifikuje dle outcome — BE s drobným kladným pnl neředí průměr výher', () => {
    const ds = buildLabDatasetFromTrades([
      mk({ pnl: 200, riskAmount: 100 }),            // Win +2R
      mk({ pnl: 0.005, riskAmount: 100, isBE: true }), // BE s r≈0
    ]);
    const ov = computeOverview(ds);
    expect(ov.avgWinR).toBeCloseTo(2);
  });
});

describe('computeCfSummary — párové srovnání variant', () => {
  const cfTrade = (r: number, cf: any) => mk({
    pnl: r * 100, riskAmount: 100,
    counterfactual: { available: true, ...cf },
  });

  it('deltaR = varianta − realita na TĚCH SAMÝCH obchodech; bestFixed dle párové delty', () => {
    // A: real +1R, swing 1.5 (párová delta +0.5) | B: real −1R, ote 0.5 (párová delta +1.5)
    // Syrové Σ by vybraly swing (1.5 > 0.5); párově je lepší ote.
    const A = cfTrade(1, { swing: { realizedR: 1.5 } });
    const B = cfTrade(-1, { ote: { realizedR: 0.5 } });
    const cf = computeCfSummary(buildLabDatasetFromTrades([A, B]));
    expect(cf.bestFixed?.label).toBe('OTE SL');
    expect(cf.deltaR).toBeCloseTo(1.5);
  });
});

describe('computeBiasSummary — podíl aligned', () => {
  it('alignedSharePct nepřeletí 100 % ani se zápornou proti-bias skupinou', () => {
    const ds = buildLabDatasetFromTrades([
      mk({ pnl: 300, riskAmount: 100, biasAligned: true }),
      mk({ pnl: 300, riskAmount: 100, biasAligned: true }),
      mk({ pnl: -200, riskAmount: 100, biasAligned: false }),
    ]);
    const b = computeBiasSummary(ds);
    expect(b.alignedSharePct).not.toBeNull();
    expect(b.alignedSharePct!).toBeLessThanOrEqual(100);
  });
});
