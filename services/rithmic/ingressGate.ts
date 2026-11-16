/**
 * Rozhodovací funkce vstupní brány přímého kanálu — NEZAPOJENÝ prototyp k návrhu
 * docs/reviews/rithmic-direct-channel-design-v2-20261116.md.
 *
 * Čistá funkce: (politika, požadavek, stav procesu) → přijmout / odmítnout s důvodem.
 * Nic neověřuje sama (podpis, token a přihlášení ověří volající a předá výsledek),
 * nic neprovádí a nemá žádné výchozí nastavení: politika je vždy vstup. Sporné body
 * z oponentury (co smí jít relayem, kdy je potřeba token, délka platnosti, čerstvost
 * znalosti o brzdách) jsou data v politice, dokud je vlastník neschválí.
 *
 * Pevná pravidla, která politika změnit NEMŮŽE:
 *  - neznámý typ příkazu se odmítne;
 *  - nic se nepřijme bez důkazů, které politika pro třídu a cestu vyžaduje — ani
 *    brzda (neověřený požadavek se nikdy neprovede; odložit smí jen zápis a audit);
 *  - každá třída musí mít pro každou povolenou cestu aspoň jeden vyžadovaný důkaz;
 *  - plot proti brzdě (`brakeEpoch`) se u brzd a snížení rizika NIKDY nekontroluje
 *    (po vypnutí musí projít zavření, zrušení vlastního vstupu i doplnění SL);
 *  - brzdy nemají kontrolu času klienta (telefon s rozhozenými hodinami musí zabrzdit);
 *  - snížení rizika musí nést identitu cíle (jinak by opožděné „zavřít" zavřelo jinou pozici);
 *  - bez načteného stavu procesu projdou jen brzdy;
 *  - zvýšení rizika a správa vyžadují živé spojení s brokerem;
 *  - brzda nesmí být těžší než vstup: kudy smí přijít zvýšení rizika nebo správa,
 *    tudy smí i brzda a snížení rizika, a nevyžadují žádný důkaz navíc;
 *  - čtení stavu (`read`) se rozhoduje jen podle důkazů — klient z něj plot teprve získává.
 *
 * Smlouvy pro volajícího (brána je sama nevynutí):
 *  - Zařazení příkazu do třídy je vstup. Vykonavatel musí pro každý typ deklarovat
 *    nejvolnější přípustnou třídu a volnější zařazení odmítnout (příkaz zapisující
 *    k brokerovi zařazený jako `brake` by šel bez plotu, času i živého brokera).
 *  - U snížení rizika brána jen vyžaduje, že cíl je uveden; že cíl odpovídá skutečné
 *    pozici (obchod / epocha pozice), ověřuje vykonavatel těsně před zápisem.
 *  - Platnost důkazů (krátkodobý token) mezi přijetím a zápisem hlídá volající;
 *    brána při druhé kontrole dostává jen stav procesu.
 */
export type CommandClass = 'brake' | 'risk-reducing' | 'risk-increasing' | 'manage' | 'read';
export type IngressPath = 'direct' | 'relay';
/** Co volající ověřil: podpis klíčem klienta, krátkodobý token uživatele, přihlášení uživatele na relayi. */
export type IngressProof = 'clientKey' | 'userToken' | 'relayUserAuth';

export interface ClassPolicy {
  /** Pro každou povolenou cestu seznam důkazů, které musí být VŠECHNY ověřené. Chybějící cesta = zakázáno. */
  paths: Partial<Record<IngressPath, readonly IngressProof[]>>;
  /** Kontrola času záměru (jen u tříd, kde ji pevná pravidla dovolují). */
  time?: {
    /** Nejdelší dovolená platnost záměru od jeho vzniku. */
    maxValidityMs: number;
    /** O kolik smí být čas vzniku v budoucnosti proti hodinám procesu. */
    clockToleranceMs: number;
  };
  /** Vyžadovat čerstvé potvrzení serveru, že nečeká žádná brzda (lease). */
  requireFreshBrakeKnowledge?: boolean;
}

export interface IngressPolicy {
  /** Typ příkazu → třída. Co tu není, neexistuje. */
  commands: Readonly<Record<string, CommandClass>>;
  classes: Readonly<Record<CommandClass, ClassPolicy>>;
}

