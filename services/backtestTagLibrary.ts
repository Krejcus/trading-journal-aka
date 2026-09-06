import type { Trade } from '../types';
import { tradeValuesEqual } from './tradePatch';

export type BacktestTagCategory = 'setup' | 'mistake' | 'context';
export type BacktestTagStatus = 'active' | 'archived' | 'deleted' | 'merged';
export type BacktestTagField = 'tags' | 'htfConfluence' | 'ltfConfluence';
export interface BacktestLibraryTag {
  id: string; label: string; category: BacktestTagCategory; aliases: string[];
  status: BacktestTagStatus; mergedIntoId?: string;
}
export interface BacktestTagLibrary { version: 1; ownerId: string; revision: number; tags: BacktestLibraryTag[] }
export interface BacktestTagScope { tradeIds: string[]; fields: BacktestTagField[] }
export interface BacktestTagTradePatch { tradeId: string; expected: Partial<Trade>; updates: Partial<Trade> }
export interface BacktestTagCommitPlan {
  operationId: string; ownerId: string; kind: 'catalog' | 'merge';
  expectedLibrary: BacktestTagLibrary; library: BacktestTagLibrary;
  affectedTradeIds: string[]; tradePatches: BacktestTagTradePatch[];
  scope: BacktestTagScope; scopeSnapshots: Array<{ tradeId: string; expected: Partial<Trade> }>;
  skippedAutomatic: Array<{ tradeId: string; field: BacktestTagField; labels: string[] }>;
  sourceId?: string; targetId?: string;
}
export type BacktestTagLibraryChange =
  | { type: 'create'; tag: Pick<BacktestLibraryTag, 'id' | 'label' | 'category'> & { aliases?: string[] } }
  | { type: 'edit'; id: string; label: string; category: BacktestTagCategory; aliases: string[] }
  | { type: 'archive' | 'restore' | 'delete'; id: string };
