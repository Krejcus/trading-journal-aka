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
}

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
  role: 'stop' | 'target';
}

const TERMINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected']);
/** Záznamy starší než tohle se při načtení zahodí (bracket je `DAY`, den dávno skončil). */
const MAX_AGE_MS = 36 * 3_600_000;

export class RithmicProtection {
  private brackets: BracketIntent[] = [];
  private flattenRecords: FlattenRecord[] = [];
  /** `účet:noha` → rodič a role. Platí pro vlastní i cizí brackety (kvůli zrušení nohy). */
  private readonly legs = new Map<string, LegLink>();

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

  save(): Promise<void> {
    return this.store.save({ brackets: this.brackets, flattens: this.flattenRecords });
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

  bracketsFor(accountId: number, symbol?: string): BracketIntent[] {
    return this.brackets.filter((b) => b.accountId === accountId && (symbol === undefined || b.symbol === symbol));
  }

  /** Je příkaz noha bracketu (vlastního i cizího)? */
  legOf(accountId: number, orderId: string): LegLink | undefined {
    return this.legs.get(`${accountId}:${orderId}`);
  }

  legsOf(accountId: number, entryId: string): Array<{ orderId: string; role: 'stop' | 'target' }> {
    const out: Array<{ orderId: string; role: 'stop' | 'target' }> = [];
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
    if (update.userTag) {
      // Vstup: nese naši značku a NEMÁ rodiče. (Nohy značku nenesou — změřeno.)
      const intent = this.brackets.find((b) => b.accountId === accountId && b.tag === update.userTag);
      if (intent && !update.originalBasketId && !intent.entryId) {
        intent.entryId = update.basketId;
        bound = true;
      }
    }
    if (update.originalBasketId && update.originalBasketId !== update.basketId) {
      const key = `${accountId}:${update.basketId}`;
      if (!this.legs.has(key)) {
        this.legs.set(key, { parentId: update.originalBasketId, role: /STOP/i.test(update.priceType) ? 'stop' : 'target' });
      }
      return { entryId: this.bracketByEntry(accountId, update.originalBasketId) ? update.originalBasketId : null, bound };
    }
    return { entryId: this.bracketByEntry(accountId, update.basketId) ? update.basketId : null, bound };
  }

  /**
   * Stav ochrany vlastního vstupu. `orderOf` čte knihu adaptéru, `net` je čistá pozice
   * kontraktu na účtu (`null` = neznámá). Nic nemění.
   */
  bracketState(
    accountId: number,
    entryId: string,
    orderOf: (orderId: string) => BrokerOrder | undefined,
    net: number | null,
  ): { state: BracketState; detail: string } {
    const intent = this.bracketByEntry(accountId, entryId);
    const entry = orderOf(entryId);
    if (!intent || !entry) return { state: 'unknown', detail: 'vstup není v knize nebo k němu není záznam' };
    const legs = this.legsOf(accountId, entryId).map((leg) => ({ ...leg, order: orderOf(leg.orderId) }));
    const active = legs.filter((leg) => leg.order && !TERMINAL.has(leg.order.status));
    if (entry.filledQuantity === 0) {
      if (!TERMINAL.has(entry.status)) return { state: 'entry-working', detail: '' };
      return active.length ? { state: 'orphan-legs', detail: `vstup skončil bez vyplnění, ale pracuje ${active.map((l) => l.orderId).join(', ')}` } : { state: 'done', detail: '' };
    }
    if (net === null) return { state: 'unknown', detail: 'pozice není známá' };
    if (net === 0) {
      return active.length
        ? { state: 'orphan-legs', detail: `pozice je 0, ale pracuje ${active.map((l) => `${l.role} ${l.orderId}`).join(', ')}` }
        : { state: 'done', detail: '' };
    }
    const problems: string[] = [];
    for (const role of ['stop', 'target'] as const) {
      if ((role === 'stop' ? intent.stopTicks : intent.targetTicks) === undefined) continue;
      // Jen noha potvrzená burzou (`working`); `pending` ještě ochrana není.
      const working = legs.filter((leg) => leg.role === role && leg.order?.status === 'working');
      if (working.length !== 1) {
        problems.push(`${role === 'stop' ? 'SL' : 'TP'}: pracuje ${working.length} místo 1`);
        continue;
      }
      // Každá role se kontroluje zvlášť proti vyplněnému množství vstupu (ne součet noh).
      const remaining = working[0].order!.quantity - working[0].order!.filledQuantity;
      // Po dílčím vyplnění nohy sedí zbytek s pozicí, ne s původním vstupem.
      if (remaining !== entry.filledQuantity && remaining !== Math.abs(net)) {
        problems.push(`${role === 'stop' ? 'SL' : 'TP'}: ${remaining} ks proti ${entry.filledQuantity} vyplněným (pozice ${net})`);
      }
    }
    return problems.length ? { state: 'unprotected', detail: problems.join('; ') } : { state: 'protected', detail: '' };
  }

  // ---- zavírání pozice --------------------------------------------------------
  flattenByTag(tag: string): FlattenRecord | undefined {
    return this.flattenRecords.find((record) => record.tag === tag);
  }

  addFlatten(record: FlattenRecord): void {
    this.flattenRecords.push(record);
  }
}
