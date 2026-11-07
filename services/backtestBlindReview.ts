import { createBacktestRuntime } from './backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRun, type BacktestWorkspaceState } from './backtestTypes';
import type { ChartReplaySpeed } from './chartReplay';

export type BlindReviewChoice = 'Long' | 'Short' | 'Nebral' | 'Nevím';
export type BlindReviewPool = 'model' | 'no-fvg' | 'low-rr' | 'unfilled' | 'other' | 'touch' | 'random';
export type BlindReviewPhase = 'playing' | 'ask' | 'reveal';

export interface BlindReviewModel {
  dir: 1 | -1;
  kind: string;
  level: string;
  res: string;
  entry?: number;
  sl?: number;
  tp?: number | null;
  tpName?: string | null;
  rr?: number | null;
  risk?: number;
  r?: number | null;
  net?: number | null;
  fillMs?: number | null;
  endMs?: number | null;
}
export interface BlindReviewCase {
  id: string;
  day: string;
  openMs: number;
  stopMs: number;
  endMs: number;
  pool: BlindReviewPool;
  model: BlindReviewModel | null;
  touch: { kind: string; dir: number; level: string } | null;
  vote: { answer: BlindReviewChoice; why: string };
}
export interface BlindReviewAnswer { answer: BlindReviewChoice; text: string; answeredAt: number }
export interface BlindReviewMark { time: number; price: number | null; dir: 'Long' | 'Short'; text: string; at: number }
export interface BlindReviewDoc {
  id: string;
  name: string;
  cases: BlindReviewCase[];
  answers: Record<string, BlindReviewAnswer>;
  marks: Record<string, BlindReviewMark[]>;
}

const CHOICES: readonly BlindReviewChoice[] = ['Long', 'Short', 'Nebral', 'Nevím'];
const HISTORY_MS = 14 * 86_400_000;
const validCase = (value: BlindReviewCase) => Boolean(value)
  && typeof value.id === 'string' && value.id.length > 0
  && Number.isSafeInteger(value.openMs) && Number.isSafeInteger(value.stopMs) && Number.isSafeInteger(value.endMs)
  && value.openMs <= value.stopMs && value.stopMs < value.endMs
  && CHOICES.includes(value.vote?.answer);

export function parseBlindReviewRow(row: {
  id: string; name: string; cases: unknown; answers: unknown; marks: unknown;
}): BlindReviewDoc {
  const cases = row.cases as BlindReviewCase[];
  if (!Array.isArray(cases) || !cases.length || !cases.every(validCase) || new Set(cases.map(item => item.id)).size !== cases.length) {
    throw new Error('Sada slepého hodnocení je neplatná.');
  }
  return {
    id: row.id,
    name: row.name,
    cases,
    answers: (row.answers && typeof row.answers === 'object' ? row.answers : {}) as BlindReviewDoc['answers'],
    marks: (row.marks && typeof row.marks === 'object' ? row.marks : {}) as BlindReviewDoc['marks'],
  };
}

export const blindReviewProgress = (doc: BlindReviewDoc) => ({
  answered: doc.cases.filter(item => doc.answers[item.id]).length,
  total: doc.cases.length,
});

/** Další neodpovězený případ, null = sada je hotová. */
export const nextOpenBlindCase = (doc: BlindReviewDoc): BlindReviewCase | null =>
  doc.cases.find(item => !doc.answers[item.id]) ?? null;

/** Odpověď se zamyká: po odhalení výsledku už ji nejde změnit. */
export function answerBlindCase(doc: BlindReviewDoc, caseId: string, answer: BlindReviewChoice, text: string, now: number): BlindReviewDoc {
  if (!doc.cases.some(item => item.id === caseId)) throw new Error('Neznámý případ.');
  if (doc.answers[caseId]) throw new Error('Odpověď už je zamčená.');
  if (!CHOICES.includes(answer)) throw new Error('Neplatná odpověď.');
  return { ...doc, answers: { ...doc.answers, [caseId]: { answer, text: text.trim(), answeredAt: now } } };
}

