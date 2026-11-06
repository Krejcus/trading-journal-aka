/**
 * DEMO záznam pro volitelné SL/TP a Limit bez nohou (`docs/reviews/instant-legs-design-20261106.md`).
 * Spouští JEN Filip. Scénáře: `recordLegsPlan.ts`, interpret a pojistky: `recordDemoSession.ts`
 * (jen DEMO8661118, MNQ front, DISARMED, flat na začátku, úklid a ověřený flat na konci, qty ≤ 2,
 * záznam mimo repo bez tokenů).
 *
 * Interpret zatím neběžel proti brokerovi, proto po krocích a záznam vždy prohlédnout:
 *   1. bez fillu: --scenario bare-limit-cancel --confirm
 *   2. s fillem: --scenario lone-stop-liquidate --confirm --allow-fill
 *   3. teprve potom zbytek, po jednom nebo --scenario all --confirm --allow-fill
 * Dry-run (nic se nepošle): bez `--confirm`.
 *   npx tsx scripts/copier/record-legs.ts --account 61038658 --symbol MNQZ6 --side Buy --market-price 28075 --scenario all
 * Volby `--sl-points 40` `--tp-points 40` (≥ 40). `lone-stop-then-oco` nespouštět kolem zpráv.
 *
 * Během běhu na nic nesahat. Exit 0 = hotovo a účet čistý; 2 = přerušeno, účet čistý;
 * 4 = účet NEověřen; 1 = nespuštěno. Bez závěrečného výpisu zkontroluj Tradovate.
 * Po záznamu: `npm run copier:mac -- reconcile` před ARM.
 */
import { parseRecordLegsArgs } from './recordLegsPlan';
import { runDemoRecording } from './recordDemoSession';

let plan: ReturnType<typeof parseRecordLegsArgs>;
try {
  plan = parseRecordLegsArgs(process.argv.slice(2));
} catch (reason) {
  console.error(`NESPUŠTĚNO: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
}
process.exit(await runDemoRecording(plan, { script: 'record-legs', filePrefix: 'leader-legs', tagPrefix: 'rlg' }));
