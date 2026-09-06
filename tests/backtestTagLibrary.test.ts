import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import {
  backtestTagKey, createBacktestTagLibrary, prepareBacktestTagLibraryChange, previewBacktestTagMerge,
  resolveBacktestLibraryTag, validateBacktestTagCommitPlan, validateBacktestTagLibrary,
  type BacktestTagCategory, type BacktestTagField, type BacktestTagLibrary,
} from '../services/backtestTagLibrary';
import { buildBacktestTradeRecalculationUpdates } from '../services/backtestTradeRecalculation';

const ownerId = 'owner-a';
const command = (library: BacktestTagLibrary, operationId = 'operation') => ({ ownerId, expectedRevision: library.revision, operationId });
const add = (library: BacktestTagLibrary, id: string, label: string, category: BacktestTagCategory = 'setup', aliases: string[] = []) =>
  prepareBacktestTagLibraryChange(library, { type: 'create', tag: { id, label, category, aliases } }, command(library, id)).library;
const library = () => add(add(createBacktestTagLibrary(ownerId), 'source', 'Starý setup', 'mistake', ['STARÁ ZKRATKA']), 'target', 'Nový setup', 'context', ['Nová zkratka']);
const trade = (id: string, updates: Partial<Trade> = {}): Trade => ({ id, accountId: 'account-1', backtestRunId: 'run-1', tags: [], notes: 'Private unchanged', ...updates } as Trade);
const preview = (trades: Trade[], fields: BacktestTagField[] = ['tags'], lib = library()) =>
  previewBacktestTagMerge(lib, trades, { ...command(lib), sourceId: 'source', targetId: 'target', scope: { tradeIds: trades.map(t => String(t.id)), fields } });

describe('backtest tag library identities and catalog operations', () => {
  it('uses NFC and full caseless aliases without changing display labels or removing accents', () => {
    expect(backtestTagKey('  Odra\u0301z  ')).toBe(backtestTagKey('ODRÁZ'));
    expect(backtestTagKey('Straße')).toBe(backtestTagKey('STRASSE'));
    expect(backtestTagKey('ος')).toBe(backtestTagKey('ΟΣ'));
    expect(backtestTagKey('Můj setup')).not.toBe(backtestTagKey('Muj setup'));
    const lib = add(createBacktestTagLibrary(ownerId), 'stable', '  Odra\u0301z ', 'setup');
    expect(lib.tags[0].label).toBe('Odráz');
    expect(resolveBacktestLibraryTag(lib, 'ODRÁZ')?.id).toBe('stable');
  });

  it('rejects ambiguous aliases even across categories and archived/deleted entries', () => {
    const lib = add(createBacktestTagLibrary(ownerId), 'one', 'Odra\u0301z', 'setup');
    expect(() => add(lib, 'two', 'Jiné', 'mistake', ['ODRÁZ'])).toThrow(/nejednoznačný/);
    const deleted = prepareBacktestTagLibraryChange(lib, { type: 'delete', id: 'one' }, command(lib)).library;
    expect(() => add(deleted, 'two', 'ODRÁZ', 'context')).toThrow(/nejednoznačný/);
    expect(resolveBacktestLibraryTag(deleted, 'odráz')).toMatchObject({ id: 'one', status: 'deleted' });
  });

  it('renames catalog metadata with stable identity and the old alias, without historical patches', () => {
    const lib = library(), original = JSON.stringify(lib);
    const change = prepareBacktestTagLibraryChange(lib, { type: 'edit', id: 'source', label: 'Opravený název', category: 'setup', aliases: ['STARÁ ZKRATKA'] }, command(lib));
    expect(change.tradePatches).toEqual([]);
    expect(change.affectedTradeIds).toEqual([]);
    expect(resolveBacktestLibraryTag(change.library, 'STARÝ SETUP')).toMatchObject({ id: 'source', label: 'Opravený název', category: 'setup' });
    expect(JSON.stringify(lib)).toBe(original);
  });

  it('archives, removes from suggestions and restores without releasing the stable tag identity', () => {
    let lib = library();
    for (const [type, status] of [['archive', 'archived'], ['delete', 'deleted'], ['restore', 'active']] as const) {
      const change = prepareBacktestTagLibraryChange(lib, { type, id: 'source' }, command(lib));
      expect(change.library.tags.find(tag => tag.id === 'source')?.status).toBe(status);
      expect(change.tradePatches).toEqual([]);
      lib = change.library;
    }
    expect(resolveBacktestLibraryTag(lib, 'stará zkratka')?.id).toBe('source');
  });

  it('rejects wrong ownership and stale library revision before preparing any change', () => {
    const lib = library();
    expect(() => prepareBacktestTagLibraryChange(lib, { type: 'archive', id: 'source' }, { ...command(lib), ownerId: 'other' })).toThrow(/jinému uživateli/);
    expect(() => prepareBacktestTagLibraryChange(lib, { type: 'archive', id: 'source' }, { ...command(lib), expectedRevision: 0 })).toThrow(/mezitím změnil/);
  });

  it('refuses malformed alias ownership instead of silently repairing catalog data', () => {
    const lib = library();
    lib.tags[1].aliases.push('Starý setup');
    const before = JSON.stringify(lib);
    expect(() => validateBacktestTagLibrary(lib)).toThrow(/nejednoznačný/);
    expect(JSON.stringify(lib)).toBe(before);
  });
});

