import { orderedBatchReads } from '../lib/orderedBatchReads';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { isEvidenceJournalTrade, visibleJournalTrades } from '../lib/journalTradeFacts';

/** Broker execution history belongs to the owner-only history table. Review
 * sharing and ordinary trade saves must not copy it into a public JSON blob. */
export function stripPrivateJournalHistory<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripPrivateJournalHistory) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'executionHistory' && key !== 'copierSnapshotLoadError')
    .map(([key, item]) => [key, stripPrivateJournalHistory(item)])) as T;
}

type ExecutionHistory = NonNullable<Trade['executionHistory']>;

function validHistory(value: unknown): value is ExecutionHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const history = value as Record<string, unknown>;
  return Array.isArray(history.fills) && Array.isArray(history.protection) && Array.isArray(history.gaps);
}

/**
 * Obchody z Tradovate importu jsou od 23. 11. 2026 zmrazené: čísla i vazby
 * screenshotů leží přímo v `trades`, soukromá historie fillů v
 * `trade_execution_history` (migrace 20261123100000). Seznam proto nic
 * nedotahuje; detail vlastníka připojí historii fillů pro graf obchodu.
 * Chybějící historie u detailu je chyba čtení, ne prázdný graf.
 */
export async function hydrateOwnedJournalTrades(
  client: SupabaseClient, trades: readonly Trade[], ownerId: string | null, targetOwnerId: string | null,
  stillOwner: () => boolean | Promise<boolean>, options: { signal?: AbortSignal; detail?: boolean } = {},
): Promise<Trade[]> {
  const clean = visibleJournalTrades(trades.map(stripPrivateJournalHistory));
  // Cizím (sdílení, propojení) se obchody z importu dál neukazují — stejně
  // jako před zmrazením. Zviditelnit je je samostatné rozhodnutí.
  if (!ownerId || ownerId !== targetOwnerId) return clean.filter(trade => !isEvidenceJournalTrade(trade));
  if (!options.detail) return clean;
  const journal = clean.filter(isEvidenceJournalTrade);
  if (!journal.length) return clean;
  const active = async () => {
    if (options.signal?.aborted) throw new Error('journal-read-aborted');
    if (!await stillOwner()) throw new Error('journal-session-changed');
  };
  const signal = () => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const ids = [...new Set(journal.map(trade => String(trade.id)))];
  const histories = new Map<string, ExecutionHistory>();
  const pages = await orderedBatchReads(Math.ceil(ids.length / 100), async page => {
    await active();
    const selected = ids.slice(page * 100, page * 100 + 100);
    const { data, error } = await client.from('trade_execution_history')
      .select('trade_id,history').eq('user_id', ownerId).in('trade_id', selected)
      .returns<Array<{ trade_id: string; history: unknown }>>()
      .abortSignal(signal());
    await active();
    return { selected, data, error };
  });
  for (const { selected, data, error } of pages) {
    if (error || !Array.isArray(data)) throw new Error('journal-history-unavailable');
    for (const row of data) {
      if (!selected.includes(row.trade_id) || histories.has(row.trade_id) || !validHistory(row.history)) throw new Error('journal-history-incomplete');
      histories.set(row.trade_id, row.history);
    }
  }
  if (histories.size !== ids.length) throw new Error('journal-history-incomplete');
  await active();
  return clean.map(trade => {
    const history = histories.get(String(trade.id));
    return history ? { ...trade, executionHistory: history } : trade;
  });
}
