import type { LabExperiment, Trade } from '../types';
import type { BacktestRun } from './backtestTypes';
import { canonicalBacktestEvidence, hashBacktestEvidence } from './backtestEvidenceIdentity';

export interface ResearchDateWindow { from: string; through: string }
export interface BacktestResearchRule {
  hypothesis: string; rule: string; falsification: string; targetPositions: number;
  timeZone: string; development?: ResearchDateWindow; validation?: ResearchDateWindow;
}
export interface BacktestRuleRevision {
  id: string; version: number; parentId?: string; recordedAt: number | null;
  source: 'created' | 'edited' | 'legacy-import'; reason: string;
  definition: BacktestResearchRule; hash: string;
}
export interface BacktestResearchCase { version: 1; revisions: BacktestRuleRevision[] }
export interface BacktestResearchBinding {
  version: 1; id: string; experimentId: string; revisionId: string; revisionHash: string;
  /** Captured rule text stays in the owner-only run, never the social Trade JSON. */
  definition: BacktestResearchRule; boundAt: number;
  role: 'development' | 'validation'; marketStart: number; marketEnd: number;
  exposureAtBinding: 'already-observed' | 'unknown' | 'no-known-exposure';
  exposureReasons: string[]; priorRunIds: string[];
}
export type BacktestResearchTradeReference = Pick<BacktestResearchBinding, 'id' | 'experimentId' | 'revisionId' | 'revisionHash' | 'role'>;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const time = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
const text = (value: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Vyplň text do ${max} znaků.`);
  return value.trim();
};
const date = (value: string) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
};
const windowValid = (value: ResearchDateWindow) => value && date(value.from) && date(value.through) && value.from <= value.through;
export function validateResearchRule(input: BacktestResearchRule): BacktestResearchRule {
  if (!input || !Number.isSafeInteger(input.targetPositions) || input.targetPositions < 5 || input.targetPositions > 100000) throw new Error('Cílový vzorek musí být 5–100 000 pozic.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(0); } catch { throw new Error('Neplatné časové pásmo výzkumu.'); }
  if (!input.timeZone || (input.development && !windowValid(input.development)) || (input.validation && !windowValid(input.validation))) throw new Error('Zkontroluj rozsah vývojového a ověřovacího vzorku.');
  if (input.development && input.validation && input.development.from <= input.validation.through && input.validation.from <= input.development.through) throw new Error('Vývojový a ověřovací vzorek se nesmějí překrývat.');
  return { hypothesis: text(input.hypothesis, 10000), rule: text(input.rule, 20000), falsification: text(input.falsification, 10000), targetPositions: input.targetPositions,
    timeZone: input.timeZone, ...(input.development ? { development: { ...input.development } } : {}), ...(input.validation ? { validation: { ...input.validation } } : {}) };
}
export async function validateResearchCase(value: BacktestResearchCase): Promise<void> {
  if (!value || value.version !== 1 || !Array.isArray(value.revisions) || !value.revisions.length || value.revisions.length > 500) throw new Error('Neplatná historie pravidel.');
  if (new TextEncoder().encode(canonicalBacktestEvidence(value)).byteLength > 2 * 1024 * 1024) throw new Error('Historie pravidel přesáhla limit 2 MiB.');
  const ids = new Set<string>(); let previous: BacktestRuleRevision | undefined;
  for (const revision of value.revisions) {
    if (!id(revision.id) || ids.has(revision.id) || revision.version !== (previous?.version ?? 0) + 1 || revision.parentId !== previous?.id
      || !['created', 'edited', 'legacy-import'].includes(revision.source)
      || (revision.source === 'legacy-import' ? previous !== undefined || revision.recordedAt !== null : !time(revision.recordedAt!))
      || (previous?.recordedAt != null && revision.recordedAt! < previous.recordedAt)
      || (previous && revision.source !== 'edited') || (!previous && revision.source === 'edited')) throw new Error('Historie pravidel má porušenou návaznost.');
    const normalized = validateResearchRule(revision.definition);
    if (canonicalBacktestEvidence(normalized) !== canonicalBacktestEvidence(revision.definition)
      || revision.hash !== await hashBacktestEvidence(normalized)) throw new Error('Obsah verze pravidel neodpovídá otisku.');
    text(revision.reason, 1000); ids.add(revision.id); previous = revision;
  }
}
export async function appendResearchRule(input: { previous?: BacktestResearchCase; expectedHeadId?: string;
  definition: BacktestResearchRule; reason: string; recordedAt: number; operationId: string;
  legacy?: Pick<LabExperiment, 'hypothesis' | 'rule' | 'targetTrades'>;
}): Promise<BacktestResearchCase> {
  if (!id(input.operationId) || !time(input.recordedAt)) throw new Error('Chybí platná identita nebo čas změny pravidla.');
  const definition = validateResearchRule(input.definition); const reason = text(input.reason, 1000);
  const revisions = structuredClone(input.previous?.revisions ?? []);
  if (input.previous) await validateResearchCase(input.previous);
  const existing = revisions.find(revision => revision.id === input.operationId);
  const hash = await hashBacktestEvidence(definition);
  if (existing) {
    if (existing.hash !== hash || existing.reason !== reason || existing.recordedAt !== input.recordedAt
      || existing.parentId !== (input.legacy && input.expectedHeadId === undefined ? `${input.operationId}-legacy` : input.expectedHeadId)) throw new Error('Operace už patří jiné změně pravidel.');
    return structuredClone(input.previous!);
  }
  if (revisions.at(-1)?.id !== input.expectedHeadId) throw new Error('Pravidlo se mezitím změnilo. Návrh zůstává otevřený.');
  if (!revisions.length && input.legacy) {
    const legacyDefinition = validateResearchRule({ hypothesis: input.legacy.hypothesis?.trim() || 'Původní hypotéza nebyla zapsaná.', rule: input.legacy.rule,
      falsification: 'Původní kritérium vyvrácení nebylo zaznamenané.', targetPositions: Math.max(5, input.legacy.targetTrades || 20), timeZone: definition.timeZone });
    revisions.push({ id: `${input.operationId}-legacy`, version: 1, recordedAt: null, source: 'legacy-import', reason: 'Zachování původního pravidla; čas jeho poslední změny není doložen.', definition: legacyDefinition, hash: await hashBacktestEvidence(legacyDefinition) });
  }
  const previous = revisions.at(-1);
  if (previous?.recordedAt != null && input.recordedAt < previous.recordedAt) throw new Error('Čas zařízení je starší než poslední uložená verze.');
  revisions.push({ id: input.operationId, version: (previous?.version ?? 0) + 1, ...(previous ? { parentId: previous.id } : {}), recordedAt: input.recordedAt,
    source: previous ? 'edited' : 'created', reason, definition, hash });
  const result: BacktestResearchCase = { version: 1, revisions };
  await validateResearchCase(result); return result;
}
const day = (millis: number, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(millis);
/** Evidence in this app, not proof of everything a person has seen elsewhere. */
export function researchExposureAtBinding(input: { marketStart: number; marketEnd: number; runs: readonly BacktestRun[]; trades: readonly Trade[]; historyComplete: boolean }) {
  const reasons = new Set<string>(); const priorRunIds = new Set<string>(); let observed = false;
  if (!input.historyComplete) reasons.add('Seznam předchozích zobrazení není úplný.');
  for (const run of input.runs) {
    const max = run.runtimeState.maxRevealedTime;
    if (run.endAt < input.marketStart || run.startAt > input.marketEnd) continue;
    if (max === undefined || !Number.isFinite(max) || max < 0) { reasons.add('Překrývající se starší session nemá úplnou historii odhalení.'); priorRunIds.add(run.id); continue; }
    if (Math.max(max, run.runtimeState.replay.cursorTime ?? 0) * 1000 >= input.marketStart) { observed = true; priorRunIds.add(run.id); reasons.add('Ve stejném období už byl odhalen trh v jiné session.'); }
  }
  for (const trade of input.trades) {
    const start = Number.isFinite(trade.entryTime) ? trade.entryTime! : trade.timestamp;
    if (start <= input.marketEnd && trade.timestamp >= input.marketStart) { observed = true; reasons.add('V tomto období už existuje známý obchod nebo jeho výsledek.'); if (trade.backtestRunId) priorRunIds.add(trade.backtestRunId); }
  }
  return { status: observed ? 'already-observed' as const : reasons.size ? 'unknown' as const : 'no-known-exposure' as const, reasons: [...reasons], priorRunIds: [...priorRunIds].sort() };
}
export async function bindResearchRule(input: { experiment: LabExperiment; revisionId: string; role: BacktestResearchBinding['role']; marketStart: number; marketEnd: number;
  recordedAt: number; operationId: string; runs: readonly BacktestRun[]; trades: readonly Trade[]; historyComplete: boolean }): Promise<BacktestResearchBinding> {
  if (input.experiment.world !== 'backtest' || !input.experiment.research) throw new Error('Vyber výzkumnou verzi backtest pravidel.');
  await validateResearchCase(input.experiment.research);
  const revision = input.experiment.research.revisions.find(item => item.id === input.revisionId);
  if (!revision || revision.recordedAt === null) throw new Error('Tuto starší verzi bez doloženého času nelze použít pro nový ověřovací průchod.');
  if (!time(input.recordedAt) || input.recordedAt < revision.recordedAt || !id(input.operationId)
    || !time(input.marketStart) || !time(input.marketEnd) || input.marketEnd < input.marketStart || !['development','validation'].includes(input.role)) throw new Error('Neplatný čas nebo identita výzkumné session.');
  const plan = revision.definition[input.role];
  if (input.role === 'validation' && !plan) throw new Error('Pro tuto verzi nejdřív stanov ověřovací období.');
  if (plan && (day(input.marketStart, revision.definition.timeZone) < plan.from || day(input.marketEnd, revision.definition.timeZone) > plan.through)) throw new Error('Session leží mimo zvolený výzkumný vzorek v jeho časovém pásmu.');
  const exposure = researchExposureAtBinding(input);
  return { version: 1, id: input.operationId, experimentId: input.experiment.id, revisionId: revision.id, revisionHash: revision.hash,
    definition: structuredClone(revision.definition), boundAt: input.recordedAt, role: input.role, marketStart: input.marketStart, marketEnd: input.marketEnd,
    exposureAtBinding: exposure.status, exposureReasons: exposure.reasons, priorRunIds: exposure.priorRunIds };
}
export const researchTradeReference = (binding?: BacktestResearchBinding): BacktestResearchTradeReference | undefined => binding
  ? { id: binding.id, experimentId: binding.experimentId, revisionId: binding.revisionId, revisionHash: binding.revisionHash, role: binding.role } : undefined;
