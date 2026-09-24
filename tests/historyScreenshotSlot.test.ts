import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HistoryScreenshotSlot, clipboardImage, pasteTargetsEditable, shotTargetIds, withAttachedScreenshot } from '../components/HistoryScreenshotSlot';
import type { Trade } from '../types';

const trade = (patch: Partial<Trade> = {}) => ({ id: 't1', needsReview: true, ...patch } as Trade);

describe('snímek vložený z karty Historie', () => {
  it('nový snímek jde dopředu a starší zůstanou bez duplicit', () => {
    const next = withAttachedScreenshot(trade({ screenshot: 'a', screenshots: ['a', 'b'] }), 'new');
    expect(next.screenshot).toBe('new');
    expect(next.screenshots).toEqual(['new', 'a', 'b']);
    expect(withAttachedScreenshot(trade({ screenshots: ['x', 'new'] }), 'new').screenshots).toEqual(['new', 'x']);
  });

  it('vložený obrázek není reflexe — obchod zůstane nezkontrolovaný', () => {
    expect(withAttachedScreenshot(trade(), 'url').needsReview).toBe(true);
  });

  it('App ukládá snímek mimo handleUpdateTrade, který by nastavil needsReview: false', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('onAttachScreenshot={handleAttachTradeScreenshot}');
    const handler = app.slice(app.indexOf('const handleAttachTradeScreenshot'), app.indexOf('const handleUpdateTrade = useCallback'));
    expect(handler).toContain('handleUpdateTrades(targets.map(trade => withAttachedScreenshot(trade, url)))');
    // Chybí-li některý účet sloučené karty, neuloží se nic — ne jen část skupiny.
    expect(handler).toContain('if (targets.length !== ids.size) return Promise.resolve(false);');
    expect(handler).not.toContain('handleUpdateTrade(');
  });
});

describe('komu snímek patří', () => {
  it('sloučená karta uloží snímek ke všem účtům skupiny', () => {
    expect(shotTargetIds(trade({ id: 'combined_x', combinedTradeIds: ['a', 2, 'c'] }))).toEqual(['a', '2', 'c']);
  });

  it('běžná karta jen k sobě', () => {
    expect(shotTargetIds(trade({ id: 42 as unknown as string }))).toEqual(['42']);
  });

  it('sloučená karta bez členů nemá kam uložit', () => {
    expect(shotTargetIds(trade({ id: 'combined_x' }))).toEqual([]);
  });
});

describe('vložení v detailu obchodu', () => {
  const modal = readFileSync(new URL('../components/TradeDetailModal.tsx', import.meta.url), 'utf8');
  const history = readFileSync(new URL('../components/TradeHistory.tsx', import.meta.url), 'utf8');

  it('otevřený editační formulář má vlastní vkládání — detail mu ho nebere', () => {
    expect(modal).toContain('if (!onAttachScreenshotFile || isFullEditOpen) return;');
  });

  it('karta pod detailem se nevkládá dvakrát', () => {
    expect(history).toContain('if (!trade || selectedTrade || isMultiSelectMode');
  });

  it('po uložení se zahodí předem načtený detail bez snímku', () => {
    const attach = history.slice(history.indexOf('const attachScreenshot'), history.indexOf('}, [onAttachScreenshot]);'));
    expect(attach.indexOf('await onAttachScreenshot(ids, url)')).toBeLessThan(attach.indexOf('preparedJournalDetailRef.current.delete(key)'));
  });
});

describe('schránka', () => {
  const data = (items: Array<{ kind: string; type: string }>) => ({
    items: items.map(item => ({ ...item, getAsFile: () => ({ name: item.type }) as unknown as File })),
  }) as unknown as DataTransfer;

  it('vezme první obrázek, text ignoruje', () => {
    expect(clipboardImage(data([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }]))?.name).toBe('image/png');
    expect(clipboardImage(data([{ kind: 'string', type: 'text/plain' }]))).toBeNull();
    expect(clipboardImage(null)).toBeNull();
  });

  it('psaní do pole se nepřebíjí', () => {
    const at = (selector: string | null) => ({ closest: () => selector }) as unknown as EventTarget;
    expect(pasteTargetsEditable(at('textarea'))).toBe(true);
    expect(pasteTargetsEditable(at(null))).toBe(false);
    expect(pasteTargetsEditable(null)).toBe(false);
  });
});

describe('prázdná plocha karty', () => {
  const slot = (patch: Partial<React.ComponentProps<typeof HistoryScreenshotSlot>> = {}) =>
    renderToStaticMarkup(React.createElement(HistoryScreenshotSlot, {
      light: true, canAttach: true, state: null, onPickFile: () => {}, ...patch,
    }));

  it('řekne „Bez screenshotu“ a nabídne vložení', () => {
    const markup = slot();
    expect(markup).toContain('Bez screenshotu');
    expect(markup).toContain('Vložit');
    expect(markup).toContain('repeating-linear-gradient');
  });

  it('kde nejde uložit (kombinovaná karta), akci nenabízí', () => {
    expect(slot({ canAttach: false })).not.toContain('Vložit');
  });

  it('ukáže průběh, úspěch i chybu', () => {
    expect(slot({ state: { status: 'uploading' } })).toContain('Ukládám snímek');
    expect(slot({ state: { status: 'saved' } })).toContain('Snímek uložen');
    expect(slot({ state: { status: 'error', message: 'Účet pro uložení obrázku se změnil.' } })).toContain('Účet pro uložení obrázku se změnil.');
  });
});
