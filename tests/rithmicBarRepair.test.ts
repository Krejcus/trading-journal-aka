import { describe, expect, it } from 'vitest';
import { BAR_REPAIR_MAX_SPAN_SEC, BAR_REPAIR_SETTLE_MS, barRepairWindow, mergeRepairedBars, mergeRepairWindows, repairedBarsFrom } from '../services/rithmic/barRepair';

const bar = (time: number, open = 1, volume = 10) => ({ time, open, high: open + 1, low: open - 1, close: open, volume });
const MIN = 1_795_504_320; // celá minuta (s)

describe('oprava svíček po výpadku cen ve službě', () => {
  it('okno jde od minuty výpadku po minutu obnovy; ptát se smí až po jejím skončení', () => {
    const w = barRepairWindow((MIN - 120) * 1_000 + 31_000, MIN * 1_000 + 22_000);
    expect(w).toEqual({ fromSec: MIN - 180, lastSec: MIN, dueAtMs: (MIN + 60) * 1_000 + BAR_REPAIR_SETTLE_MS });
  });

  it('start procesu = minuta startu a jedna před ní (přihlášení může přejít přes hranici minuty)', () => {
    const at = MIN * 1_000 + 5_000;
    expect(barRepairWindow(at, at)).toMatchObject({ fromSec: MIN - 60, lastSec: MIN });
  });

  it('dlouhý výpadek se jedním dotazem doplňuje nejvýš 6 hodin zpět', () => {
    const w = barRepairWindow((MIN - 24 * 3_600) * 1_000, MIN * 1_000);
    expect(w.fromSec).toBe(MIN - BAR_REPAIR_MAX_SPAN_SEC);
  });

  it('z odpovědi bere jen svíčky okna; bez svíčky minuty obnovy je odpověď neúplná', () => {
    const w = barRepairWindow(MIN * 1_000, MIN * 1_000 + 20_000);
    expect(repairedBarsFrom([bar(MIN - 180), bar(MIN - 60)], w)).toEqual({ bars: [bar(MIN - 60)], complete: false });
    expect(repairedBarsFrom([bar(MIN + 60, 9), bar(MIN, 3), bar(MIN - 60, 2), bar(MIN - 180, 1)], w)).toEqual({ bars: [bar(MIN - 60, 2), bar(MIN, 3)], complete: true });
  });

  it('nesmyslnou svíčku zahodí', () => {
    const w = barRepairWindow(MIN * 1_000, MIN * 1_000);
    expect(repairedBarsFrom([{ ...bar(MIN), open: Number.NaN }], w)).toEqual({ bars: [], complete: false });
  });

  it('dvě čekající opravy se sloučí do jednoho okna (rozpadající se spojení nenásobí dotazy)', () => {
    const first = barRepairWindow((MIN - 300) * 1_000, (MIN - 240) * 1_000);
    const second = barRepairWindow((MIN - 30) * 1_000, MIN * 1_000 + 10_000);
    expect(mergeRepairWindows(first, second)).toEqual({ fromSec: first.fromSec, lastSec: MIN, dueAtMs: second.dueAtMs });
  });

  it('do historie opravené svíčky nahradí a chybějící vloží', () => {
    const history = [bar(MIN - 180, 1), bar(MIN, 26898.25)];
    expect(mergeRepairedBars(history, [bar(MIN - 60, 5), bar(MIN, 26903.25)])).toEqual([bar(MIN - 180, 1), bar(MIN - 60, 5), bar(MIN, 26903.25)]);
    expect(mergeRepairedBars(history, [])).toEqual(history);
  });
});
