/**
 * Mikro-benchmark: STARÉ vs NOVÉ horké cesty z audit-fixů.
 * Spusť: npx tsx scripts/perf-bench.ts
 * Měří algoritmickou změnu (O(N²)→O(1), single-pass KPI, JSON.stringify vs podpis).
 * Nejde o end-to-end render čas v prohlížeči, ale o čistou práci, kterou fixy odstranily.
 */

type T = {
  id: string; pnl: number; date: string; timestamp: number;
  instrument: string; direction: 'Long' | 'Short'; groupId?: string;
  executionStatus?: 'Valid' | 'Invalid' | 'Missed'; screenshot?: string;
  notes?: string; tags?: string[];
};

function makeTrades(n: number, withBigShot = false): T[] {
  const inst = ['MNQ', 'ES', 'NQ', 'MES', 'GC'];
  const big = withBigShot ? 'data:image/png;base64,' + 'A'.repeat(300_000) : undefined; // ~300 KB
  const out: T[] = [];
  const base = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const ts = base + i * 3_600_000;
    out.push({
      id: `t${i}`,
      pnl: (i % 7 === 0) ? 0 : (i % 3 === 0 ? -120 - (i % 50) : 200 + (i % 90)),
      date: new Date(ts).toISOString(),
      timestamp: ts,
      instrument: inst[i % inst.length],
      direction: i % 2 ? 'Long' : 'Short',
      groupId: i % 4 === 0 ? `g${Math.floor(i / 4)}` : undefined,
      executionStatus: i % 11 === 0 ? 'Missed' : 'Valid',
      screenshot: withBigShot && i % 5 === 0 ? big : `https://cdn/x/${i}.webp`,
      notes: 'pozn '.repeat(8),
      tags: ['imported'],
    });
  }
  return out;
}

function bench(label: string, fn: () => void, iters: number): number {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`   ${label.padEnd(34)} ${ms.toFixed(3)} ms/iter`);
  return ms;
}

function speedup(oldMs: number, newMs: number): string {
  if (newMs < 0.0005) return `~${(oldMs / 0.0005).toFixed(0)}× rychlejší (NEW ~0)`;
  return `${(oldMs / newMs).toFixed(1)}× rychlejší`;
}

// ─── 1) TradeHistory: detekce skupin/copy v render path ───────────────────────
function benchTradeHistory(n: number) {
  const trades = makeTrades(n);
  const visible = trades.slice(0, Math.min(60, n)); // viditelné karty (1 obrazovka + pár scrollů)
  const iters = 40;
  console.log(`\n● TradeHistory group-scan — ${n} obchodů, ${visible.length} viditelných karet (1 re-render):`);

  // STARÉ: pro každou kartu 2× lineární filter přes celý seznam
  const oldRun = () => {
    let acc = 0;
    for (const trade of visible) {
      let group = trade.groupId ? trades.filter(t => t.groupId === trade.groupId) : [];
      if (group.length <= 1) {
        const fuzzy = trades.filter(t => t.instrument === trade.instrument && t.timestamp === trade.timestamp && t.direction === trade.direction);
        if (fuzzy.length > 1) group = fuzzy;
      }
      acc += group.length;
    }
    if (acc < 0) throw 0;
  };

  // NOVÉ: jednou postav index (useMemo), pak O(1) lookup. Simulujeme dva případy:
  const newFirst = () => { // první render (index se staví)
    const g = new Map<string, T[]>(), f = new Map<string, T[]>();
    for (const t of trades) {
      if (t.groupId) { const a = g.get(t.groupId); a ? a.push(t) : g.set(t.groupId, [t]); }
      const fk = `${t.instrument}|${t.timestamp}|${t.direction}`;
      const a = f.get(fk); a ? a.push(t) : f.set(fk, [t]);
    }
    let acc = 0;
    for (const trade of visible) {
      let group = trade.groupId ? (g.get(trade.groupId) || []) : [];
      if (group.length <= 1) { const fz = f.get(`${trade.instrument}|${trade.timestamp}|${trade.direction}`) || []; if (fz.length > 1) group = fz; }
      acc += group.length;
    }
    if (acc < 0) throw 0;
  };
  // re-render se stejnými trades → index je memoizovaný, jen lookupy
  const g = new Map<string, T[]>(), f = new Map<string, T[]>();
  for (const t of trades) {
    if (t.groupId) { const a = g.get(t.groupId); a ? a.push(t) : g.set(t.groupId, [t]); }
    const fk = `${t.instrument}|${t.timestamp}|${t.direction}`;
    const a = f.get(fk); a ? a.push(t) : f.set(fk, [t]);
  }
  const newReRender = () => {
    let acc = 0;
    for (const trade of visible) {
      let group = trade.groupId ? (g.get(trade.groupId) || []) : [];
      if (group.length <= 1) { const fz = f.get(`${trade.instrument}|${trade.timestamp}|${trade.direction}`) || []; if (fz.length > 1) group = fz; }
      acc += group.length;
    }
    if (acc < 0) throw 0;
  };

  const o = bench('STARÉ (2× filter/kartu)', oldRun, iters);
  const nf = bench('NOVÉ (1. render, build index)', newFirst, iters);
  const nr = bench('NOVÉ (re-render, index cached)', newReRender, iters);
  console.log(`   → 1. render: ${speedup(o, nf)} | re-render: ${speedup(o, nr)}`);
}

