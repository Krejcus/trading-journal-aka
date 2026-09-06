const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];

/** Bootstrap of realized trade P&L. Ruin means equity reached zero, not loss from a later peak. */
export const simulateBacktestMonteCarlo = (
  tradePnls: readonly number[],
  initialBalance: number,
  options: { simulations?: number; pathCount?: number; random?: () => number } = {},
) => {
  const pnls = tradePnls.filter(Number.isFinite);
  const len = pnls.length;
  if (len < 10) return null;
  const simulations = Math.max(1, Math.floor(options.simulations ?? 600));
  const pathCount = Math.min(simulations, Math.max(0, Math.floor(options.pathCount ?? 36)));
  const random = options.random ?? Math.random;
  const startBalance = Number.isFinite(initialBalance) ? initialBalance : 0;
  const bands = Math.min(len, 60);
  const stepIdx = Array.from({ length: bands + 1 }, (_, b) => Math.round((b / bands) * len));
  const cols: number[][] = stepIdx.map(() => new Array(simulations));
  const paths: number[][] = Array.from({ length: pathCount }, () => new Array(stepIdx.length));
  const finals: number[] = [];
  const maxDDs: number[] = [];
  let ruinedPaths = 0;
  for (let s = 0; s < simulations; s++) {
    let eq = 0, peak = 0, maxdd = 0, minEquity = startBalance, bi = 1;
    cols[0][s] = 0;
    if (s < pathCount) paths[s][0] = 0;
    for (let i = 0; i < len; i++) {
      const sample = Math.min(len - 1, Math.max(0, Math.floor(random() * len)));
      eq += pnls[sample];
      peak = Math.max(peak, eq);
      maxdd = Math.max(maxdd, peak - eq);
      minEquity = Math.min(minEquity, startBalance + eq);
      if (bi < stepIdx.length && i + 1 === stepIdx[bi]) {
        cols[bi][s] = eq;
        if (s < pathCount) paths[s][bi] = eq;
        bi++;
      }
    }
    finals.push(eq);
    maxDDs.push(maxdd);
    if (startBalance > 0 && minEquity <= 0) ruinedPaths++;
  }
  const fSorted = [...finals].sort((a, b) => a - b);
  const ddSorted = [...maxDDs].sort((a, b) => a - b);
  const band = (p: number) => cols.map(c => percentile([...c].sort((a, b) => a - b), p));
  return {
    len, startBalance,
    expectancy: pnls.reduce((a, b) => a + b, 0) / len,
    p5: percentile(fSorted, 0.05), p25: percentile(fSorted, 0.25), p50: percentile(fSorted, 0.5),
    p75: percentile(fSorted, 0.75), p95: percentile(fSorted, 0.95),
    ddMed: percentile(ddSorted, 0.5), ddP95: percentile(ddSorted, 0.95),
    pLoss: (finals.filter(f => f < 0).length / simulations) * 100,
    ruinPct: startBalance > 0 ? (ruinedPaths / simulations) * 100 : null,
    b5: band(0.05), b25: band(0.25), b50: band(0.5), b75: band(0.75), b95: band(0.95),
    paths,
  };
};
