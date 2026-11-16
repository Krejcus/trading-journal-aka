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
  /** `revision` se zvýší každým uložením (prázdná tabulka má 0). */
  load(): Promise<{ entries: RithmicAccountRegistryEntry[]; revision: number }>;
  /**
   * Atomické a trvalé uložení JEN když je uložená revize rovna `expectedRevision`
   * (jinak musí vyhodit chybu). Brání tomu, aby dva procesy přidělily stejné číslo
   * různým účtům a poslední zápis vyhrál.
   */
  save(entries: RithmicAccountRegistryEntry[], expectedRevision: number): Promise<void>;
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
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: RithmicAccountRegistryStore) {
    this.store = store;
  }

  /** Načte tabulku; poškozená tabulka (duplicitní číslo/klíč, číslo mimo rozsah) = chyba, ne oprava. */
  async load(): Promise<void> {
    const { entries, revision } = await this.store.load();
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Tabulka Rithmic účtů je poškozená: neplatná revize');
    const byKey = new Map<string, RithmicAccountRegistryEntry>();
    const byId = new Map<number, RithmicAccountRegistryEntry>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!Number.isSafeInteger(entry.id) || entry.id <= RITHMIC_ACCOUNT_ID_BASE) {
        // Čísla začínají na RITHMIC_ACCOUNT_ID_BASE + 1.
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
    this.revision = revision;
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
   * Selže-li uložení, číslo se nepoužije a tabulka se musí znovu načíst (`load`),
   * než se z ní dá číst — mezitím mohl zapsat jiný proces.
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
      try {
        await this.store.save([...this.byId.values(), entry].sort((a, b) => a.id - b.id), this.revision);
      } catch (error) {
        // Někdo jiný mohl mezitím zapsat: tabulku v paměti už nelze brát za platnou.
        this.loaded = false;
        throw error;
      }
      this.revision += 1;
      this.byKey.set(key, entry);
      this.byId.set(id, entry);
      return id;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