export interface IngressFence {
  processId: string;
  startedAt: number;
  brakeEpoch: number;
}

export interface IngressRequest {
  path: IngressPath;
  commandType: string;
  /** Důkazy, které volající skutečně ověřil (ne ty, které požadavek tvrdí). */
  verified: readonly IngressProof[];
  /** Plot ze statusu, který klient viděl. */
  fence?: IngressFence;
  /** Identita cíle (účet + obchod / epocha pozice). */
  target?: string;
  /** Čas vzniku záměru podle klienta a jeho neměnná konečná platnost (z podepsaného těla). */
  createdAt?: number;
  validUntil?: number;
}

export interface IngressProcessState {
  processId: string;
  startedAt: number;
  brakeEpoch: number;
  /** Durable stav procesu je načtený (kniha operací, klíče, limity). */
  stateLoaded: boolean;
  /** Spojení s brokerem je živé podle zprávy serveru, ne časovače. */
  brokerAlive: boolean;
  /** Server v posledních L ms potvrdil, že nečeká žádná brzda. */
  brakeKnowledgeFresh: boolean;
  now: number;
}

export type IngressRefusal =
  | 'unknown-command'
  | 'path-not-allowed'
  | 'not-verified'
  | 'state-not-loaded'
  | 'stale-process'
  | 'stale-brake-epoch'
  | 'missing-target'
  | 'missing-time'
  | 'expired'
  | 'from-future'
  | 'validity-too-long'
  | 'invalid-validity'
  | 'broker-not-alive'
  | 'brake-knowledge-stale';

export type IngressDecision =
  | { ok: true; commandClass: CommandClass; /** Plot, který se musí znovu ověřit těsně před zápisem. */ recheck: 'none' | 'process' | 'process+brake' }
  | { ok: false; code: IngressRefusal; detail: string };

const refuse = (code: IngressRefusal, detail: string): IngressDecision => ({ ok: false, code, detail });
const CLASSES: readonly CommandClass[] = ['brake', 'risk-reducing', 'risk-increasing', 'manage', 'read'];
const PATHS: readonly IngressPath[] = ['direct', 'relay'];
const fenceMode = (commandClass: CommandClass): 'none' | 'process' | 'process+brake' =>
  commandClass === 'risk-increasing' || commandClass === 'manage' ? 'process+brake' : commandClass === 'brake' ? 'none' : 'process';

const isPath = (value: unknown): value is IngressPath => value === 'direct' || value === 'relay';
const PROOFS: readonly IngressProof[] = ['clientKey', 'userToken', 'relayUserAuth'];
/** Pojistka proti nesmyslné politice; skutečná čísla jsou v politice a musí být menší. */
const HARD_MAX_VALIDITY_MS = 60_000;
const HARD_MAX_CLOCK_TOLERANCE_MS = 10_000;

function proofsFor(rules: ClassPolicy, path: IngressPath): readonly IngressProof[] | undefined {
  return Object.prototype.hasOwnProperty.call(rules.paths, path) ? rules.paths[path] : undefined;
}