// ─── 2) Dashboard KPI: multi-filter vs single-pass ────────────────────────────
function benchDashboardKpi(n: number) {
  const trades = makeTrades(n);
  const iters = 200;
  console.log(`\n● Dashboard KPI agregace — ${n} obchodů (1 render):`);

  const oldRun = () => {
    // kpi_winrate (4×) + profit_factor (2×) + day_winrate (build mapy) + execution (3×)
    const winCount = trades.filter(t => t.pnl > 0 && t.executionStatus !== 'Missed').length;
    const beCount = trades.filter(t => t.pnl === 0 && t.executionStatus !== 'Missed').length;
    const lossCount = trades.filter(t => t.pnl < 0 && t.executionStatus !== 'Missed').length;
    const totalCount = trades.filter(t => t.executionStatus !== 'Missed').length;
    const gp = trades.filter(t => t.pnl > 0 && t.executionStatus !== 'Missed').reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl < 0 && t.executionStatus !== 'Missed').reduce((s, t) => s + t.pnl, 0));
    const dayPnL: Record<string, number> = {};
    trades.filter(t => t.executionStatus !== 'Missed').forEach(t => { const k = t.date.slice(0, 10); dayPnL[k] = (dayPnL[k] || 0) + t.pnl; });
    const pd = Object.values(dayPnL).filter(p => p > 0).length;
    const ld = Object.values(dayPnL).filter(p => p < 0).length;
    const bd = Object.values(dayPnL).filter(p => p === 0).length;
    const allSignals = trades.length;
    const exec = trades.filter(t => t.executionStatus !== 'Missed').length;
    const missed = trades.filter(t => t.executionStatus === 'Missed').length;
    if (winCount + beCount + lossCount + totalCount + gp + gl + pd + ld + bd + allSignals + exec + missed < -1) throw 0;
  };

  const newRun = () => {
    let winCount = 0, beCount = 0, lossCount = 0, nonMissed = 0, missed = 0, gp = 0, gl = 0;
    const dayPnL: Record<string, number> = {};
    for (const tr of trades) {
      if (tr.executionStatus === 'Missed') { missed++; continue; }
      nonMissed++;
      if (tr.pnl > 0) { winCount++; gp += tr.pnl; }
      else if (tr.pnl < 0) { lossCount++; gl += tr.pnl; }
      else beCount++;
      const k = tr.date.slice(0, 10); dayPnL[k] = (dayPnL[k] || 0) + tr.pnl;
    }
    const dv = Object.values(dayPnL);
    const pd = dv.filter(p => p > 0).length, ld = dv.filter(p => p < 0).length, bd = dv.filter(p => p === 0).length;
    if (winCount + beCount + lossCount + nonMissed + missed + gp + Math.abs(gl) + pd + ld + bd < -1) throw 0;
  };

  const o = bench('STARÉ (~15 průchodů)', oldRun, iters);
  const nw = bench('NOVÉ (1 průchod)', newRun, iters);
  console.log(`   → ${speedup(o, nw)}`);
}

// ─── 3) selectedTrade sync: JSON.stringify vs podpis ──────────────────────────
function benchSelectedTradeSync() {
  const trades = makeTrades(2000, true); // s velkými base64 screenshoty
  const sel = trades.find(t => t.screenshot?.startsWith('data:'))!;
  const updated = { ...sel, notes: 'změněno' };
  const iters = 2000;
  console.log(`\n● TradeDetail sync — obchod s ~300 KB base64 screenshotem (1 změna):`);

  const oldRun = () => { const c = JSON.stringify(updated) !== JSON.stringify(sel); if (c === undefined) throw 0; };

  const tradeSig = (t: any): string => {
    if (!t) return '';
    const { screenshot, screenshots, ...rest } = t;
    const shotKey = (typeof screenshot === 'string' ? `${screenshot.length}:${screenshot.slice(0, 32)}` : '') + '|' + (Array.isArray(screenshots) ? screenshots.length : 0);
    return JSON.stringify(rest) + '#' + shotKey;
  };
  const newRun = () => { const c = tradeSig(updated) !== tradeSig(sel); if (c === undefined) throw 0; };

  const o = bench('STARÉ (2× JSON.stringify)', oldRun, iters);
  const nw = bench('NOVÉ (tradeSig)', newRun, iters);
  console.log(`   → ${speedup(o, nw)}`);
}

// ─── 4) Mrtvý `stats` memo (App.tsx) — calculateStats co teď nikdy neběží ──────
async function benchDeadStats(n: number) {
  const { calculateStats } = await import('../services/analysis');
  const trades = makeTrades(n) as any[];
  const iters = 50;
  console.log(`\n● Smazaný mrtvý 'stats' memo — calculateStats nad ${n} obchody (běžel na každou změnu, nikde se nečetl):`);
  const o = bench('STARÉ (běželo zbytečně)', () => { calculateStats(trades, 10000); }, iters);
  console.log(`   → NOVÉ: 0 ms (úplně odstraněno) — ušetřeno ${o.toFixed(2)} ms na každou změnu obchodů`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' AlphaTrade — benchmark audit-fixů (STARÉ vs NOVÉ)');
  console.log(' Node:', process.version);
  console.log('═══════════════════════════════════════════════════════════════');

  for (const n of [500, 2000, 5000]) benchTradeHistory(n);
  for (const n of [500, 2000, 5000]) benchDashboardKpi(n);
  benchSelectedTradeSync();
  await benchDeadStats(2000);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' Hotovo. Čísla = čistá CPU práce na hlavním vlákně (méně = méně záseků).');
  console.log('═══════════════════════════════════════════════════════════════');
}

main();
