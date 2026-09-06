import type { MarketCandle } from './marketData';
import type { BacktestInstrument, BacktestRuntimeState } from './backtestTypes';

export type BacktestDecisionAction = 'taken' | 'skipped' | 'missed' | 'no-setup';
export type BacktestResearchKind = 'decision' | 'note' | 'bookmark' | 'prep' | 'debrief';
export type BacktestNotePhase = 'before' | 'during' | 'after';
export interface BacktestResearchContext {
  runId: string;
  instrument: BacktestInstrument;
  /** Last revealed bar-open timestamp, UTC seconds. */
  marketTime: number;
  /** Persistent observation history; missing legacy evidence remains unknown. */
  knowledgeHorizonTime: number | null;
  knowledgeState: 'current' | 'rewound' | 'unknown';
  bar: MarketCandle | null;
  positionIds: string[];
  pendingOrderIds: string[];
  closedTradeIds: string[];
  hasExecutionHistory: boolean;
  /** True only when a run has been explicitly completed. */
  runCompleted: boolean;
}
export interface BacktestResearchRevision {
  id: string;
  revisionId: string;
  opId?: string;
  operationFingerprint?: string;
  /** Client-supplied audit clock, not a server attestation. */
  clockSource?: 'client';
  previousRevisionId?: string;
  revision: number;
  kind: BacktestResearchKind;
  action?: BacktestDecisionAction;
  phase?: BacktestNotePhase;
  title: string;
  text: string;
  tags: string[];
  /** Context and firstRecordedAt are immutable across edits. */
  context: BacktestResearchContext;
  firstRecordedAt: number;
  recordedAt: number;
  revisionMarketTime: number;
  retrospective: boolean;
  phaseVerified: boolean;
  archived: boolean;
  screenshotDataUrl?: string;
}
export interface BacktestResearchJournal { version: 1; revisions: BacktestResearchRevision[] }
export interface BacktestResearchDraft {
  kind: BacktestResearchKind;
  action?: BacktestDecisionAction;
  phase?: BacktestNotePhase;
  title?: string;
  text?: string;
  tags?: readonly string[];
  screenshotDataUrl?: string;
}
const actions = new Set<BacktestDecisionAction>(['taken', 'skipped', 'missed', 'no-setup']);
const kinds = new Set<BacktestResearchKind>(['decision', 'note', 'bookmark', 'prep', 'debrief']);
const phases = new Set<BacktestNotePhase>(['before', 'during', 'after']);
const clean = (value: string | undefined, max: number) => {
  if (value !== undefined && typeof value !== 'string') throw new Error('Text musí být řetězec.');
  const text = value?.trim() ?? '';
  if (text.length > max) throw new Error(`Text překračuje limit ${max.toLocaleString('cs')} znaků.`);
  return text;
};
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value;
const stamp = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(identity) && new Set(value).size === value.length;
const canonical = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
/** Local retry token, not a cryptographic signature or trustworthy server time. */
const fingerprint = (value: unknown): string => {
  const text = canonical(value); let left = 0x811c9dc5; let right = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) { left = Math.imul(left ^ text.charCodeAt(i), 0x01000193); right = Math.imul(right ^ text.charCodeAt(i), 0x85ebca6b); }
  return `${(left >>> 0).toString(16)}:${(right >>> 0).toString(16)}`;
};
const validBar = (bar: MarketCandle) => bar && [bar.time,bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)
  && bar.volume >= 0 && bar.high >= Math.max(bar.open,bar.close) && bar.low <= Math.min(bar.open,bar.close);
const validContext = (context: BacktestResearchContext) => context && identity(context.runId)
  && ['MNQ','NQ'].includes(context.instrument) && Number.isFinite(context.marketTime) && context.marketTime >= 0
  && (context.bar === null || (validBar(context.bar) && context.bar.time <= context.marketTime))
  && strings(context.positionIds) && strings(context.pendingOrderIds) && strings(context.closedTradeIds)
  && typeof context.hasExecutionHistory === 'boolean' && typeof context.runCompleted === 'boolean'
  && (context.hasExecutionHistory || !context.positionIds.length && !context.pendingOrderIds.length && !context.closedTradeIds.length)
  && (context.knowledgeHorizonTime === null
    ? context.knowledgeState === 'unknown'
    : Number.isFinite(context.knowledgeHorizonTime) && context.knowledgeHorizonTime >= context.marketTime
      && context.knowledgeState === (context.knowledgeHorizonTime > context.marketTime ? 'rewound' : 'current'));
