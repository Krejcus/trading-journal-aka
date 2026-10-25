import type { Trade } from '../types';

/**
 * Delta sync obchodů přes verze (docs/reviews/sync-phases-1-2-design-20261025.md).
 *
 * Základ = poslední ověřený úplný seznam obchodů vlastníka + kurzor do
 * `sync_changes`. Při každém čtení se stáhne jen seznam změněných ID a ty se
 * dočtou stejnými funkcemi jako úplné čtení — server neposílá rozdíly, klient
 * vždy dočte aktuální složený stav. Cokoli neobvyklého (reset, chyba, starý
 * základ) končí úplným čtením: nikdy neukázat neověřený stav jako čerstvý.
 */

export interface TradeSyncChanges {
  reset: boolean;
  cursor: string;
  epoch: number;
  tradeIds: string[];
}

export interface TradeSyncMeta {
  version: 1;
  userId: string;
  epoch: number;
  cursor: string;
  /** Kdy proběhlo poslední úplné čtení; po 24 h se dělá znovu (samoléčení). */
  bootstrappedAt: number;
}

export interface TradeSyncDeps {
  ownerId: string;
  stillOwner: () => Promise<boolean>;
  /** null = funkce na serveru ještě není (starší DB) → engine se vypne. */
  fetchChanges: (cursor: string | null, epoch: number | null) => Promise<TradeSyncChanges | null>;
  readFull: () => Promise<Trade[]>;
  readByIds: (ids: string[]) => Promise<Trade[]>;
  loadMeta: () => Promise<TradeSyncMeta | null>;
  loadTrades: () => Promise<Trade[] | null>;
  /** `trades` jen když se změnily — zápis 5–10 MB do IndexedDB není zadarmo. */
  save: (meta: TradeSyncMeta, trades?: Trade[]) => Promise<void>;
  now: () => number;
}

export interface TradeSyncResult {
  trades: Trade[];
  /** ID dočtená v této deltě; null = úplné čtení (změnit se mohlo cokoli). */
  changedIds: string[] | null;
  /** Základ je starší než 24 h: volající má na pozadí naplánovat úplné čtení. */
  refreshDue?: boolean;
}

export const TRADE_SYNC_MAX_BASE_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const byNewest = (a: Trade, b: Trade) => Number(b.timestamp) - Number(a.timestamp);

/** Nahradit změněná ID tím, co server vrátil; co nevrátil (smazané/skryté), zmizí. */
export function applyTradeDelta(base: readonly Trade[], changedIds: readonly string[], rows: readonly Trade[]): Trade[] {
  const changed = new Set(changedIds.map(String));
  return [...base.filter(trade => !changed.has(String(trade.id))), ...rows.filter(row => changed.has(String(row.id)))].sort(byNewest);
}

export const isValidTradeSyncMeta = (value: unknown, ownerId: string): value is TradeSyncMeta => {
  const meta = value as Partial<TradeSyncMeta> | null;
  return Boolean(meta) && meta!.version === 1 && meta!.userId === ownerId && typeof meta!.cursor === 'string'
    && /^[0-9]{1,19}$/.test(meta!.cursor) && Number.isSafeInteger(meta!.epoch) && Number.isFinite(meta!.bootstrappedAt);
};

async function bootstrap(deps: TradeSyncDeps, start: TradeSyncChanges | null): Promise<TradeSyncResult> {
  // Dvoufázově: kurzor PŘED úplným čtením. Co se změní během čtení, přijde
  // v další deltě znovu (dočtení je idempotentní).
  // Bez kurzoru (výpadek RPC) se jen přečte vše a základ se neuloží.
  const point = start ?? await deps.fetchChanges(null, null).catch(() => null);
  const trades = await deps.readFull();
  if (!await deps.stillOwner()) throw new Error('trade-list-session-changed');
  if (point) {
    await deps.save({ version: 1, userId: deps.ownerId, epoch: point.epoch, cursor: point.cursor, bootstrappedAt: deps.now() }, trades)
      .catch(() => undefined);
  }
  return { trades, changedIds: null };
}

export async function syncOwnerTrades(deps: TradeSyncDeps, options: { forceFull?: boolean } = {}): Promise<TradeSyncResult> {
  if (options.forceFull) return bootstrap(deps, null);
  const meta = await deps.loadMeta().catch(() => null);
  const validMeta = isValidTradeSyncMeta(meta, deps.ownerId) ? meta : null;
  const base = validMeta ? await deps.loadTrades().catch(() => null) : null;
  if (!validMeta || !Array.isArray(base)) return bootstrap(deps, null);
  // Starý základ nezdržuje start: delta proběhne hned, úplné čtení na pozadí.
  const refreshDue = deps.now() - validMeta.bootstrappedAt > TRADE_SYNC_MAX_BASE_AGE_MS;
  let delta: TradeSyncChanges | null;
  try {
    delta = await deps.fetchChanges(validMeta.cursor, validMeta.epoch);
  } catch {
    return bootstrap(deps, null);
  }
  if (!delta) return { trades: await deps.readFull(), changedIds: null };
  if (delta.reset) return bootstrap(deps, delta);
  const ids = [...new Set(delta.tradeIds.map(String))];
  if (ids.some(id => !UUID.test(id))) return bootstrap(deps, null);
  const nextMeta: TradeSyncMeta = { ...validMeta, epoch: delta.epoch, cursor: delta.cursor };
  if (ids.length === 0) {
    await deps.save(nextMeta).catch(() => undefined);
    return { trades: base, changedIds: [], refreshDue };
  }
  let rows: Trade[];
  try {
    rows = await deps.readByIds(ids);
  } catch (reason) {
    if (reason instanceof Error && reason.message === 'trade-list-session-changed') throw reason;
    return bootstrap(deps, null);
  }
  if (!await deps.stillOwner()) throw new Error('trade-list-session-changed');
  const trades = applyTradeDelta(base, ids, rows);
  await deps.save(nextMeta, trades).catch(() => undefined);
  return { trades, changedIds: ids, refreshDue };
}
