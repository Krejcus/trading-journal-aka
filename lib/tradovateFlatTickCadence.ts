/**
 * Tempo zobrazovacího čtení (pozice + příkazy, 2 dotazy u brokera) pro připojení BEZ pozice.
 *
 * Smyčka čtení běží podle nejrychlejšího připojení: s pozicí kdekoli po 3 s. Do 11. 11. 2026
 * se v tom tempu četlo i každé prázdné připojení, za které worker neručí (např. DEMO vedle
 * skupiny Lucid) — 40 dotazů/min, tedy přesně minutový strop zobrazovacího pruhu, na který
 * pak narážela ostatní čtení. Prázdné připojení má vlastní tempo nezávislé na ostatních:
 * stejných 15 s (LIVE) jako když je prázdné všechno, takže se nic nečte řidčeji než dřív.
 *
 * Jen zobrazení: nic z toho neautorizuje příkaz ani nemění, co worker čte (INV-UI-01/03,
 * INV-TRAD-09).
 */

/** Časovač se budí s rozptylem; čtení o chlup dřív nesmí přeskočit celé kolo. */
const TIMER_SLACK_MS = 500;

/**
 * Která připojení se v tomto kole čtou plným tickem. Připojení s pozicí vždy (jeho tempo
 * řídí smyčka); prázdné jen po uplynutí intervalu od posledního použitého čtení. Selhané čtení
 * čas neposouvá a zkusí se v dalším kole jako dřív (odmítnutí rozpočtem a 429 mají vlastní
 * odklad jinde). Neznámý čas posledního čtení = číst hned.
 */
export function dueFullTickConnections(options: {
  connectionIds: readonly string[];
  hasOpenPosition: (connectionId: string) => boolean;
  lastFlatTickAt: Readonly<Record<string, number | undefined>>;
  flatIntervalMs: number;
  now: number;
}): string[] {
  return options.connectionIds.filter(connectionId => {
    if (options.hasOpenPosition(connectionId)) return true;
    const last = options.lastFlatTickAt[connectionId];
    return last == null || !Number.isFinite(last) || last > options.now
      || options.now - last >= options.flatIntervalMs - TIMER_SLACK_MS;
  });
}
