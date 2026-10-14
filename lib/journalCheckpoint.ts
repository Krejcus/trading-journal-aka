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

/**
 * Proč bod K nelze použít (prázdné = lze). Pozdní doplnění čehokoli z toho by
 * se do zmrazených obchodů nepropsalo, protože na straně zmrazených dat chybí
 * objekt, ke kterému by se dalo vázat (kontrola oponenta 14. 10.).
 */
export function journalCheckpointBlockers(evidence: readonly JournalEvidence[], at: number): string[] {
  const blockers: string[] = [];
  const open = journalOrdersOpenSince(evidence, at);
  if (open.length) blockers.push(`open-orders:${open.length}`);
  const latest = latestJournalEvidence(evidence);
  const has = (type: string, id: unknown) => id != null && latest.has(`${type}:${id}`);
  const projection = projectJournalEvidence(evidence);
  const fillTime = new Map<string, number>();
  for (const [key, event] of latest) if (key.startsWith('fill:')) fillTime.set(String(event.entity.id), brokerTime(event) ?? event.receivedAt);
  for (const issue of projection.issues) {
    const [kind, id] = [issue.slice(0, issue.indexOf(':')), issue.slice(issue.indexOf(':') + 1)];
    if (kind === 'incomplete-fill' && (fillTime.get(id) ?? -Infinity) < at) blockers.push(issue);
    if (kind === 'missing-id') {
      const event = evidence.find(row => row.id === id);
      if (!event || event.receivedAt < at) blockers.push(issue);
    }
  }
  for (const [key, event] of latest) {
    const type = key.slice(0, key.indexOf(':')), row = event.entity;
    const time = brokerTime(event) ?? event.receivedAt;
    if (type === 'fill' && time < at) {
      if (!has('order', row.orderId)) blockers.push(`missing-order:${row.orderId}`);
      if (!has('contract', row.contractId)) blockers.push(`missing-contract:${row.contractId}`);
    }
    if (['orderversion', 'command', 'executionreport'].includes(type) && row.orderId != null && !has('order', row.orderId)
      && time < at) blockers.push(`missing-order:${row.orderId}`);
    if ((type === 'fillfee' || type === 'cashbalancelog') && time < at) {
      for (const [field, value] of Object.entries(row)) {
        if (/CurrencyId$|^currencyId$/.test(field) && value != null && !has('currency', value)) blockers.push(`missing-currency:${value}`);
      }
    }
  }
  return [...new Set(blockers)].sort();
}

type Comparable = Omit<JournalPositionEpisode, 'history'> & { history: Omit<JournalPositionEpisode['history'], 'issues' | 'complete'> };
const comparable = (episode: JournalPositionEpisode): Comparable => {
  const { issues: _issues, complete: _complete, ...history } = episode.history;
  return { ...episode, history };
};
/** JSON s seřazenými klíči (jsonb z databáze klíče přeřazuje). */
export const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item instanceof Set ? [...item].sort()
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

