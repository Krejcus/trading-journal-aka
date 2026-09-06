import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BacktestTagManager from '../components/BacktestTagManager';
import { createBacktestTagLibrary, prepareBacktestTagLibraryChange } from '../services/backtestTagLibrary';

const empty = createBacktestTagLibrary('owner');
const library = prepareBacktestTagLibraryChange(empty, { type: 'create', tag: { id: 'one', label: 'Můj setup', category: 'setup' } }, { ownerId: 'owner', expectedRevision: 0, operationId: 'create' }).library;
describe('tag manager preview UI', () => {
  it('states the historical scope explicitly and renders without making a persistence call', () => {
    const onCommit = vi.fn();
    const html = renderToStaticMarkup(React.createElement(BacktestTagManager, { library, trades: [], ownerId: 'owner', onCommit }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Můj setup');
    expect(html).toContain('Nenačtené obchody nejsou součástí této změny.');
    expect(html).toContain('Historické výskyty i jeho identita zůstanou zachované');
    expect(html).toContain('Zobrazit dopad sloučení');
    expect(html).not.toContain('Potvrdit sloučení');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not expose another owner catalog and blocks edits on ownership mismatch', () => {
    const html = renderToStaticMarkup(React.createElement(BacktestTagManager, { library, trades: [], ownerId: 'other', onCommit: vi.fn() }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Můj setup');
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});
