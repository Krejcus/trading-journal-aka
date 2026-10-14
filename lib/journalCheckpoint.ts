import { buildJournalPositionEpisodes, type JournalPositionEpisode, type JournalProjectionWindow } from './journalPositionEpisodes.js';
import { journalValidSnapshots } from './journalPositionSnapshot.js';
import { latestJournalEvidence, projectJournalEvidence, type JournalEvidence } from './tradovateJournalEvidence.js';
import type { JournalUntakenOrder } from './journalEntryOrders.js';

/**
 * Kontrolní body živého deníku (14. 10. 2026, docs/JOURNAL_LIVE_PLAN.md).
 * K je `completedAt` jednoho snímku pozic, ve kterém je každý zachycený účet
 * ověřeně flat. Posun K je bezpečný jen bez příkazu zadaného před K, který by
 * ještě pracoval, a jen když okno od K dá pro pozice po K totéž co dosavadní
 * výpočet — to ověřuje `compareJournalWindows` při každém posunu.
 */
export interface JournalFlatCapture { at: number; window: JournalProjectionWindow }

/** Snímky (jedno REST kolo přes všechny účty), kde je každý účet ověřeně flat. */
export function journalFlatCaptures(evidence: readonly JournalEvidence[]): JournalFlatCapture[] {
  const gaps = projectJournalEvidence(evidence).gaps;
  const captured = new Map<string, Set<number>>();
  for (const event of evidence) {
    if (event.entityType !== 'positionsnapshot' || event.source !== 'snapshot' || typeof event.entity.snapshotId !== 'string'
      || event.entity.kind !== 'complete' || !Number.isSafeInteger(event.entity.accountId)) continue;
    const key = `${event.sessionId}:${event.entity.snapshotId}`;
    const accounts = captured.get(key) ?? new Set<number>(); accounts.add(Number(event.entity.accountId)); captured.set(key, accounts);
  }
  const valid = new Map<string, { at: Set<number>; flat: Set<number> }>();
  for (const snapshot of journalValidSnapshots(evidence, gaps)) {
    if ([...snapshot.positions.values()].some(net => net !== 0)) continue;
    const key = `${snapshot.sessionId}:${snapshot.snapshotId}`;
    const row = valid.get(key) ?? { at: new Set<number>(), flat: new Set<number>() };
    row.at.add(snapshot.completedAt); row.flat.add(snapshot.accountId); valid.set(key, row);
  }
  const result: JournalFlatCapture[] = [];
  for (const [key, row] of valid) {
    const accounts = captured.get(key);
    // Celé kolo: všechny jeho účty flat a ověřené, jeden společný čas dokončení.
    if (!accounts || row.at.size !== 1 || accounts.size !== row.flat.size || [...accounts].some(id => !row.flat.has(id))) continue;
    result.push({ at: [...row.at][0], window: { start: [...row.at][0], flatAccounts: row.flat } });
  }
  return result.sort((a, b) => a.at - b.at);
}

const TERMINAL_ORDER_STATUSES = new Set(['Canceled', 'Completed', 'Expired', 'Filled', 'Rejected']);

/** Příkazy zadané před `at`, které podle posledního pozorování ještě nejsou ukončené. */
export function journalOrdersOpenSince(evidence: readonly JournalEvidence[], at: number): string[] {
  const result: string[] = [];
  for (const [key, event] of latestJournalEvidence(evidence)) {
    if (!key.startsWith('order:')) continue;
    const created = Date.parse(String(event.entity.timestamp ?? ''));
    // Neznámý čas zadání: nelze doložit, že vznikl až po K — konzervativně blokuje.
    if (Number.isFinite(created) && created >= at) continue;
    if (TERMINAL_ORDER_STATUSES.has(String(event.entity.ordStatus))) continue;
    result.push(String(event.entity.id));
  }
  return result.sort();
}

type Comparable = Omit<JournalPositionEpisode, 'history'> & { history: Omit<JournalPositionEpisode['history'], 'issues' | 'complete'> };
const comparable = (episode: JournalPositionEpisode): Comparable => {
  const { issues: _issues, complete: _complete, ...history } = episode.history;
  return { ...episode, history };
};
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item instanceof Set ? [...item].sort()
  : item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))
    : item);

export interface JournalWindowDifference { kind: 'missing' | 'extra' | 'changed' | 'untaken'; id: string }

/**
 * Shoda dvou výpočtů pro vše od K: pozice (fakta, filly, ochrana, vstupní
 * příkazy, P&L, stav) a nevzaté příkazy. `issues/complete` se liší legitimně
 * (problémy celého připojení z doby před K) a jsou jen zobrazení.
 */
export function compareJournalWindows(
  reference: { episodes: readonly JournalPositionEpisode[]; untakenOrders: readonly JournalUntakenOrder[] },
  candidate: { episodes: readonly JournalPositionEpisode[]; untakenOrders: readonly JournalUntakenOrder[] },
  at: number,
): JournalWindowDifference[] {
  const differences: JournalWindowDifference[] = [];
  const after = (episodes: readonly JournalPositionEpisode[]) => new Map(episodes.filter(episode => episode.entryAt >= at).map(episode => [episode.id, episode]));
  const left = after(reference.episodes), right = after(candidate.episodes);
  for (const [id, episode] of left) {
    const other = right.get(id);
    if (!other) differences.push({ kind: 'missing', id });
    else if (stable(comparable(episode)) !== stable(comparable(other))) differences.push({ kind: 'changed', id });
  }
  for (const id of right.keys()) if (!left.has(id)) differences.push({ kind: 'extra', id });
  const untaken = (orders: readonly JournalUntakenOrder[]) => stable(orders.filter(order => order.placedAt >= at)
    .map(order => ({ ...order })).sort((a, b) => a.orderId.localeCompare(b.orderId)));
  if (untaken(reference.untakenOrders) !== untaken(candidate.untakenOrders)) differences.push({ kind: 'untaken', id: '*' });
  return differences;
}

/** Plný výpočet a okno od K nad stejným vstupem (posun K a testy). */
export function journalWindowCheck(evidence: readonly JournalEvidence[], capture: JournalFlatCapture,
  reference = buildJournalPositionEpisodes(evidence)) {
  const window = buildJournalPositionEpisodes(evidence, capture.window);
  return { window, differences: compareJournalWindows(reference, window, capture.at) };
}
