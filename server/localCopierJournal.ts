import { createFileJournalEvidenceStore } from './fileJournalEvidenceStore.js';
import type { TradovateBrokerPort } from '../services/tradovateBroker.js';
import { startJournalEvidenceUpload } from './journalEvidenceUpload.js';

/** Local recording is always available; only the explicitly approved relay may upload. */
export async function startLocalCopierJournal(options: {
  path: string; connectionId: string; environment: 'demo' | 'live'; broker: TradovateBrokerPort;
  relay?: { apiOrigin: string; authorizationHeader: () => Promise<string> };
}) {
  const store = await createFileJournalEvidenceStore({ ...options,
    onError: error => console.warn(`[JOURNAL] ${options.connectionId.slice(0, 8)} ${error.message}`),
  });
  const accounts = new Set<number>();
  let uploader: ReturnType<typeof startJournalEvidenceUpload> | null = null;
  if (options.relay && options.environment === 'demo') {
    try {
      uploader = startJournalEvidenceUpload({ ...options.relay, flush: store.flush,
        onError: error => console.warn(`[JOURNAL] upload unavailable: ${error.message}`) });
    } catch {
      console.warn('[JOURNAL] remote origin is not approved; recording locally');
    }
  }
  const orderAccounts = new Map<string, number | null>();
  const unsubscribe = options.broker.subscribeEvidence(event => {
    if (typeof event.entity.accountId === 'number') accounts.add(event.entity.accountId);
    if (event.entityType === 'order' && event.entity.id != null && typeof event.entity.accountId === 'number') {
      const id = String(event.entity.id);
      const previous = orderAccounts.get(id);
      orderAccounts.set(id, previous !== undefined && previous !== event.entity.accountId ? null : event.entity.accountId);
    }
    return store.record(event);
  });
  return {
    connectionId: options.connectionId,
    ownsAccount: (accountId: number) => accounts.has(accountId),
    accountForOrder: (orderId: string) => orderAccounts.get(orderId) ?? null,
    record: store.record,
    health: store.health,
    async close() { unsubscribe(); await uploader?.close(); await store.close(); },
  };
}