export function addBlindMark(doc: BlindReviewDoc, caseId: string, mark: BlindReviewMark): BlindReviewDoc {
  if (doc.answers[caseId]) throw new Error('Po odpovědi už značky nejdou přidat, výsledek je známý.');
  return { ...doc, marks: { ...doc.marks, [caseId]: [...(doc.marks[caseId] ?? []), { ...mark, text: mark.text.trim() }] } };
}

export function blindCasePhase(item: BlindReviewCase, answered: boolean, cursorTime: number | null): BlindReviewPhase {
  if (answered) return 'reveal';
  return cursorTime !== null && cursorTime * 1_000 >= item.stopMs ? 'ask' : 'playing';
}

/** Před odpovědí replay nesmí za zastavení; ruční značka ho zastaví dřív. Po odpovědi běží volně. */
export function blindReplayStop(item: BlindReviewCase, answered: boolean, manualStop: number | null): number | undefined {
  if (answered) return undefined;
  const stop = item.stopMs / 1_000;
  return manualStop !== null ? Math.min(manualStop, stop) : stop;
}

/** Co by udělal model. Limit, který se nevyplnil, je pořád jeho rozhodnutí vstoupit. */
export function blindModelChoice(item: BlindReviewCase): BlindReviewChoice {
  if ((item.pool === 'model' || item.pool === 'unfilled') && item.model) return item.model.dir > 0 ? 'Long' : 'Short';
  return 'Nebral';
}

const KIND: Record<string, string> = { sweep: 'sweep', pruraz: 'průraz' };
export function blindModelText(item: BlindReviewCase): string {
  if (item.pool === 'random') return 'Náhodné zastavení, model tady nic nemá.';
  if (item.pool === 'touch' && item.touch) return `Model viděl ${KIND[item.touch.kind] ?? item.touch.kind} ${item.touch.level}, ale bez zlomu na vstup.`;
  const model = item.model;
  if (!model) return 'Model tady nic nemá.';
  const head = `${model.dir > 0 ? 'long' : 'short'}, ${KIND[model.kind] ?? model.kind} ${model.level}`;
  switch (model.res) {
    case 'no-fvg': return `Model by nevzal (${head}): po zlomu nebyla FVG.`;
    case 'low-rr': return `Model by nevzal (${head}): nejbližší protější level je pod 1 R.`;
    case 'no-fill': return `Model by dal limit (${head}), ale do konce okna se nevyplnil.`;
    case 'tp-before-fill': return `Model by dal limit (${head}), ale cena došla na cíl dřív než na vstup.`;
    case 'no-tp': return `Model by nevzal (${head}): za vstupem není protější level.`;
    case 'bad-sl': return `Model by nevzal (${head}): nejde postavit SL.`;
    default: return `Model by vzal: ${head}.`;
  }
}

export function blindResultLabel(model: BlindReviewModel): string {
  return ({ win: 'TP', loss: 'SL', cutoff: 'Konec dne', 'tp-under-entry': 'TP za vstupem' } as Record<string, string>)[model.res] ?? model.res;
}

/** Dočasná session jednoho případu: skutečný Backtest, ale nic se z ní neukládá. */
export function buildBlindScratchRun(item: BlindReviewCase, workspaceState: BacktestWorkspaceState | null, speed: ChartReplaySpeed): BacktestRun {
  const now = Date.now();
  const openSeconds = item.openMs / 1_000;
  return {
    id: `blind-${item.id}`,
    accountId: 'blind-review',
    name: 'Slepé hodnocení',
    status: 'paused',
    initialCapital: 50_000,
    baseCurrency: 'USD',
    startAt: item.openMs - HISTORY_MS,
    endAt: item.endMs,
    executionSymbol: 'MNQ',
    replayInterval: '1m',
    cursorAt: item.openMs,
    config: { ...DEFAULT_BACKTEST_CONFIG, instruments: ['MNQ'] },
    workspaceState: workspaceState ?? { layoutId: '1' },
    runtimeState: {
      ...createBacktestRuntime(50_000),
      maxRevealedTime: openSeconds,
      replay: { phase: 'active', cursorTime: openSeconds, startTime: openSeconds, playing: false, speed, stepMinutes: 1 },
    },
    revision: 0,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  } as BacktestRun;
}
