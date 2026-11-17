/**
 * Vstup se serverovým SL/TP (bracket Rithmicu) a záznam o zavírání pozice.
 *
 * Proč zvlášť: adaptér nemá vlastní trvalý stav, ale dvě věci restart přežít musí —
 *  - CO jsme po Rithmicu chtěli (které nohy měl vstup dostat), jinak po restartu nejde
 *    poznat, že ochrana chybí (značka příkazu to neříká a nohy značku nenesou);
 *  - že zavírání pozice už začalo, aby se tatáž operace nikdy neposlala podruhé.
 *
 * Změřeno (Rithmic Test, 16. 11. 2026): nohy vznikají až po vyplnění vstupu, nenesou
 * `user_tag`, vazbu na rodiče (`original_basket_id`) mají až od druhé zprávy a ve snímku;
 * zrušení jedné nohy zruší i sestru. Nezměřeno: částečné vyplnění, zda vyplnění jedné nohy
 * ruší druhou. Proto tu není žádné dostavování — jen stav a hlášení (INV-OUTBOX-03).
 */
import type { BrokerOrder, OrderSide } from '../brokerPort';
import type { RithmicOrderUpdate } from './rithmicClient';

export interface BracketIntent {
  tag: string;
  accountId: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  stopTicks?: number;
  targetTicks?: number;
  /** `basket_id` vstupu — z odpovědi, z notifikace se značkou, nebo ze snímku. */
  entryId?: string;
  createdAt: number;
  /** Bracket skončil (vstup i nohy konečné, žádná vlastní expozice). Dál se nehlídá. */
  closedAt?: number;
  /**
   * Kusy tohoto vstupu zavřené MIMO jeho nohy (částečné zavření jednoho vstupu s víc kusy): o tolik je
   * expozice vstupu menší, než kolik plyne z plnění vstupu a noh. Trvalé — po restartu se z příkazů nepozná.
   */
  exitedOutside?: number;
  /**
   * Právě běží zmenšení ochrany na `to` kusů (změna množství nohy mění na burze obě nohy — změřeno 17. 11. 2026).
   * Dokud trvá, platí za správné množství nohy i `to`. Zapisuje se PŘED zápisem; ukončí ho potvrzený výstup
   * (pak přibude `exitedOutside`), nebo neúspěch (pak je ochrana menší než expozice a hlásí se jako neúplná).
   */
  resizing?: { to: number; at: number };
}

/** Jak dlouho smí noha během zmenšování ochrany mít už nové množství, než se nesoulad začne hlásit. */
const RESIZE_TOLERANCE_MS = 10_000;

export type FlattenPhase = 'started' | 'canceling' | 'exit-sent' | 'done' | 'interrupted';

export interface FlattenRecord {
  tag: string;
  accountId: number;
  symbol: string;
  phase: FlattenPhase;
  /** Výsledek vrácený volajícímu (jen audit). */
  result?: string;
  at: number;
}

export interface ProtectionState {
  brackets: BracketIntent[];
  flattens: FlattenRecord[];
}

/** Trvalé úložiště (soubor workeru). `save` se volá PŘED odesláním zápisu k Rithmicu. */
export interface ProtectionStore {
  load(): Promise<ProtectionState | null>;
  save(state: ProtectionState): Promise<void>;
}

export function memoryProtectionStore(initial: ProtectionState | null = null): ProtectionStore & { saved: () => ProtectionState | null } {
  let current = initial ? (JSON.parse(JSON.stringify(initial)) as ProtectionState) : null;
  return {
    load: async () => (current ? (JSON.parse(JSON.stringify(current)) as ProtectionState) : null),
    save: async (state) => {
      current = JSON.parse(JSON.stringify(state)) as ProtectionState;
    },
    saved: () => current,
  };
}

/**
 * - `entry-working` — vstup čeká, nic vyplněno, nohy ještě nemají vzniknout
 * - `protected` — pozice trvá a každá požadovaná noha pracuje ve správném množství
 * - `unprotected` — pozice trvá a ochrana chybí nebo nesedí
 * - `orphan-legs` — pozice je 0, ale noha dál pracuje (mohla by otevřít nový obchod)
 * - `done` — pozice je 0 a nic z bracketu nepracuje
 * - `unknown` — vstup nebo pozici neznáme
 */
export type BracketState = 'entry-working' | 'protected' | 'unprotected' | 'orphan-legs' | 'done' | 'unknown';

interface LegLink {
  parentId: string;
  /** `unknown` = typ příkazu ještě nebyl znám (zpráva bez `price_type`) — nic se z toho neodvozuje. */
  role: 'stop' | 'target' | 'unknown';
}

const TERMINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected']);
/** Záznamy starší než tohle se při načtení zahodí (bracket je `DAY`, den dávno skončil). */
const MAX_AGE_MS = 36 * 3_600_000;

export class RithmicProtection {
  private brackets: BracketIntent[] = [];
  private flattenRecords: FlattenRecord[] = [];
  /** `účet:noha` → rodič a role. Platí pro vlastní i cizí brackety (kvůli zrušení nohy). */
  private readonly legs = new Map<string, LegLink>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ProtectionStore,
    private readonly now: () => number,
  ) {}

  /** Načte záznamy. Vrací operace zavírání, které minulý běh nedokončil. */
  async load(): Promise<FlattenRecord[]> {
    const state = await this.store.load();
    const fresh = <T extends { at?: number; createdAt?: number }>(row: T): boolean => this.now() - (row.at ?? row.createdAt ?? 0) < MAX_AGE_MS;
    this.brackets = (state?.brackets ?? []).filter(fresh);
    this.flattenRecords = (state?.flattens ?? []).filter(fresh);
    const interrupted = this.flattenRecords.filter((record) => record.phase !== 'done' && record.phase !== 'interrupted');
    for (const record of interrupted) record.phase = 'interrupted';
    if (interrupted.length) await this.save();
    return interrupted;
  }

  /**
   * Zápisy jdou za sebou a každý zapíše stav platný v okamžiku svého běhu — souběžná volání
   * tak nemohou skončit starším stavem na disku.
   */
  save(): Promise<void> {
    const run = (): Promise<void> => this.store.save({ brackets: this.brackets, flattens: this.flattenRecords });
    const next = this.saveChain.then(run, run);
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  // ---- vstupy s ochranou -----------------------------------------------------
  addBracket(intent: BracketIntent): void {
    this.brackets.push(intent);
  }

  /** Zápis prokazatelně neodešel — záměr se smí zahodit. */
  dropBracket(tag: string): void {
    this.brackets = this.brackets.filter((b) => b.tag !== tag);
  }

  bracketByEntry(accountId: number, entryId: string): BracketIntent | undefined {
    return this.brackets.find((b) => b.accountId === accountId && b.entryId === entryId);
  }

  hasTag(accountId: number, tag: string): boolean {
    return this.brackets.some((b) => b.accountId === accountId && b.tag === tag);
  }

  bracketsFor(accountId: number, symbol?: string): BracketIntent[] {
    return this.brackets.filter((b) => b.accountId === accountId && (symbol === undefined || b.symbol === symbol));
  }

  /** Je příkaz noha bracketu (vlastního i cizího)? */
  legOf(accountId: number, orderId: string): LegLink | undefined {
    return this.legs.get(`${accountId}:${orderId}`);
  }

  legsOf(accountId: number, entryId: string): Array<{ orderId: string; role: 'stop' | 'target' | 'unknown' }> {
    const out: Array<{ orderId: string; role: 'stop' | 'target' | 'unknown' }> = [];
    const prefix = `${accountId}:`;
    for (const [key, link] of this.legs) {
      if (key.startsWith(prefix) && link.parentId === entryId) out.push({ orderId: key.slice(prefix.length), role: link.role });
    }
    return out;
  }

  /**
   * Zpráva o příkazu (živá i řádek snímku). Vrací ID vlastního vstupu, kterého se týká —
   * volající pak má znovu zkontrolovat jeho ochranu. `bound` = vstup byl právě spárován
   * se záměrem (je co uložit).
   */
  observe(accountId: number, update: RithmicOrderUpdate): { entryId: string | null; bound: boolean } {
    if (!update.basketId) return { entryId: null, bound: false };
    let bound = false;
    const isBracket = Boolean(update.bracketType) && update.bracketType !== 'BRACKETTYPE_UNSPECIFIED';
    if (update.userTag && isBracket && (!update.originalBasketId || update.originalBasketId === update.basketId)) {
      // Vstup: nese naši značku, je bracket a NEMÁ rodiče. (Nohy značku nenesou — změřeno.)
      const intent = this.brackets.find((b) => b.accountId === accountId && b.tag === update.userTag);
      if (intent && !intent.entryId) {
        intent.entryId = update.basketId;
        bound = true;
      }
    }
    const key = `${accountId}:${update.basketId}`;
    if (update.originalBasketId && update.originalBasketId !== update.basketId) {
      const known = this.legs.get(key);
      const stop = /STOP/i.test(update.priceType);
      if (!known) this.legs.set(key, { parentId: update.originalBasketId, role: update.priceType ? (stop ? 'stop' : 'target') : 'unknown' });
      // Typ příkazu v první zprávě s vazbou chybět může — roli opravíme, jakmile je znát.
      else if (update.priceType) known.role = stop ? 'stop' : 'target';
    }
    // Zpráva nohy bez vazby (např. o zrušení) patří rodiči, kterého už známe.
    const parentId = this.legs.get(key)?.parentId;
    if (parentId) return { entryId: this.bracketByEntry(accountId, parentId) ? parentId : null, bound };
    return { entryId: this.bracketByEntry(accountId, update.basketId) ? update.basketId : null, bound };
  }

  /**
   * Stav ochrany vlastního vstupu. Expozice bracketu se počítá z JEHO příkazů (vyplněný vstup
   * minus vyplněné nohy) — čistá pozice účtu může patřit jinému obchodu.
   *  - `net`: čistá pozice kontraktu (`null` = neznámá).
   *  - `closedByZero`: od posledního vyplnění tohoto vstupu byla na kontraktu DŮVĚRYHODNĚ
   *    vidět nulová pozice (živá zpráva novější než vyplnění, stabilní důkaz stavu, výchozí
   *    stav po připojení). Jen to — nebo vyplněné nohy — smí bracket uzavřít natrvalo;
   *    opakovaná nula z obyčejného čtení ne (snímek může být pozadu za vyplněním).
   * `latch` = bracket skončil; volající má stav uložit. Nic jiného se nemění.
   */
  bracketState(
    accountId: number,
    entryId: string,
    orderOf: (orderId: string) => BrokerOrder | undefined,
    net: number | null,
    closedByZero = false,
  ): { state: BracketState; detail: string; latch?: boolean } {
    const intent = this.bracketByEntry(accountId, entryId);
    const entry = orderOf(entryId);
    if (!intent || !entry) return { state: 'unknown', detail: 'vstup není v knize nebo k němu není záznam' };
    const legs = this.legsOf(accountId, entryId).map((leg) => {
      const order = orderOf(leg.orderId);
      // Role podle knihy, když ji zná (stop má spoušť); jinak podle zprávy s vazbou.
      const role: 'stop' | 'target' | 'unknown' = order?.stopPrice !== undefined ? 'stop' : order?.limitPrice !== undefined ? 'target' : leg.role;
      return { orderId: leg.orderId, role, order };
    });
    const active = legs.filter((leg) => leg.order && !TERMINAL.has(leg.order.status));
    const orphan = (why: string): { state: BracketState; detail: string } => ({ state: 'orphan-legs', detail: `${why}, ale pracuje ${active.map((l) => `${l.role} ${l.orderId}`).join(', ')}` });
    if (entry.filledQuantity === 0) {
      if (!TERMINAL.has(entry.status)) return { state: 'entry-working', detail: '' };
      return active.length ? orphan('vstup skončil bez vyplnění') : { state: 'done', detail: '', latch: intent.closedAt === undefined };
    }
    const exposure = entry.filledQuantity - legs.reduce((sum, leg) => sum + (leg.order?.filledQuantity ?? 0), 0) - (intent.exitedOutside ?? 0);
    // Přeplnění se kontroluje PŘED západkou: nohy vyplněné víc než vstup nejsou nikdy „hotovo".
    if (exposure < 0) {
      return { state: 'unprotected', detail: `nohy vyplnily o ${-exposure} ks víc než vstup — pozice může být obrácená` };
    }
    // Západka platí jen dokud nic z bracketu nepracuje; objeví-li se noha, hodnotí se znovu.
    if (intent.closedAt !== undefined && !active.length) return { state: 'done', detail: '' };
    if (exposure === 0) {
      if (active.length) return orphan('nohy expozici zavřely');
      return { state: 'done', detail: '', latch: TERMINAL.has(entry.status) };
    }
    if (net === null) return { state: 'unknown', detail: 'pozice není známá' };
    if (closedByZero && net === 0) {
      // Expozici zavřelo něco jiného (zavření pozice, ruční příkaz): důvěryhodná nula po vyplnění
      // vstupu A ZÁROVEŇ teď žádná pozice. Jen to smí bracket uzavřít natrvalo.
      if (active.length) return orphan('pozice byla zavřena');
      return { state: 'done', detail: '', latch: TERMINAL.has(entry.status) };
    }
    if (net === 0) {
      // Nula z obyčejného čtení: stav je „hotovo", ale bracket se jí NEzavírá natrvalo.
      return active.length ? orphan('pozice je 0') : { state: 'done', detail: '' };
    }
    const problems: string[] = [];
    for (const role of ['stop', 'target'] as const) {
      if ((role === 'stop' ? intent.stopTicks : intent.targetTicks) === undefined) continue;
      const name = role === 'stop' ? 'SL' : 'TP';
      // Jen noha potvrzená burzou (`working`); `pending` ještě ochrana není.
      const working = legs.filter((leg) => leg.role === role && leg.order?.status === 'working');
      if (working.length !== 1) {
        problems.push(`${name}: pracuje ${working.length} místo 1`);
        continue;
      }
      // Každá role zvlášť proti expozici bracketu (ne součet noh, ne pozice účtu).
      const remaining = working[0].order!.quantity - working[0].order!.filledQuantity;
      // Během zmenšování ochrany smí noha mít už nové množství (druhá ho dostane vzápětí).
      // Tolerance je krátká: nedoběhne-li zmenšení do 10 s, hlásí se skutečný stav (ochrana menší než expozice).
      if (remaining !== exposure && !(intent.resizing && this.now() - intent.resizing.at < RESIZE_TOLERANCE_MS && remaining === intent.resizing.to)) problems.push(`${name}: ${remaining} ks proti expozici ${exposure}`);
    }
    return problems.length ? { state: 'unprotected', detail: problems.join('; ') } : { state: 'protected', detail: '' };
  }

  /** Nohy vlastního vstupu, které ještě nejsou potvrzené burzou ani konečné. */
  hasPendingLegs(accountId: number, entryId: string, orderOf: (orderId: string) => BrokerOrder | undefined): boolean {
    return this.legsOf(accountId, entryId).some((leg) => orderOf(leg.orderId)?.status === 'pending');
  }

  /** Vstup se po uzavření ještě vyplnil (závod zrušení × vyplnění): západka padá, hlídá se znovu. */
  reopenBracket(accountId: number, entryId: string): boolean {
    const intent = this.bracketByEntry(accountId, entryId);
    if (!intent || intent.closedAt === undefined) return false;
    delete intent.closedAt;
    return true;
  }

  /** Začátek zmenšení ochrany vstupu na `to` kusů (zapsat a uložit PŘED zápisem k brokerovi). */
  beginResize(accountId: number, entryId: string, to: number): boolean {
    const intent = this.bracketByEntry(accountId, entryId);
    if (!intent || intent.closedAt !== undefined || intent.resizing) return false;
    intent.resizing = { to, at: this.now() };
    return true;
  }

  /** Konec zmenšení: `exitedQuantity` > 0 = tolik kusů prokazatelně odešlo mimo nohy; 0 = výstup neproběhl. */
  endResize(accountId: number, entryId: string, exitedQuantity: number): void {
    const intent = this.bracketByEntry(accountId, entryId);
    if (!intent) return;
    // Výstup se připíše jen k OTEVŘENÉMU záměru — opakované volání (hlídač po restartu) nesmí přičíst podruhé.
    const open = intent.resizing !== undefined;
    delete intent.resizing;
    if (open && exitedQuantity > 0) intent.exitedOutside = (intent.exitedOutside ?? 0) + exitedQuantity;
  }

  closeBracket(accountId: number, entryId: string): void {
    const intent = this.bracketByEntry(accountId, entryId);
    if (intent && intent.closedAt === undefined) intent.closedAt = this.now();
  }

  // ---- zavírání pozice --------------------------------------------------------
  flattenByTag(tag: string): FlattenRecord | undefined {
    return this.flattenRecords.find((record) => record.tag === tag);
  }

  /** Dřívější zavření na kontraktu, které odešlo a jehož výsledek nikdo neprokázal. */
  hasUnresolvedExit(accountId: number, symbol: string, exceptTag = ''): boolean {
    return this.flattenRecords.some((r) => r.accountId === accountId && r.symbol === symbol && r.tag !== exceptTag
      && (r.phase === 'exit-sent' || r.phase === 'interrupted'));
  }

  /** Stav kontraktu je prokázaný čtením — dřívější nejistá zavření jsou tím vyřešená. */
  resolveExits(accountId: number, symbol: string): void {
    for (const r of this.flattenRecords) {
      if (r.accountId === accountId && r.symbol === symbol && (r.phase === 'exit-sent' || r.phase === 'interrupted')) {
        r.phase = 'done';
        r.result = r.result ?? 'resolved-by-state';
      }
    }
  }

  /** Úplná obnova stavu (výchozí snímek příkazů i pozic) vyřeší všechna dřívější zavření účtu. */
  resolveAllExits(accountId: number): boolean {
    let changed = false;
    for (const r of this.flattenRecords) {
      if (r.accountId === accountId && (r.phase === 'exit-sent' || r.phase === 'interrupted')) {
        r.phase = 'done';
        r.result = r.result ?? 'resolved-by-state';
        changed = true;
      }
    }
    return changed;
  }

  /** Operace, která nic neodeslala, po sobě nenechá záznam (značku smí volající použít znovu). */
  dropFlatten(tag: string): void {
    this.flattenRecords = this.flattenRecords.filter((record) => record.tag !== tag);
  }

  addFlatten(record: FlattenRecord): void {
    this.flattenRecords.push(record);
  }
}
