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
      seenTerminalRejects: [{ accountId: 201, brokerOrderId: 'stop-1', at: 101 }],
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
      safety: {
        accountEligibility: snapshot.safety.accountEligibility,
        seenTerminalRejects: snapshot.safety.seenTerminalRejects,
      },
    });
  });

  it('seen terminal rejects validuje tvar, unikátnost i bounded velikost', async () => {
    const duplicate = emptySnapshot();
    duplicate.safety = {
      ...duplicate.safety!,
      seenTerminalRejects: [
        { accountId: 201, brokerOrderId: 'same', at: 1 },
        { accountId: 201, brokerOrderId: 'same', at: 2 },
      ],
    };
    const duplicateStore = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot: duplicate },
    }), crypto.randomUUID(), () => 1);
    await expect(duplicateStore.load()).rejects.toThrow('Invalid copier snapshot');

    const oversized = emptySnapshot();
    oversized.safety = {
      ...oversized.safety!,
      seenTerminalRejects: Array.from({ length: 2_049 }, (_, index) => ({
        accountId: 201,
        brokerOrderId: `reject-${index}`,
        at: index,
      })),
    };
    const oversizedStore = createSupabaseCopierStore(fakeClient({
      row: { revision: 4, snapshot: oversized },
    }), crypto.randomUUID(), () => 1);
    await expect(oversizedStore.load()).rejects.toThrow('Invalid copier snapshot');
  });

  it('validuje additivní day-lock, snooze a warning metadata fail-closed', async () => {
    const valid = emptySnapshot();
    valid.safety = {
      ...valid.safety!,
      dayLockTrigger: 'losing-trades',
      dayLockAt: 10,
      dayLockSnoozedRules: ['max-trades'],
      dayUnlock: { at: 9, reason: 'Vědomé odemknutí dne' },
      dailyStats: {
        sessionEndAt: 100,
        realizedPnlUsd: -20,
        losingTrades: 1,
        tradesToday: 2,
        windowState: 'inside',
        warnedRules: [{ rule: 'losing-trades', current: 1, limit: 2, at: 8 }],
        openLots: [],
        unpricedSymbols: [],
      },
    };
    await expect(createSupabaseCopierStore(fakeClient({
      row: { revision: 1, snapshot: valid },
    }), crypto.randomUUID(), () => 1).load()).resolves.toMatchObject({ safety: valid.safety });

    const invalid = structuredClone(valid);
    if (!invalid.safety?.dailyStats) throw new Error('missing-test-stats');
    invalid.safety.dailyStats.warnedRules = [
      { rule: 'max-trades', current: 1, limit: 2, at: 8 },
      { rule: 'max-trades', current: 2, limit: 2, at: 9 },
    ];
    await expect(createSupabaseCopierStore(fakeClient({
      row: { revision: 1, snapshot: invalid },
    }), crypto.randomUUID(), () => 1).load()).rejects.toThrow('Invalid copier snapshot');
  });

  it('přeloží databázový CAS konflikt na doménovou chybu', async () => {
    const store = createSupabaseCopierStore(fakeClient({
      rpcError: { message: 'COPIER_REVISION_CONFLICT expected=2 actual=3' },
    }), crypto.randomUUID(), () => 1);
    await expect(store.commit({ ...emptySnapshot(), revision: 2 }, 2))
      .rejects.toBeInstanceOf(CopierStoreConflictError);
  });
});
