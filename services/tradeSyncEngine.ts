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
  /** Epizody kopírky se změnou — vazba na obchod mohla zmizet, dočíst i obchody, které ji měly. */
  episodeIds?: string[];
}

export interface TradeSyncMeta {
  version: 1;
  userId: string;
  epoch: number;
  cursor: string;
  /** Kdy proběhlo poslední úplné čtení; po 24 h se dělá znovu (samoléčení). */
  bootstrappedAt: number;
  /** Obchody, kterým se nenačetly snímky — přidat do další delty. */
  retryIds?: string[];
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
  /** Zahodit základ (server funkci nemá — starý základ by se jinak zobrazoval ze startovní cache). */
  clear?: () => Promise<void>;
  /** Úprava celého seznamu po deltě (např. skrytí nahrazených journal obchodů). */
  normalize?: (trades: Trade[]) => Trade[];
  now: () => number;
}

export interface TradeSyncResult {
  trades: Trade[];
  /** ID, která se opravdu změnila; null = úplné čtení bez předchozího základu. */
  changedIds: string[] | null;
  /** Základ je starší než 24 h: volající má na pozadí naplánovat úplné čtení. */
  refreshDue?: boolean;
}

export const TRADE_SYNC_MAX_BASE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Jako úplné čtení: nejnovější první, při shodě času podle ID vzestupně. */
const byNewest = (a: Trade, b: Trade) => (Number(b.timestamp) - Number(a.timestamp))
  || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/** Nahradit změněná ID tím, co server vrátil; co nevrátil (smazané/skryté), zmizí. */
export function applyTradeDelta(base: readonly Trade[], changedIds: readonly string[], rows: readonly Trade[]): Trade[] {
  const changed = new Set(changedIds.map(String));
  return [...base.filter(trade => !changed.has(String(trade.id))), ...rows.filter(row => changed.has(String(row.id)))].sort(byNewest);
}

/**
 * ID, která se mezi seznamy liší přítomností, nebo (u `compare`, jinak všech)
 * obsahem. Přítomnost se hlídá vždy celá — normalizace může skrýt i nedočtený obchod.
 */
export function changedTradeIds(previous: readonly Trade[], next: readonly Trade[], compare?: ReadonlySet<string>): string[] {
  const before = new Map(previous.map(trade => [String(trade.id), trade]));
  const changed = new Set<string>();
  for (const trade of next) {
    const id = String(trade.id);
    const old = before.get(id);
    before.delete(id);
    if (!old) changed.add(id);
    else if (old !== trade && (!compare || compare.has(id)) && JSON.stringify(old) !== JSON.stringify(trade)) changed.add(id);
  }
  before.forEach((_, id) => changed.add(id));
  return [...changed];
}

export const isValidTradeSyncMeta = (value: unknown, ownerId: string): value is TradeSyncMeta => {
  const meta = value as Partial<TradeSyncMeta> | null;
  return Boolean(meta) && meta!.version === 1 && meta!.userId === ownerId && typeof meta!.cursor === 'string'
    && /^[0-9]{1,19}$/.test(meta!.cursor) && Number.isSafeInteger(meta!.epoch) && Number.isFinite(meta!.bootstrappedAt)
    && (meta!.retryIds === undefined || (Array.isArray(meta!.retryIds) && meta!.retryIds.every(id => typeof id === 'string' && UUID.test(id))));
};

const retryIdsOf = (trades: readonly Trade[]) => trades
  .filter(trade => (trade as Trade & { copierSnapshotLoadError?: boolean }).copierSnapshotLoadError === true)
  .map(trade => String(trade.id)).slice(0, MAX_RETRY_IDS);