/** Ověří, že politika neporušuje pevná pravidla. Chyba = proces nenastartuje. */
export function assertValidIngressPolicy(policy: IngressPolicy): void {
  for (const commandClass of CLASSES) {
    const rules = policy.classes[commandClass];
    if (!rules) throw new Error(`Politika brány nemá třídu ${commandClass}`);
    for (const key of Object.keys(rules.paths)) {
      if (!isPath(key)) throw new Error(`Politika brány: třída ${commandClass} má neznámou cestu ${key}`);
      const proofs = rules.paths[key];
      if (!Array.isArray(proofs) || proofs.length === 0) {
        throw new Error(`Politika brány: třída ${commandClass} cestou ${key} nevyžaduje žádný důkaz`);
      }
      if (proofs.some((proof) => !PROOFS.includes(proof))) throw new Error(`Politika brány: třída ${commandClass} má neznámý důkaz`);
    }
    const noTime = commandClass === 'brake' || commandClass === 'risk-reducing' || commandClass === 'read';
    if (commandClass === 'brake' && rules.time) throw new Error('Politika brány: brzdy nesmí mít kontrolu času');
    if (commandClass === 'risk-reducing' && rules.time) {
      throw new Error('Politika brány: snížení rizika se váže na identitu cíle, ne na čas');
    }
    if (commandClass === 'read' && rules.time) throw new Error('Politika brány: čtení nemá kontrolu času');
    if (noTime && rules.requireFreshBrakeKnowledge) {
      throw new Error(`Politika brány: třída ${commandClass} nesmí čekat na znalost o brzdách`);
    }
    if (!noTime) {
      if (!rules.time) throw new Error(`Politika brány: třída ${commandClass} musí mít kontrolu času`);
      const { maxValidityMs, clockToleranceMs } = rules.time;
      if (
        !Number.isFinite(maxValidityMs) || !Number.isFinite(clockToleranceMs) ||
        !(maxValidityMs > 0 && maxValidityMs <= HARD_MAX_VALIDITY_MS) ||
        !(clockToleranceMs >= 0 && clockToleranceMs <= HARD_MAX_CLOCK_TOLERANCE_MS)
      ) {
        throw new Error(`Politika brány: neplatné časy u třídy ${commandClass}`);
      }
    }
  }
  if (!PATHS.some((path) => proofsFor(policy.classes.brake, path))) throw new Error('Politika brány: brzdy nemají žádnou cestu');
  // Brzda ani snížení rizika nesmí být těžší než to, co riziko zvyšuje.
  for (const risky of ['risk-increasing', 'manage'] as const) {
    for (const path of PATHS) {
      const riskyProofs = proofsFor(policy.classes[risky], path);
      if (!riskyProofs) continue;
      for (const safe of ['brake', 'risk-reducing'] as const) {
        const safeProofs = proofsFor(policy.classes[safe], path);
        if (!safeProofs) throw new Error(`Politika brány: cestou ${path} smí přijít ${risky}, ale ne ${safe}`);
        if (safeProofs.some((proof) => !riskyProofs.includes(proof))) {
          throw new Error(`Politika brány: ${safe} cestou ${path} vyžaduje důkaz, který ${risky} nepotřebuje`);
        }
      }
    }
  }
  for (const [type, commandClass] of Object.entries(policy.commands)) {
    if (!CLASSES.includes(commandClass)) throw new Error(`Politika brány: příkaz ${type} má neznámou třídu`);
  }
}

export type AcceptedIngress = Extract<IngressDecision, { ok: true }>;

