import { describe, expect, it } from 'vitest';
import { parseAllRefs, stripAllRefs } from '../services/aiService';

describe('Coach measurable experiment actions', () => {
  it('accepts a complete Lab experiment and removes its marker from visible text', () => {
    const text = 'Ověříme to.\n[ACTION:{"type":"lab_experiment","label":"Stop po lossu","hypothesis":"Sníží denní ztrátu.","rule":"Po prvním lossu končím.","targetTrades":20}]';
    const refs = parseAllRefs(text);

    expect(refs.actions).toEqual([expect.objectContaining({
      type: 'lab_experiment',
      label: 'Stop po lossu',
      targetTrades: 20,
    })]);
    expect(stripAllRefs(text)).toBe('Ověříme to.');
  });

  it('rejects an experiment without an evaluable hypothesis or sample', () => {
    const text = '[ACTION:{"type":"lab_experiment","label":"Neúplný","rule":"Něco změním.","targetTrades":2}]';
    expect(parseAllRefs(text).actions).toEqual([]);
  });

  it('keeps evidence markers out of visible chat text', () => {
    expect(stripAllRefs('Podloženo [INCIDENT:i-1] [EXECUTION:e-1] [ORDER:o-1] [EXPERIMENT:x-1] [REVIEW:2026-07-30]'))
      .toBe('Podloženo');
  });
});