describe('explicit historical merge preview', () => {
  it('merges alias occurrences into target category with exact patches and stable redirected IDs', () => {
    const trades = [trade('a', { tags: ['stará zkratka', 'Nový setup', 'Jiný'] }), trade('b', { tags: ['Jiný'] })];
    const before = JSON.stringify(trades), lib = library(), result = preview(trades, ['tags'], lib);
    expect(result.affectedTradeIds).toEqual(['a']);
    expect(result.tradePatches[0].updates).toEqual({ tags: ['Nový setup', 'Jiný'] });
    expect(result.tradePatches[0].expected).toMatchObject({ id: 'a', accountId: 'account-1', backtestRunId: 'run-1', tags: trades[0].tags });
    expect(result.tradePatches[0].expected).not.toHaveProperty('notes');
    expect(result.scopeSnapshots).toHaveLength(2);
    expect(result.library.tags.find(tag => tag.id === 'source')).toMatchObject({ id: 'source', status: 'merged', mergedIntoId: 'target' });
    expect(resolveBacktestLibraryTag(result.library, 'STARÁ ZKRATKA')).toMatchObject({ id: 'target', category: 'context' });
    expect(JSON.stringify(trades)).toBe(before);
  });

  it('supports a catalog-only merge without implying any historical rewrite', () => {
    const lib = library();
    const result = previewBacktestTagMerge(lib, [trade('not-selected', { tags: ['Starý setup'] })], { ...command(lib), sourceId: 'source', targetId: 'target', scope: { tradeIds: [], fields: [] } });
    expect(result.tradePatches).toEqual([]);
    expect(result.scope.tradeIds).toEqual([]);
    expect(resolveBacktestLibraryTag(result.library, 'Starý setup')?.id).toBe('target');
  });

  it('preserves generated source capsules and manual target ownership through later recalculation', () => {
    const input = trade('a', {
      htfConfluence: ['Starý setup', 'stará zkratka', 'Nový setup', 'Other automatic'],
      ltfConfluence: ['Starý setup'], autoConfluence: { htf: ['Starý setup', 'Nový setup', 'Other automatic'], ltf: ['Starý setup'] },
    });
    const result = preview([input], ['htfConfluence']);
    expect(result.skippedAutomatic).toEqual([{ tradeId: 'a', field: 'htfConfluence', labels: ['Starý setup'] }]);
    expect(result.tradePatches[0].updates).toEqual({
      htfConfluence: ['Starý setup', 'Nový setup', 'Other automatic'],
      autoConfluence: { htf: ['Starý setup', 'Other automatic'], ltf: ['Starý setup'] },
    });
    const after = { ...input, ...result.tradePatches[0].updates };
    const recalculated = buildBacktestTradeRecalculationUpdates(after, trade('a', { htfConfluence: ['Nový setup'], ltfConfluence: [] }));
    expect(recalculated.htfConfluence).toContain('Nový setup');
    expect(recalculated.autoConfluence?.htf).not.toContain('Nový setup');
    expect(after.ltfConfluence).toEqual(['Starý setup']);
  });

  it('leaves purely automatic sources untouched and preserves unrelated provenance entries', () => {
    const result = preview([trade('a', { htfConfluence: ['Starý setup'], autoConfluence: { htf: ['Starý setup'], ltf: ['Untouched'] } })], ['htfConfluence']);
    expect(result.tradePatches).toEqual([]);
    expect(result.skippedAutomatic).toHaveLength(1);
  });

  it('treats unknown legacy provenance as manual and rewrites only selected fields', () => {
    const input = trade('a', { tags: ['Starý setup'], htfConfluence: ['STARÁ ZKRATKA'], ltfConfluence: ['Starý setup'] });
    const result = preview([input], ['htfConfluence']);
    expect(result.tradePatches[0].updates).toEqual({ htfConfluence: ['Nový setup'] });
    expect(result.tradePatches[0].expected).not.toHaveProperty('tags');
    expect(result.tradePatches[0].expected).not.toHaveProperty('ltfConfluence');
    expect(input).not.toHaveProperty('autoConfluence');
  });

  it('keeps earlier merge aliases resolving across a subsequent merge chain', () => {
    const lib = add(library(), 'third', 'Třetí tag', 'setup');
    const first = preview([], [], lib).library;
    const second = previewBacktestTagMerge(first, [], { ...command(first), sourceId: 'target', targetId: 'third', scope: { tradeIds: [], fields: [] } }).library;
    expect(resolveBacktestLibraryTag(second, 'STARÁ ZKRATKA')).toMatchObject({ id: 'third', category: 'setup' });
    expect(second.tags.find(tag => tag.id === 'source')?.id).toBe('source');
  });

  it('requires every explicitly selected trade and its backtest identity to be loaded', () => {
    const lib = library();
    expect(() => previewBacktestTagMerge(lib, [], { ...command(lib), sourceId: 'source', targetId: 'target', scope: { tradeIds: ['missing'], fields: ['tags'] } })).toThrow(/není načtený/);
    expect(() => preview([trade('live', { backtestRunId: undefined })])).toThrow(/backtest session/);
    expect(() => preview([trade('a'), trade('a')])).toThrow(/Rozsah/);
    expect(() => previewBacktestTagMerge(lib, [trade('a'), trade('a')], { ...command(lib), sourceId: 'source', targetId: 'target', scope: { tradeIds: ['a'], fields: ['tags'] } })).toThrow(/duplicit/);
  });
});

