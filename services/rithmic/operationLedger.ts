/**
 * Kniha operací přímého kanálu — NEZAPOJENÝ prototyp k návrhu
 * docs/reviews/rithmic-direct-channel-design-v2-20261116.md (oddíly 4 a 5 + oponentura).
 *
 * Čistá logika: jediné IO je vložené úložiště, čas je vždy parametr.
 *
 * Co zajišťuje:
 *  - každá operace má právě jeden durable záznam; stejné ID + stejný záměr vrací
 *    aktuální stav, stejné ID + jiný záměr je konflikt beze změny;
 *  - `accepted` je uložené dřív, než se `accept` vrátí; `sending` dřív, než se
 *    `beginSending` vrátí — teprve pak smí volající psát k brokerovi;
 *  - zrušit jde jen to, co ještě nezačalo odesílat (`cancelBeforeSend`); uzavřít
 *    odesílanou operaci smí jen držitel dokladu z `beginSending` (`settleSent`),
 *    takže rušení naslepo nikdy neoznačí letící zápis za „neodešlo";
 *  - restart u zápisů k brokerovi: `accepted` → `rejected` (nic neodešlo),
 *    `sending` → `unknown` (mohlo odejít: jen dohledání, nikdy nové provedení);
 *  - `unknown` blokuje další zvýšení rizika a správu — na stejném cíli vždy, a u
 *    hlídaných druhů (vstup, správa, zapnutí) kdekoli — dokud ho někdo výslovně
 *    nevyřeší (`resolveUnknown`); snížení rizika a brzdy projdou;
 *  - kapacita (jeden nevyřízený, rozestup, strop za 24 h) se počítá ze záznamů
 *    a rezervuje při přijetí; do rozestupu a stropu se počítá VŠE, co začalo
 *    odesílat — i příkaz, který broker odmítl;
 *  - dvě snížení rizika téhož cíle neběží souběžně; zvýšení rizika a správa čekají
 *    na cokoli otevřeného na cíli; snížení rizika na visící vstup nečeká;
 *  - otevřené, neznámé, brzdy a snížení rizika se neořezávají nikdy.
 *
 * Smlouvy pro volajícího (kniha je sama nevynutí):
 *  - BRZDA NEČEKÁ NA KNIHU. Třída `brake` se uplatní i tehdy, když `accept`
 *    vyhodí výjimku (plný disk) nebo odmítne; kniha je pro brzdy jen audit
 *    a deduplikace. Odložit smí zápis, nikdy samotné zabrzdění.
 *  - Třída `brake` smí být jen idempotentní zpřísnění stavu (vypnout, kill, zámek
 *    dne) — nikdy akce u brokera. Flatten a rušení příkazů patří do
 *    `risk-reducing`. Přijatou brzdu vrací `load` v `reapply`; volající ověří
 *    její platnost (obchodní den) dřív, než ji uplatní znovu.
 *  - `validUntil` a cíl musí být součástí podepsaného záměru (otisku) a vázané
 *    na start procesu; jinak by po ořezu prošlo staré ID s čerstvou platností.
 *  - Pozdní výsledek pro už uzavřený záznam (`settleSent` vyhodí chybu) je incident:
 *    volající ho musí ohlásit a stav ověřit čtením, ne ignorovat.
 *  - Kniha není zámek procesu: jedinou instanci musí zaručit lease/zámek souboru.
 *  - Odesílatel má vlastní časový limit a po něm operaci vždy uzavře jako `unknown`;
 *    kniha dobu odesílání nehlídá. Zavření a brzda na visící vstup nečekají.
 *  - Načtení za běhu (po selhání uložení) shodí všechny operace v letu do `unknown` /
 *    `rejected`. Odesílatel, kterému pak `settleSent` selže, předá skutečný výsledek
 *    přes `resolveUnknown` s dokladem `late-result`.
 *  - Brzda vrácená v `reapply`, kterou volající neuplatní ani neuzavře, zůstane otevřená.
 *
 * Záměrně nerozhodnuto (parametry nebo věc volajícího): všechna čísla, složení
 * otisku, formát a místo úložiště, kdo vlastní blokaci ARM při `unknown`,
 * zdroj času přes restart, identita cíle.
 */
export type OperationState = 'accepted' | 'sending' | 'done' | 'rejected' | 'unknown';
export type OperationClass = 'brake' | 'risk-reducing' | 'risk-increasing' | 'manage';