export interface IngressGate {
  /** Rozhodnutí při přijetí požadavku. */
  evaluate(request: IngressRequest, state: IngressProcessState): IngressDecision;
  /**
   * Druhá kontrola synchronně těsně před zápisem k brokerovi (po všech `await`).
   * Přijme jen rozhodnutí, které tato brána sama vydala.
   */
  recheckBeforeWrite(
    decision: AcceptedIngress,
    request: Pick<IngressRequest, 'fence' | 'validUntil'>,
    state: IngressProcessState,
  ): IngressDecision;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Ověří politiku, zmrazí její kopii a vrátí bránu. Jiná cesta k rozhodování neexistuje. */
export function createIngressGate(input: IngressPolicy): IngressGate {
  const policy = deepFreeze(JSON.parse(JSON.stringify(input)) as IngressPolicy);
  assertValidIngressPolicy(policy);
  const issued = new WeakSet<object>();
  const accept = (commandClass: CommandClass, recheck: AcceptedIngress['recheck']): AcceptedIngress => {
    const decision: AcceptedIngress = Object.freeze({ ok: true as const, commandClass, recheck });
    issued.add(decision);
    return decision;
  };

  function evaluate(request: IngressRequest, state: IngressProcessState): IngressDecision {
    const commandClass = Object.prototype.hasOwnProperty.call(policy.commands, request.commandType)
      ? policy.commands[request.commandType]
      : undefined;
    if (!commandClass) return refuse('unknown-command', `příkaz ${String(request.commandType)} brána nezná`);
    const rules = policy.classes[commandClass];
    const proofs = isPath(request.path) ? proofsFor(rules, request.path) : undefined;
    if (!proofs || proofs.length === 0) return refuse('path-not-allowed', `třída ${commandClass} nesmí přijít cestou ${String(request.path)}`);
    const verified = Array.isArray(request.verified) ? request.verified : [];
    const missing = proofs.filter((proof) => !verified.includes(proof));
    if (missing.length) return refuse('not-verified', `chybí ověření: ${missing.join(', ')}`);
    // Brzda a čtení stavu: stačí důkazy. Čtení musí jít i bez plotu a bez načteného stavu,
    // jinak by klient plot nikdy nezískal a neviděl by ani to, že proces není připravený.
    if (commandClass === 'brake' || commandClass === 'read') return accept(commandClass, 'none');
    if (!state.stateLoaded) return refuse('state-not-loaded', 'stav procesu není načtený — projdou jen brzdy a čtení');

    const mode = fenceMode(commandClass);
    const fence = request.fence;
    if (!fence || fence.processId !== state.processId || fence.startedAt !== state.startedAt) {
      return refuse('stale-process', 'požadavek vznikl pro jiný běh procesu');
    }
    if (mode === 'process+brake' && fence.brakeEpoch !== state.brakeEpoch) {
      return refuse('stale-brake-epoch', 'od vzniku požadavku přišla brzda nebo nové zapnutí');
    }
    if (!request.target) return refuse('missing-target', `třída ${commandClass} bez identity cíle`);

    if (rules.time) {
      const { createdAt, validUntil } = request;
      if (typeof createdAt !== 'number' || typeof validUntil !== 'number' || !Number.isFinite(createdAt) || !Number.isFinite(validUntil)) {
        return refuse('missing-time', 'chybí čas vzniku nebo platnost záměru');
      }
      if (createdAt > state.now + rules.time.clockToleranceMs) return refuse('from-future', 'čas vzniku je v budoucnosti');
      if (validUntil <= createdAt) return refuse('invalid-validity', 'platnost záměru končí dřív, než vznikl');
      if (validUntil - createdAt > rules.time.maxValidityMs) return refuse('validity-too-long', 'platnost záměru je delší, než třída dovoluje');
      if (!(validUntil > state.now)) return refuse('expired', 'záměr už neplatí');
    }
    if (commandClass === 'risk-increasing' || commandClass === 'manage') {
      if (!state.brokerAlive) return refuse('broker-not-alive', 'spojení s brokerem není živé');
      if (rules.requireFreshBrakeKnowledge && !state.brakeKnowledgeFresh) {
        return refuse('brake-knowledge-stale', 'nevím, jestli nečeká brzda');
      }
    }
    return accept(commandClass, mode);
  }

  function recheckBeforeWrite(
    decision: AcceptedIngress,
    request: Pick<IngressRequest, 'fence' | 'validUntil'>,
    state: IngressProcessState,
  ): IngressDecision {
    if (!issued.has(decision)) return refuse('not-verified', 'rozhodnutí nevydala tato brána');
    if (decision.recheck === 'none') return decision;
    if (!state.stateLoaded) return refuse('state-not-loaded', 'stav procesu přestal být načtený');
    const fence = request.fence;
    if (!fence || fence.processId !== state.processId || fence.startedAt !== state.startedAt) {
      return refuse('stale-process', 'proces se mezitím restartoval');
    }
    if (decision.recheck === 'process+brake') {
      if (fence.brakeEpoch !== state.brakeEpoch) return refuse('stale-brake-epoch', 'mezi přijetím a zápisem přišla brzda');
      if (!state.brokerAlive) return refuse('broker-not-alive', 'spojení s brokerem spadlo před zápisem');
      const rules = policy.classes[decision.commandClass];
      if (rules.time && !(typeof request.validUntil === 'number' && request.validUntil > state.now)) {
        return refuse('expired', 'záměr vypršel před zápisem');
      }
      if (rules.requireFreshBrakeKnowledge && !state.brakeKnowledgeFresh) {
        return refuse('brake-knowledge-stale', 'nevím, jestli nečeká brzda');
      }
    }
    return decision;
  }

  return Object.freeze({ evaluate, recheckBeforeWrite });
}
