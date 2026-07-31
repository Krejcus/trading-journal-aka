import { describe, expect, it } from 'vitest';
import {
  isMemoryActive,
  normalizeMemoryEvidence,
  normalizeMemoryMetadata,
  type MemoryEntry,
} from '../services/coachMemoryService';

describe('Coach evidence-aware memory contract', () => {
  it('normalizuje a deduplikuje pouze kanonické evidence reference', () => {
    expect(normalizeMemoryEvidence([
      { type: 'trade', id: 'trade-1', date: '2026-07-30T12:00:00Z', note: ' první důkaz ' },
      { type: 'trade', id: 'trade-1' },
      { type: 'unknown', id: 'x' },
      { type: 'review', id: '2026-07-30' },
      null,
    ])).toEqual([
      { type: 'trade', id: 'trade-1', date: '2026-07-30', note: 'první důkaz' },
      { type: 'review', id: '2026-07-30' },
    ]);
  });

  it('označí nepodloženou observation jako hypotézu s nižší confidence', () => {
    expect(normalizeMemoryMetadata('observation', {})).toMatchObject({
      status: 'active',
      confidence: 0.5,
      evidence: [],
      validation_state: 'hypothesis',
    });
    expect(normalizeMemoryMetadata('observation', {
      evidence: [{ type: 'incident', id: 'incident-1' }],
      confidence: 0.95,
      validation_state: 'supported',
    })).toMatchObject({ confidence: 0.65, validation_state: 'hypothesis' });
  });

  it('potvrdí opakovaný pattern až třemi nezávislými referencemi', () => {
    const metadata = normalizeMemoryMetadata('observation', {
      validation_state: 'supported',
      evidence: [
        { type: 'incident', id: 'incident-1' },
        { type: 'incident', id: 'incident-2' },
        { type: 'review', id: '2026-07-30' },
      ],
    });
    expect(metadata).toMatchObject({ validation_state: 'supported', confidence: 0.8 });
  });

  it('proti-důkaz přepne tvrzení na contested a omezí confidence', () => {
    const metadata = normalizeMemoryMetadata('observation', {
      validation_state: 'supported',
      confidence: 0.9,
      evidence: [
        { type: 'incident', id: 'incident-1' },
        { type: 'incident', id: 'incident-2' },
        { type: 'incident', id: 'incident-3' },
      ],
      counter_evidence: [{ type: 'review', id: '2026-07-31' }],
    });
    expect(metadata).toMatchObject({ validation_state: 'contested', confidence: 0.5 });
  });

  it('commitment explicitně dostává plnou confidence', () => {
    expect(normalizeMemoryMetadata('commitment', { scope: 'global' })).toMatchObject({
      scope: 'global',
      status: 'active',
      confidence: 1,
      validation_state: 'user_stated',
    });
  });

  it('nepustí do běžného recallu superseded, retracted ani expirovanou paměť', () => {
    const entry = (metadata: MemoryEntry['metadata']): Pick<MemoryEntry, 'metadata'> => ({ metadata });
    expect(isMemoryActive(entry({ status: 'active' }), '2026-07-31')).toBe(true);
    expect(isMemoryActive(entry({ status: 'superseded' }), '2026-07-31')).toBe(false);
    expect(isMemoryActive(entry({ status: 'retracted' }), '2026-07-31')).toBe(false);
    expect(isMemoryActive(entry({ status: 'active', expires_at: '2026-07-30' }), '2026-07-31')).toBe(false);
    expect(isMemoryActive(entry({ status: 'active', expires_at: '2026-07-31' }), '2026-07-31')).toBe(true);
  });
});
