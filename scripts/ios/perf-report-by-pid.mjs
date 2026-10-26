#!/usr/bin/env node
// Rozbor měření iPhonu po procesech (PID). Syslog z telefonu u části procesů
// ztrácí první řádky včetně `origin`, takže perf-report.mjs běhy slučuje;
// tady je každý proces jeden start appky.
// Použití: node scripts/ios/perf-report-by-pid.mjs syslog.txt [počet-zahřívacích-startů]
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2] ?? '/dev/stdin', 'utf8').split('\n');
const skip = Number(process.argv[3] ?? 0);
const runs = new Map();
for (const line of lines) {
  const pid = line.match(/\[(\d+)\]/)?.[1];
  const match = line.match(/AT-PERF ([a-z0-9:._-]+) (\d+)/);
  if (!pid || !match) continue;
  const run = runs.get(pid) ?? { marks: {}, durs: {} };
  const [, name, value] = match;
  if (name.endsWith(':dur')) (run.durs[name.slice(0, -4)] ??= []).push(Number(value));
  else run.marks[name] ??= Number(value);
  runs.set(pid, run);
}
const median = values => values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : null;
// Syslog může ztratit i nav značku: LIVE start pozná podle jakékoli live: značky.
const page = run => (Object.keys(run.marks).some(name => name.startsWith('live:')) ? 'live' : 'dashboard');
const rows = [...runs].slice(skip).map(([pid, run]) => ({
  pid, page: page(run),
  paint: run.marks['boot:dashboard-paint'] ?? null,
  fresh: run.marks['boot:refresh-done'] ?? null,
  copierFirst: run.marks['live:copier-status-first'] ?? null,
  reveal: run.marks['live:reveal'] ?? null,
  sync: (run.durs['sync:delta'] ?? run.durs['sync:full'] ?? []).join('/') || null,
  jankCount: (run.durs['jank:frame'] ?? []).length,
  jankTotal: (run.durs['jank:frame'] ?? []).reduce((a, b) => a + b, 0),
  jankMax: Math.max(0, ...(run.durs['jank:frame'] ?? [])),
  relay: median(run.durs['net:tradovate-oauth-copier-relay:fetch'] ?? []),
}));
console.table(rows);
for (const pageName of ['dashboard', 'live']) {
  const subset = rows.filter(row => row.page === pageName);
  if (!subset.length) continue;
  const pick = key => median(subset.map(row => row[key]).filter(value => value != null));
  console.log(`${pageName}: ${subset.length} startů, medián paint ${pick('paint')} ms, čerstvá data ${pick('fresh')} ms, `
    + `první stav kopírky ${pick('copierFirst')} ms, reveal ${pick('reveal')} ms, zaseknutí ${pick('jankCount')}× / ${pick('jankTotal')} ms, relay ${pick('relay')} ms`);
}
