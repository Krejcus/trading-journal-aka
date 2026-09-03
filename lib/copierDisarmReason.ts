export type CopierDisarmTrigger =
  | 'fail-closed'
  | 'manual'
  | 'arm-expiry'
  | 'kill-switch'
  | 'transport';

export type CopierCopiesOutcome =
  | 'guard-flattened'
  | 'auto-closed'
  | 'left-open-protected'
  | 'left-open-unprotected'
  | 'flat'
  | 'unknown';

export type CopierDisarmCode =
  | 'follower-position-mismatch'
  | 'follower-transition-unverified'
  | 'follower-position-check-failed'
  | 'leader-flat-follower-open'
  | 'leader-flat-guard-failed'
  | 'modify-unconfirmed-filled'
  | 'flat-sweep-deadline'
  | 'flat-sweep-failed'
  | 'blocked-account-ineligible'
  | 'protective-order-incomplete'
  | 'sequence-broken'
  | 'order-rejected'
  | 'order-blocked'
  | 'oversized-broker-order'
  | 'leader-order-limit'
  | 'auto-close-failed'
  | 'flatten-failed'
  | 'transport-lost'
  | 'arm-expired'
  | 'kill-switch'
  | 'manual'
  | 'unknown';

export interface CopierDisarmRecord {
  at: number;
  trigger: CopierDisarmTrigger;
  code: CopierDisarmCode;
  /** Jedna lidská věta: co se stalo. */
  title: string;
  /** Původní technický text beze ztráty pro detail/tooltip. */
  detail: string;
  copiesOutcome: CopierCopiesOutcome;
  /** Jedna lidská věta: co má operátor udělat dál. */
  nextStep: string;
}

export const COPIER_DISARM_HISTORY_LIMIT = 20;