export interface OperationRecord {
  operationId: string;
  /** Otisk záměru — skládá volající (typ, cíl, prostředí, konfigurace, platnost, tělo). */
  fingerprint: string;
  operationClass: OperationClass;
  /** Druh pro rozestup a stropy, např. 'entry', 'manage', 'arm'. */
  kind: string;
  /** Cíl (účet, pozice, obchod) — operace se stejným cílem neběží souběžně. */
  target?: string;
  state: OperationState;
  /** Pořadí přijetí; monotónní i přes restart a ořez. */
  sequence: number;
  acceptedAt: number;
  /** Neměnná konečná platnost záměru; opakování ji neprodlužuje. */
  validUntil: number;
  /** Vyplněno, jakmile operace začala odesílat k brokerovi (i když pak byla odmítnuta). */
  sendingAt?: number;
  /** Doklad odesílatele; bez něj nejde odesílanou operaci uzavřít. */
  sendingToken?: number;
  settledAt?: number;
  /** Krátký strojový důvod u `rejected` / `unknown`. */
  reason?: string;
  /** Výsledek pro klienta (jen data k zobrazení). */
  result?: unknown;
}

export interface OperationLedgerSnapshot {
  records: OperationRecord[];
  revision: number;
  /** Nejvyšší kdy přidělené pořadí (přežívá ořez). */
  sequence: number;
}

export interface OperationLedgerStore {
  load(): Promise<OperationLedgerSnapshot>;
  /** Atomicky a trvale, jen když uložená revize = `expectedRevision`; jinak chyba. */
  save(records: OperationRecord[], sequence: number, expectedRevision: number): Promise<void>;
}

export interface OperationLimits {
  /** Druhy, pro které platí zámek „jeden nevyřízený" (napříč těmito druhy). */
  singlePendingKinds: readonly string[];
  /** Nejmenší odstup od předchozí operace téhož druhu (ms). */
  spacingMs: Readonly<Record<string, number>>;
  /** Nejvíc operací druhu za klouzavých 24 h. Rizikový druh bez stropu se nepřijme. */
  dailyCap: Readonly<Record<string, number>>;
}

export interface OperationRequest {
  operationId: string;
  fingerprint: string;
  operationClass: OperationClass;
  kind: string;
  target?: string;
  validUntil: number;
}

export type AcceptOutcome =
  | { status: 'accepted'; record: OperationRecord }
  /** Tatáž operace už existuje: vrací se její stav, nic se nespouští. */
  | { status: 'existing'; record: OperationRecord }
  /** Stejné ID, jiný záměr: záznam se nemění, nic se nespouští. */
  | { status: 'conflict'; record: OperationRecord }
  | { status: 'refused'; reason: 'expired' | 'busy' | 'unresolved' | 'spacing' | 'daily-cap' | 'invalid'; detail: string };

const DAY_MS = 24 * 3_600_000;
const STATES: ReadonlySet<string> = new Set(['accepted', 'sending', 'done', 'rejected', 'unknown']);
const CLASSES: ReadonlySet<string> = new Set(['brake', 'risk-reducing', 'risk-increasing', 'manage']);
const OPEN: ReadonlySet<OperationState> = new Set(['accepted', 'sending']);
const EXEMPT: ReadonlySet<OperationClass> = new Set(['brake', 'risk-reducing']);

/** Do rozestupu a stropu se nepočítá jen to, co prokazatelně nikdy nezačalo odesílat. */
const countsTowardLimits = (record: OperationRecord): boolean => record.state !== 'rejected' || record.sendingAt !== undefined;
const normalTarget = (target: string | undefined): string | undefined => (target ? target : undefined);

function assertValidRecord(record: OperationRecord): void {
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  if (
    !record.operationId || !record.fingerprint || !record.kind ||
    !STATES.has(record.state) || !CLASSES.has(record.operationClass) ||
    !finite(record.acceptedAt) || !finite(record.validUntil) ||
    !Number.isSafeInteger(record.sequence) || record.sequence <= 0 ||
    (record.sendingAt !== undefined && !finite(record.sendingAt))
  ) {
    throw new Error(`Kniha operací je poškozená: neplatný záznam ${record.operationId || '(bez ID)'}`);
  }
}

