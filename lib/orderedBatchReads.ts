/** Souběžnost čtení po dávkách: rychlejší než za sebou, šetrné k Supabase. */
export const ORDERED_BATCH_READ_CONCURRENCY = 4;

/**
 * Spustí `count` dávkových čtení nejvýš po `concurrency` současně a vrátí
 * výsledky v pořadí dávek. Volající je pak vyhodnotí stejně jako dřív při
 * čtení za sebou (první chyba v pořadí rozhoduje). Po prvním výjimečném
 * selhání (změna účtu, zrušení) se další dávky už nespouští; doběhnou jen
 * rozjeté a vyhodí se chyba s nejnižším indexem.
 */
export async function orderedBatchReads<T>(
  count: number,
  read: (index: number) => Promise<T>,
  concurrency = ORDERED_BATCH_READ_CONCURRENCY,
): Promise<T[]> {
  const results = new Array<T>(count);
  const failures = new Map<number, unknown>();
  let next = 0;
  const worker = async () => {
    while (next < count && failures.size === 0) {
      const index = next++;
      try {
        results[index] = await read(index);
      } catch (error) {
        failures.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, worker));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}