export interface BacktestTagCommandContext { ownerId: string; expectedRevision: number; operationId: string }
export const BACKTEST_TAG_FIELDS: readonly BacktestTagField[] = ['tags', 'htfConfluence', 'ltfConfluence'];
export const BACKTEST_TAG_CATEGORIES: readonly BacktestTagCategory[] = ['setup', 'mistake', 'context'];
const statuses: readonly BacktestTagStatus[] = ['active', 'archived', 'deleted', 'merged'];
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const fail = (message: string): never => { throw new Error(message); };
export const normalizeBacktestTagLabel = (value: string): string => {
  if (typeof value !== 'string') return fail('Název tagu musí být text.');
  const label = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!label || label.length > 80 || label.includes(',')) return fail('Tag musí mít 1–80 znaků a nesmí obsahovat čárku.');
  return label;
};
// Unicode full-fold exceptions to simple lowercase, generated from Unicode 13.
// Explicit data keeps ß/SS, Greek final sigma and Cherokee aliases consistent.
const FULL_CASE_FOLD: Record<string, string> = {"\u00b5":"\u03bc","\u00df":"ss","\u0149":"\u02bcn","\u017f":"s","\u01f0":"j\u030c","\u0345":"\u03b9","\u0390":"\u03b9\u0308\u0301","\u03b0":"\u03c5\u0308\u0301","\u03c2":"\u03c3","\u03d0":"\u03b2","\u03d1":"\u03b8","\u03d5":"\u03c6","\u03d6":"\u03c0","\u03f0":"\u03ba","\u03f1":"\u03c1","\u03f5":"\u03b5","\u0587":"\u0565\u0582","\u13a0":"\u13a0","\u13a1":"\u13a1","\u13a2":"\u13a2","\u13a3":"\u13a3","\u13a4":"\u13a4","\u13a5":"\u13a5","\u13a6":"\u13a6","\u13a7":"\u13a7","\u13a8":"\u13a8","\u13a9":"\u13a9","\u13aa":"\u13aa","\u13ab":"\u13ab","\u13ac":"\u13ac","\u13ad":"\u13ad","\u13ae":"\u13ae","\u13af":"\u13af","\u13b0":"\u13b0","\u13b1":"\u13b1","\u13b2":"\u13b2","\u13b3":"\u13b3","\u13b4":"\u13b4","\u13b5":"\u13b5","\u13b6":"\u13b6","\u13b7":"\u13b7","\u13b8":"\u13b8","\u13b9":"\u13b9","\u13ba":"\u13ba","\u13bb":"\u13bb","\u13bc":"\u13bc","\u13bd":"\u13bd","\u13be":"\u13be","\u13bf":"\u13bf","\u13c0":"\u13c0","\u13c1":"\u13c1","\u13c2":"\u13c2","\u13c3":"\u13c3","\u13c4":"\u13c4","\u13c5":"\u13c5","\u13c6":"\u13c6","\u13c7":"\u13c7","\u13c8":"\u13c8","\u13c9":"\u13c9","\u13ca":"\u13ca","\u13cb":"\u13cb","\u13cc":"\u13cc","\u13cd":"\u13cd","\u13ce":"\u13ce","\u13cf":"\u13cf","\u13d0":"\u13d0","\u13d1":"\u13d1","\u13d2":"\u13d2","\u13d3":"\u13d3","\u13d4":"\u13d4","\u13d5":"\u13d5","\u13d6":"\u13d6","\u13d7":"\u13d7","\u13d8":"\u13d8","\u13d9":"\u13d9","\u13da":"\u13da","\u13db":"\u13db","\u13dc":"\u13dc","\u13dd":"\u13dd","\u13de":"\u13de","\u13df":"\u13df","\u13e0":"\u13e0","\u13e1":"\u13e1","\u13e2":"\u13e2","\u13e3":"\u13e3","\u13e4":"\u13e4","\u13e5":"\u13e5","\u13e6":"\u13e6","\u13e7":"\u13e7","\u13e8":"\u13e8","\u13e9":"\u13e9","\u13ea":"\u13ea","\u13eb":"\u13eb","\u13ec":"\u13ec","\u13ed":"\u13ed","\u13ee":"\u13ee","\u13ef":"\u13ef","\u13f0":"\u13f0","\u13f1":"\u13f1","\u13f2":"\u13f2","\u13f3":"\u13f3","\u13f4":"\u13f4","\u13f5":"\u13f5","\u13f8":"\u13f0","\u13f9":"\u13f1","\u13fa":"\u13f2","\u13fb":"\u13f3","\u13fc":"\u13f4","\u13fd":"\u13f5","\u1c80":"\u0432","\u1c81":"\u0434","\u1c82":"\u043e","\u1c83":"\u0441","\u1c84":"\u0442","\u1c85":"\u0442","\u1c86":"\u044a","\u1c87":"\u0463","\u1c88":"\ua64b","\u1e96":"h\u0331","\u1e97":"t\u0308","\u1e98":"w\u030a","\u1e99":"y\u030a","\u1e9a":"a\u02be","\u1e9b":"\u1e61","\u1e9e":"ss","\u1f50":"\u03c5\u0313","\u1f52":"\u03c5\u0313\u0300","\u1f54":"\u03c5\u0313\u0301","\u1f56":"\u03c5\u0313\u0342","\u1f80":"\u1f00\u03b9","\u1f81":"\u1f01\u03b9","\u1f82":"\u1f02\u03b9","\u1f83":"\u1f03\u03b9","\u1f84":"\u1f04\u03b9","\u1f85":"\u1f05\u03b9","\u1f86":"\u1f06\u03b9","\u1f87":"\u1f07\u03b9","\u1f88":"\u1f00\u03b9","\u1f89":"\u1f01\u03b9","\u1f8a":"\u1f02\u03b9","\u1f8b":"\u1f03\u03b9","\u1f8c":"\u1f04\u03b9","\u1f8d":"\u1f05\u03b9","\u1f8e":"\u1f06\u03b9","\u1f8f":"\u1f07\u03b9","\u1f90":"\u1f20\u03b9","\u1f91":"\u1f21\u03b9","\u1f92":"\u1f22\u03b9","\u1f93":"\u1f23\u03b9","\u1f94":"\u1f24\u03b9","\u1f95":"\u1f25\u03b9","\u1f96":"\u1f26\u03b9","\u1f97":"\u1f27\u03b9","\u1f98":"\u1f20\u03b9","\u1f99":"\u1f21\u03b9","\u1f9a":"\u1f22\u03b9","\u1f9b":"\u1f23\u03b9","\u1f9c":"\u1f24\u03b9","\u1f9d":"\u1f25\u03b9","\u1f9e":"\u1f26\u03b9","\u1f9f":"\u1f27\u03b9","\u1fa0":"\u1f60\u03b9","\u1fa1":"\u1f61\u03b9","\u1fa2":"\u1f62\u03b9","\u1fa3":"\u1f63\u03b9","\u1fa4":"\u1f64\u03b9","\u1fa5":"\u1f65\u03b9","\u1fa6":"\u1f66\u03b9","\u1fa7":"\u1f67\u03b9","\u1fa8":"\u1f60\u03b9","\u1fa9":"\u1f61\u03b9","\u1faa":"\u1f62\u03b9","\u1fab":"\u1f63\u03b9","\u1fac":"\u1f64\u03b9","\u1fad":"\u1f65\u03b9","\u1fae":"\u1f66\u03b9","\u1faf":"\u1f67\u03b9","\u1fb2":"\u1f70\u03b9","\u1fb3":"\u03b1\u03b9","\u1fb4":"\u03ac\u03b9","\u1fb6":"\u03b1\u0342","\u1fb7":"\u03b1\u0342\u03b9","\u1fbc":"\u03b1\u03b9","\u1fbe":"\u03b9","\u1fc2":"\u1f74\u03b9","\u1fc3":"\u03b7\u03b9","\u1fc4":"\u03ae\u03b9","\u1fc6":"\u03b7\u0342","\u1fc7":"\u03b7\u0342\u03b9","\u1fcc":"\u03b7\u03b9","\u1fd2":"\u03b9\u0308\u0300","\u1fd3":"\u03b9\u0308\u0301","\u1fd6":"\u03b9\u0342","\u1fd7":"\u03b9\u0308\u0342","\u1fe2":"\u03c5\u0308\u0300","\u1fe3":"\u03c5\u0308\u0301","\u1fe4":"\u03c1\u0313","\u1fe6":"\u03c5\u0342","\u1fe7":"\u03c5\u0308\u0342","\u1ff2":"\u1f7c\u03b9","\u1ff3":"\u03c9\u03b9","\u1ff4":"\u03ce\u03b9","\u1ff6":"\u03c9\u0342","\u1ff7":"\u03c9\u0342\u03b9","\u1ffc":"\u03c9\u03b9","\uab70":"\u13a0","\uab71":"\u13a1","\uab72":"\u13a2","\uab73":"\u13a3","\uab74":"\u13a4","\uab75":"\u13a5","\uab76":"\u13a6","\uab77":"\u13a7","\uab78":"\u13a8","\uab79":"\u13a9","\uab7a":"\u13aa","\uab7b":"\u13ab","\uab7c":"\u13ac","\uab7d":"\u13ad","\uab7e":"\u13ae","\uab7f":"\u13af","\uab80":"\u13b0","\uab81":"\u13b1","\uab82":"\u13b2","\uab83":"\u13b3","\uab84":"\u13b4","\uab85":"\u13b5","\uab86":"\u13b6","\uab87":"\u13b7","\uab88":"\u13b8","\uab89":"\u13b9","\uab8a":"\u13ba","\uab8b":"\u13bb","\uab8c":"\u13bc","\uab8d":"\u13bd","\uab8e":"\u13be","\uab8f":"\u13bf","\uab90":"\u13c0","\uab91":"\u13c1","\uab92":"\u13c2","\uab93":"\u13c3","\uab94":"\u13c4","\uab95":"\u13c5","\uab96":"\u13c6","\uab97":"\u13c7","\uab98":"\u13c8","\uab99":"\u13c9","\uab9a":"\u13ca","\uab9b":"\u13cb","\uab9c":"\u13cc","\uab9d":"\u13cd","\uab9e":"\u13ce","\uab9f":"\u13cf","\uaba0":"\u13d0","\uaba1":"\u13d1","\uaba2":"\u13d2","\uaba3":"\u13d3","\uaba4":"\u13d4","\uaba5":"\u13d5","\uaba6":"\u13d6","\uaba7":"\u13d7","\uaba8":"\u13d8","\uaba9":"\u13d9","\uabaa":"\u13da","\uabab":"\u13db","\uabac":"\u13dc","\uabad":"\u13dd","\uabae":"\u13de","\uabaf":"\u13df","\uabb0":"\u13e0","\uabb1":"\u13e1","\uabb2":"\u13e2","\uabb3":"\u13e3","\uabb4":"\u13e4","\uabb5":"\u13e5","\uabb6":"\u13e6","\uabb7":"\u13e7","\uabb8":"\u13e8","\uabb9":"\u13e9","\uabba":"\u13ea","\uabbb":"\u13eb","\uabbc":"\u13ec","\uabbd":"\u13ed","\uabbe":"\u13ee","\uabbf":"\u13ef","\ufb00":"ff","\ufb01":"fi","\ufb02":"fl","\ufb03":"ffi","\ufb04":"ffl","\ufb05":"st","\ufb06":"st","\ufb13":"\u0574\u0576","\ufb14":"\u0574\u0565","\ufb15":"\u0574\u056b","\ufb16":"\u057e\u0576","\ufb17":"\u0574\u056d"};
export const backtestTagKey = (value: string): string => Array.from(normalizeBacktestTagLabel(value))
  .map(char => FULL_CASE_FOLD[char] ?? char.toLowerCase()).join('').normalize('NFC');
