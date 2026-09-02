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
    expect(() => createSupabaseCopierStore(fakeClient({}), 'not-a-uuid', () => 1)).toThrow('UUID');
  });

  it('prázdný runtime načte jako bezpečný revision 0 snapshot', async () => {
    const store = createSupabaseCopierStore(fakeClient({ row: null }), crypto.randomUUID(), () => 1);
    expect(await store.load()).toEqual(emptySnapshot());
  });

  it('commit vrátí novou CAS revision', async () => {
    const store = createSupabaseCopierStore(fakeClient({ rpcData: 1 }), crypto.randomUUID(), () => 1);
    expect((await store.commit(emptySnapshot(), 0)).revision).toBe(1);
  });

  it('poškozený snapshot failne zavřeně místo návratu prázdného stavu', async () => {
    const store = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot: { lastSequence: 10 } },
    }), crypto.randomUUID(), () => 1);
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
    }), crypto.randomUUID(), () => 1);
    await expect(store.load()).rejects.toThrow('Invalid copier snapshot');
  });

  it('načte nové reject metadata a resolution, ale zachová kompatibilitu volitelných polí', async () => {
    const snapshot = emptySnapshot();
    snapshot.safety = {
      entryCooldownUntil: 0,
      dayLockUntil: 0,
      accountEligibility: [{
        accountId: 201,
        state: 'active',
        at: 100,
        lastExecution: {
          kind: 'rejected',
          reason: 'price outside the price limits',
          symbol: 'MNQU6',
          brokerOrderId: 'stop-1',
          orderType: 'Stop',
          side: 'Buy',
          stopPrice: 29_189.75,
          at: 101,
          resolution: {
            kind: 'guard-flattened',
            at: 106,
            detail: 'guard potvrdil flat',
          },
        },
      }],
    };
    const store = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot },
    }), crypto.randomUUID(), () => 1);
    await expect(store.load()).resolves.toMatchObject({
      safety: { accountEligibility: snapshot.safety.accountEligibility },
    });
  });

  it('přeloží databázový CAS konflikt na doménovou chybu', async () => {
    const store = createSupabaseCopierStore(fakeClient({
      rpcError: { message: 'COPIER_REVISION_CONFLICT expected=2 actual=3' },
    }), crypto.randomUUID(), () => 1);
    await expect(store.commit({ ...emptySnapshot(), revision: 2 }, 2))
      .rejects.toBeInstanceOf(CopierStoreConflictError);
  });
});