async function bootstrap(deps: TradeSyncDeps, start: TradeSyncChanges | null, previous: readonly Trade[] | null): Promise<TradeSyncResult> {
  // Dvoufázově: kurzor PŘED úplným čtením. Co se změní během čtení, přijde
  // v další deltě znovu (dočtení je idempotentní). Bez kurzoru (výpadek RPC)
  // se jen přečte vše a základ se neuloží.
  const point = start ?? await deps.fetchChanges(null, null).catch(() => null);
  const read = await deps.readFull();
  const trades = deps.normalize ? deps.normalize(read) : read;
  if (!await deps.stillOwner()) throw new Error('trade-list-session-changed');
  if (point) {
    await deps.save({ version: 1, userId: deps.ownerId, epoch: point.epoch, cursor: point.cursor, bootstrappedAt: deps.now(),
      retryIds: retryIdsOf(trades) }, trades).catch(() => undefined);
  }
  // S předchozím základem appka dostane přesný rozdíl (i ruční obchody), ne jen „změnilo se cokoli“.
  return { trades, changedIds: previous ? changedTradeIds(previous, trades) : null };
}

export async function syncOwnerTrades(deps: TradeSyncDeps, options: { forceFull?: boolean } = {}): Promise<TradeSyncResult> {
  const meta = await deps.loadMeta().catch(() => null);
  const validMeta = isValidTradeSyncMeta(meta, deps.ownerId) ? meta : null;
  const base = validMeta ? await deps.loadTrades().catch(() => null) : null;
  const previous = validMeta && Array.isArray(base) ? base : null;
  if (options.forceFull || !validMeta || !previous) return bootstrap(deps, null, previous);
  // Starý základ nezdržuje start: delta proběhne hned, úplné čtení na pozadí.
  const refreshDue = deps.now() - validMeta.bootstrappedAt > TRADE_SYNC_MAX_BASE_AGE_MS;
  let delta: TradeSyncChanges | null;
  try {
    delta = await deps.fetchChanges(validMeta.cursor, validMeta.epoch);
  } catch {
    return bootstrap(deps, null, previous);
  }
  if (!delta) {
    await deps.clear?.().catch(() => undefined);
    const trades = await deps.readFull();
    if (!await deps.stillOwner()) throw new Error('trade-list-session-changed');
    return { trades, changedIds: changedTradeIds(previous, trades) };
  }
  if (delta.reset) return bootstrap(deps, delta, previous);
  const episodes = new Set((delta.episodeIds ?? []).map(String));
  const ids = [...new Set([
    ...delta.tradeIds.map(String),
    ...(validMeta.retryIds ?? []),
    ...(episodes.size ? previous.filter(trade => trade.copierEpisodeId && episodes.has(String(trade.copierEpisodeId))).map(trade => String(trade.id)) : []),
  ])];
  if (ids.some(id => !UUID.test(id))) return bootstrap(deps, null, previous);
  const nextMeta: TradeSyncMeta = { ...validMeta, epoch: delta.epoch, cursor: delta.cursor, retryIds: [] };
  if (ids.length === 0) {
    await deps.save(nextMeta).catch(() => undefined);
    return { trades: previous, changedIds: [], refreshDue };
  }
  let rows: Trade[];
  try {
    rows = await deps.readByIds(ids);
  } catch (reason) {
    if (reason instanceof Error && reason.message === 'trade-list-session-changed') throw reason;
    return bootstrap(deps, null, previous);
  }
  if (!await deps.stillOwner()) throw new Error('trade-list-session-changed');
  const applied = applyTradeDelta(previous, ids, rows);
  const trades = deps.normalize ? deps.normalize(applied) : applied;
  nextMeta.retryIds = retryIdsOf(rows);
  // Hlášené ID bez změny obsahu (např. otevřená pozice bez řádku obchodu):
  // nezapisovat 5–10 MB a vrátit stejnou referenci, ať se appka nepřekresluje.
  const changed = changedTradeIds(previous, trades, new Set(ids));
  if (changed.length === 0) {
    await deps.save(nextMeta).catch(() => undefined);
    return { trades: previous, changedIds: [], refreshDue };
  }
  await deps.save(nextMeta, trades).catch(() => undefined);
  return { trades, changedIds: changed, refreshDue };
}