/** Otisk věcného obsahu: projekce čte entitu a typ události, ne čas pozorování. */
const fingerprintOf = (event: JournalEvidence) => {
  const { finallyPaired: _ignored, ...entity } = event.entity;
  return stable({ eventType: event.eventType.toLowerCase() === 'deleted' ? 'deleted' : 'observed', entity: event.entityType === 'fill' ? entity : event.entity });
};
const brokerTime = (event: JournalEvidence) => {
  const at = typeof event.entity.timestamp === 'string' ? Date.parse(event.entity.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
};
const DICTIONARY_TYPES = new Set(['contract', 'currency']);
const idOf = (value: unknown) => value == null ? null : String(value);

export interface JournalCheckpointRef { kind: string; id: string; fingerprint?: string }
export interface JournalCheckpointManifest {
  /** Entity řádky vstupu k archivaci (klíč `typ:id`). */
  entityKeys: string[];
  /** Retained události vstupu k archivaci (id události). */
  retainedIds: string[];
  /** Otisky všeho, co patří k obchodům před K. */
  refs: JournalCheckpointRef[];
}

/**
 * Co při posunu na K zmrazit. Kořeny jsou příkazy a filly s broker časem
 * před K; k nim patří vše, co na ně odkazuje (verze, commandy, reporty,
 * děti, fees, páry, účetnictví, copylinky) bez ohledu na čas pozorování —
 * broker je posílá znovu i za hodiny. Retained události (filly, pozice,
 * snímky, spojení) s veškerou aktivitou před K se archivují samostatně.
 */
export function journalCheckpointManifest(evidence: readonly JournalEvidence[], at: number): JournalCheckpointManifest {
  const latest = latestJournalEvidence(evidence);
  const connectionId = evidence[0]?.connectionId;
  const orders = new Set<string>(), fills = new Set<string>(), commands = new Set<string>(), pairs = new Set<string>();
  for (const [key, event] of latest) {
    const [type] = key.split(':');
    const time = brokerTime(event) ?? event.receivedAt;
    if (type === 'order' && time < at) orders.add(String(event.entity.id));
    if (type === 'fill' && time < at) { fills.add(String(event.entity.id)); if (event.entity.orderId != null) orders.add(String(event.entity.orderId)); }
  }
  // Uzávěr přes odkazy, dokud se něco přidává (děti příkazů, filly příkazů…).
  for (let changed = true; changed;) {
    changed = false;
    const add = (set: Set<string>, value: unknown) => { const id = idOf(value); if (id != null && !set.has(id)) { set.add(id); changed = true; } };
    for (const [key, event] of latest) {
      const row = event.entity, type = key.slice(0, key.indexOf(':'));
      if (type === 'order' && [row.parentId, row.ocoId, row.linkedId].some(id => id != null && orders.has(String(id)))) add(orders, row.id);
      if (type === 'fill' && row.orderId != null && orders.has(String(row.orderId))) add(fills, row.id);
      if (type === 'command' && row.orderId != null && orders.has(String(row.orderId))) add(commands, row.id);
      if (type === 'fillpair' && [row.buyFillId, row.sellFillId].some(id => id != null && fills.has(String(id)))) add(pairs, row.id);
    }
  }
  const member = (type: string, event: JournalEvidence) => {
    const row = event.entity;
    switch (type) {
      case 'order': return orders.has(String(row.id));
      case 'fill': return fills.has(String(row.id));
      case 'command': return commands.has(String(row.id));
      case 'orderversion': return commands.has(String(row.id)) || (row.orderId != null && orders.has(String(row.orderId)));
      case 'commandreport': return row.commandId != null && commands.has(String(row.commandId));
      case 'executionreport': return (row.orderId != null && orders.has(String(row.orderId))) || (row.commandId != null && commands.has(String(row.commandId)));
      case 'fillfee': return fills.has(String(row.id));
      case 'fillpair': return pairs.has(String(row.id));
      case 'cashbalancelog': return (row.fillPairId != null && pairs.has(String(row.fillPairId))) || (row.fillId != null && fills.has(String(row.fillId)));
      case 'copylink': return (row.orderId != null && orders.has(String(row.orderId)))
        || (row.leaderConnectionId === connectionId && row.leaderOrderId != null && orders.has(String(row.leaderOrderId)));
      default: return false;
    }
  };
  const refs: JournalCheckpointRef[] = [];
  const entityKeys: string[] = [];
  for (const [key, event] of latest) {
    const type = key.slice(0, key.indexOf(':'));
    // Člen uzávěru obchodů před K, nebo cokoli s broker časem před K (např.
    // pohyby účtu mimo obchody) — jinak by se jevilo jako pozdní evidence.
    const broker = brokerTime(event);
    if (DICTIONARY_TYPES.has(type) || type === 'positionsnapshot' || type === 'journalbackfill' || type === 'position'
      || !(member(type, event) || (broker != null && broker < at))) continue;
    refs.push({ kind: type, id: String(event.entity.id), fingerprint: fingerprintOf(event) });
    if (type !== 'fill') entityKeys.push(key);
  }
  // Účty s historií před K: když některý z nich v kole snímků chyběl a znovu
  // obchoduje, okno by jeho lane začalo neznámé — kontrola pak K vrátí.
  const accounts = new Set<string>();
  for (const [key, event] of latest) if (key.startsWith('fill:') && (brokerTime(event) ?? event.receivedAt) < at
    && event.entity.accountId != null) accounts.add(String(event.entity.accountId));
  for (const id of accounts) refs.push({ kind: 'account', id });
  const retainedIds: string[] = [];
  const seenPositions = new Set<string>();
  for (const event of evidence) {
    const time = brokerTime(event);
    if (event.entityType === 'position' && event.source === 'stream' && time != null && time < at) {
      const id = `${event.entity.id}:${time}:${event.entity.netPos}`;
      if (!seenPositions.has(id)) { seenPositions.add(id); refs.push({ kind: 'position', id }); }
    }
    if (!['fill', 'position', 'connection', 'positionsnapshot'].includes(event.entityType) && event.entity.id != null) continue;
    const activity = Math.max(event.receivedAt, time ?? -Infinity,
      typeof event.entity.completedAt === 'number' ? event.entity.completedAt : -Infinity);
    if (activity < at) retainedIds.push(event.id);
  }
  return { entityKeys: entityKeys.sort(), retainedIds: retainedIds.sort(), refs };
}

/** Vstup bez archivovaných řádků (ověření posunu nad tím, co pak import uvidí). */
export function journalLiveAfterArchive(evidence: readonly JournalEvidence[], manifest: JournalCheckpointManifest): JournalEvidence[] {
  const entityKeys = new Set(manifest.entityKeys), retained = new Set(manifest.retainedIds);
  return evidence.filter(event => {
    const retainedMode = ['fill', 'position', 'connection', 'positionsnapshot'].includes(event.entityType) || event.entity.id == null;
    return retainedMode ? !retained.has(event.id) : !entityKeys.has(`${event.entityType}:${event.entity.id}`);
  });
}

export interface JournalLateRow {
  /** Vlastní identita řádku (u stream pozice `id:čas:net`). */
  own: JournalCheckpointRef;
  /** Čas události pro návrat K (broker čas, jinak příjem). */
  at: number;
  /** Událost s broker časem před K: neznámá = pozdní. */
  beforeCheckpoint: boolean;
  /** Zmrazené objekty, na které řádek odkazuje. */
  references: Array<{ kind: string; id: string }>;
}
export interface JournalLateCheck {
  rows: JournalLateRow[];
  /** Nejstarší čas pozdní události poznané bez dotazu (spojení, snímek). */
  lateAt: number | null;
}

/**
 * Pozdní evidence k obchodům před K v živém vstupu: vlastní otisk se liší,
 * neznámý záznam s časem před K, nebo nový záznam odkazující na zmrazený
 * objekt (pozdní fee, pár, ledger, report…). Totožné opakování je v pořádku.
 */
export function journalLateEvidenceCheck(evidence: readonly JournalEvidence[], at: number,
  flatAccounts: ReadonlySet<number> = new Set()): JournalLateCheck {
  const rows: JournalLateRow[] = [];
  let lateAt: number | null = null;
  const connectionId = evidence[0]?.connectionId;
  for (const [key, event] of latestJournalEvidence(evidence)) {
    const type = key.slice(0, key.indexOf(':'));
    if (DICTIONARY_TYPES.has(type) || type === 'positionsnapshot' || type === 'journalbackfill' || type === 'position') continue;
    const row = event.entity, broker = brokerTime(event);
    const references: JournalLateRow['references'] = [];
    const reference = (kind: string, value: unknown) => { const id = idOf(value); if (id != null) references.push({ kind, id }); };
    if (['fill', 'command', 'orderversion', 'executionreport', 'copylink'].includes(type)) reference('order', row.orderId);
    if (type === 'order') for (const value of [row.parentId, row.ocoId, row.linkedId]) reference('order', value);
    if (['commandreport', 'executionreport'].includes(type)) reference('command', row.commandId);
    if (type === 'orderversion') reference('command', row.id);
    if (type === 'fillfee') reference('fill', row.id);
    if (type === 'fillpair') { reference('fill', row.buyFillId); reference('fill', row.sellFillId); }
    if (type === 'cashbalancelog') { reference('fillpair', row.fillPairId); reference('fill', row.fillId); }
    if (type === 'copylink' && row.leaderConnectionId === connectionId) reference('order', row.leaderOrderId);
    // Fill účtu, který v kole snímků K chyběl, ale má historii před K.
    if (type === 'fill' && row.accountId != null && !flatAccounts.has(Number(row.accountId))) reference('account', row.accountId);
    rows.push({ own: { kind: type, id: String(row.id), fingerprint: fingerprintOf(event) }, at: broker ?? event.receivedAt,
      beforeCheckpoint: broker != null && broker < at, references });
  }
  for (const event of evidence) {
    const broker = brokerTime(event);
    if ((event.entityType === 'connection' || event.entityType === 'positionsnapshot') && event.receivedAt < at) {
      lateAt = lateAt == null ? event.receivedAt : Math.min(lateAt, event.receivedAt);
    }
    if (event.entityType === 'position' && event.source === 'stream' && broker != null && broker < at) {
      rows.push({ own: { kind: 'position', id: `${event.entity.id}:${broker}:${event.entity.netPos}` }, at: broker, beforeCheckpoint: true, references: [] });
    }
  }
  return { rows, lateAt };
}

/** Všechny dotazy na zmrazená data (vlastní identity i odkazy). */
export function journalLateQueries(check: JournalLateCheck): Array<{ kind: string; id: string }> {
  const seen = new Map<string, { kind: string; id: string }>();
  for (const row of check.rows) for (const ref of [row.own, ...row.references]) seen.set(`${ref.kind}:${ref.id}`, { kind: ref.kind, id: ref.id });
  return [...seen.values()];
}

/**
 * Opakovaný fill z jiného kanálu (REST vs stream) může nést jen část polí.
 * Totožný = stejný typ události a každé přítomné pole stejné jako u zmrazeného.
 */
function sameObservedFields(live: string, frozen: string | null): boolean {
  if (frozen == null) return false;
  try {
    const a = JSON.parse(live) as { eventType: string; entity: Record<string, unknown> };
    const b = JSON.parse(frozen) as { eventType: string; entity: Record<string, unknown> };
    return a.eventType === b.eventType && Object.entries(a.entity).every(([key, value]) => stable(value) === stable(b.entity[key]));
  } catch {
    return false;
  }
}

export interface JournalLateEvidence {
  /** Nejstarší čas pozdní události bez vazby na zmrazený objekt (spojení, snímek, neznámý fill/pozice před K). */
  at: number | null;
  /** Nejstarší kontrolní bod, který zmrazil změněný nebo nově odkazovaný objekt. */
  epoch: number | null;
}

/** Pozdní evidence (→ K se vrátí na bod před ní), nebo null. */
export function journalLateEvidenceAt(check: JournalLateCheck,
  hits: ReadonlyArray<{ kind: string; id: string; fingerprint: string | null; epoch?: number }>): JournalLateEvidence | null {
  const known = new Map(hits.map(hit => [`${hit.kind}:${hit.id}`, hit]));
  let at = check.lateAt, epoch: number | null = null;
  const lateAt = (time: number) => { at = at == null ? time : Math.min(at, time); };
  const lateEpoch = (value: number | undefined) => { const e = value ?? 0; epoch = epoch == null ? e : Math.min(epoch, e); };
  for (const row of check.rows) {
    const own = known.get(`${row.own.kind}:${row.own.id}`);
    if (own) {
      if (row.own.fingerprint !== undefined && own.fingerprint !== row.own.fingerprint
        && !(row.own.kind === 'fill' && sameObservedFields(row.own.fingerprint, own.fingerprint))) lateEpoch(own.epoch);
      continue;
    }
    const referenced = row.references.map(ref => known.get(`${ref.kind}:${ref.id}`)).filter(hit => hit != null);
    if (referenced.length) lateEpoch(Math.min(...referenced.map(hit => hit!.epoch ?? 0)));
    else if (row.beforeCheckpoint) lateAt(row.at);
  }
  return at == null && epoch == null ? null : { at, epoch };
}
