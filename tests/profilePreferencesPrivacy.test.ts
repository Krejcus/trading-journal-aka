import { beforeEach, describe, expect, it, vi } from 'vitest';

// Preference jsou soukromý sloupec: appka je čte jen přes get_profile_preferences_v1.
// Chyba čtení nesmí nikdy vést k zápisu prázdných preferencí (smazalo by to vše).
const state = vi.hoisted(() => ({ rpcError: null as null | { code: string }, prefs: { theme: 'dark', ironRules: [1] } as unknown, updates: [] as unknown[] }));
vi.mock('../services/supabase', () => {
  const session = { user: { id: '6fd09385-2400-4643-b6dc-9ab3b4a827cd' } };
  const builder = () => {
    const chain: Record<string, unknown> = {};
    chain.update = (value: unknown) => { state.updates.push(value); return chain; };
    chain.eq = () => chain;
    chain.select = () => chain;
    chain.single = async () => ({ data: { id: session.user.id }, error: null });
    return chain;
  };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      rpc: async (name: string) => name === 'get_profile_preferences_v1'
        ? { data: state.rpcError ? null : state.prefs, error: state.rpcError }
        : { data: null, error: null },
      from: () => builder(),
    },
  };
});

describe('soukromé preference', () => {
  beforeEach(() => { state.rpcError = null; state.updates = []; });

  it('chyba čtení není „prázdné preference“ — vyhodí výjimku', async () => {
    const { storageService } = await import('../services/storageService');
    state.rpcError = { code: 'PGRST202' };
    await expect(storageService.getPreferences()).rejects.toThrow('preferences-read-failed');
  });

  it('uložení null / pole se odmítne dřív, než cokoli zapíše', async () => {
    const { storageService } = await import('../services/storageService');
    await expect(storageService.savePreferences(null as never)).rejects.toThrow('preferences-save-invalid');
    await expect(storageService.savePreferences([] as never)).rejects.toThrow('preferences-save-invalid');
    expect(state.updates).toEqual([]);
  });

  it('notifikace sítě při chybě čtení nic nezapíšou', async () => {
    const { storageService } = await import('../services/storageService');
    state.rpcError = { code: 'PGRST202' };
    await expect(storageService.updateNetworkNotifications({})).rejects.toThrow('preferences-read-failed');
    expect(state.updates).toEqual([]);
  });

  it('notifikace sítě zachovají ostatní preference', async () => {
    const { storageService } = await import('../services/storageService');
    await storageService.updateNetworkNotifications({ a: { newTrade: true, newPrep: false, newReview: false } });
    expect(state.updates).toEqual([{ preferences: { theme: 'dark', ironRules: [1], networkNotifications: { a: { newTrade: true, newPrep: false, newReview: false } } } }]);
  });
});
