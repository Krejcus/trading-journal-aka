/**
 * Rozpočet dotazů na účty a limity (RMS) u Rithmicu.
 *
 * Proč: Rithmic počítá dotazy typu „Get Accounts" do TVRDÉHO limitu 2000 na uživatele od posledního
 * plánovaného restartu jejich systému. Po vyčerpání uživatele automaticky vypne a odhlásí všechna spojení;
 * zapnutí zpět jde jen přes podporu. Stalo se 18. 11. 2026 v 1:40: služba četla limity každých 5 s
 * (2000 × 5 s ≈ 2 h 47 min od spuštění).
 *
 * Pravidla:
 *  - limity se čtou po (znovu)připojení a pak nejvýš jednou za `RMS_LIMITS_REFRESH_MS`;
 *  - neúspěšné čtení se opakuje nejdřív za `retryMs` (žádná rychlá smyčka);
 *  - počítadlo je TRVALÉ (přežije restart služby) a drží se po kalendářních týdnech UTC — Rithmic svůj čítač
 *    nuluje jen při plánovaném restartu, jehož čas neznáme, proto je týdenní strop hluboko pod 2000;
 *  - do téhož počítadla jde i každé PŘIHLÁŠENÍ k příkazům (posílá dotaz na seznam účtů); navíc má hodinový strop;
 *  - po vyčerpání stropu se už nečte ani nepřihlašuje: limity zestárnou a služba nové vstupy odmítne
 *    (zavření a ochrana otevřené pozice na limitech nezávisí), adaptér se po dalším výpadku sám nepřipojí.
 *
 * Co NENÍ ověřeno: které šablony (302 / 304 / 306) Rithmic do čítače počítá a kdy ho nuluje. Jedno čtení limitů
 * posílá 304 i 306 a počítá se tu jako JEDEN dotaz (odpovídá časování incidentu: 2000 × 5 s); strop má proto
 * rezervu i pro případ, že se počítají oba.
 *
 * Čistá logika bez souborů a času — úložiště a hodiny dodává volající.
 */
export interface RmsQueryBudgetState { week: string; count: number }

export const RMS_QUERY_WEEKLY_CAP = 400;
/** Nejvýš tolik přihlášení k příkazům za hodinu (kmitající spojení); pak se adaptér zastaví. */
export const RMS_LOGINS_PER_HOUR_CAP = 20;
export const RMS_LIMITS_REFRESH_MS = 60 * 60_000;
export const RMS_LIMITS_RETRY_MS = 5 * 60_000;
export const RMS_LIMITS_RECONNECT_MIN_MS = 60_000;
/** Jak dlouho smí služba pracovat s naposledy přečtenými limity (pak vstupy odmítá, dokud je nepřečte znovu). */
export const RMS_LIMITS_MAX_AGE_MS = 90 * 60_000;

/** Týden UTC začínající pondělím, jako `YYYY-MM-DD` jeho pondělí. */
export function rmsBudgetWeek(now: number): string {
  const date = new Date(now);
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return new Date(monday).toISOString().slice(0, 10);
}

const valid = (state: unknown): state is RmsQueryBudgetState =>
  typeof state === 'object' && state !== null
  && typeof (state as RmsQueryBudgetState).week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((state as RmsQueryBudgetState).week)
  && Number.isSafeInteger((state as RmsQueryBudgetState).count) && (state as RmsQueryBudgetState).count >= 0;

/**
 * Zapíše jeden dotaz do rozpočtu. `undefined` = záznam ještě neexistuje (začíná se od nuly). Cokoli jiného
 * nečitelného (včetně `null` a prázdného souboru) se bere jako VYČERPANÉ — neznámý počet = nečíst; jinak by
 * poškozený soubor rozpočet tiše vynuloval. Záznam z budoucího týdne (posunuté hodiny) se také nenuluje.
 */
export function spendRmsQuery(stored: unknown, now: number, cap: number = RMS_QUERY_WEEKLY_CAP): { allowed: boolean; state: RmsQueryBudgetState } {
  const week = rmsBudgetWeek(now);
  if (stored !== undefined && !valid(stored)) return { allowed: false, state: { week, count: cap } };
  const current = valid(stored) && stored.week >= week ? stored.count : 0;
  if (current >= cap) return { allowed: false, state: { week, count: current } };
  return { allowed: true, state: { week, count: current + 1 } };
}

/** Je čas číst limity? `lastAttemptAt` = poslední pokus (úspěšný i ne), `lastOk` = jak dopadl. */
export function rmsLimitsReadDue(input: { now: number; lastAttemptAt: number | null; lastOk: boolean; epochChanged: boolean }): boolean {
  if (input.lastAttemptAt === null) return true;
  const since = input.now - input.lastAttemptAt;
  // Nové přihlášení čte brzy (jinak by po krátkém výpadku stály vstupy), ale kmitající spojení nejvýš jednou za minutu;
  // čtení i samotná přihlášení pak zastaví týdenní strop.
  if (input.epochChanged) return since >= RMS_LIMITS_RECONNECT_MIN_MS;
  return since >= (input.lastOk ? RMS_LIMITS_REFRESH_MS : RMS_LIMITS_RETRY_MS);
}

/** Hodinový strop přihlášení: vrátí nový seznam časů a zda je další přihlášení dovolené. */
export function rmsLoginAllowed(recent: readonly number[], now: number, cap: number = RMS_LOGINS_PER_HOUR_CAP): { allowed: boolean; recent: number[] } {
  const kept = recent.filter((at) => now - at < 3_600_000);
  return kept.length >= cap ? { allowed: false, recent: kept } : { allowed: true, recent: [...kept, now] };
}
