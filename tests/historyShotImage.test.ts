import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadedIds = new Set<string>();
vi.mock('../services/storageService', () => ({
  storageService: {
    getLoadedImageIds: () => loadedIds,
    markImageLoaded: (id: string) => { loadedIds.add(id); },
  },
}));

const { HistoryShotImage } = await import('../components/HistoryShotImage');

const render = (props: Partial<React.ComponentProps<typeof HistoryShotImage>> = {}) => renderToStaticMarkup(
  React.createElement(HistoryShotImage, {
    id: 't1', src: 'https://example.test/shot.jpg', failed: false, copierThumb: false, variant: 'card', onError: () => {},
    ...props,
  }),
);

describe('HistoryShotImage — náhled s vlastním stavem načtení', () => {
  beforeEach(() => loadedIds.clear());

  it('shows the skeleton and a hidden image until the screenshot loads', () => {
    const html = render();
    expect(html).toMatch(/class="history-shot-skeleton[^"]*opacity-100/);
    expect(html).toMatch(/<img[^>]*class="[^"]*opacity-0/);
  });

  it('an image already loaded elsewhere (remount, other view) skips the skeleton', () => {
    loadedIds.add('t1');
    const html = render();
    // Kostra zůstává jen schovaná (prolnutí), obrázek je vidět hned.
    expect(html).toMatch(/class="history-shot-skeleton[^"]*opacity-0/);
    expect(html).toMatch(/<img[^>]*class="[^"]*opacity-100/);
    expect(render({ variant: 'row' })).toMatch(/<img[^>]*class="[^"]*opacity-60 scale-100/);
  });

  it('a copier thumbnail keeps its crop and, once warmed (decoded at start), is visible right away', () => {
    expect(render({ copierThumb: true })).toMatch(/<img[^>]*class="[^"]*object-\[80%_50%\] opacity-0/);
    loadedIds.add('t1');
    expect(render({ copierThumb: true })).toMatch(/<img[^>]*class="[^"]*object-\[80%_50%\] opacity-100/);
  });

  it('a failed card keeps the image under the error overlay; a failed row shows only the icon', () => {
    const card = render({ failed: true });
    expect(card).toContain('bg-slate-900/60');
    expect(card).not.toContain('history-shot-skeleton');
    expect(card).toContain('<img');
    const row = render({ failed: true, variant: 'row' });
    expect(row).not.toContain('<img');
    expect(row).not.toContain('history-shot-skeleton');
  });
});