describe('preview-to-commit concurrency boundary', () => {
  it('detects a newly affected row inside the chosen scope, including previously unaffected rows', () => {
    const trades = [trade('a', { tags: ['Starý setup'] }), trade('b', { tags: ['Other'] })];
    const result = preview(trades);
    const current = [trades[0], { ...trades[1], tags: ['Other', 'Starý setup'] }];
    expect(() => validateBacktestTagCommitPlan(result, library(), current, ownerId)).toThrow(/obchodu b/);
  });

  it('allows unrelated note edits but rejects changes to source tags, account, run or provenance', () => {
    const original = trade('a', { htfConfluence: ['Starý setup'], autoConfluence: { htf: [], ltf: [] } });
    const result = preview([original], ['htfConfluence']);
    expect(validateBacktestTagCommitPlan(result, library(), [{ ...original, notes: 'New review' }], ownerId).remainingTradePatches).toHaveLength(1);
    for (const changed of [
      { ...original, accountId: 'different' }, { ...original, backtestRunId: 'different' },
      { ...original, htfConfluence: ['Different'] }, { ...original, autoConfluence: { htf: ['Starý setup'], ltf: [] } },
    ]) expect(() => validateBacktestTagCommitPlan(result, library(), [changed], ownerId)).toThrow(/od náhledu změnily/);
  });

  it('rejects a changed library or user, and leaves the existing preview untouched', () => {
    const original = trade('a', { tags: ['Starý setup'] }), result = preview([original]), before = JSON.stringify(result);
    expect(() => validateBacktestTagCommitPlan(result, add(library(), 'extra', 'Additional'), [original], ownerId)).toThrow(/Katalog se od náhledu/);
    expect(() => validateBacktestTagCommitPlan(result, library(), [original], 'other')).toThrow(/Uživatel/);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('resumes an uncertain partial batch without reapplying acknowledged rows', () => {
    const original = [trade('a', { tags: ['Starý setup'] }), trade('b', { tags: ['Starý setup'] })];
    const result = preview(original);
    const partiallySaved = [{ ...original[0], ...result.tradePatches[0].updates }, original[1]];
    const retry = validateBacktestTagCommitPlan(result, library(), partiallySaved, ownerId);
    expect(retry.remainingTradePatches.map(item => item.tradeId)).toEqual(['b']);
    expect(retry.libraryAlreadyApplied).toBe(false);
    const allSaved = original.map((row, index) => ({ ...row, ...result.tradePatches[index].updates }));
    expect(validateBacktestTagCommitPlan(result, result.library, allSaved, ownerId)).toEqual({ remainingTradePatches: [], libraryAlreadyApplied: true });
  });
});
