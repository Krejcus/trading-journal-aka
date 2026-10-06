export type CopierDisarmTrigger =
  | 'fail-closed'
  | 'manual'
  | 'config-change'
  | 'arm-expiry'
  | 'kill-switch'
  | 'transport'
  /** OAuth připojení propfirmy zmizelo ze serveru za běhu (odpojeno/odvoláno). */
  | 'connection-removed';

export type CopierCopiesOutcome =
  | 'guard-flattened'
  | 'auto-closed'
  | 'left-open-protected'
  | 'left-open-unprotected'
  | 'flat'
  | 'unknown';

export type CopierDisarmCode =
  | 'config-change'
  | 'connection-removed'
  | 'reconcile-request'
  | 'prop-reserve'
  | 'route-gap-divergence'
  | 'host-sleep'
  | 'leader-flat-read-failed'
  | 'unexplained-position-divergence'
  | 'prop-limit'
  | 'follower-position-mismatch'
  | 'follower-transition-unverified'
  | 'follower-position-check-failed'
  | 'leader-flat-follower-open'
  | 'leader-flat-guard-failed'
  | 'modify-unconfirmed-filled'
  | 'flat-sweep-deadline'
  | 'flat-sweep-failed'
  | 'protective-stop-retained'
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
  /** Durable leader exposure episode, whose later guard may refine only this outcome. */
  episodeId?: string;
  /** Jedna lidská věta: co má operátor udělat dál. */
  nextStep: string;
}

export const COPIER_DISARM_HISTORY_LIMIT = 20;

const COPY_BY_CODE: Record<CopierDisarmCode, { title: string; nextStep: string }> = {
  'connection-removed': {
    title: 'Kopírka se vypnula, protože bylo odpojeno připojení propfirmy.',
    nextStep: 'Připoj propfirmu znovu v Připojeních, nebo její účty odeber ze skupiny; potom spusť Kontrolu pozic.',
  },
  'config-change': {
    title: 'Kopírka se vypnula kvůli uložení změny skupiny.',
    nextStep: 'Zkontroluj uložené účty a pravidla; nový ARM zapni až po ověření skupiny.',
  },
  'reconcile-request': {
    title: 'Kopírka se vypnula před ruční Kontrolou pozic.',
    nextStep: 'Počkej na dokončení read-only kontroly a nový ARM zapni jen po čistém výsledku.',
  },
  'prop-reserve': {
    title: 'Kopírka zůstala vypnutá kvůli nedostatečné rezervě followera nad prop floorem.',
    nextStep: 'Ověř aktuální rezervu a denní P&L účtu u prop firmy; po opravě nastavení spusť Kontrolu pozic.',
  },
  'route-gap-divergence': {
    title: 'Stav účtu se během obměny broker spojení změnil mimo stream kopírky.',
    nextStep: 'Ověř pozice a working příkazy dotčené route v Tradovate a potom spusť Kontrolu pozic.',
  },
  'host-sleep': {
    title: 'Mac se uspal nebo přestal odpovídat; kopírka zůstala bezpečně vypnutá.',
    nextStep: 'Otevři Tradovate, ověř pozice a working příkazy a potom spusť Kontrolu pozic.',
  },
  'leader-flat-read-failed': {
    title: 'Dozor po flat leaderovi nedostal včas spolehlivý broker snapshot.',
    nextStep: 'Oveř pozice leadera i followerů v Tradovate a potom spusť Kontrolu pozic.',
  },
  'unexplained-position-divergence': {
    title: 'Pozice followerů se odchýlily od očekávané kopie.',
    nextStep: 'Ověř pozice a ochranné příkazy všech dotčených účtů v Tradovate, potom spusť Kontrolu pozic.',
  },
  'prop-limit': {
    title: 'Prop limit zablokoval nebo ukončil kopírování na účtu.',
    nextStep: 'Ověř stav a limity účtu u prop firmy i v Tradovate; před novým ARM účet vyřaď nebo autoritativně ověř.',
  },
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
  'protective-stop-retained': {
    title: 'Follower drží svůj SL, který leader zrušil — rozhodni ručně v Tradovate.',
    nextStep: 'Ověř otevřenou pozici followera a jeho working SL přímo v Tradovate; ochranu neruš naslepo.',
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
  const text = detail.replace(/\s+/g, ' ').trim();
  // Host sleep is a more truthful transport cause and must win over the
  // generic transport trigger supplied by older controller call sites.
  if (/\bhost-sleep\b|Mac neodpovídal od/i.test(text)) return 'host-sleep';
  if (trigger === 'manual') return 'manual';
  if (trigger === 'config-change') return 'config-change';
  if (trigger === 'connection-removed') return 'connection-removed';
  if (trigger === 'arm-expiry') return 'arm-expired';
  if (trigger === 'kill-switch') return 'kill-switch';
  if (trigger === 'transport') return 'transport-lost';

  if (/\breconcile-request\b|kontrolou pozic/i.test(text)) return 'reconcile-request';
  if (/\bprop-reserve\b|rezerv[auy].*prop floor/i.test(text)) return 'prop-reserve';
  if (/\broute-gap-divergence\b/i.test(text)) return 'route-gap-divergence';
  if (/leader-flat-read-failed|leader-flat guard.*(?:read deadline|deadline.*(?:position|order)|čtení.*selhal)/i.test(text)) {
    return 'leader-flat-read-failed';
  }
  if (/\bconfig-change\b|uložen(?:í|ím).*změn[ay] skupiny/i.test(text)) return 'config-change';
  if (/unexplained-position-divergence|nevysvětlen[áou]+ (?:position )?divergenc/i.test(text)) {
    return 'unexplained-position-divergence';
  }
  if (/\bprop[- ]limit\b|prop limitu|drawdown floor|liquidation-only/i.test(text)) return 'prop-limit';
  if (/flat sweep nedokončen.*deadline/i.test(text)) return 'flat-sweep-deadline';
  if (/flat sweep nedokončen/i.test(text)) return 'flat-sweep-failed';
  if (/follower drží (?:svůj )?sl, který leader zrušil|ochranný cancel byl zastaven před odesláním/i.test(text)) {
    return 'protective-stop-retained';
  }
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
  if (/leader-flat guard/i.test(text)) return 'leader-flat-guard-failed';
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
  episodeId?: string;
}): CopierDisarmRecord {
  const detail = input.detail.trim() || 'Bez technického detailu';
  const requestedCode = input.code ?? classifyCopierDisarmReason(detail, input.trigger);
  // Status přichází z nezávisle nasazovaného workeru. Novější worker může
  // poslat kód, který starší UI ještě nezná; nesmí tím shodit incident panel.
  const code = Object.prototype.hasOwnProperty.call(COPY_BY_CODE, requestedCode)
    ? requestedCode
    : classifyCopierDisarmReason(detail, input.trigger);
  const copy = COPY_BY_CODE[code];
  return {
    at: input.at,
    trigger: input.trigger,
    code,
    title: copy.title,
    detail,
    copiesOutcome: input.copiesOutcome,
    ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    nextStep: copy.nextStep,
  };
}

