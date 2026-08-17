import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CopierStoreConflictError, emptySnapshot } from '../services/copierStore';
import { createSupabaseCopierStore } from '../services/supabaseCopierStore';

function fakeClient(options: {
  row?: { revision: number; snapshot: unknown } | null;
  rpcData?: number | null;
  rpcError?: { message: string } | null;
}) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: options.row ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
    async rpc() {
      return { data: options.rpcData ?? null, error: options.rpcError ?? null };
    },
  } as unknown as SupabaseClient;
}

describe('createSupabaseCopierStore', () => {
  it('odmítne runtime id, které PostgreSQL UUID parametr nemůže přijmout', () => {
    expect(() => createSupabaseCopierStore(fakeClient({}), 'not-a-uuid')).toThrow('UUID');
  });

  it('prázdný runtime načte jako bezpečný revision 0 snapshot', async () => {
    const store = createSupabaseCopierStore(fakeClient({ row: null }), crypto.randomUUID());
    expect(await store.load()).toEqual(emptySnapshot());
  });

  it('commit vrátí novou CAS revision', async () => {
    const store = createSupabaseCopierStore(fakeClient({ rpcData: 1 }), crypto.randomUUID());
    expect((await store.commit(emptySnapshot(), 0)).revision).toBe(1);
  });

  it('poškozený snapshot failne zavřeně místo návratu prázdného stavu', async () => {
    const store = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot: { lastSequence: 10 } },
    }), crypto.randomUUID());
    await expect(store.load()).rejects.toThrow('Invalid copier snapshot');
  });

  it('failne zavřeně i při hluboce poškozeném outboxu nebo duplicitních klíčích', async () => {
    const malformed = {
      ...emptySnapshot(),
      outbox: [{ key: 'a', status: 'acknowledged' }],
      replicated: ['duplicate', 'duplicate'],
    };
    const store = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot: malformed },
    }), crypto.randomUUID());
    await expect(store.load()).rejects.toThrow('Invalid copier snapshot');
  });

  it('přeloží databázový CAS konflikt na doménovou chybu', async () => {
    const store = createSupabaseCopierStore(fakeClient({
      rpcError: { message: 'COPIER_REVISION_CONFLICT expected=2 actual=3' },
    }), crypto.randomUUID());
    await expect(store.commit({ ...emptySnapshot(), revision: 2 }, 2))
      .rejects.toBeInstanceOf(CopierStoreConflictError);
  });
});
