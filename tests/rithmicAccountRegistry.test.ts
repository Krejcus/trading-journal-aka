import { describe, expect, it } from 'vitest';
import {
  RITHMIC_ACCOUNT_ID_BASE,
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';

function memoryStore(initial: RithmicAccountRegistryEntry[] = []) {
  const state = { saved: initial.map((e) => ({ ...e })), saves: 0, failNext: false, revision: initial.length ? 1 : 0 };
  const store: RithmicAccountRegistryStore = {
    load: async () => ({ entries: state.saved.map((e) => ({ ...e })), revision: state.revision }),
    save: async (entries, expectedRevision) => {
      if (state.failNext) {
        state.failNext = false;
        throw new Error('disk full');
      }
      if (expectedRevision !== state.revision) throw new Error('revision conflict');
      state.saves += 1;
      state.revision += 1;
      state.saved = entries.map((e) => ({ ...e }));
    },
  };
  return { store, state };
}

const acc = (accountId: string, system = 'Rithmic Test') => ({ system, fcmId: 'FCM', ibId: 'IB', accountId });

describe('RithmicAccountRegistry', () => {
  it('přiděluje sekvenčně, ukládá před použitím a po restartu vrací stejná čísla', async () => {
    const { store, state } = memoryStore();
    const first = new RithmicAccountRegistry(store);
    await first.load();
    const a = await first.ensure(acc('1875'));
    const b = await first.ensure(acc('42'));
    expect([a, b]).toEqual([RITHMIC_ACCOUNT_ID_BASE + 1, RITHMIC_ACCOUNT_ID_BASE + 2]);
    expect(await first.ensure(acc('1875'))).toBe(a);
    expect(state.saves).toBe(2);

    const second = new RithmicAccountRegistry(store);
    await second.load();
    expect(second.lookup(acc('42'))).toBe(b);
    expect(second.resolve(a)).toEqual(acc('1875'));
    expect(await second.ensure(acc('7'))).toBe(RITHMIC_ACCOUNT_ID_BASE + 3);
  });

  it('číslo se neodvozuje z textu účtu a stejný účet v jiném systému je jiný účet', async () => {
    const { store } = memoryStore();
    const registry = new RithmicAccountRegistry(store);
    await registry.load();
    const test = await registry.ensure(acc('123456'));
    const live = await registry.ensure(acc('123456', 'Rithmic 01'));
    expect(test).not.toBe(123456);
    expect(live).not.toBe(test);
  });

  it('selhání uložení číslo nepřidělí a tabulku nezmění', async () => {
    const { store, state } = memoryStore();
    const registry = new RithmicAccountRegistry(store);
    await registry.load();
    state.failNext = true;
    await expect(registry.ensure(acc('1'))).rejects.toThrow('disk full');
    // po selhání se tabulka musí načíst znovu, než se z ní čte nebo přiděluje
    expect(() => registry.lookup(acc('1'))).toThrow(/není načtená/);
    await registry.load();
    expect(registry.lookup(acc('1'))).toBeNull();
    expect(await registry.ensure(acc('1'))).toBe(RITHMIC_ACCOUNT_ID_BASE + 1);
  });

  it('souběžné přidělení téhož účtu dá jedno číslo', async () => {
    const { store, state } = memoryStore();
    const registry = new RithmicAccountRegistry(store);
    await registry.load();
    const ids = await Promise.all([registry.ensure(acc('9')), registry.ensure(acc('9')), registry.ensure(acc('8'))]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(state.saves).toBe(2);
  });

  it('dva procesy nad jednou tabulkou nepřidělí stejné číslo různým účtům', async () => {
    const { store } = memoryStore();
    const a = new RithmicAccountRegistry(store);
    const b = new RithmicAccountRegistry(store);
    await a.load();
    await b.load();
    const first = await a.ensure(acc('A'));
    await expect(b.ensure(acc('B'))).rejects.toThrow('revision conflict');
    await b.load();
    expect(b.lookup(acc('A'))).toBe(first);
    expect(await b.ensure(acc('B'))).toBe(first + 1);
  });

  it('poškozenou tabulku odmítne načíst', async () => {
    const dupId = memoryStore([{ ...acc('1'), id: RITHMIC_ACCOUNT_ID_BASE + 1 }, { ...acc('2'), id: RITHMIC_ACCOUNT_ID_BASE + 1 }]);
    await expect(new RithmicAccountRegistry(dupId.store).load()).rejects.toThrow(/poškozená/);
    const dupKey = memoryStore([{ ...acc('1'), id: RITHMIC_ACCOUNT_ID_BASE + 1 }, { ...acc('1'), id: RITHMIC_ACCOUNT_ID_BASE + 2 }]);
    await expect(new RithmicAccountRegistry(dupKey.store).load()).rejects.toThrow(/poškozená/);
    const badId = memoryStore([{ ...acc('1'), id: 62364058 }]);
    await expect(new RithmicAccountRegistry(badId.store).load()).rejects.toThrow(/poškozená/);
  });

  it('před načtením a s neplatnou identitou nic nevrací', async () => {
    const { store } = memoryStore();
    const registry = new RithmicAccountRegistry(store);
    expect(() => registry.lookup(acc('1'))).toThrow(/není načtená/);
    await expect(registry.ensure(acc('1'))).rejects.toThrow(/není načtená/);
    await registry.load();
    await expect(registry.ensure(acc(''))).rejects.toThrow(/neplatné pole/);
    await expect(registry.ensure(acc('a|b'))).rejects.toThrow(/zakázaný znak/);
    expect(registry.resolve(5)).toBeNull();
  });
});