const labels = (values: readonly string[]): string[] => {
  if (!Array.isArray(values)) return fail('Aliasy musí být seznam názvů.');
  const seen = new Set<string>();
  return values.map(normalizeBacktestTagLabel).filter(label => {
    const key = backtestTagKey(label); if (seen.has(key)) return false; seen.add(key); return true;
  });
};
const tagLabels = (tag: BacktestLibraryTag) => [tag.label, ...tag.aliases];
const destination = (tag: BacktestLibraryTag, byId: Map<string, BacktestLibraryTag>): BacktestLibraryTag => {
  const seen = new Set<string>(); let current = tag;
  while (current.status === 'merged') {
    if (seen.has(current.id)) return fail('Katalog tagů obsahuje cyklus sloučení.');
    seen.add(current.id);
    const next = byId.get(current.mergedIntoId ?? '');
    if (!next) return fail('Cílový tag sloučení chybí.');
    current = next;
  }
  return current;
};
export const createBacktestTagLibrary = (ownerId: string): BacktestTagLibrary => {
  if (!identity(ownerId)) return fail('Nejdřív přihlas vlastníka katalogu.');
  return { version: 1, ownerId, revision: 0, tags: [] };
};
/** Never repair malformed catalogs by removing unknown entries or aliases. */
export const validateBacktestTagLibrary = (library: BacktestTagLibrary): BacktestTagLibrary => {
  if (!library || library.version !== 1 || !identity(library.ownerId) || !Number.isSafeInteger(library.revision)
    || library.revision < 0 || !Array.isArray(library.tags) || library.tags.length > 500) return fail('Katalog tagů má neplatný formát.');
  const byId = new Map<string, BacktestLibraryTag>();
  for (const tag of library.tags) {
    if (!tag || !identity(tag.id) || byId.has(tag.id) || !BACKTEST_TAG_CATEGORIES.includes(tag.category)
      || !statuses.includes(tag.status) || !Array.isArray(tag.aliases) || tag.aliases.length > 32
      || normalizeBacktestTagLabel(tag.label) !== tag.label
      || !tradeValuesEqual(labels(tag.aliases), tag.aliases)
      || tag.aliases.some(alias => backtestTagKey(alias) === backtestTagKey(tag.label))
      || (tag.status === 'merged' ? !identity(tag.mergedIntoId) : tag.mergedIntoId !== undefined)) return fail('Tag obsahuje neplatnou identitu, název nebo aliasy.');
    byId.set(tag.id, tag);
  }
  const keys = new Map<string, string>();
  for (const tag of library.tags) {
    const terminal = destination(tag, byId);
    for (const label of tagLabels(tag)) {
      const key = backtestTagKey(label), existing = keys.get(key);
      if (existing && existing !== terminal.id) return fail(`Alias „${label}“ je nejednoznačný; patří více tagům.`);
      keys.set(key, terminal.id);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(library)).length > 1_048_576) return fail('Katalog překročil kapacitu 1 MiB. Původní katalog zůstává zachovaný.');
  return library;
};
export const resolveBacktestLibraryTag = (library: BacktestTagLibrary, label: string): BacktestLibraryTag | undefined => {
  validateBacktestTagLibrary(library);
  const key = backtestTagKey(label), byId = new Map(library.tags.map(tag => [tag.id, tag]));
  const found = library.tags.find(tag => tagLabels(tag).some(value => backtestTagKey(value) === key));
  return found ? structuredClone(destination(found, byId)) : undefined;
};
const authorize = (library: BacktestTagLibrary, context: BacktestTagCommandContext) => {
  if (!library || !identity(context.ownerId) || context.ownerId !== library.ownerId) fail('Katalog patří jinému uživateli.');
  validateBacktestTagLibrary(library);
  if (context.expectedRevision !== library.revision) fail('Katalog se mezitím změnil. Nejdřív načti aktuální verzi.');
  if (!identity(context.operationId)) fail('Změna katalogu nemá platné ID operace.');
};
const plan = (before: BacktestTagLibrary, next: BacktestTagLibrary, context: BacktestTagCommandContext): BacktestTagCommitPlan => {
  validateBacktestTagLibrary(next);
  return { operationId: context.operationId, ownerId: context.ownerId, kind: 'catalog',
    expectedLibrary: structuredClone(before), library: structuredClone(next), affectedTradeIds: [], tradePatches: [],
    scope: { tradeIds: [], fields: [] }, scopeSnapshots: [], skippedAutomatic: [] };
};
/** Metadata changes never rewrite historical trade strings. Delete is a catalog
 * tombstone: old labels retain their identity and cannot be reassigned silently. */