/**
 * Starší worker mohl uložit `unknown`, přestože detail nebo lastError nese
 * známou příčinu. UI ji smí zpřesnit, ale nesmí měnit výsledek kopií.
 */
export function resolveCopierDisarmRecord(
  record: CopierDisarmRecord | undefined,
  lastError?: string | null,
): CopierDisarmRecord | undefined {
  if (!record) return undefined;
  // Worker posílá stabilní kód; text vlastní UI, aby i nový `config-change`
  // dostal přesnou českou hlášku bez závislosti na verzi workeru.
  if (record.code !== 'unknown' && Object.prototype.hasOwnProperty.call(COPY_BY_CODE, record.code)) {
    return createCopierDisarmRecord({
      at: record.at,
      trigger: record.trigger,
      detail: record.detail,
      copiesOutcome: record.copiesOutcome,
      code: record.code,
      ...(record.episodeId ? { episodeId: record.episodeId } : {}),
    });
  }
  const detailCode = classifyCopierDisarmReason(record.detail, record.trigger);
  const fallbackDetail = lastError?.trim() || '';
  const fallbackCode = fallbackDetail
    ? classifyCopierDisarmReason(fallbackDetail, record.trigger)
    : 'unknown';
  const detail = detailCode !== 'unknown' ? record.detail
    : fallbackCode !== 'unknown' ? fallbackDetail
      : record.detail;
  const code = detailCode !== 'unknown' ? detailCode : fallbackCode;
  if (code === 'unknown') return record;
  return createCopierDisarmRecord({
    at: record.at,
    trigger: record.trigger,
    detail,
    copiesOutcome: record.copiesOutcome,
    code,
    ...(record.episodeId ? { episodeId: record.episodeId } : {}),
  });
}
