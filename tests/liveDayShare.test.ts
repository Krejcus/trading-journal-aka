import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  normalizePublicLiveDayShare,
  publicLiveDayAvatar,
  publicLiveDaySummary,
  redactLiveDayAccountName,
} from '../lib/liveDayShare';
import type { LiveDaySummary } from '../lib/liveDaySummary';

const summary: LiveDaySummary = {
  rows: [
    { accountId: 62364058, name: 'LFF05066846490007', firm: 'Lucid', value: 1868.5, state: 'confirmed', stale: false },
    { accountId: 62364057, name: 'A', firm: 'Tradeify', value: -52.2, state: 'confirmed', stale: false },
  ],
  confirmed: 1816.3,
  confirmedCount: 2,
  accountCount: 2,
  partial: false,
  stale: false,
  noTradeCount: 0,
  unconfirmedCount: 0,
};

describe('LIVE day public snapshot', () => {
  it('keeps compact HTTPS avatars and drops inline data images', () => {
    expect(publicLiveDayAvatar('https://cdn.example.com/avatar.jpg')).toBe('https://cdn.example.com/avatar.jpg');
    expect(publicLiveDayAvatar('data:image/jpeg;base64,abc')).toBeNull();
  });

  it('redacts every broker account identifier and replaces short names completely', () => {
    expect(redactLiveDayAccountName('LFF05066846490007', 0)).toBe('LFF0••••0007');
    expect(redactLiveDayAccountName('A', 1)).toBe('Účet 2');
    const shared = publicLiveDaySummary(summary);
    expect(JSON.stringify(shared)).not.toContain('62364058');
    expect(JSON.stringify(shared)).not.toContain('LFF05066846490007');
    expect(shared.rows.map(row => row.accountId)).toEqual([1, 2]);
  });

  it('accepts the public contract and rejects malformed counts or tokens', () => {
    const candidate = {
      token: '11111111-1111-4111-8111-111111111111',
      tradeDate: '2026-09-21',
      owner: { name: 'Filip', avatar: null },
      summary: publicLiveDaySummary(summary),
      trades: 1,
      losingTrades: 0,
      theme: 'light',
      createdAt: '2026-09-21T10:00:00.000Z',
    };
    expect(normalizePublicLiveDayShare(candidate)).toMatchObject({ tradeDate: '2026-09-21', trades: 1 });
    expect(normalizePublicLiveDayShare({ ...candidate, token: '../private' })).toBeNull();
    expect(normalizePublicLiveDayShare({
      ...candidate,
      summary: { ...candidate.summary, accountCount: 99 },
    })).toBeNull();
  });
});

describe('LIVE day share migration', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260921101224_live_day_shares.sql', import.meta.url), 'utf8');

  it('keeps table and preview bucket private while owner writes stay RLS-scoped', () => {
    expect(sql).toContain('alter table public.live_day_shares enable row level security');
    expect(sql).toContain('revoke all on table public.live_day_shares from anon, authenticated');
    expect(sql).toContain('with check ((select auth.uid()) = owner_id)');
    expect(sql).toContain("'live-day-share-previews', 'live-day-share-previews', false");
    expect(sql).not.toMatch(/grant\s+select[^;]+\s+to\s+anon/i);
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });
});

describe('LIVE day share background', () => {
  const sharedView = readFileSync(new URL('../components/SharedLiveDayView.tsx', import.meta.url), 'utf8');
  const authView = readFileSync(new URL('../components/Auth.tsx', import.meta.url), 'utf8');

  it('sdílí graf z přihlášení v obou motivech, ve světlém ve vlastní variantě', () => {
    // Přihlášení je jen tmavé, takže si vystačí s výchozí variantou.
    expect(authView).toContain('<AnimatedTradingBackground />');
    // Veřejná karta ho má i ve světlém — dřív se vykresloval na černo, tak
    // byl vypnutý; teď má světlou desku a tmavší svíčky.
    expect(sharedView).toContain("<AnimatedTradingBackground variant={light ? 'light' : 'dark'} />");
    expect(sharedView).not.toContain('{!light ? <AnimatedTradingBackground');
    expect(sharedView).toContain("light ? 'bg-slate-200' : 'bg-black'");
  });

  it('karta na veřejné stránce vyplní šířku, nesmrskne se na obsah', () => {
    // `LiveDayCard` je flex položka bez vlastní šířky — bez obalu `w-full`
    // by se stránka tvářila úzce bez ohledu na `max-w`.
    expect(sharedView).toContain('<div className="w-full"><LiveDayCard');
  });
});
