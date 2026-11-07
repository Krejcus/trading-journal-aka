import { describe, expect, it } from 'vitest';
import {
  addBlindMark, answerBlindCase, blindCasePhase, blindModelChoice, blindModelText, blindReplayStop, blindReviewProgress,
  buildBlindScratchRun, nextOpenBlindCase, parseBlindReviewRow, type BlindReviewCase, type BlindReviewDoc,
} from '../services/backtestBlindReview';
import { clampReplayToStop, DEFAULT_CHART_REPLAY_STATE } from '../services/chartReplay';

const base = (id: string, patch: Partial<BlindReviewCase> = {}): BlindReviewCase => ({
  id, day: '2026-07-10', openMs: 1_000_000_000, stopMs: 1_000_600_000, endMs: 1_020_000_000, pool: 'random',
  model: null, touch: null, vote: { answer: 'Nebral', why: 'x' }, ...patch,
});
const doc = (cases: BlindReviewCase[]): BlindReviewDoc => ({ id: 'd', name: 'S', cases, answers: {}, marks: {} });

describe('backtest blind review', () => {
  it('nepustí neplatnou sadu', () => {
    expect(() => parseBlindReviewRow({ id: 'd', name: 'S', cases: [], answers: {}, marks: {} })).toThrow();
    expect(() => parseBlindReviewRow({ id: 'd', name: 'S', cases: [base('a'), base('a')], answers: {}, marks: {} })).toThrow();
    expect(() => parseBlindReviewRow({ id: 'd', name: 'S', cases: [base('a', { stopMs: 1 })], answers: {}, marks: {} })).toThrow();
    expect(parseBlindReviewRow({ id: 'd', name: 'S', cases: [base('a')], answers: null, marks: null }).answers).toEqual({});
  });

  it('odpověď se zamyká a další případ je první neodpovězený', () => {
    const first = doc([base('a'), base('b')]);
    expect(nextOpenBlindCase(first)?.id).toBe('a');
    const answered = answerBlindCase(first, 'a', 'Long', '  proč ', 5);
    expect(answered.answers.a).toEqual({ answer: 'Long', text: 'proč', answeredAt: 5 });
    expect(first.answers).toEqual({});
    expect(nextOpenBlindCase(answered)?.id).toBe('b');
    expect(blindReviewProgress(answered)).toEqual({ answered: 1, total: 2 });
    expect(() => answerBlindCase(answered, 'a', 'Short', '', 6)).toThrow('zamčená');
    expect(() => answerBlindCase(first, 'z', 'Short', '', 6)).toThrow();
  });

  it('po odpovědi už nejde přidat značka', () => {
    const mark = { time: 1, price: 2, dir: 'Long' as const, text: ' t ', at: 3 };
    const marked = addBlindMark(doc([base('a')]), 'a', mark);
    expect(marked.marks.a[0].text).toBe('t');
    expect(() => addBlindMark(answerBlindCase(marked, 'a', 'Nebral', '', 1), 'a', mark)).toThrow();
  });

  it('fáze a zastavení hlídají, že výsledek není vidět před odpovědí', () => {
    const item = base('a');
    const stop = item.stopMs / 1_000;
    expect(blindCasePhase(item, false, stop - 60)).toBe('playing');
    expect(blindCasePhase(item, false, stop)).toBe('ask');
    expect(blindCasePhase(item, true, stop)).toBe('reveal');
    expect(blindReplayStop(item, false, null)).toBe(stop);
    expect(blindReplayStop(item, false, stop - 60)).toBe(stop - 60);
    expect(blindReplayStop(item, false, stop + 60)).toBe(stop);
    expect(blindReplayStop(item, true, null)).toBeUndefined();
  });

  it('replay nepustí kurzor za zastavení', () => {
    const active = { ...DEFAULT_CHART_REPLAY_STATE, phase: 'active' as const, playing: true };
    expect(clampReplayToStop({ ...active, cursorTime: 90 }, 100)).toEqual({ ...active, cursorTime: 90 });
    expect(clampReplayToStop({ ...active, cursorTime: 160 }, 100)).toEqual({ ...active, cursorTime: 100, playing: false });
    expect(clampReplayToStop({ ...active, cursorTime: 100 }, 100).playing).toBe(false);
    const paused = { ...active, cursorTime: 100, playing: false };
    expect(clampReplayToStop(paused, 100)).toBe(paused);
    expect(clampReplayToStop({ ...active, cursorTime: 160 }, undefined).cursorTime).toBe(160);
    expect(clampReplayToStop({ ...DEFAULT_CHART_REPLAY_STATE, cursorTime: 160 }, 100).cursorTime).toBe(160);
  });

  it('nevyplněný limit je pořád rozhodnutí modelu vstoupit', () => {
    const model = { dir: -1 as const, kind: 'sweep', level: 'VWAP', res: 'no-fill' };
    expect(blindModelChoice(base('a', { pool: 'unfilled', model }))).toBe('Short');
    expect(blindModelChoice(base('a', { pool: 'low-rr', model: { ...model, res: 'low-rr' } }))).toBe('Nebral');
    expect(blindModelChoice(base('a'))).toBe('Nebral');
    expect(blindModelText(base('a', { pool: 'low-rr', model: { ...model, res: 'low-rr' } }))).toContain('pod 1 R');
  });

  it('dočasná session startuje na otevření a jen s MNQ', () => {
    const item = base('a');
    const run = buildBlindScratchRun(item, null, 3);
    expect(run.config.instruments).toEqual(['MNQ']);
    expect(run.cursorAt).toBe(item.openMs);
    expect(run.endAt).toBe(item.endMs);
    expect(run.startAt).toBeLessThan(item.openMs);
    expect(run.runtimeState.replay).toMatchObject({ phase: 'active', cursorTime: item.openMs / 1_000, playing: false, speed: 3 });
  });
});