export class OperationLedger {
  private readonly store: OperationLedgerStore;
  private readonly limits: OperationLimits;
  private records = new Map<string, OperationRecord>();
  private revision = 0;
  private sequence = 0;
  private loaded = false;
  /** Všechny změny i načtení jdou jednou frontou; rozhodnutí padne uvnitř jednoho jejího kroku. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: OperationLedgerStore, limits: OperationLimits) {
    this.store = store;
    this.limits = limits;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Načte knihu a uzavře, co restart přerušil. Volá se při startu (a po selhání uložení).
   * `reapply` = přijaté brzdy, které volající musí po ověření platnosti uplatnit znovu.
   */
  load(now: number): Promise<{ rejected: string[]; unknown: string[]; reapply: OperationRecord[] }> {
    return this.enqueue(async () => {
      this.loaded = false;
      const snapshot = await this.store.load();
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
        throw new Error('Kniha operací je poškozená: neplatná revize nebo pořadí');
      }
      const map = new Map<string, OperationRecord>();
      const rejected: string[] = [];
      const unknown: string[] = [];
      const reapply: OperationRecord[] = [];
      let changed = false;
      for (const record of snapshot.records) {
        assertValidRecord(record);
        if (map.has(record.operationId)) throw new Error(`Kniha operací je poškozená: duplicitní ID ${record.operationId}`);
        if (record.sequence > snapshot.sequence) throw new Error('Kniha operací je poškozená: pořadí záznamu je vyšší než uložené maximum');
        const next = { ...record };
        if (next.operationClass === 'brake' && OPEN.has(next.state)) {
          // Přijatá brzda nesmí restartem zmizet: zůstává otevřená a volající ji uplatní znovu.
          if (next.state !== 'accepted' || next.sendingToken !== undefined) changed = true;
          next.state = 'accepted';
          delete next.sendingToken;
          reapply.push({ ...next });
        } else if (next.state === 'accepted') {
          next.state = 'rejected';
          next.reason = 'restart-before-send';
          next.settledAt = now;
          rejected.push(next.operationId);
          changed = true;
        } else if (next.state === 'sending') {
          next.state = 'unknown';
          next.reason = 'restart-during-send';
          next.settledAt = now;
          delete next.sendingToken;
          unknown.push(next.operationId);
          changed = true;
        }
        map.set(next.operationId, next);
      }
      let revision = snapshot.revision;
      if (changed) {
        await this.store.save([...map.values()], snapshot.sequence, snapshot.revision);
        revision += 1;
      }
      this.records = map;
      this.revision = revision;
      this.sequence = snapshot.sequence;
      this.loaded = true;
      return { rejected, unknown, reapply };
    });
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('Kniha operací není načtená');
  }

  private async persist(mutate: (draft: Map<string, OperationRecord>) => void, sequence = this.sequence): Promise<void> {
    const draft = new Map([...this.records].map(([key, value]) => [key, { ...value }]));
    mutate(draft);
    try {
      await this.store.save([...draft.values()], sequence, this.revision);
    } catch (error) {
      // Stav na disku je nejistý (zápis mohl i proběhnout): knihu je nutné znovu načíst.
      this.loaded = false;
      throw error;
    }
    this.revision += 1;
    this.sequence = sequence;
    this.records = draft;
  }

  get(operationId: string): OperationRecord | null {
    this.assertLoaded();
    const record = this.records.get(operationId);
    return record ? { ...record } : null;
  }

  /** Operace s neznámým výsledkem — dokud je někdo výslovně nevyřeší. */
  unresolved(): OperationRecord[] {
    this.assertLoaded();
    return [...this.records.values()].filter((r) => r.state === 'unknown').map((r) => ({ ...r }));
  }

  private refusal(request: OperationRequest, target: string | undefined, now: number): AcceptOutcome | null {
    if (request.operationClass === 'brake') return null;
    const all = [...this.records.values()];
    if (target) {
      // Dvě snížení rizika téhož cíle nikdy souběžně (dvě zavření téže pozice, dva stopy).
      // Snížení rizika ale NEČEKÁ na visící vstup nebo správu: zavřít musí jít vždy.
      // Zvýšení rizika a správa čekají na cokoli otevřeného na cíli.
      const exemptRequest = EXEMPT.has(request.operationClass);
      const sameTarget = all.find(
        (r) => OPEN.has(r.state) && r.operationClass !== 'brake' && r.target === target && (!exemptRequest || r.operationClass === 'risk-reducing'),
      );
      if (sameTarget) return { status: 'refused', reason: 'busy', detail: `na cíli ${target} běží operace ${sameTarget.operationId}` };
    }
    if (EXEMPT.has(request.operationClass)) return null;
    if (!target) return { status: 'refused', reason: 'invalid', detail: 'riziková operace bez cíle' };
    // Neznámý výsledek na cíli: další riziko by se mohlo sečíst s příkazem, který možná prošel.
    const unresolved = all.find((r) => r.state === 'unknown' && r.target === target);
    if (unresolved) return { status: 'refused', reason: 'unresolved', detail: `operace ${unresolved.operationId} na cíli ${target} má neznámý výsledek` };
    if (this.limits.singlePendingKinds.includes(request.kind)) {
      const busy = all.find((r) => OPEN.has(r.state) && this.limits.singlePendingKinds.includes(r.kind));
      if (busy) return { status: 'refused', reason: 'busy', detail: `běží operace ${busy.operationId}` };
      // Neznámý výsledek hlídaného druhu blokuje všechny hlídané druhy i na jiném cíli téhož
      // účtu (cíl může být „účet + obchod"): možná vyplněný vstup + nový vstup = dvojnásobek.
      const pendingUnknown = all.find((r) => r.state === 'unknown' && this.limits.singlePendingKinds.includes(r.kind));
      if (pendingUnknown) {
        return { status: 'refused', reason: 'unresolved', detail: `operace ${pendingUnknown.operationId} má neznámý výsledek` };
      }
    }
    const cap = this.limits.dailyCap[request.kind];
    if (cap === undefined) return { status: 'refused', reason: 'invalid', detail: `druh ${request.kind} nemá nastavený strop` };
    const counted = all.filter((r) => r.kind === request.kind && countsTowardLimits(r));
    const spacing = this.limits.spacingMs[request.kind];
    if (spacing !== undefined) {
      const last = counted.reduce((max, r) => Math.max(max, r.acceptedAt), -Infinity);
      if (now - last < spacing) return { status: 'refused', reason: 'spacing', detail: `rozestup ${spacing} ms` };
    }
    if (counted.filter((r) => now - r.acceptedAt < DAY_MS).length >= cap) {
      return { status: 'refused', reason: 'daily-cap', detail: `strop ${cap} za 24 h` };
    }
    return null;
  }

  /**
   * Přijme operaci; záznam `accepted` je uložený dřív, než se vrátí.
   * U třídy `brake` viz smlouvu v hlavičce: brzda se uplatní i při výjimce odsud.
   */
  accept(request: OperationRequest, now: number): Promise<AcceptOutcome> {
    return this.enqueue(async () => {
      this.assertLoaded();
      if (!request.operationId || !request.fingerprint || !request.kind || !CLASSES.has(request.operationClass) || !Number.isFinite(now)) {
        return { status: 'refused', reason: 'invalid', detail: 'chybí ID, otisk, druh nebo třída' } as const;
      }
      const target = normalTarget(request.target);
      const existing = this.records.get(request.operationId);
      if (existing) {
        const same =
          existing.fingerprint === request.fingerprint &&
          existing.operationClass === request.operationClass &&
          existing.kind === request.kind &&
          existing.target === target;
        return { status: same ? 'existing' : 'conflict', record: { ...existing } } as const;
      }
      const exempt = EXEMPT.has(request.operationClass);
      if (!exempt && !(Number.isFinite(request.validUntil) && request.validUntil > now)) {
        return { status: 'refused', reason: 'expired', detail: 'záměr už neplatí' } as const;
      }
      const refusal = this.refusal(request, target, now);
      if (refusal) return refusal;
      const sequence = this.sequence + 1;
      const record: OperationRecord = {
        operationId: request.operationId,
        fingerprint: request.fingerprint,
        operationClass: request.operationClass,
        kind: request.kind,
        ...(target ? { target } : {}),
        state: 'accepted',
        sequence,
        acceptedAt: now,
        validUntil: Number.isFinite(request.validUntil) ? request.validUntil : 0,
      };
      await this.persist((draft) => draft.set(record.operationId, record), sequence);
      return { status: 'accepted', record: { ...record } } as const;
    });
  }

  /**
   * Těsně před zápisem k brokerovi. Vrací doklad (číslo), se kterým jde operaci
   * uzavřít, nebo null — pak se k brokerovi NESMÍ zapsat (operace není `accepted`,
   * už ji někdo zrušil, nebo jí vypršela platnost).
   */
  beginSending(operationId: string, now: number): Promise<number | null> {
    return this.enqueue(async () => {
      this.assertLoaded();
      const record = this.records.get(operationId);
      if (!record || record.state !== 'accepted') return null;
      if (!EXEMPT.has(record.operationClass) && !(record.validUntil > now)) {
        await this.persist((draft) => {
          const r = draft.get(operationId)!;
          r.state = 'rejected';
          r.reason = 'expired-before-send';
          r.settledAt = now;
        });
        return null;
      }
      const token = this.revision + 1;
      await this.persist((draft) => {
        const r = draft.get(operationId)!;
        r.state = 'sending';
        r.sendingAt = now;
        r.sendingToken = token;
      });
      return token;
    });
  }

  /**
   * Zruší operaci, která ještě nezačala odesílat (brzda, konec platnosti, brána).
   * Vrací false a nic nemění, když už odesílá nebo je uzavřená — pak je její
   * výsledek věcí odesílatele a NELZE ji prohlásit za neodeslanou.
   */
  cancelBeforeSend(operationId: string, now: number, reason: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertLoaded();
      const record = this.records.get(operationId);
      if (!record || record.state !== 'accepted') return false;
      await this.persist((draft) => {
        const r = draft.get(operationId)!;
        r.state = 'rejected';
        r.reason = reason;
        r.settledAt = now;
      });
      return true;
    });
  }

  /**
   * Uzavře odesílanou operaci. Smí jen držitel dokladu z `beginSending`.
   * `rejected` tu znamená „broker výslovně odmítl" nebo „prokazatelně neodešlo" —
   * do rozestupu a stropu se počítá v obou případech.
   * Vyhodí chybu, když záznam mezitím uzavřel někdo jiný (restart, dohledání): incident.
   */
  settleSent(
    operationId: string,
    token: number,
    state: 'done' | 'rejected' | 'unknown',
    now: number,
    detail: { reason?: string; result?: unknown } = {},
  ): Promise<OperationRecord> {
    return this.enqueue(async () => {
      this.assertLoaded();
      const record = this.records.get(operationId);
      if (!record) throw new Error(`Operace ${operationId} neexistuje`);
      if (record.state !== 'sending' || record.sendingToken !== token) {
        throw new Error(`Operaci ${operationId} ve stavu ${record.state} nelze uzavřít tímto dokladem — ověř stav čtením`);
      }
      await this.persist((draft) => {
        const r = draft.get(operationId)!;
        r.state = state;
        r.settledAt = now;
        delete r.sendingToken;
        if (detail.reason !== undefined) r.reason = detail.reason;
        if (detail.result !== undefined) r.result = detail.result;
      });
      return { ...this.records.get(operationId)! };
    });
  }

  /**
   * Výslovné vyřešení neznámého výsledku. Jen z `unknown`, jen s dokladem: čtením od
   * brokera, pozdním výsledkem odesílatele, nebo ručním rozhodnutím obsluhy. NIKDY časovačem.
   */
  resolveUnknown(
    operationId: string,
    state: 'done' | 'rejected',
    now: number,
    detail: { evidence: 'broker-read' | 'late-result' | 'manual'; reason: string; result?: unknown },
  ): Promise<OperationRecord> {
    return this.enqueue(async () => {
      this.assertLoaded();
      if (!['broker-read', 'late-result', 'manual'].includes(detail.evidence) || !detail.reason || detail.reason.trim().length < 5) {
        throw new Error('Neznámý výsledek lze vyřešit jen s druhem dokladu a důvodem (aspoň 5 znaků)');
      }
      const record = this.records.get(operationId);
      if (!record) throw new Error(`Operace ${operationId} neexistuje`);
      if (record.state !== 'unknown') throw new Error(`Operace ${operationId} není ve stavu unknown`);
      await this.persist((draft) => {
        const r = draft.get(operationId)!;
        r.state = state;
        r.settledAt = now;
        r.reason = `${detail.evidence}: ${detail.reason}`;
        if (detail.result !== undefined) r.result = detail.result;
      });
      return { ...this.records.get(operationId)! };
    });
  }

  /**
   * Ořez uzavřených rizikových záznamů. Otevřené, neznámé, brzdy a snížení rizika
   * se neořezávají nikdy; ostatní nejdřív po `retainMs` (nejméně 24 h kvůli stropům)
   * a po konci platnosti.
   */
  prune(now: number, retainMs: number): Promise<number> {
    return this.enqueue(async () => {
      this.assertLoaded();
      const keepFor = Math.max(retainMs, DAY_MS);
      const drop = [...this.records.values()].filter(
        (r) =>
          !EXEMPT.has(r.operationClass) &&
          (r.state === 'done' || r.state === 'rejected') &&
          now - r.acceptedAt > keepFor &&
          now > r.validUntil,
      );
      if (drop.length === 0) return 0;
      await this.persist((draft) => {
        for (const r of drop) draft.delete(r.operationId);
      });
      return drop.length;
    });
  }
}