export const prepareBacktestTagLibraryChange = (
  library: BacktestTagLibrary, change: BacktestTagLibraryChange, context: BacktestTagCommandContext,
): BacktestTagCommitPlan => {
  authorize(library, context);
  if (!change || !['create', 'edit', 'archive', 'restore', 'delete'].includes(change.type)) return fail('Neznámá změna katalogu.');
  const next = structuredClone(library); next.revision += 1;
  if (change.type === 'create') {
    if (next.tags.some(tag => tag.id === change.tag.id)) return fail('ID tagu už existuje.');
    const label = normalizeBacktestTagLabel(change.tag.label);
    next.tags.push({ ...change.tag, label, aliases: labels(change.tag.aliases ?? []).filter(alias => backtestTagKey(alias) !== backtestTagKey(label)), status: 'active' });
  } else {
    const index = next.tags.findIndex(tag => tag.id === change.id);
    const current = next.tags[index];
    if (!current || current.status === 'merged') return fail('Tag chybí nebo už byl sloučen.');
    if (change.type === 'edit') {
      const label = normalizeBacktestTagLabel(change.label);
      next.tags[index] = { ...current, label, category: change.category,
        aliases: labels([...change.aliases, current.label]).filter(alias => backtestTagKey(alias) !== backtestTagKey(label)) };
    } else next.tags[index] = { ...current, status: change.type === 'archive' ? 'archived' : change.type === 'delete' ? 'deleted' : 'active' };
  }
  return plan(library, next, context);
};
const selectedTrades = (trades: readonly Trade[], scope: BacktestTagScope): Trade[] => {
  if (!Array.isArray(scope.tradeIds) || scope.tradeIds.length > 500 || new Set(scope.tradeIds).size !== scope.tradeIds.length
    || !Array.isArray(scope.fields) || new Set(scope.fields).size !== scope.fields.length
    || scope.fields.some(field => !BACKTEST_TAG_FIELDS.includes(field))) return fail('Rozsah sloučení není platný.');
  const byId = new Map<string, Trade>();
  for (const trade of trades) {
    const id = String(trade.id);
    if (byId.has(id)) return fail(`Obchod ${id} je v načteném seznamu duplicitně.`);
    byId.set(id, trade);
  }
  return scope.tradeIds.map(id => {
    const trade = byId.get(id);
    if (!trade) return fail(`Obchod ${id} není načtený. Náhled nelze považovat za úplný.`);
    if (!trade.backtestRunId || !trade.accountId) return fail(`Obchod ${id} nemá ověřenou backtest session a účet.`);
    return trade;
  });
};
const snapshot = (trade: Trade, fields: readonly BacktestTagField[]): Partial<Trade> => {
  const result: Partial<Trade> = { id: trade.id, accountId: trade.accountId, backtestRunId: trade.backtestRunId };
  for (const field of fields) {
    const value = trade[field];
    if (value !== undefined && (!Array.isArray(value) || value.some(label => typeof label !== 'string'))) return fail('Obchod má neplatný seznam tagů.');
    if (value !== undefined) result[field] = [...value];
  }
  if (fields.some(field => field !== 'tags') && trade.autoConfluence !== undefined) {
    if (!trade.autoConfluence || !Array.isArray(trade.autoConfluence.htf) || !Array.isArray(trade.autoConfluence.ltf)
      || [...trade.autoConfluence.htf, ...trade.autoConfluence.ltf].some(label => typeof label !== 'string')) return fail('Obchod má neplatný původ automatických tagů.');
    result.autoConfluence = structuredClone(trade.autoConfluence);
  }
  return result;
};
const keysFor = (library: BacktestTagLibrary, id: string): Set<string> => {
  const byId = new Map(library.tags.map(tag => [tag.id, tag]));
  return new Set(library.tags.filter(tag => destination(tag, byId).id === id).flatMap(tagLabels).map(backtestTagKey));
};
const existingKey = (label: string): string => {
  // Existing free-text tags may predate today's input limits. Never discard them.
  const normalized = label.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return Array.from(normalized).map(char => FULL_CASE_FOLD[char] ?? char.toLowerCase()).join('').normalize('NFC');
};
export const previewBacktestTagMerge = (
  library: BacktestTagLibrary, trades: readonly Trade[],
  input: BacktestTagCommandContext & { sourceId: string; targetId: string; scope: BacktestTagScope },
): BacktestTagCommitPlan => {
  authorize(library, input);
  const source = library.tags.find(tag => tag.id === input.sourceId), target = library.tags.find(tag => tag.id === input.targetId);
  if (!source || !target || source.id === target.id || source.status !== 'active' || target.status !== 'active') return fail('Vyber dva různé aktivní tagy.');
  const selected = selectedTrades(trades, input.scope);
  const next = structuredClone(library); next.revision += 1;
  next.tags = next.tags.map(tag => tag.id === source.id ? { ...tag, status: 'merged', mergedIntoId: target.id } : tag);
  const result = plan(library, next, input);
  Object.assign(result, { kind: 'merge', sourceId: source.id, targetId: target.id, scope: structuredClone(input.scope) });
  const sourceKeys = keysFor(library, source.id), targetKeys = keysFor(library, target.id), targetKey = backtestTagKey(target.label);
  for (const trade of selected) {
    const expected = snapshot(trade, input.scope.fields), updates: Partial<Trade> = {};
    result.scopeSnapshots.push({ tradeId: String(trade.id), expected });
    let nextAuto = trade.autoConfluence ? structuredClone(trade.autoConfluence) : undefined;
    for (const field of input.scope.fields) {
      const values = trade[field] ?? [], kind = field === 'htfConfluence' ? 'htf' : field === 'ltfConfluence' ? 'ltf' : null;
      const automatic = new Set(kind ? trade.autoConfluence?.[kind] ?? [] : []);
      const automaticSource = values.filter(label => automatic.has(label) && sourceKeys.has(existingKey(label)));
      if (automaticSource.length) result.skippedAutomatic.push({ tradeId: String(trade.id), field, labels: automaticSource });
      if (!values.some(label => !automatic.has(label) && sourceKeys.has(existingKey(label)))) continue;
      const mapped = values.map(label => !automatic.has(label) && (sourceKeys.has(existingKey(label)) || targetKeys.has(existingKey(label))) ? target.label : label);
      let emittedTarget = false;
      const merged = mapped.filter((label, index) => {
        if (existingKey(label) !== targetKey) return true;
        if (automatic.has(values[index])) return false; // Explicit manual target owns the resulting capsule.
        if (emittedTarget) return false;
        emittedTarget = true; return true;
      });
      if (!tradeValuesEqual(values, merged)) updates[field] = merged;
      if (kind && nextAuto) nextAuto = { ...nextAuto, [kind]: nextAuto[kind].filter(label => existingKey(label) !== targetKey) };
    }
    if (nextAuto && !tradeValuesEqual(nextAuto, trade.autoConfluence)) updates.autoConfluence = nextAuto;
    if (Object.keys(updates).length) {
      result.affectedTradeIds.push(String(trade.id));
      result.tradePatches.push({ tradeId: String(trade.id), expected: structuredClone(expected), updates });
    }
  }
  return result;
};

