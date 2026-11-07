/**
 * SL a TP po jedné u vlastní holé pozice (6. 11. 2026, `docs/reviews/instant-legs-design-20261106.md`).
 * Čisté brány pro worker. Stav je `bare: true` s 0, 1 nebo 2 id nohou; 2 nohy = běžný spravovaný obchod.
 */
export type ManualLeg = 'stopLoss' | 'takeProfit';
export type SingleLegAction = 'add-leg' | 'remove-leg' | 'move-stop' | 'move-target';

/**
 * Smí akce projít mimo ARMED ∧ ¬shadow ∧ ¬kill? Jen přidání SL k pozici bez nohou: riziko jen snižuje
 * a nic neruší. Přidání TP i odebrání nohy ruší ochrannou nohu, INV-BRAKE-02 to pod brzdou zakazuje.
 */
export function singleLegAllowedUnderBrake(input: { action: SingleLegAction; leg: ManualLeg | null; hasStop: boolean; hasTarget: boolean }): boolean {
  return input.action === 'add-leg' && input.leg === 'stopLoss' && !input.hasStop && !input.hasTarget;
}

/** Cena nohy vůči trhu: správná strana a aspoň `minTicks`. null = smí. */
export function singleLegPriceProblem(input: {
  side: 'Buy' | 'Sell'; leg: ManualLeg; price: number; market: number; minTicks: number; tick?: number;
}): string | null {
  const tick = input.tick ?? 0.25;
  const dir = input.side === 'Buy' ? 1 : -1;
  const gain = (input.price - input.market) * dir;
  const gap = input.minTicks * tick - 1e-9;
  const ok = input.leg === 'stopLoss' ? gain <= -gap : gain >= gap;
  return ok ? null : `${input.leg === 'stopLoss' ? 'SL' : 'TP'} musí být aspoň ${input.minTicks} ticků od trhu na správné straně (trh ${input.market}).`;
}

/**
 * Korelátor páruje samostatnou nohu k čerstvému fillu podle času (`inferenceWindowMs`) a samotná noha by
 * skončila `incomplete-bracket-pair`. Bez známého času fillu čekáme déle, Fill může přijít až po pozici.
 */
export function singleLegFillSettled(input: { now: number; fillAt: number | null; createdAt: number; windowMs: number }): boolean {
  if (input.fillAt != null) return input.now - input.fillAt >= input.windowMs + 250;
  return input.now - input.createdAt >= Math.max(5_000, input.windowMs + 250);
}
