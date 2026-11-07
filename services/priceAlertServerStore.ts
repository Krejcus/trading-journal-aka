import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, readPriceAlertState, sanitizePriceAlert, sanitizePriceAlertDefaults,
  type PriceAlert, type PriceAlertDefaults, type PriceAlertEvent, type PriceAlertState, type PriceAlertStore,
} from '../lib/priceAlerts';

/**
 * Serverový store upozornění na cenu (2. 11. 2026, docs/reviews/price-alerts-contract-20261102.md):
 * stejné rozhraní jako `createLocalPriceAlertStore`, data v `price_alerts` / `price_alert_defaults`
 * (RLS vlastník) a spuštění z `price_alert_events` přes Realtime. Úpravy jsou optimistické
 * a čekají ve frontě v zařízení (offline), novější úprava vyhrává (`edited_at`, trigger v DB),
 * mazání je měkké. Stav spouštění mění jen server; úprava spuštěného upozornění ho znovu
 * zapne jen přes `rearm_price_alert` s očekávaným počtem spuštění. Nic odsud nečte kopírka.
 */
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

type PendingOp =
  | { kind: 'upsert'; alert: PriceAlert; rearm?: number }
  | { kind: 'delete'; alert: PriceAlert };

interface Cache { alerts: PriceAlert[]; defaults: PriceAlertDefaults; events: PriceAlertEvent[] }

const EVENTS_MAX = 20;
/** Chyby, které opakování nespraví (strop 50, neplatná data): operace se zahodí a nahlásí. */
const PERMANENT_DB_ERRORS = new Set(['23514', '22P02', '23502', '22003', '22023']);
const permanentError = (error: { code?: string; message?: string } | null | undefined) => (
  !!error && (PERMANENT_DB_ERRORS.has(error.code ?? '') || /price-alerts-limit/.test(error.message ?? ''))
);
const permanentErrorText = (error: { message?: string }) => (/price-alerts-limit/.test(error.message ?? '')
  ? 'Upozornění se neuložilo: víc než 50 najednou — nejdřív některé smaž.'
  : 'Upozornění se neuložilo: server ho odmítl (neplatná data).');
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const TRIGGER_FIELDS: (keyof PriceAlert)[] = ['price', 'condition', 'frequency', 'expiry', 'symbol'];

const cacheKey = (userId: string) => `alphatrade:price-alerts:cache:v1:${userId}`;
const queueKey = (userId: string) => `alphatrade:price-alerts:queue:v1:${userId}`;
const importedKey = (userId: string) => `alphatrade:price-alerts:imported:v1:${userId}`;
const ms = (value: unknown) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

export function priceAlertFromRow(row: Record<string, unknown>): PriceAlert | null {
  return sanitizePriceAlert({
    id: row.id, symbol: row.symbol, price: Number(row.price), condition: row.condition, conditionAuto: row.condition_auto,
    frequency: row.frequency, expiry: row.expiry, line: row.line, channels: row.channels, note: row.note,
    createdAt: ms(row.created_at), updatedAt: ms(row.edited_at), status: row.status,
    version: Number(row.version), lastTriggeredAt: row.last_triggered_at ? ms(row.last_triggered_at) : null,
    triggerCount: Number(row.trigger_count),
  });
}

export function priceAlertEventFromRow(row: Record<string, unknown>): PriceAlertEvent | null {
  const condition = row.condition === 'up' || row.condition === 'down' ? row.condition : 'cross';
  const level = Number(row.level);
  if (typeof row.id !== 'string' || typeof row.alert_id !== 'string' || !Number.isFinite(level)) return null;
  return { id: row.id, alertId: row.alert_id, at: ms(row.triggered_at), level, condition, suppressed: row.suppressed_reason != null };
}

export function priceAlertToRow(userId: string, alert: PriceAlert, deletedAt: number | null, now: number): Record<string, unknown> {
  return {
    user_id: userId, id: alert.id, symbol: alert.symbol === 'NQ' ? 'NQ' : 'MNQ', price: alert.price,
    condition: alert.condition, condition_auto: alert.conditionAuto === true, frequency: alert.frequency, expiry: alert.expiry,
    line: alert.line, channels: alert.channels, note: alert.note.slice(0, 80),
    // Smazání je nová úprava (jinak by ho novější úprava z jiného zařízení tiše zahodila).
    edited_at: new Date(deletedAt != null ? Math.max(now, (alert.updatedAt || 0) + 1) : Math.min(alert.updatedAt || now, now)).toISOString(),
    deleted_at: deletedAt == null ? null : new Date(deletedAt).toISOString(),
  };
}

