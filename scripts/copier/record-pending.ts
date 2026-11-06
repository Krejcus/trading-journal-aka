/**
 * R1–R7 DEMO záznam čekajících vstupů (`docs/reviews/trading-gaps-designs/pending.md`
 * §1.2): posun rodiče OSO a relativní posun nohou (R1, R2), modify Suspended
 * nohou (R3), noha po fillu s novou cenou (R4), orderQty rodiče (R5), víc
 * čekajících OSO z flat souběžně (R6a+c = exits split-limit). R6b a R7 viz
 * `recordPendingPlan.ts` (překryvy). C5e se nenahrává. Spouští JEN Filip.
 * Pojistky: `recordDemoSession.ts` + `recordDemoPlan.ts` (jen DEMO8661118, MNQ
 * front, DISARMED, flat na začátku, úklid a ověřený flat, qty/expozice ≤ 2).
 *
 * Dry-run (nic se nepřipojí ani nepošle):
 *   npx tsx scripts/copier/record-pending.ts --account 61038658 --symbol MNQZ6 --side Buy \
 *     --market-price 28075 --scenario all
 * Bez fillu (R1, R3, R5, R6): přidat `--confirm`.
 * S možným fillem (R2 přes trh, R4 Limit na trhu): přidat `--confirm --allow-fill`.
 * Volby: `--sl-points 40` `--tp-points 40`, `--fill-wait-ms 10000–180000` (R4),
 * aliasy `--scenario r1,r3,r5`.
 *
 * Exit 0 = hotovo a účet čistý; 2 = přerušeno, účet čistý; 4 = účet NEověřen;
 * 1 = nespuštěno. Po záznamu: `npm run copier:mac -- reconcile` (read-only).
 */
import { parseRecordPendingArgs } from './recordPendingPlan';
import { runDemoRecording } from './recordDemoSession';

let plan: ReturnType<typeof parseRecordPendingArgs>;
try {
  plan = parseRecordPendingArgs(process.argv.slice(2));
} catch (reason) {
  console.error(`NESPUŠTĚNO: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
}
process.exit(await runDemoRecording(plan, { script: 'record-pending', filePrefix: 'leader-pending', tagPrefix: 'rpd' }));