const COPY_BY_CODE: Record<CopierDisarmCode, { title: string; nextStep: string }> = {
  'follower-position-mismatch': {
    title: 'Pozice followera nesouhlasí s očekávaným násobkem leadera.',
    nextStep: 'Otevři Tradovate, porovnej pozice a potom spusť Kontrolu pozic.',
  },
  'follower-transition-unverified': {
    title: 'Follower má neočekávanou pozici a její vznik nelze bezpečně přiřadit.',
    nextStep: 'Ověř pozici i ochranné příkazy v Tradovate a potom spusť Kontrolu pozic.',
  },
  'follower-position-check-failed': {
    title: 'Broker nepotvrdil aktuální pozici followera.',
    nextStep: 'Zkontroluj spojení a skutečný stav účtu v Tradovate, potom spusť Kontrolu pozic.',
  },
  'leader-flat-follower-open': {
    title: 'Leader je flat, ale alespoň jedna kopie zůstala otevřená.',
    nextStep: 'Ověř všechny follower pozice a ochranné příkazy v Tradovate, potom spusť Kontrolu pozic.',
  },
  'leader-flat-guard-failed': {
    title: 'Ochranné zavření kopií při flat leaderovi nebylo potvrzené.',
    nextStep: 'Zkontroluj follower pozice v Tradovate a případné otevřené kopie zavři ručně.',
  },
  'modify-unconfirmed-filled': {
    title: 'Změnu příkazu nešlo potvrdit, protože objednávka mezitím skončila jako filled.',
    nextStep: 'Ověř výslednou pozici a ochranné příkazy v Tradovate, potom spusť Kontrolu pozic.',
  },
  'flat-sweep-deadline': {
    title: 'Úklid ochranných příkazů po zploštění překročil bezpečný časový limit.',
    nextStep: 'Ověř v Tradovate, že nezůstal working SL nebo target, a potom spusť Kontrolu pozic.',
  },
  'flat-sweep-failed': {
    title: 'Úklid ochranných příkazů po zploštění se nepodařilo potvrdit.',
    nextStep: 'Ověř v Tradovate, že nezůstal working SL nebo target, a potom spusť Kontrolu pozic.',
  },
  'blocked-account-ineligible': {
    title: 'Do kopírování vstoupil účet, který nebyl způsobilý pro nový příkaz.',
    nextStep: 'Zkontroluj stav účtu a před novým ARM ho vyřaď nebo autoritativně ověř.',
  },
  'protective-order-incomplete': {
    title: 'Ochranné SL a target se nepodařilo bezpečně spárovat.',
    nextStep: 'Ověř v Tradovate pozici i obě ochranné nohy a potom spusť Kontrolu pozic.',
  },
  'sequence-broken': {
    title: 'Události příkazů přišly v pořadí, které nelze bezpečně zpracovat.',
    nextStep: 'Počkej na ustálení broker stavu a potom spusť Kontrolu pozic.',
  },
  'order-rejected': {
    title: 'Broker odmítl alespoň jeden kopírovaný příkaz.',
    nextStep: 'Ověř odmítnutý účet, pozici a ochranné příkazy v Tradovate, potom spusť Kontrolu pozic.',
  },
  'order-blocked': {
    title: 'Bezpečnostní pravidlo zablokovalo kopírovaný příkaz.',
    nextStep: 'Ověř konkrétní blokaci v technickém detailu a potom spusť Kontrolu pozic.',
  },
  'oversized-broker-order': {
    title: 'Broker hlásí větší objednávku, než kopírka povolila.',
    nextStep: 'Ověř objednávku a pozici v Tradovate a potom spusť Kontrolu pozic.',
  },
  'leader-order-limit': {
    title: 'Byl překročen bezpečnostní limit nových leader příkazů pro tuto session.',
    nextStep: 'Nepokračuj v této session bez kontroly pozic a nového vědomého startu.',
  },
  'auto-close-failed': {
    title: 'Automatické zavření kopií nebylo potvrzené.',
    nextStep: 'Okamžitě ověř všechny follower pozice v Tradovate a otevřené kopie zavři ručně.',
  },
  'flatten-failed': {
    title: 'Požadované zploštění účtů nebylo potvrzené.',
    nextStep: 'Okamžitě ověř všechny cílové účty v Tradovate a zbývající pozice zavři ručně.',
  },
  'transport-lost': {
    title: 'Kopírka ztratila spojení s brokerem.',
    nextStep: 'Zkontroluj Tradovate a po obnovení spojení spusť Kontrolu pozic.',
  },
  'arm-expired': {
    title: 'Platnost ostrého ARM skončila.',
    nextStep: 'Zkontroluj výsledek kopií a nový ARM zapni jen vědomě pro další session.',
  },
  'kill-switch': {
    title: 'Kill switch nouzově zastavil kopírku.',
    nextStep: 'Ověř účty v Tradovate; nový start vyžaduje restart runtime a novou kontrolu pozic.',
  },
  manual: {
    title: 'Kopírka byla vypnuta ručně.',
    nextStep: 'Před dalším zapnutím ověř, že stav účtů odpovídá tvému záměru.',
  },
  unknown: {
    title: 'Kopírka se bezpečně vypnula z neznámého technického důvodu.',
    nextStep: 'Ověř pozice a working příkazy v Tradovate a potom spusť Kontrolu pozic.',
  },
};

export const copierCopiesOutcomeText = (outcome: CopierCopiesOutcome): string => ({
  'guard-flattened': 'Kopie byly guardem potvrzeně zavřené.',
  'auto-closed': 'Kopie byly automaticky a potvrzeně zavřené.',
  'left-open-protected': 'Otevřené kopie zůstaly na místě s brokerovou ochranou.',
  'left-open-unprotected': 'Otevřené kopie zůstaly bez potvrzené ochrany.',
  flat: 'Kopírka eviduje skupinu jako flat.',
  unknown: 'Výsledek kopií se nepodařilo potvrdit.',
})[outcome];

