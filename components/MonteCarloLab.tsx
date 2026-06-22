import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Activity, Sparkles } from 'lucide-react';
import { Trade } from '../types';

interface Props {
  theme: 'dark' | 'light' | 'oled' | string;
  trades: Trade[];
  initialBalance?: number;
  onClose: () => void;
}

const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const BEST = '#22c55e', MOST = '#3b82f6', WORST = '#f97316';
const moneyK = (v: number) => { const a = Math.abs(v); if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`; if (a >= 1000) return `$${Math.round(v / 1000)}k`; return `$${Math.round(v)}`; };
function niceNum(x: number) { if (x <= 0) return 1; const exp = Math.floor(Math.log10(x)); const f = x / Math.pow(10, exp); const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * Math.pow(10, exp); }
function niceTicks(max: number, count = 4) { const step = niceNum(max / count); const ticks: number[] = []; for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v); return ticks; }

// Seedovaný PRNG (mulberry32) — umožní přesně zrekonstruovat konkrétní běhy (best/median/worst).
function mulberry32(a: number) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seedFor = (s: number) => ((s + 1) * 2654435761) >>> 0;

function simPath(seed: number, start: number, wr: number, rr: number, riskP: number, cost: number, N: number, idx: number[] | null, full: boolean) {
  const rng = mulberry32(seed);
  let bal = start, peak = start, dd = 0, ls = 0, mls = 0, ws = 0, mws = 0, wins = 0, bi = 0;
  const sampled = idx ? new Array<number>(idx.length) : null;
  const fullArr = full ? new Float64Array(N + 1) : null;
  if (fullArr) fullArr[0] = start;
  if (idx && idx[0] === 0 && sampled) { sampled[0] = start; bi = 1; }
  for (let i = 0; i < N; i++) {
    const risk = bal * riskP;
    if (rng() < wr) { bal += risk * rr - cost; ls = 0; ws++; if (ws > mws) mws = ws; wins++; }
    else { bal -= risk + cost; ls++; if (ls > mls) mls = ls; ws = 0; }
    if (bal > peak) peak = bal;
    const d = peak > 0 ? ((peak - bal) / peak) * 100 : 0; if (d > dd) dd = d;
    if (fullArr) fullArr[i + 1] = bal;
    if (idx && sampled && bi < idx.length && i + 1 === idx[bi]) { sampled[bi] = bal; bi++; }
  }
  return { final: bal, maxdd: dd, streak: mls, winStreak: mws, wins, sampled, full: fullArr };
}

interface ScenStat { result: number; totalRet: number; maxDD: number; maxLoss: number; maxWin: number; winPct: number; path: number[]; }
interface SimResult {
  start: number; N: number; ruinT: number;
  p5: number; p50: number; p95: number;
  pProfit: number; ruin: number; ddMed: number; ddP95: number;
  stMed: number; stMax: number; expR: number; avgRet: number; sd: number;
  finals: number[]; bandIdx: number[]; b5: number[]; b95: number[];
  best: number[]; med: number[]; worst: number[];
  ddDist: { label: string; prob: number }[];
  scen: { med: ScenStat; worst: ScenStat; best: ScenStat };
}

function runSim(start: number, wrPct: number, rr: number, riskPct: number, N: number, cost: number, SIMS: number, ruinT: number): SimResult {
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
    return { result: r.final, totalRet: ((r.final - start) / start) * 100, maxDD: r.maxdd, maxLoss: r.streak, maxWin: r.winStreak, winPct: (r.wins / N) * 100, path: Array.from(r.full!) };
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
    ddMed: pct(ddS, 0.5), ddP95: pct(ddS, 0.95),
    stMed: pct(stS, 0.5), stMax: stS[stS.length - 1],
    expR: wr * rr - (1 - wr), avgRet: ((pct(fS, 0.5) - start) / start) * 100, sd,
    finals: fS, bandIdx: idx, b5: band(0.05), b95: band(0.95),
    best: sBest.path, med: sMed.path, worst: sWorst.path,
    ddDist, scen: { med: sMed, worst: sWorst, best: sBest },
  };
}

function setupCanvas(cv: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1; const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
  const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

interface Geom { pl: number; pr: number; W: number; N: number; }

function drawEquity(cv: HTMLCanvasElement, d: SimResult, cText: string, isDark: boolean, hoverIdx: number | null, geomOut: { current: Geom | null }) {
  const { ctx, w: W, h: H } = setupCanvas(cv);
  const pl = 56, pr = 16, pt = 14, pb = 26;
  ctx.clearRect(0, 0, W, H);
  const mx = Math.max(d.start, ...d.best, ...d.b95);
  const ticks = niceTicks(mx, 4); const maxY = ticks[ticks.length - 1] || 1; const rg = maxY || 1;
  const X = (i: number) => pl + (i / d.N) * (W - pl - pr);
  const Y = (v: number) => pt + (1 - v / rg) * (H - pt - pb);
  ctx.font = '11px ui-sans-serif, system-ui';
  for (const tk of ticks) {
    const yy = Y(tk);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pl, yy); ctx.lineTo(W - pr, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = cText; ctx.textAlign = 'right'; ctx.fillText(moneyK(tk), pl - 6, yy + 4);
  }
  const xstep = Math.max(1, niceNum(d.N / 12)); ctx.textAlign = 'center'; ctx.fillStyle = cText;
  for (let t = 0; t <= d.N; t += xstep) ctx.fillText(String(t), X(t), H - 9);
  // faint band P5–P95
  ctx.fillStyle = isDark ? 'rgba(99,102,241,0.13)' : 'rgba(99,102,241,0.10)';
  ctx.beginPath();
  for (let k = 0; k < d.b95.length; k++) { const x = X(d.bandIdx[k]), y = Y(d.b95[k]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  for (let k = d.b5.length - 1; k >= 0; k--) ctx.lineTo(X(d.bandIdx[k]), Y(d.b5[k]));
  ctx.closePath(); ctx.fill();
  const lineP = (arr: number[], col: string) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath(); for (let i = 0; i < arr.length; i++) { const x = X(i), y = Y(arr[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); };
  lineP(d.worst, WORST); lineP(d.best, BEST); lineP(d.med, MOST);
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx <= d.N) {
    const hx = X(hoverIdx);
    ctx.strokeStyle = cText; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx, pt); ctx.lineTo(hx, H - pb); ctx.stroke(); ctx.globalAlpha = 1;
    const dot = (arr: number[], col: string) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hx, Y(arr[hoverIdx]), 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = isDark ? '#0a0e17' : '#fff'; ctx.lineWidth = 2; ctx.stroke(); };
    dot(d.best, BEST); dot(d.med, MOST); dot(d.worst, WORST);
  }
  geomOut.current = { pl, pr, W, N: d.N };
}

interface BarGeom { pl: number; pr: number; pt: number; pb: number; W: number; H: number; n: number; bw: number; }

function drawHist(cv: HTMLCanvasElement, d: SimResult, cText: string, isDark: boolean, hoverBin: number | null, geomOut: { current: BarGeom | null }) {
  const { ctx, w: W, h: H } = setupCanvas(cv);
  ctx.clearRect(0, 0, W, H);
  const pl = 42, pr = 8, pt = 10, pb = 26;
  const f = d.finals, lo = pct(f, 0.01), hi = pct(f, 0.99), BINS = 32, rg = hi - lo || 1;
  const bins = new Array(BINS).fill(0);
  for (const v of f) { let b = Math.floor(((v - lo) / rg) * BINS); if (b < 0) b = 0; if (b >= BINS) b = BINS - 1; bins[b]++; }
  const mxc = Math.max(...bins) || 1, bw = (W - pl - pr) / BINS;
  ctx.font = '10px ui-sans-serif, system-ui'; ctx.fillStyle = cText;
  ctx.textAlign = 'right'; ctx.fillText(String(mxc), pl - 5, pt + 8); ctx.fillText('0', pl - 5, H - pb);
  ctx.save(); ctx.translate(11, (pt + H - pb) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Četnost', 0, 0); ctx.restore();
  ctx.textAlign = 'center';
  for (let k = 0; k <= 4; k++) { const v = lo + (k / 4) * rg; ctx.fillText(moneyK(v), pl + (k / 4) * (W - pl - pr), H - 9); }
  for (let b = 0; b < BINS; b++) {
    const bx = lo + ((b + 0.5) / BINS) * rg; const base = bx >= d.start ? '16,185,129' : '244,63,94';
    const bh = (bins[b] / mxc) * (H - pt - pb); const x = pl + b * bw;
    ctx.fillStyle = `rgba(${base},${hoverBin === b ? 1 : 0.7})`; ctx.fillRect(x + 1, H - pb - bh, bw - 2, bh);
  }
  const sx = pl + ((d.start - lo) / rg) * (W - pl - pr);
  ctx.strokeStyle = cText; ctx.globalAlpha = 0.55; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(sx, pt); ctx.lineTo(sx, H - pb); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  geomOut.current = { pl, pr, pt, pb, W, H, n: BINS, bw };
}

function drawDD(cv: HTMLCanvasElement, d: SimResult, cText: string, isDark: boolean, hoverBin: number | null, geomOut: { current: BarGeom | null }) {
  const { ctx, w: W, h: H } = setupCanvas(cv);
  ctx.clearRect(0, 0, W, H);
  const pl = 42, pr = 8, pt = 10, pb = 26; const dd = d.ddDist; const n = dd.length;
  const maxP = Math.max(...dd.map(x => x.prob), 1);
  const niceMax = Math.ceil(maxP / 25) * 25 || 25;
  const bw = (W - pl - pr) / n;
  ctx.font = '10px ui-sans-serif, system-ui'; ctx.fillStyle = cText; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { const v = (k / 4) * niceMax; const yy = (pt) + (1 - v / niceMax) * (H - pt - pb); ctx.fillText(`${Math.round(v)}%`, pl - 5, yy + 3); ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'; ctx.beginPath(); ctx.moveTo(pl, yy); ctx.lineTo(W - pr, yy); ctx.stroke(); }
  ctx.save(); ctx.translate(11, (pt + H - pb) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Pravděpodobnost', 0, 0); ctx.restore();
  ctx.textAlign = 'center';
  for (let b = 0; b < n; b++) {
    const bh = (dd[b].prob / niceMax) * (H - pt - pb); const x = pl + b * bw;
    ctx.fillStyle = `rgba(249,115,22,${hoverBin === b ? 0.95 : 0.7})`; ctx.fillRect(x + 2, H - pb - bh, bw - 4, bh);
    ctx.fillStyle = cText; ctx.fillText(dd[b].label, x + bw / 2, H - 9);
  }
  geomOut.current = { pl, pr, pt, pb, W, H, n, bw };
}

const MonteCarloLab: React.FC<Props> = ({ theme, trades, initialBalance, onClose }) => {
  const isDark = theme !== 'light';
  const [wr, setWr] = useState(50);
  const [rr, setRr] = useState(2);
  const [risk, setRisk] = useState(1);
  const [n, setN] = useState(100);
  const [ruin, setRuin] = useState(50);
  const [bal, setBal] = useState(initialBalance && initialBalance > 0 ? Math.round(initialBalance) : 50000);
  const [cost, setCost] = useState(4);
  const [sims, setSims] = useState(1000);

  const result = useMemo(() => runSim(bal, wr, rr, risk, n, cost, sims, ruin), [bal, wr, rr, risk, n, cost, sims, ruin]);

  // Prefill z reálných obchodů
  const prefill = useMemo(() => {
    const valid = trades.filter(t => t.executionStatus !== 'Missed');
    const wins = valid.filter(t => (t.pnl || 0) > 0);
    const losses = valid.filter(t => (t.pnl || 0) < 0);
    const denom = wins.length + losses.length;
    if (denom < 5) return null;
    const avgWin = wins.reduce((s, t) => s + (t.pnl || 0), 0) / (wins.length || 1);
    const avgLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0)) / (losses.length || 1);
    const rTrades = valid.filter(t => t.riskAmount && (t.riskAmount as number) > 0);
    const avgRisk = rTrades.length ? rTrades.reduce((s, t) => s + (t.riskAmount as number), 0) / rTrades.length : 0;
    return {
      wr: (wins.length / denom) * 100,
      rr: avgLoss > 0 ? avgWin / avgLoss : 2,
      risk: avgRisk > 0 && bal > 0 ? (avgRisk / bal) * 100 : null,
      n: valid.length,
    };
  }, [trades, bal]);

  const applyPrefill = useCallback(() => {
    if (!prefill) return;
    setWr(Math.round(clamp(prefill.wr, 10, 90)));
    setRr(Math.round(clamp(prefill.rr, 0.3, 5) * 10) / 10);
    if (prefill.risk != null) setRisk(Math.round(clamp(prefill.risk, 0.1, 5) * 10) / 10);
    setN(Math.round(clamp(Math.round(prefill.n / 10) * 10, 20, 500)));
  }, [prefill]);

  const eqRef = useRef<HTMLCanvasElement>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const ddRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef<Geom | null>(null);
  const histGeom = useRef<BarGeom | null>(null);
  const ddGeom = useRef<BarGeom | null>(null);
  const cText = isDark ? 'rgba(148,163,184,0.9)' : 'rgba(100,116,139,0.9)';
  const [hover, setHover] = useState<{ idx: number; px: number } | null>(null);
  const [histBin, setHistBin] = useState<{ bin: number; px: number } | null>(null);
  const [ddBin, setDdBin] = useState<{ bin: number; px: number } | null>(null);
  const [scen, setScen] = useState<'med' | 'worst' | 'best'>('med');

  const draw = useCallback(() => {
    if (eqRef.current) drawEquity(eqRef.current, result, cText, isDark, hover ? hover.idx : null, geomRef);
    if (histRef.current) drawHist(histRef.current, result, cText, isDark, histBin ? histBin.bin : null, histGeom);
    if (ddRef.current) drawDD(ddRef.current, result, cText, isDark, ddBin ? ddBin.bin : null, ddGeom);
  }, [result, cText, isDark, hover, histBin, ddBin]);

  const onEqMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const g = geomRef.current, cv = eqRef.current; if (!g || !cv) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < g.pl || mx > g.W - g.pr) { setHover(null); return; }
    const frac = (mx - g.pl) / (g.W - g.pl - g.pr);
    const idx = clamp(Math.round(frac * g.N), 0, g.N);
    const px = g.pl + (idx / g.N) * (g.W - g.pl - g.pr);
    setHover(h => (h && h.idx === idx ? h : { idx, px }));
  }, []);

  const barBin = (e: React.MouseEvent<HTMLCanvasElement>, g: BarGeom | null, cv: HTMLCanvasElement | null): { bin: number; px: number } | null => {
    if (!g || !cv) return null;
    const mx = e.clientX - cv.getBoundingClientRect().left;
    if (mx < g.pl || mx > g.W - g.pr) return null;
    const b = Math.floor((mx - g.pl) / g.bw);
    return b >= 0 && b < g.n ? { bin: b, px: g.pl + (b + 0.5) * g.bw } : null;
  };

  // Biny pro tooltip histogramu konečných zůstatků (32 binů, jako v drawHist).
  const histInfo = useMemo(() => {
    const f = result.finals, lo = pct(f, 0.01), hi = pct(f, 0.99), BINS = 32, rg = hi - lo || 1;
    const bins = new Array(BINS).fill(0);
    for (const v of f) { let b = Math.floor(((v - lo) / rg) * BINS); if (b < 0) b = 0; if (b >= BINS) b = BINS - 1; bins[b]++; }
    return { lo, rg, BINS, bins };
  }, [result]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const h = () => draw();
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [draw]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const profCol = result.p50 >= result.start ? 'text-emerald-400' : 'text-rose-400';
  const sliderCls = 'w-full accent-violet-500';
  const fieldCls = `w-full h-9 rounded-lg px-2.5 text-sm outline-none border ${isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-800'}`;

  const Slider: React.FC<{ label: string; val: string; children: React.ReactNode }> = ({ label, val, children }) => (
    <div>
      <div className="flex justify-between text-[11px] mb-1"><span className="text-slate-400 font-bold">{label}</span><span className={`font-black ${isDark ? 'text-white' : 'text-slate-800'}`}>{val}</span></div>
      {children}
    </div>
  );
  const Stat: React.FC<{ label: string; value: string; sub?: string; cls?: string }> = ({ label, value, sub, cls }) => (
    <div className={`rounded-xl p-3 ${isDark ? 'bg-white/[0.04]' : 'bg-slate-50'}`}>
      <div className="text-[10px] font-bold text-slate-500 mb-1">{label}</div>
      <div className={`text-lg font-black font-mono leading-none ${cls || (isDark ? 'text-white' : 'text-slate-800')}`}>{value}</div>
      {sub && <div className="text-[9px] font-bold text-slate-500 mt-1">{sub}</div>}
    </div>
  );

  const overlay = (
    <div className="fixed inset-0 z-[9000] flex flex-col bg-[var(--bg-page)]/95 backdrop-blur-xl animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}><Activity size={18} /></div>
          <div>
            <h2 className="text-lg font-black tracking-tight italic">MONTE CARLO LAB</h2>
            <p className="text-[11px] font-bold text-slate-500">Stress-test strategie · {sims} simulací</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={applyPrefill} disabled={!prefill}
            className={`flex items-center gap-1.5 px-3 h-9 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all ${prefill ? 'bg-violet-600 hover:bg-violet-500 text-white' : 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500'}`}
            title={prefill ? 'Předvyplní win rate, R:R, risk a počet z tvých obchodů' : 'Potřebuješ aspoň 5 uzavřených obchodů'}>
            <Sparkles size={13} /> Načíst z mých obchodů
          </button>
          <button onClick={onClose} className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}><X size={18} /></button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'} space-y-3.5`}>
            <Slider label="Win rate" val={`${wr} %`}><input type="range" min={10} max={90} step={1} value={wr} onChange={e => setWr(+e.target.value)} className={sliderCls} /></Slider>
            <Slider label="Avg win / loss (R:R)" val={rr.toFixed(1)}><input type="range" min={0.3} max={5} step={0.1} value={rr} onChange={e => setRr(+e.target.value)} className={sliderCls} /></Slider>
            <Slider label="Risk na obchod" val={`${risk.toFixed(1)} %`}><input type="range" min={0.1} max={5} step={0.1} value={risk} onChange={e => setRisk(+e.target.value)} className={sliderCls} /></Slider>
            <Slider label="Počet obchodů" val={`${n}`}><input type="range" min={20} max={500} step={10} value={n} onChange={e => setN(+e.target.value)} className={sliderCls} /></Slider>
            <Slider label="Ruin při poklesu o" val={`${ruin} %`}><input type="range" min={10} max={90} step={5} value={ruin} onChange={e => setRuin(+e.target.value)} className={sliderCls} /></Slider>
          </div>
          <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'} grid grid-cols-3 gap-2.5`}>
            <div className="col-span-3"><div className="text-[10px] font-bold text-slate-500 mb-1">Počáteční zůstatek</div><input type="number" step={1000} value={bal} onChange={e => setBal(+e.target.value || 0)} className={fieldCls} /></div>
            <div><div className="text-[10px] font-bold text-slate-500 mb-1">Náklady $</div><input type="number" step={1} value={cost} onChange={e => setCost(+e.target.value || 0)} className={fieldCls} /></div>
            <div className="col-span-2"><div className="text-[10px] font-bold text-slate-500 mb-1">Simulací</div>
              <select value={sims} onChange={e => setSims(+e.target.value)} className={fieldCls}>
                <option value={250}>250</option><option value={1000}>1000</option><option value={2000}>2000</option>
              </select>
            </div>
          </div>
        </div>

        {/* Charts + stats */}
        <div className="space-y-4 min-w-0">
          <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Equity křivky</span>
              <div className="flex gap-3.5 text-[10px] font-bold">
                <span style={{ color: BEST }}><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: BEST }} />Nejlepší</span>
                <span style={{ color: MOST }}><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: MOST }} />Nejpravděpodobnější</span>
                <span style={{ color: WORST }}><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: WORST }} />Nejhorší</span>
              </div>
            </div>
            <div className="flex">
              <div className="flex items-center justify-center" style={{ width: 16 }}>
                <span className="text-[9px] font-bold text-slate-500 whitespace-nowrap" style={{ transform: 'rotate(-90deg)' }}>Zůstatek ($)</span>
              </div>
              <div className="relative flex-1 min-w-0">
                <div className="h-[300px]">
                  <canvas ref={eqRef} className="w-full h-full block cursor-crosshair" onMouseMove={onEqMove} onMouseLeave={() => setHover(null)} />
                </div>
                {hover && (
                  <div className="absolute top-2 z-10 pointer-events-none rounded-xl px-3 py-2 text-[11px] shadow-xl border bg-[var(--bg-card)] border-[var(--border-subtle)]"
                    style={{ left: clamp(hover.px + 12, 0, 999), maxWidth: 190, transform: hover.px > 360 ? 'translateX(-110%)' : 'none' }}>
                    <div className="font-black mb-1" style={{ color: isDark ? '#fff' : '#0f172a' }}>Obchod #{hover.idx}</div>
                    <div style={{ color: BEST }}>Nejlepší: <b>{money(result.best[hover.idx])}</b></div>
                    <div style={{ color: MOST }}>Nejpravděp.: <b>{money(result.med[hover.idx])}</b></div>
                    <div style={{ color: WORST }}>Nejhorší: <b>{money(result.worst[hover.idx])}</b></div>
                  </div>
                )}
              </div>
            </div>
            <div className="text-center text-[9px] font-bold text-slate-500 mt-1">Číslo obchodu</div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <Stat label="Medián zůstatek" value={money(result.p50)} sub={`${result.avgRet >= 0 ? '+' : ''}${result.avgRet.toFixed(0)} % z účtu`} cls={profCol} />
            <Stat label="Nepříznivý · P5" value={money(result.p5)} sub="1 z 20 horší" cls={result.p5 >= result.start ? 'text-emerald-400' : 'text-rose-400'} />
            <Stat label="Příznivý · P95" value={money(result.p95)} sub="1 z 20 lepší" cls="text-emerald-400" />
            <Stat label="Pravděpodobnost zisku" value={`${result.pProfit.toFixed(0)} %`} sub="sim. nad startem" cls={result.pProfit >= 70 ? 'text-emerald-400' : result.pProfit >= 50 ? '' : 'text-rose-400'} />
            <Stat label="Riziko ruinu" value={`${result.ruin.toFixed(result.ruin < 10 ? 1 : 0)} %`} sub={`pokles ≥ ${result.ruinT} %`} cls={result.ruin <= 1 ? 'text-emerald-400' : result.ruin <= 5 ? 'text-amber-400' : 'text-rose-400'} />
            <Stat label="Max drawdown" value={`${result.ddMed.toFixed(1)} %`} sub={`nejhorší ${result.ddP95.toFixed(1)} %`} cls="text-rose-400" />
            <Stat label="Nejdelší série proher" value={`${result.stMed.toFixed(0)}×`} sub={`nejhorší ${result.stMax.toFixed(0)}×`} />
            <Stat label="Expectancy" value={`${result.expR.toFixed(2)} R`} sub="na obchod" cls={result.expR >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          </div>

          {/* Dvě distribuce — interaktivní s hoverem */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
              <span className={`text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Rozdělení konečných zůstatků</span>
              <div className="relative h-[140px] mt-2">
                <canvas ref={histRef} className="w-full h-full block cursor-crosshair"
                  onMouseMove={e => setHistBin(barBin(e, histGeom.current, histRef.current))}
                  onMouseLeave={() => setHistBin(null)} />
                {histBin && (() => {
                  const lo = histInfo.lo + (histBin.bin / histInfo.BINS) * histInfo.rg;
                  const hiB = histInfo.lo + ((histBin.bin + 1) / histInfo.BINS) * histInfo.rg;
                  return (
                    <div className="absolute top-1 z-10 pointer-events-none rounded-lg px-2.5 py-1.5 text-[10px] shadow-xl border bg-[var(--bg-card)] border-[var(--border-subtle)]"
                      style={{ left: clamp(histBin.px + 8, 0, 999), maxWidth: 160, transform: histBin.px > 180 ? 'translateX(-108%)' : 'none' }}>
                      <div className="font-black">{moneyK(lo)}–{moneyK(hiB)}</div>
                      <div className="text-slate-500">{histInfo.bins[histBin.bin]} simulací</div>
                    </div>
                  );
                })()}
              </div>
              <div className="text-center text-[9px] font-bold text-slate-500 mt-1">Konečný zůstatek ($)</div>
            </div>

            <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
              <span className={`text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>Rozdělení drawdownu</span>
              <div className="relative h-[140px] mt-2">
                <canvas ref={ddRef} className="w-full h-full block cursor-crosshair"
                  onMouseMove={e => setDdBin(barBin(e, ddGeom.current, ddRef.current))}
                  onMouseLeave={() => setDdBin(null)} />
                {ddBin && result.ddDist[ddBin.bin] && (
                  <div className="absolute top-1 z-10 pointer-events-none rounded-lg px-2.5 py-1.5 text-[10px] shadow-xl border bg-[var(--bg-card)] border-[var(--border-subtle)]"
                    style={{ left: clamp(ddBin.px + 8, 0, 999), maxWidth: 170, transform: ddBin.px > 180 ? 'translateX(-108%)' : 'none' }}>
                    <div className="font-black">drawdown do {result.ddDist[ddBin.bin].label}</div>
                    <div className="text-slate-500">{result.ddDist[ddBin.bin].prob.toFixed(1)} % simulací</div>
                  </div>
                )}
              </div>
              <div className="text-center text-[9px] font-bold text-slate-500 mt-1">Úroveň drawdownu</div>
            </div>
          </div>

          {/* Scénář toggle + per-scénář staty */}
          <div className={`rounded-2xl p-4 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
            <div className="flex gap-2 mb-4">
              {([['med', 'Nejpravděpodobnější', MOST], ['worst', 'Nejhorší', WORST], ['best', 'Nejlepší', BEST]] as const).map(([k, label, col]) => (
                <button key={k} onClick={() => setScen(k)}
                  className={`flex-1 h-9 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border ${scen === k ? 'text-white' : (isDark ? 'border-white/10 text-slate-400 hover:bg-white/5' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}`}
                  style={scen === k ? { background: col, borderColor: col } : undefined}>
                  {label}
                </button>
              ))}
            </div>
            {(() => { const sc = result.scen[scen]; return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <Stat label="Počáteční zůstatek" value={money(result.start)} />
                <Stat label="Výsledný zůstatek" value={money(sc.result)} cls={sc.result >= result.start ? 'text-emerald-400' : 'text-rose-400'} />
                <Stat label="Celkový výnos" value={`${sc.totalRet >= 0 ? '+' : ''}${sc.totalRet.toFixed(1)} %`} cls={sc.totalRet >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
                <Stat label="Max drawdown" value={`${sc.maxDD.toFixed(1)} %`} cls="text-rose-400" />
                <Stat label="Max série proher" value={`${sc.maxLoss}×`} />
                <Stat label="Max série výher" value={`${sc.maxWin}×`} />
                <Stat label="Win %" value={`${sc.winPct.toFixed(1)} %`} />
                <Stat label="Počet obchodů" value={`${result.N}`} />
              </div>
            ); })()}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

export default MonteCarloLab;
