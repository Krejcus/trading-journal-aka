import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CopyGroupChangePreview } from '../components/LiveCopyTradeOverview';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const saved: CopyGroupConfig = {
  id: 'group-1',
  name: 'Hlavní',
  enabled: false,
  leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-fill', multiplier: 2, maxContracts: 4 },
    { accountId: 400, mode: 'on-submit', multiplier: 1 },
  ],
};

const draft: CopyGroupConfig = {
  ...saved,
  leaderAccountId: 200,
  followers: [
    { accountId: 100, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 3, maxContracts: 2 },
    { accountId: 500, mode: 'on-fill', multiplier: 2 },
  ],
};

const labels = new Map([
  [100, 'Leader A (ID 100)'],
  [200, 'Follower B (ID 200)'],
  [300, 'Follower C (ID 300)'],
  [400, 'Follower D (ID 400)'],
  [500, 'Follower E (ID 500)'],
]);

describe('CopyGroupChangePreview', () => {
  it('před uložením ukáže leadera i všechny přidané, odebrané a upravené followery', () => {
    const markup = renderToStaticMarkup(React.createElement(CopyGroupChangePreview, {
      saved,
      draft,
      accountLabel: (accountId: number) => labels.get(accountId) ?? `Účet ${accountId}`,
    }));

    expect(markup).toContain('aria-label="Přehled změn před uložením"');
    expect(markup).toContain('Leader A (ID 100)');
    expect(markup).toContain('Follower B (ID 200)');
    expect(markup).toContain('Follower C (ID 300)');
    expect(markup).toContain('Follower D (ID 400)');
    expect(markup).toContain('Follower E (ID 500)');
    expect(markup).toContain('Režim: Při vyplnění → Při zadání');
    expect(markup).toContain('Max: 4 → 2');
    expect(markup.match(/Přidán/g)).toHaveLength(2);
    expect(markup.match(/Odebrán/g)).toHaveLength(2);
    expect(markup.match(/Změněn/g)).toHaveLength(1);
  });

  it('zvýrazní každou zobrazenou hodnotu násobku nad 1', () => {
    const markup = renderToStaticMarkup(React.createElement(CopyGroupChangePreview, {
      saved,
      draft,
      accountLabel: (accountId: number) => labels.get(accountId) ?? `Účet ${accountId}`,
    }));

    expect(markup.match(/data-risk-multiplier="true"/g)).toHaveLength(3);
    expect(markup).toContain('>2×</span>');
    expect(markup).toContain('>3×</span>');
  });
});
