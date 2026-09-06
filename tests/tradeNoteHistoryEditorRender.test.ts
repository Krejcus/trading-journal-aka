import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import TradeNoteHistoryEditor from '../components/TradeNoteHistoryEditor';
import { buildTradeNoteHistoryPatch, createTradeNoteDrafts, type TradeNoteHistory } from '../services/tradeNoteHistory';

const context = { marketTime: 100, maxRevealedMarketTime: 200, entryMarketTime: 120, exitMarketTime: 180, closedTradeReview: true };
const base = buildTradeNoteHistoryPatch({ before: 'Původní plán', during: '', after: 'První závěr' }, undefined, context, { operationId: 'first', clientCapturedAt: 123456789 }).history;

describe('controlled phase note editor', () => {
  it('keeps legacy text distinct and renders the unsaved parent draft without generating a revision', () => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(React.createElement(TradeNoteHistoryEditor, {
      baseHistory: base, legacyNotes: 'Starý neurčený text', captureContext: context,
      drafts: { ...createTradeNoteDrafts(base), after: 'Rozepsáno po chybě uložení' }, onChange,
    }));
    expect(markup).toContain('fáze a čas neznámé');
    expect(markup).toContain('Starý neurčený text');
    expect(markup).toContain('Rozepsáno po chybě uložení</textarea>');
    expect(markup).toContain('První závěr');
    expect(markup).toContain('Původní plán');
    expect(markup).toContain('čas zařízení');
    expect(markup).toContain('1970-01-01 00:03:20 UTC');
    expect(onChange).not.toHaveBeenCalled();
    expect(base.revision).toBe(2);
  });

  it('disables malformed history editing while preserving the draft and legacy text for recovery', () => {
    const markup = renderToStaticMarkup(React.createElement(TradeNoteHistoryEditor, {
      baseHistory: { version: 3 } as unknown as TradeNoteHistory, legacyNotes: 'Recover legacy',
      captureContext: context, drafts: { before: '', during: '', after: 'Recover unsaved' }, onChange: vi.fn(),
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Recover legacy');
    expect(markup).toContain('Recover unsaved</textarea>');
    expect(markup).toMatch(/<textarea[^>]*disabled/);
  });
});
