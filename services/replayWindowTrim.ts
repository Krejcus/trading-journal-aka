/**
 * Kam zakotvit ořez replay okna, když po načtení starší historie přeroste limit.
 *
 * Původně se okno vždy ořízlo na posledních `maxBars` — tedy ke konci dat.
 * Jenže historie se dotahuje právě ve chvíli, kdy je uživatel scrollem hluboko
 * v minulosti: okno se mu pod rukama přesunulo na konec a graf skočil dopředu
 * (reprodukováno: pohled na 00:00–02:00 skončil na 14:00–15:00).
 *
 * Ořez proto kotvíme kolem toho, kam se uživatel dívá, a jen doplníme rezervu
 * na další scrollování. Když viewport neznáme, chováme se jako dřív.
 *
 * Vrací index, na kterém má okno začínat.
 */
export const replayTrimStartIndex = (params: {
  /** Hranice aktuálního okna v poli svíček (po případném prependu). */
  windowStart: number;
  windowEnd: number;
  /**
   * Index svíčky, na kterou sahá pravý okraj pohledu — dohledaný podle ČASU
   * v aktuálním poli. Logický index z grafu se použít nedá: vztahuje se ke
   * starým vykresleným barům, kdežto okno je už z nového pole. Míchání obou
   * soustav posunulo kotvu o celý prepend a graf odskočil o dny.
   */
  viewEndIndex: number | null;
  /** Maximální počet vykreslovaných barů. */
  maxBars: number;
  /** Rezerva, o kterou se okno posouvá při scrollu. */
  chunk: number;
}): number => {
  const { windowStart, windowEnd, viewEndIndex, maxBars, chunk } = params;
  if (viewEndIndex === null || !Number.isFinite(viewEndIndex)) {
    return Math.max(0, windowEnd - maxBars);
  }
  // Okno musí obsáhnout pohled i rezervu, ale nikdy nesmí přerůst konec dat.
  const anchorEnd = Math.min(windowEnd, Math.max(viewEndIndex + chunk, windowStart + maxBars));
  return Math.max(0, anchorEnd - maxBars);
};
