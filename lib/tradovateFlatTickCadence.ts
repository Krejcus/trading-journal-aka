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

/**
 * Vedlejší připojení = worker právě hlásí stav a žádný účet tohoto připojení není v jeho skupině
 * (např. DEMO login vedle skupiny Lucid). Přes appku se na něm neobchoduje, worker za něj neručí
 * a graf z něj nic nepotvrzuje; bez pozice se čte po 30 s. Každá otevřená appka tak z rozpočtu
 * toho loginu bere polovinu (11. 11. 2026: dvě appky držely login na hodinovém stropu).
 * S pozicí, při poruše workera a u účtů skupiny platí původní tempo.
 */
export const SIDE_FLAT_TICK_INTERVAL_MS = 30_000;
const WORKER_RECEIPT_MAX_AGE_MS = 8_000;

export function isWorkerSideConnection(
  receipt: { status?: unknown; observedAt?: number | null } | null | undefined,
  accountIds: readonly number[],
  now: number,
): boolean {
  const at = receipt?.observedAt;
  if (at == null || !Number.isFinite(at) || at > now + 1_000 || now - at > WORKER_RECEIPT_MAX_AGE_MS) return false;
  const status = receipt?.status as { controller?: { connected?: unknown }; group?: { leaderAccountId?: unknown; followers?: unknown } } | null | undefined;
  if (status?.controller?.connected !== true) return false;
  const leader = status.group?.leaderAccountId;
  if (typeof leader !== 'number' || !Number.isSafeInteger(leader)) return false;
  const followers = Array.isArray(status.group?.followers) ? status.group.followers as Array<{ accountId?: unknown }> : null;
  // Neznámé složení skupiny = nevíme, zda účet do ní patří → původní tempo.
  if (!followers || followers.some(row => typeof row?.accountId !== 'number')) return false;
  const members = new Set<number>([leader, ...followers.map(row => row.accountId as number)]);
  return accountIds.length > 0 && accountIds.every(id => !members.has(id));
}

/** Časovač se budí s rozptylem; čtení o chlup dřív nesmí přeskočit celé kolo. */
const TIMER_SLACK_MS = 500;
/** Rezerva na dobu samotného čtení při odhadu, kdy přijde další kolo plného čtení. */
export const FULL_TICK_ROUND_COST_MS = 1_500;

/**
 * Která připojení se v tomto kole čtou plným tickem. Připojení s pozicí vždy (jeho tempo
 * řídí smyčka); prázdné tak, aby rozestup použitých čtení nepřekročil interval: čte se, jakmile by
 * čekání na další kolo plného čtení (`nextRoundMs`) interval přetáhlo. Kola plného čtení jsou
 * s pozicí na připojení bez ručení workeru po ~7 s, takže čisté „až po 15 s“ by dalo až 21 s —
 * víc než 20s okno potvrzení pozic v grafu (review 5fa36aeb). Selhané čtení
 * čas neposouvá a zkusí se v dalším kole jako dřív (odmítnutí rozpočtem a 429 mají vlastní
 * odklad jinde). Neznámý čas posledního čtení = číst hned.
 */
export function dueFullTickConnections(options: {
  connectionIds: readonly string[];
  hasOpenPosition: (connectionId: string) => boolean;
  lastFlatTickAt: Readonly<Record<string, number | undefined>>;
  flatIntervalMs: number;
  /** Vlastní interval pro jednotlivé připojení (vedlejší login); bez něj platí `flatIntervalMs`. */
  flatIntervalMsOf?: (connectionId: string) => number;
  /** Odhad, za jak dlouho smyčka nabídne další plné čtení (raději delší: čte se pak dřív). */
  nextRoundMs: number;
  now: number;
}): string[] {
  return options.connectionIds.filter(connectionId => {
    if (options.hasOpenPosition(connectionId)) return true;
    const last = options.lastFlatTickAt[connectionId];
    const own = options.flatIntervalMsOf?.(connectionId) ?? 0;
    const interval = Math.max(options.flatIntervalMs, own);
    if (last == null || !Number.isFinite(last) || last > options.now || options.now - last >= interval - TIMER_SLACK_MS) return true;
    // Vlastní delší interval (vedlejší login) se nepředbíhá: pohled dopředu by ho při kolech po 15 s
    // zkrátil zpět na 15 s (review 5afdb327). Nic na něm nestojí, pár sekund navíc nevadí.
    if (own > options.flatIntervalMs) return false;
    return options.now - last + Math.max(0, options.nextRoundMs) > interval;
  });
}
