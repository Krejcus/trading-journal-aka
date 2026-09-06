import { it, expect } from 'vitest';
import type { Account, Trade } from '../types';
import { buildBacktestAiExport } from '../services/backtestAiExport';
it('exports stable IDs, custom setup/tags, auto provenance and every stored evidence field without mutations', () => {
  const trade = { id: 'trade-42', accountId: 'A', backtestRunId: 'run-1', timestamp: 123, entryTime: 100, instrument: 'MNQ', tags: ['my tag'], setupType: 'reaction', htfConfluence: ['manual', 'auto'], ltfConfluence: ['legacy'], autoConfluence: { htf: ['auto'], ltf: [] }, notes: 'critical note', screenshots: ['private-ref'], source: 'replay', executionPath: { status: 'partial' }, futureEvidence: { version: 3 }, positionSize: 2 } as unknown as Trade;
  const before = structuredClone(trade);
  const output = buildBacktestAiExport([{ id: 'A', name: 'Session', initialBalance: 1000 } as Account], [trade, { ...trade, id: 'other', accountId: 'B' }], [], '2026-09-05');
  expect(output.version).toBe(2); expect(output.pocetObchodu).toBe(1);
  expect(output.obchody[0]).toMatchObject({ id: 'trade-42', accountId: 'A', backtestRunId: 'run-1', tags: ['my tag'], setupType: 'reaction', autoConfluence: trade.autoConfluence, notes: 'critical note', screenshots: ['private-ref'], executionPath: { status: 'partial' }, futureEvidence: { version: 3 } });
  expect(output.obchody[0].confluenceProvenance.manualOrUnclassified).toEqual({ htf: ['manual'], ltf: ['legacy'] });
  expect(JSON.parse(JSON.stringify(output)).obchody[0].id).toBe('trade-42');
  expect(trade).toEqual(before);
});
it('does not invent automatic or manual attribution for legacy trades without provenance', () => {
  const output = buildBacktestAiExport([{ id: 'A' } as Account], [{ id: 'legacy', accountId: 'A', htfConfluence: ['unknown'] } as Trade], []);
  expect(output.obchody[0].autoConfluence).toBeNull();
  expect(output.obchody[0].confluenceProvenance.manualOrUnclassified.htf).toEqual(['unknown']);
});
