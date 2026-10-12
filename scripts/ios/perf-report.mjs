#!/usr/bin/env node
// Seřadí značky AT-PERF ze systémového logu iPhonu do časové osy.
// Použití: python3 -m pymobiledevice3 syslog live -m AT-PERF > perf.log
//          node scripts/ios/perf-report.mjs perf.log
// Každé spuštění appky začíná značkou origin:utc-ms-of-day; časy marků jsou
// ms od začátku načtení stránky, `:dur` jsou trvání.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2] ?? '/dev/stdin', 'utf8').split('\n');
const runs = [];
for (const line of lines) {
  const match = line.match(/AT-PERF ([a-z0-9:._-]+) (\d+)/);
  if (!match) continue;
  const [, name, value] = match;
  if (name === 'origin:utc-ms-of-day') { runs.push({ origin: Number(value), marks: [], durations: new Map() }); continue; }
  const run = runs.at(-1);
  if (!run) continue;
  if (name.endsWith(':dur')) {
    const key = name.slice(0, -4);
    const entry = run.durations.get(key) ?? { count: 0, total: 0, max: 0 };
    entry.count += 1; entry.total += Number(value); entry.max = Math.max(entry.max, Number(value));
    run.durations.set(key, entry);
  } else run.marks.push([name, Number(value)]);
}
runs.forEach((run, index) => {
  const at = new Date(run.origin).toISOString().slice(11, 23);
  console.log(`\n=== Spuštění ${index + 1} (začátek ${at} UTC) ===`);
  for (const [name, ms] of run.marks) console.log(`${String(ms).padStart(7)} ms  ${name}`);
  if (run.durations.size) {
    console.log('\n  trvání (počet × průměr / max ms):');
    for (const [name, d] of [...run.durations].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${name.padEnd(56)} ${String(d.count).padStart(3)} × ${String(Math.round(d.total / d.count)).padStart(5)} / ${d.max}`);
    }
  }
});
