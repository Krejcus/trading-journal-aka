/**
 * Souhlas s obchodováním na SKUTEČNÉM systému Rithmicu (ne Rithmic Test).
 *
 * Výchozí stav je VYPNUTO: bez platného souhlasu jde jiný systém spustit jen pro čtení. Souhlas je soubor,
 * který vytvoří člověk u klávesnice (scripts/rithmic/grantLiveTrading.ts — chce terminál a opsání věty
 * s číslem účtu), platí jen pro jeden systém + uživatele + účet a jen omezenou dobu. Smazání souboru
 * = okamžité vypnutí nových vstupů. Vypršení ani smazání NIKDY nebrání zavření, rušení a správě ochrany.
 */
export interface LiveTradingConsent {
  version: 1 | 2;
  system: string;
  user: string;
  account: string;
  grantedAt: number;
  expiresAt: number;
  /** Strop kusů na příkaz i na pozici (nejvýš LIVE_CONSENT_MAX_QUANTITY). */
  maxQuantity: number | 'rms';
  /** Každý vstup musí nést SL (serverová ochrana). */
  requireStop: boolean;
  /** Věta, kterou člověk opsal — musí odpovídat `liveConsentPhrase(account)`. */
  phrase: string;
}

export const LIVE_CONSENT_MAX_HOURS = 24;
export const LIVE_CONSENT_MAX_QUANTITY = 2;
export const liveConsentPhrase = (account: string): string => `OBCHODOVAT ${account}`;

export interface LiveConsentContext { system: string; user: string; accounts: readonly string[]; now: number }

/** `null` = souhlas platí pro tento systém, uživatele a účet. Jinak důvod, proč ne (česky, pro obsluhu). */
export function liveTradingConsentProblem(value: unknown, context: LiveConsentContext): string | null {
  if (context.system === 'Rithmic Test') return 'souhlas se týká jen skutečných systémů — Rithmic Test ho nepotřebuje';
  if (!value || typeof value !== 'object') return 'souhlas s obchodováním na skutečném účtu chybí';
  const consent = value as Partial<LiveTradingConsent>;
  if (consent.version !== 1 && consent.version !== 2) return 'souhlas má neznámou verzi';
  const text = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 120;
  if (!text(consent.system) || !text(consent.user) || !text(consent.account) || !text(consent.phrase)) return 'souhlas je neúplný';
  if (consent.system !== context.system) return `souhlas je pro systém „${consent.system}", běží „${context.system}"`;
  if (consent.user !== context.user) return 'souhlas je pro jiného uživatele Rithmicu';
  // Jeden účet na přihlášení: služba obchoduje vždy první účet, víc účtů by znamenalo nejistotu, který to je.
  if (context.accounts.length !== 1) return `přihlášení má ${context.accounts.length} účtů — obchodování na skutečném systému jde jen s jedním`;
  if (context.accounts[0] !== consent.account) return 'souhlas je pro jiný účet';
  if (consent.phrase !== liveConsentPhrase(consent.account)) return 'souhlas nemá opsanou větu s číslem účtu';
  const finite = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item);
  if (!finite(consent.grantedAt) || !finite(consent.expiresAt)) return 'souhlas nemá platnost';
  if (consent.grantedAt > context.now + 60_000) return 'souhlas je vydaný v budoucnosti (hodiny?)';
  if (consent.expiresAt - consent.grantedAt > LIVE_CONSENT_MAX_HOURS * 3_600_000 || consent.expiresAt <= consent.grantedAt) return `souhlas smí platit nejvýš ${LIVE_CONSENT_MAX_HOURS} hodin`;
  if (context.now >= consent.expiresAt) return 'souhlas vypršel — vydej nový (scripts/rithmic/grantLiveTrading.ts)';
  if (!(consent.version === 2 && consent.maxQuantity === 'rms')) {
    const max = consent.maxQuantity;
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > (consent.version === 1 ? LIVE_CONSENT_MAX_QUANTITY : 2_147_483_647)) return 'souhlas má neplatný strop kusů';
  }
  if (typeof consent.requireStop !== 'boolean') return 'souhlas neříká, jestli je SL povinný';
  return null;
}