export function createServerPriceAlertStore(deps: {
  client: SupabaseClient;
  userId: string;
  storage: StorageLike | null;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}): PriceAlertStore & { dispose(): void; refresh(): Promise<void> } {
  const { client, userId, storage } = deps;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((callback, wait) => setTimeout(callback, wait));
  const cancel = deps.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const read = <T>(key: string): T | null => {
    try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
  };
  const write = (key: string, value: unknown) => {
    try { storage?.setItem(key, JSON.stringify(value)); } catch { /* plné úložiště: zůstane v paměti */ }
  };

  const cached = read<Cache>(cacheKey(userId));
  let server = new Map<string, PriceAlert>((cached?.alerts ?? []).flatMap(item => {
    const alert = sanitizePriceAlert(item);
    return alert ? [[alert.id, alert] as const] : [];
  }));
  let defaults: PriceAlertDefaults = sanitizePriceAlertDefaults(cached?.defaults ?? DEFAULT_PRICE_ALERT);
  let defaultsDirty = false;
  let events: PriceAlertEvent[] = Array.isArray(cached?.events) ? cached!.events.slice(-EVENTS_MAX) : [];
  const queue = new Map<string, PendingOp>(Object.entries(read<Record<string, PendingOp>>(queueKey(userId)) ?? {}).flatMap(([id, op]) => {
    const alert = op && sanitizePriceAlert(op.alert);
    return alert && (op.kind === 'upsert' || op.kind === 'delete') ? [[id, { ...op, alert } as PendingOp] as const] : [];
  }));
  let sync: NonNullable<PriceAlertState['sync']> = 'syncing';
  let error: string | null = null;
  let disposed = false;
  let flushing = false;
  // Změna zadaná během odesílání: po doběhnutí se fronta projde znovu (jinak by čekala na pull).
  let rerun = false;
  // Pořadí čtení vůči zápisům: snímek starší než poslední zápis mapu nepřepíše.
  let writeGen = 0;
  let pullSeq = 0;
  let retry = 0;
  let retryTimer: unknown = null;
  let pulledOnce = false;
  const listeners = new Set<() => void>();
  let state: PriceAlertState = { alerts: [], defaults, sync, events, error };

  const rebuild = () => {
    const merged = new Map(server);
    for (const [id, op] of queue) {
      if (op.kind === 'delete') merged.delete(id);
      // Čekající znovuzapnutí neukazuje „hlídá“, dokud ho server nepotvrdí.
      else merged.set(id, op.alert);
    }
    const alerts = [...merged.values()].filter(alert => alert.status !== 'expired').sort((a, b) => a.createdAt - b.createdAt).slice(0, 50);
    state = { alerts, defaults, sync: queue.size || defaultsDirty ? (sync === 'synced' ? 'syncing' : sync) : sync, events, error };
    write(cacheKey(userId), { alerts: [...server.values()], defaults, events } satisfies Cache);
    write(queueKey(userId), Object.fromEntries(queue));
    listeners.forEach(listener => { try { listener(); } catch { /* posluchač nesmí shodit store */ } });
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer != null) return;
    retryTimer = schedule(() => { retryTimer = null; void flush(); }, RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]);
    retry += 1;
  };

  const flushQueue = async (): Promise<void> => {
    for (const [id, op] of [...queue]) {
      if (disposed) return;
      if (queue.get(id) !== op) continue;
      const row = priceAlertToRow(userId, op.alert, op.kind === 'delete' ? now() : null, now());
      const { data, error: upsertError } = await client.from('price_alerts').upsert(row, { onConflict: 'user_id,id' }).select('*').maybeSingle();
      if (upsertError) {
        // Trvalá chyba nesmí zablokovat zbytek fronty (např. smazání jiného upozornění).
        if (!permanentError(upsertError)) throw new Error(upsertError.message);
        if (queue.get(id) === op) queue.delete(id);
        error = permanentErrorText(upsertError);
        writeGen += 1;
        continue;
      }
      // Znovuzapnutí jen když ho server potvrdí: `false` = mezitím znovu spustilo nebo už je
      // aktivní — UI pak ukáže skutečný stav ze serveru, nikdy vnucené „hlídá“.
      let rearmed = false;
      if (op.kind === 'upsert' && op.rearm != null) {
        const result = await client.rpc('rearm_price_alert', { p_alert: id, p_expected_trigger_count: op.rearm });
        if (result.error) throw new Error(result.error.message);
        rearmed = result.data === true;
      }
      if (queue.get(id) === op) queue.delete(id);
      writeGen += 1;
      const saved = data ? priceAlertFromRow(data as Record<string, unknown>) : null;
      // Smazání platí, jen když ho server opravdu zapsal (novější úprava jinde ho odmítne).
      if (data && (data as { deleted_at?: unknown }).deleted_at) server.delete(id);
      else if (saved) server.set(id, rearmed ? { ...saved, status: 'active', version: (saved.version ?? 1) + 1 } : saved);
      else if (op.kind === 'delete') server.delete(id);
    }
  };

  const flush = async (): Promise<void> => {
    if (disposed) return;
    if (flushing) { rerun = true; return; }
    flushing = true;
    try {
      do {
        rerun = false;
        await flushQueue();
      } while (rerun && !disposed);
      if (defaultsDirty) {
        const { error } = await client.from('price_alert_defaults').upsert({ user_id: userId, defaults, edited_at: new Date(now()).toISOString() }, { onConflict: 'user_id' });
        if (error) throw new Error(error.message);
        defaultsDirty = false;
      }
      retry = 0;
      sync = 'synced';
    } catch {
      sync = 'offline';
      scheduleRetry();
    } finally {
      flushing = false;
      if (!disposed) rebuild();
    }
  };

  const pull = async (): Promise<void> => {
    if (disposed) return;
    const seq = pullSeq += 1;
    const gen = writeGen;
    try {
      const [alerts, defaultsRow, eventRows] = await Promise.all([
        // Vypršelá se nemažou a strop je nepočítá: číst jen živá (a nejnovější), jinak by nová vypadla z limitu.
        client.from('price_alerts').select('*').is('deleted_at', null).neq('status', 'expired').order('created_at', { ascending: false }).limit(100),
        client.from('price_alert_defaults').select('defaults').maybeSingle(),
        client.from('price_alert_events').select('*').gte('triggered_at', new Date(now() - 24 * 3_600_000).toISOString())
          .order('triggered_at', { ascending: false }).limit(EVENTS_MAX),
      ]);
      // Odstavený store ani starší z dvou souběžných čtení už nic nezapíše (ani do úložiště).
      if (disposed || seq !== pullSeq) return;
      if (alerts.error || defaultsRow.error || eventRows.error) throw new Error('pull-failed');
      if (gen === writeGen) {
        server = new Map((alerts.data ?? []).flatMap(row => {
          const alert = priceAlertFromRow(row as Record<string, unknown>);
          return alert ? [[alert.id, alert] as const] : [];
        }));
      } else {
        // Snímek je starší než zápis, který mezitím doběhl: nepřepsat, přečíst znovu.
        schedule(() => { void pull(); }, 500);
      }
      if (defaultsRow.data && !defaultsDirty) defaults = sanitizePriceAlertDefaults((defaultsRow.data as { defaults?: unknown }).defaults);
      events = (eventRows.data ?? []).flatMap(row => {
        const event = priceAlertEventFromRow(row as Record<string, unknown>);
        return event ? [event] : [];
      }).reverse();
      if (!pulledOnce) {
        pulledOnce = true;
        importLocalOnce();
      }
      sync = queue.size || defaultsDirty ? 'syncing' : 'synced';
    } catch {
      if (disposed || seq !== pullSeq) return;
      sync = 'offline';
    }
    rebuild();
    if (queue.size || defaultsDirty) void flush();
  };

  /** Jednou na uživatele převezme upozornění založená dřív jen v tomto zařízení. */
  const importLocalOnce = () => {
    if (read<boolean>(importedKey(userId))) return;
    write(importedKey(userId), true);
    const local = readPriceAlertState(storage);
    for (const alert of local.alerts) {
      if (!server.has(alert.id) && !queue.has(alert.id) && server.size + queue.size < 50) queue.set(alert.id, { kind: 'upsert', alert });
    }
  };

  const channel = (() => {
    try {
      const filter = `user_id=eq.${userId}`;
      const realtime = client.channel(`price-alerts-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'price_alerts', filter }, payload => {
          const row = payload.new as Record<string, unknown> | undefined;
          if (!row || typeof row.id !== 'string' || queue.has(row.id)) return;
          // Změna z realtime je novější než rozběhnuté čtení.
          writeGen += 1;
          if (row.deleted_at) server.delete(row.id);
          else {
            const alert = priceAlertFromRow(row);
            if (alert) server.set(alert.id, alert);
          }
          rebuild();
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'price_alert_events', filter }, payload => {
          const event = payload.new ? priceAlertEventFromRow(payload.new as Record<string, unknown>) : null;
          if (!event || events.some(item => item.id === event.id)) return;
          events = [...events, event].slice(-EVENTS_MAX);
          rebuild();
        })
        .subscribe();
      return realtime;
    } catch {
      return null;
    }
  })();

  rebuild();
  void pull();

  const enqueue = (op: PendingOp) => {
    // Nová úprava: stará chyba už neplatí. Stejná chyba znovu se musí zase ukázat.
    error = null;
    queue.set(op.alert.id, op);
    rebuild();
    void flush();
  };

  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => state,
    add: alert => enqueue({ kind: 'upsert', alert: { ...alert, status: 'active' } }),
    update: alert => {
      const previous = queue.get(alert.id)?.alert ?? server.get(alert.id) ?? null;
      const changed = previous != null && TRIGGER_FIELDS.some(field => previous[field] !== alert[field]);
      const spent = previous?.status === 'triggered' || previous?.status === 'expired';
      const pendingRearm = (queue.get(alert.id) as { rearm?: number } | undefined)?.rearm;
      enqueue({ kind: 'upsert', alert, ...(pendingRearm != null ? { rearm: pendingRearm } : spent && changed ? { rearm: previous!.triggerCount ?? 0 } : {}) });
    },
    remove: id => {
      const alert = queue.get(id)?.alert ?? server.get(id);
      if (!alert) return;
      enqueue({ kind: 'delete', alert });
    },
    setDefaults: next => {
      defaults = sanitizePriceAlertDefaults(next);
      defaultsDirty = true;
      rebuild();
      void flush();
    },
    refresh: pull,
    dispose() {
      disposed = true;
      if (retryTimer != null) cancel(retryTimer);
      listeners.clear();
      if (channel) void client.removeChannel(channel).catch(() => undefined);
    },
  };
}
