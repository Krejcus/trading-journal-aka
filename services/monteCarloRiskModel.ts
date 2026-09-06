/** Independent binary gross outcomes; fixed cash fees and fractional sizing. Zero is absorbing. */
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];

// Seedovaný PRNG (mulberry32) — umožní přesně zrekonstruovat konkrétní běhy (best/median/worst).
function mulberry32(a: number) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seedFor = (s: number) => ((s + 1) * 2654435761) >>> 0;

export function simPath(seed: number, start: number, wr: number, rr: number, riskP: number, cost: number, N: number, idx: number[] | null, full: boolean) {
  const rng = mulberry32(seed);
  let executedTrades = 0;
  let bal = start, peak = start, dd = 0, ls = 0, mls = 0, ws = 0, mws = 0, wins = 0, bi = 0;
  const sampled = idx ? new Array<number>(idx.length) : null;
  const fullArr = full ? new Float64Array(N + 1) : null;
  if (fullArr) fullArr[0] = start;
  if (idx && idx[0] === 0 && sampled) { sampled[0] = start; bi = 1; }
  for (let i = 0; i < N; i++) {
    if (bal > 0) {
      const risk = bal * riskP;
      const net = (rng() < wr ? risk * rr : -risk) - cost;
      executedTrades++;
      bal = Math.max(0, bal + net);
      if (net > 0) { ls = 0; ws++; if (ws > mws) mws = ws; wins++; }
      else if (net < 0) { ls++; if (ls > mls) mls = ls; ws = 0; }
      else { ls = 0; ws = 0; }
    }
    if (bal > peak) peak = bal;
    const d = peak > 0 ? ((peak - bal) / peak) * 100 : 0; if (d > dd) dd = d;
    if (fullArr) fullArr[i + 1] = bal;
    if (idx && sampled && bi < idx.length && i + 1 === idx[bi]) { sampled[bi] = bal; bi++; }
  }
  return { final: bal, executedTrades, insolvent: bal <= 0, maxdd: dd, streak: mls, winStreak: mws, wins, sampled, full: fullArr };
}

export interface ScenStat { result: number; totalRet: number; maxDD: number; maxLoss: number; maxWin: number; winPct: number; path: number[]; }
export interface SimResult {
  start: number; N: number; ruinT: number;
  p5: number; p50: number; p95: number;
  pProfit: number; ruin: number; insolvency: number; grossExpR: number; ddMed: number; ddP95: number;
  stMed: number; stMax: number; expR: number; avgRet: number; sd: number;
  finals: number[]; bandIdx: number[]; b5: number[]; b95: number[];
  best: number[]; med: number[]; worst: number[];
  ddDist: { label: string; prob: number }[];
  scen: { med: ScenStat; worst: ScenStat; best: ScenStat };
}

export function runSim(start: number, wrPct: number, rr: number, riskPct: number, N: number, cost: number, SIMS: number, ruinT: number): SimResult {
  if (![start, wrPct, rr, riskPct, N, cost, SIMS, ruinT].every(Number.isFinite)
    || start <= 0 || wrPct < 0 || wrPct > 100 || rr <= 0 || riskPct <= 0 || riskPct > 100
    || cost < 0 || !Number.isInteger(N) || N < 1 || !Number.isInteger(SIMS) || SIMS < 1
    || ruinT <= 0 || ruinT > 100) throw new Error('Neplatné parametry risk simulace.');
  const wr = wrPct / 100, riskP = riskPct / 100;
  const SAMP = Math.min(N, 60); const idx: number[] = [];
  for (let b = 0; b <= SAMP; b++) idx.push(Math.round((b / SAMP) * N));
  const cols: Float64Array[] = idx.map(() => new Float64Array(SIMS));
  const finals = new Float64Array(SIMS), maxdd = new Float64Array(SIMS), streaks = new Float64Array(SIMS);
  let ruinCount = 0, bestIdx = 0, worstIdx = 0;
  for (let s = 0; s < SIMS; s++) {
    const r = simPath(seedFor(s), start, wr, rr, riskP, cost, N, idx, false);
    for (let k = 0; k < idx.length; k++) cols[k][s] = r.sampled![k];
    finals[s] = r.final; maxdd[s] = r.maxdd; streaks[s] = r.streak; if (r.maxdd >= ruinT) ruinCount++;
    if (r.final > finals[bestIdx]) bestIdx = s;
    if (r.final < finals[worstIdx]) worstIdx = s;
  }
  const order = Array.from({ length: SIMS }, (_, i) => i).sort((a, b) => finals[a] - finals[b]);
  const medIdx = order[Math.floor((SIMS - 1) * 0.5)];
  const scenOf = (s: number): ScenStat => {
    const r = simPath(seedFor(s), start, wr, rr, riskP, cost, N, null, true);
    return { result: r.final, totalRet: ((r.final - start) / start) * 100, maxDD: r.maxdd, maxLoss: r.streak, maxWin: r.winStreak, winPct: r.executedTrades ? (r.wins / r.executedTrades) * 100 : 0, path: Array.from(r.full!) };
  };
  const sBest = scenOf(bestIdx), sMed = scenOf(medIdx), sWorst = scenOf(worstIdx);
  // Drawdown distribuce — pravděpodobnost dosažení daného DD pásma
  const bounds = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, Infinity];
  const dlabels = ['5%', '10%', '15%', '20%', '25%', '30%', '40%', '50%', '60%', '75%', '>75%'];
  const dcnt = new Array(bounds.length).fill(0);
  for (let s = 0; s < SIMS; s++) { for (let j = 0; j < bounds.length; j++) { if (maxdd[s] <= bounds[j]) { dcnt[j]++; break; } } }
  const ddDist = dlabels.map((label, j) => ({ label, prob: (dcnt[j] / SIMS) * 100 })).filter((_, j) => j < 6 || dcnt[j] > 0);
  const fS = Array.from(finals).sort((a, b) => a - b);
  const ddS = Array.from(maxdd).sort((a, b) => a - b);
  const stS = Array.from(streaks).sort((a, b) => a - b);
  const band = (p: number) => cols.map(c => pct(Array.from(c).sort((a, b) => a - b), p));
  const mean = fS.reduce((a, b) => a + b, 0) / fS.length;
  const sd = Math.sqrt(fS.reduce((a, b) => a + (b - mean) * (b - mean), 0) / fS.length);
  return {
    start, N, ruinT,
    p5: pct(fS, 0.05), p50: pct(fS, 0.5), p95: pct(fS, 0.95),
    pProfit: (fS.filter(v => v > start).length / SIMS) * 100,
    ruin: (ruinCount / SIMS) * 100,
    insolvency: (fS.filter(value => value <= 0).length / SIMS) * 100,
    grossExpR: wr * rr - (1 - wr),
    ddMed: pct(ddS, 0.5), ddP95: pct(ddS, 0.95),
    stMed: pct(stS, 0.5), stMax: stS[stS.length - 1],
    expR: wr * rr - (1 - wr) - cost / (start * riskP), avgRet: ((pct(fS, 0.5) - start) / start) * 100, sd,
    finals: fS, bandIdx: idx, b5: band(0.05), b95: band(0.95),
    best: sBest.path, med: sMed.path, worst: sWorst.path,
    ddDist, scen: { med: sMed, worst: sWorst, best: sBest },
  };
}