const assertSize = (journal: BacktestResearchJournal) => {
  if (new TextEncoder().encode(JSON.stringify(journal)).length > 5_000_000) throw new Error('Deník této session dosáhl limitu 5 MB. Exportuj jej; nový zápis zatím nebyl uložen.');
};
const screenshot = (value?: string) => {
  if (!value) return undefined;
  if (typeof value !== 'string' || value.length > 700_000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('Snapshot musí být PNG, JPEG nebo WebP do přibližně 500 kB.');
  return value;
};
const phaseEvidence = (draft: BacktestResearchDraft, context: BacktestResearchContext) => {
  const phase = draft.kind === 'prep' ? 'before' : draft.kind === 'debrief' ? 'after' : draft.phase;
  const current = context.knowledgeState === 'current';
  const verified = current && (phase === 'before' ? !context.hasExecutionHistory
    : phase === 'during' ? context.positionIds.length > 0
      : phase === 'after' ? draft.kind === 'debrief' ? context.runCompleted && context.positionIds.length === 0
        : context.closedTradeIds.length > 0 && context.positionIds.length === 0 : false);
  return { phase, phaseVerified: phase ? verified : false, retrospective: !current || Boolean(phase && !verified) };
};
const normalized = (draft: BacktestResearchDraft) => {
  if (!draft || !kinds.has(draft.kind) || (draft.kind === 'decision' && !actions.has(draft.action!))
    || (draft.kind !== 'decision' && draft.action !== undefined)
    || (draft.phase !== undefined && !phases.has(draft.phase)) || (draft.tags !== undefined && !Array.isArray(draft.tags))) throw new Error('Neplatný druh rozhodnutí nebo fáze poznámky.');
  const tags = [...new Set((draft.tags ?? []).map(tag => clean(tag,80)).filter(Boolean))];
  if (tags.length > 30) throw new Error('Zápis může mít nejvýše 30 tagů.');
  return { kind: draft.kind, ...(draft.kind === 'decision' ? { action: draft.action } : {}),
    title: clean(draft.title,120), text: clean(draft.text,20_000), tags,
    ...(draft.screenshotDataUrl ? { screenshotDataUrl: screenshot(draft.screenshotDataUrl) } : {}) };
};
const validateJournal = (journal?: BacktestResearchJournal): Map<string,BacktestResearchRevision> => {
  const latest = new Map<string,BacktestResearchRevision>();
  if (!journal) return latest;
  if (journal.version !== 1 || !Array.isArray(journal.revisions)) throw new Error('Neznámá verze rozhodovacího deníku.');
  assertSize(journal);
  const revisions = new Set<string>(); const operations = new Set<string>(); let runId: string | undefined;
  for (const record of journal.revisions) {
    if (!record || !identity(record.id) || !identity(record.revisionId) || revisions.has(record.revisionId)
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || !validContext(record.context)
      || !stamp(record.recordedAt) || !stamp(record.firstRecordedAt) || record.recordedAt < record.firstRecordedAt
      || !Number.isFinite(record.revisionMarketTime) || typeof record.archived !== 'boolean'
      || typeof record.retrospective !== 'boolean' || typeof record.phaseVerified !== 'boolean'
      || (record.clockSource !== undefined && record.clockSource !== 'client')) throw new Error('Poškozená historie rozhodovacího deníku.');
    const fields = normalized(record);
    if (canonical(fields.tags) !== canonical(record.tags) || fields.title !== record.title || fields.text !== record.text
      || (record.phase !== undefined && !phases.has(record.phase))) throw new Error('Neplatný obsah historické revize.');
    if (runId !== undefined && runId !== record.context.runId) throw new Error('Deník obsahuje více sessions.');
    runId = record.context.runId;
    if (record.opId !== undefined) {
      if (!identity(record.opId) || operations.has(record.opId) || typeof record.operationFingerprint !== 'string') throw new Error('Duplicitní nebo neplatná operace deníku.');
      operations.add(record.opId);
    }
    const parent = latest.get(record.id);
    if (!parent) {
      const evidence = phaseEvidence(record,record.context);
      if (record.revision !== 1 || record.previousRevisionId !== undefined || record.firstRecordedAt !== record.recordedAt
        || record.revisionMarketTime !== record.context.marketTime || record.phase !== evidence.phase
        || record.phaseVerified !== evidence.phaseVerified || record.retrospective !== evidence.retrospective) throw new Error('Neplatný počátek historie zápisu.');
    } else if (record.revision !== parent.revision + 1 || record.previousRevisionId !== parent.revisionId
      || record.recordedAt < parent.recordedAt || record.firstRecordedAt !== parent.firstRecordedAt
      || canonical(record.context) !== canonical(parent.context) || record.kind !== parent.kind || record.phase !== parent.phase
      || !record.retrospective || record.phaseVerified || record.screenshotDataUrl !== undefined) throw new Error('Narušená návaznost nebo původní kontext revize.');
    revisions.add(record.revisionId); latest.set(record.id,record);
  }
  return latest;
};
const operation = (journal: BacktestResearchJournal | undefined, opId: string, hash: string) => {
  if (!identity(opId)) throw new Error('Neplatné ID operace.');
  const existing = journal?.revisions.find(record => record.opId === opId);
  if (existing && existing.operationFingerprint !== hash) throw new Error('ID operace už patří jinému záměru.');
  return existing;
};
const result = (journal: BacktestResearchJournal, record: BacktestResearchRevision) => ({ journal: structuredClone(journal), record: structuredClone(record) });

/** Immutable known-state capture; certified observation history survives rewind. */
export function captureBacktestResearchContext(input: {
  runId: string; instrument: BacktestInstrument; runtime: BacktestRuntimeState;
  candles: readonly MarketCandle[]; runCompleted: boolean;
}): BacktestResearchContext {
  const time = input.runtime.replay.cursorTime;
  if (time === null || !Number.isFinite(time)) throw new Error('Nejdřív zvol čas v replayi.');
  let bar: MarketCandle | null = null;
  for (const candle of input.candles) {
    if (candle.time <= time && (!bar || candle.time > bar.time)) bar = candle;
  }
  const max = input.runtime.maxRevealedTime;
  const horizon = typeof max === 'number' && Number.isFinite(max) && max >= 0 ? Math.max(max,time) : null;
  const context: BacktestResearchContext = {
    runId: input.runId, instrument: input.instrument, marketTime: time,
    knowledgeHorizonTime: horizon, knowledgeState: horizon === null ? 'unknown' : horizon > time ? 'rewound' : 'current',
    bar: bar ? { time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume } : null,
    positionIds: [...new Set(input.runtime.positions.filter(position => position.instrument === input.instrument).map(position => position.positionId).filter((id): id is string => Boolean(id)))],
    pendingOrderIds: input.runtime.orders.filter(order => order.instrument === input.instrument && order.status === 'pending').map(order => order.id),
    closedTradeIds: input.runtime.closedTrades.filter(trade => trade.instrument === input.instrument && trade.exitTime <= time).map(trade => trade.id),
    hasExecutionHistory: Boolean(input.runtime.positions.length || input.runtime.orders.length || input.runtime.fills.length || input.runtime.closedTrades.length),
    runCompleted: input.runCompleted,
  };
  if (!validContext(context)) throw new Error('Neplatný kontext replaye.');
  return structuredClone(context);
}
export function latestBacktestResearch(journal?: BacktestResearchJournal, includeArchived = false): BacktestResearchRevision[] {
  const latest = [...validateJournal(journal).values()].filter(item => includeArchived || !item.archived);
  return latest.map(record => {
    const initial = journal!.revisions.find(item => item.id === record.id && item.revision === 1);
    // Presentation only: the screenshot stays physically stored on revision 1.
    return structuredClone({ ...record, ...(initial?.screenshotDataUrl ? { screenshotDataUrl: initial.screenshotDataUrl } : {}) });
  });
}
export function appendBacktestResearch(
  previous: BacktestResearchJournal | undefined, draft: BacktestResearchDraft,
  context: BacktestResearchContext, recordedAt = Date.now(), opId: string = crypto.randomUUID(),
): { journal: BacktestResearchJournal; record: BacktestResearchRevision } {
  validateJournal(previous);
  if (!validContext(context) || !stamp(recordedAt)) throw new Error('Neplatný čas nebo kontext rozhodnutí.');
  if (previous?.revisions.some(item => item.context.runId !== context.runId)) throw new Error('Deník patří jiné session.');
  const fields = normalized(draft);
  const hash = fingerprint({ kind:'append',runId:context.runId,instrument:context.instrument,fields,phase:draft.phase });
  const existing = operation(previous,opId,hash);
  if (existing) return result(previous!,existing);
  const record: BacktestResearchRevision = { ...fields,...phaseEvidence(draft,context),
    id:crypto.randomUUID(),revisionId:crypto.randomUUID(),opId,operationFingerprint:hash,clockSource:'client',revision:1,
    context:structuredClone(context),firstRecordedAt:recordedAt,recordedAt,revisionMarketTime:context.marketTime,archived:false };
  const journal: BacktestResearchJournal = { version:1,revisions:[...previous?.revisions ?? [],record] };
  assertSize(journal); return result(journal,record);
}
export function reviseBacktestResearch(input: {
  journal:BacktestResearchJournal;id:string;expectedRevisionId:string;
  patch:Partial<Pick<BacktestResearchDraft,'action'|'title'|'text'|'tags'>> & { archived?:boolean };
  context:BacktestResearchContext;recordedAt?:number;opId?:string;
}): { journal:BacktestResearchJournal;record:BacktestResearchRevision } {
  const latest = validateJournal(input.journal);
  const current = latest.get(input.id);
  const recordedAt = input.recordedAt ?? Date.now();
  if (!current || !validContext(input.context) || input.context.runId !== current.context.runId
    || !stamp(recordedAt)) throw new Error('Neplatný čas nebo session revize.');
  if (!input.patch || Object.keys(input.patch).some(key => !['action','title','text','tags','archived'].includes(key))
    || (input.patch.archived !== undefined && typeof input.patch.archived !== 'boolean')) throw new Error('Revize smí změnit pouze obsah a archivaci zápisu.');
  const patch = Object.fromEntries(Object.entries(input.patch).filter(([,value]) => value !== undefined));
  const hash = fingerprint({ kind:'revise',id:input.id,previous:input.expectedRevisionId,patch });
  const opId = input.opId ?? crypto.randomUUID();
  const existing = operation(input.journal,opId,hash);
  if (existing) return result(input.journal,existing);
  if (current.revisionId !== input.expectedRevisionId) throw new Error('Zápis mezitím změnilo jiné okno. Tvůj návrh zůstal otevřený; porovnej poslední revizi.');
  if (recordedAt < current.recordedAt) throw new Error('Klientské auditní hodiny se vrátily zpět.');
  const fields = normalized({ ...current,...patch,kind:current.kind,screenshotDataUrl:undefined });
  const { screenshotDataUrl: _snapshot, ...withoutScreenshot } = current;
  const record:BacktestResearchRevision = { ...withoutScreenshot,...fields,revision:current.revision + 1,
    revisionId:crypto.randomUUID(),previousRevisionId:current.revisionId,opId,operationFingerprint:hash,clockSource:'client',
    context:structuredClone(current.context),
    recordedAt,revisionMarketTime:input.context.marketTime,retrospective:true,phaseVerified:false,archived:input.patch.archived ?? current.archived };
  const journal:BacktestResearchJournal = { version:1,revisions:[...input.journal.revisions,record] };
  assertSize(journal); return result(journal,record);
}
export function backtestDecisionSummary(journal?:BacktestResearchJournal) {
  const entries = latestBacktestResearch(journal).filter(item => item.kind === 'decision');
  return { total:entries.length,taken:entries.filter(item => item.action === 'taken').length,
    skipped:entries.filter(item => item.action === 'skipped').length,missed:entries.filter(item => item.action === 'missed').length,
    noSetup:entries.filter(item => item.action === 'no-setup').length,
    collection:'manual' as const,limitation:'Počty zahrnují jen ručně zaznamenané situace; nejde o všechny příležitosti trhu.' };
}
