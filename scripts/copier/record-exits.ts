/**
 * C0 DEMO conformance výstupů z pozice (`docs/reviews/trading-gaps-designs/exits.md`
 * §0.6): zmenšení nohou OSO (C2), zrušení jedné nohy OCO (C2), fill TP jednoho
 * lístku (C3, C18c/R7), ocas eventů po liquidate a otočení (C4). Spouští JEN Filip.
 * Scénáře: `recordExitsPlan.ts`, interpret a pojistky: `recordDemoSession.ts` +
 * `recordDemoPlan.ts` (jen DEMO8661118, MNQ front, DISARMED, flat na začátku,
 * úklid a ověřený flat na konci, qty/expozice ≤ 2, záznam mimo repo bez tokenů).
 *
 * Dry-run (nic se nepřipojí ani nepošle, jen plán a pojistky proti statusu workeru):
 *   npx tsx scripts/copier/record-exits.ts --account 61038658 --symbol MNQZ6 --side Buy \
 *     --market-price 28075 --scenario resize,resize-one-leg,ticket-cancel,tp-fill,reverse
 * Skutečné zadání (všechny scénáře tady se vyplní): přidat `--confirm --allow-fill`.
 * Volby: `--sl-points 40` `--tp-points 40` (≥ 40), `--tp-market` (tp-fill: TP → Market),
 * `--placement sequential` (tp-fill jako R7 přikoupení s vlastními nohami),
 * `--repeat 1–5` `--tickets 1|2` `--gap-ms 300–6000` (reverse).
 *
 * Během běhu na nic nesahat (ARM, Tradovate). Exit 0 = hotovo a účet čistý;
 * 2 = scénář přerušen, účet čistý; 4 = účet NEověřen; 1 = nespuštěno.
 * Po záznamu: `npm run copier:mac -- reconcile` (read-only) před ARM.
 */
import { parseRecordExitsArgs } from './recordExitsPlan';
import { runDemoRecording } from './recordDemoSession';

let plan: ReturnType<typeof parseRecordExitsArgs>;
try {
  plan = parseRecordExitsArgs(process.argv.slice(2));
} catch (reason) {
  console.error(`NESPUŠTĚNO: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
}
process.exit(await runDemoRecording(plan, { script: 'record-exits', filePrefix: 'leader-exits', tagPrefix: 'rex' }));