/**
 * Stabilní klasifikace je záměrně založená jen na existujících fail-closed
 * textech. Neznámý text se nikdy nepřikrášlí a zůstane celý v `detail`.
 */
export function classifyCopierDisarmReason(
  detail: string,
  trigger: CopierDisarmTrigger = 'fail-closed',
): CopierDisarmCode {
  if (trigger === 'manual') return 'manual';
  if (trigger === 'arm-expiry') return 'arm-expired';
  if (trigger === 'kill-switch') return 'kill-switch';
  if (trigger === 'transport') return 'transport-lost';

  const text = detail.replace(/\s+/g, ' ').trim();
  if (/flat sweep nedokončen.*deadline/i.test(text)) return 'flat-sweep-deadline';
  if (/flat sweep nedokončen/i.test(text)) return 'flat-sweep-failed';
  if (/modify.*(?:nebyl potvrzen|skončil).*filled|objednávka skončila jako filled/i.test(text)) {
    return 'modify-unconfirmed-filled';
  }
  if (/account-ineligible|účet (?:není|nebyl) způsobilý/i.test(text)) return 'blocked-account-ineligible';
  if (/má autoritativně pozici.*očekáváno/i.test(text)) return 'follower-position-mismatch';
  if (/příčinu nelze bezpečně přiřadit/i.test(text)) return 'follower-transition-unverified';
  if (/autoritativní kontrola (?:expozice|přechodu) followera.*selhala/i.test(text)) {
    return 'follower-position-check-failed';
  }
  if (/leader(?: je)? (?:autoritativně )?flat.*follower|leader-flat.*follower exit/i.test(text)) {
    return 'leader-flat-follower-open';
  }
  if (/ochranná noha.*neobjednanou pozici.*leader je flat/i.test(text)) {
    return 'leader-flat-follower-open';
  }
  if (/leader-flat (?:cílené zavření|guard nelze bezpečně založit)/i.test(text)) {
    return 'leader-flat-guard-failed';
  }
  if (/auto-close kopií/i.test(text)) return 'auto-close-failed';
  if (/flatten (?:selhal|nedokončil)/i.test(text)) return 'flatten-failed';
  if (/pending (?:bracket|oso) replace přišel mimo pořadí|protective leg přišel mimo pořadí|sequence-broken/i.test(text)) {
    return 'sequence-broken';
  }
  if (/nemá bezpečně spárovaný sl i tp|incomplete-bracket|oso.*(?:nejednozna|ambiguous)/i.test(text)) {
    return 'protective-order-incomplete';
  }
  if (/leader replace.*nemá pending korelaci/i.test(text)) return 'sequence-broken';
  if (/pilot limit nových leader objednávek/i.test(text)) return 'leader-order-limit';
  if (/cizí navýšení množství/i.test(text)) return 'oversized-broker-order';
  if (/po obnovení spojení|po reconnectu|transport|websocket/i.test(text)) return 'transport-lost';
  if (/\b(?:rejected|odmít(?:l|n)|reject)\b/i.test(text)) return 'order-rejected';
  if (/\b(?:blocked|maxcontracts blokoval|quantity-limit|symbol-not-allowed)\b/i.test(text)) return 'order-blocked';
  return 'unknown';
}

export function createCopierDisarmRecord(input: {
  at: number;
  trigger: CopierDisarmTrigger;
  detail: string;
  copiesOutcome: CopierCopiesOutcome;
  code?: CopierDisarmCode;
}): CopierDisarmRecord {
  const detail = input.detail.trim() || 'Bez technického detailu';
  const code = input.code ?? classifyCopierDisarmReason(detail, input.trigger);
  const copy = COPY_BY_CODE[code];
  return {
    at: input.at,
    trigger: input.trigger,
    code,
    title: copy.title,
    detail,
    copiesOutcome: input.copiesOutcome,
    nextStep: copy.nextStep,
  };
}
