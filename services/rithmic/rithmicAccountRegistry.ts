/**
 * Trvalá tabulka identit Rithmic účtů.
 *
 * Jádro kopírky pracuje s `accountId: number`; Rithmic účet je čtveřice textů
 * (systém, FCM, IB, účet). Číslo se přiděluje jednou, sekvenčně, a uloží se
 * DŘÍV, než ho kdokoli použije. Nikdy se nepřečísluje, nehashuje ani
 * neodvozuje z textu účtu — stejné číslo po restartu musí znamenat stejný účet,
 * jinak by durable stav (outboxy, vazby) ukázal na jiný účet.
 */
export interface RithmicAccountIdentity {
  system: string;
  fcmId: string;
  ibId: string;
  accountId: string;
}

export interface RithmicAccountRegistryEntry extends RithmicAccountIdentity {
  id: number;
}

export interface RithmicAccountRegistryStore {
  load(): Promise<RithmicAccountRegistryEntry[]>;
  /** Musí být atomické a trvalé; chyba = přidělení se nepoužije. */
  save(entries: RithmicAccountRegistryEntry[]): Promise<void>;
}

/** Rozsah mimo čísla Tradovate účtů (ta jsou v desítkách milionů). */
export const RITHMIC_ACCOUNT_ID_BASE = 9_000_000_000_000;

const FIELDS = ['system', 'fcmId', 'ibId', 'accountId'] as const;

function keyOf(identity: RithmicAccountIdentity): string {
  for (const field of FIELDS) {
    const value = identity[field];
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
      throw new Error(`Rithmic účet má neplatné pole ${field}`);
    }
    if (value.includes('|')) throw new Error(`Rithmic účet má v poli ${field} zakázaný znak`);
  }
  return FIELDS.map((field) => identity[field]).join('|');
}

export class RithmicAccountRegistry {
  private readonly store: RithmicAccountRegistryStore;
  private byKey = new Map<string, RithmicAccountRegistryEntry>();
  private byId = new Map<number, RithmicAccountRegistryEntry>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: RithmicAccountRegistryStore) {
    this.store = store;
  }

  /** Načte tabulku; poškozená tabulka (duplicitní číslo/klíč, číslo mimo rozsah) = chyba, ne oprava. */
  async load(): Promise<void> {
    const entries = await this.store.load();
    const byKey = new Map<string, RithmicAccountRegistryEntry>();
    const byId = new Map<number, RithmicAccountRegistryEntry>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!Number.isSafeInteger(entry.id) || entry.id <= RITHMIC_ACCOUNT_ID_BASE) {
        throw new Error(`Tabulka Rithmic účtů je poškozená: neplatné číslo ${String(entry.id)}`);
      }
      if (byKey.has(key) || byId.has(entry.id)) {
        throw new Error('Tabulka Rithmic účtů je poškozená: duplicitní záznam');
      }
      const clean = { system: entry.system, fcmId: entry.fcmId, ibId: entry.ibId, accountId: entry.accountId, id: entry.id };
      byKey.set(key, clean);
      byId.set(clean.id, clean);
    }
    this.byKey = byKey;
    this.byId = byId;
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('Tabulka Rithmic účtů není načtená');
  }

  /** Číslo existujícího účtu, nebo null. Nic nepřiděluje. */
  lookup(identity: RithmicAccountIdentity): number | null {
    this.assertLoaded();
    return this.byKey.get(keyOf(identity))?.id ?? null;
  }

  /** Identita podle čísla, nebo null pro neznámé číslo. */
  resolve(id: number): RithmicAccountIdentity | null {
    this.assertLoaded();
    const entry = this.byId.get(id);
    return entry ? { system: entry.system, fcmId: entry.fcmId, ibId: entry.ibId, accountId: entry.accountId } : null;
  }

  /**
   * Vrátí číslo účtu; neznámému přidělí další v řadě a NEJDŘÍV ho uloží.
   * Selže-li uložení, číslo se nepoužije a tabulka v paměti zůstane beze změny.
   */
  ensure(identity: RithmicAccountIdentity): Promise<number> {
    const run = this.queue.then(async () => {
      this.assertLoaded();
      const key = keyOf(identity);
      const existing = this.byKey.get(key);
      if (existing) return existing.id;
      let max = RITHMIC_ACCOUNT_ID_BASE;
      for (const id of this.byId.keys()) if (id > max) max = id;
      const id = max + 1;
      if (!Number.isSafeInteger(id)) throw new Error('Tabulka Rithmic účtů je plná');
      const entry: RithmicAccountRegistryEntry = {
        system: identity.system, fcmId: identity.fcmId, ibId: identity.ibId, accountId: identity.accountId, id,
      };
      await this.store.save([...this.byId.values(), entry].sort((a, b) => a.id - b.id));
      this.byKey.set(key, entry);
      this.byId.set(id, entry);
      return id;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