/** Recheck fresh, owner-filtered rows before committing. The parent must still
 * enforce owner + expected fields in the DB writes and use real library CAS.
 * A partially acknowledged batch may resume only where rows equal exact before
 * or after snapshots. This is NOT a cross-device transaction. */
export const validateBacktestTagCommitPlan = (
  prepared: BacktestTagCommitPlan, currentLibrary: BacktestTagLibrary, currentTrades: readonly Trade[], ownerId: string,
): { remainingTradePatches: BacktestTagTradePatch[]; libraryAlreadyApplied: boolean } => {
  if (!currentLibrary || ownerId !== prepared.ownerId || currentLibrary.ownerId !== ownerId) return fail('Uživatel se od vytvoření náhledu změnil.');
  validateBacktestTagLibrary(currentLibrary);
  const libraryAlreadyApplied = tradeValuesEqual(currentLibrary, prepared.library);
  if (!libraryAlreadyApplied && !tradeValuesEqual(currentLibrary, prepared.expectedLibrary)) return fail('Katalog se od náhledu změnil. Vytvoř nový náhled.');
  const selected = selectedTrades(currentTrades, prepared.scope), remainingTradePatches: BacktestTagTradePatch[] = [];
  for (const trade of selected) {
    const id = String(trade.id), captured = prepared.scopeSnapshots.find(item => item.tradeId === id);
    if (!captured) return fail('Náhled neobsahuje celý vybraný rozsah.');
    const now = snapshot(trade, prepared.scope.fields), patch = prepared.tradePatches.find(item => item.tradeId === id);
    const after = patch ? { ...captured.expected, ...patch.updates } : captured.expected;
    if (patch && tradeValuesEqual(now, after)) continue;
    if (!tradeValuesEqual(now, captured.expected)) return fail(`Tagy nebo původ obchodu ${id} se od náhledu změnily. Vytvoř nový náhled.`);
    if (patch) remainingTradePatches.push(structuredClone(patch));
  }
  return { remainingTradePatches, libraryAlreadyApplied };
};
