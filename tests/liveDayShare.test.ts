import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  normalizePublicLiveDayShare,
  LIVE_DAY_SHARE_AVATAR_MAX,
  liveDayShareOrigin,
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
  it('pustí HTTPS odkaz i vložený obrázek, protože appka ukládá avatar jako data: URL', () => {
    expect(publicLiveDayAvatar('https://cdn.example.com/avatar.jpg')).toBe('https://cdn.example.com/avatar.jpg');
    // „abc“ není platná base64 délka; obsah se kontroluje, ne jen prefix.
    expect(publicLiveDayAvatar('data:image/jpeg;base64,abc')).toBeNull();
    expect(publicLiveDayAvatar('data:image/jpeg;base64,abcd')).toBe('data:image/jpeg;base64,abcd');
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

  it('vložený avatar z profilu projde, aby na sdílené stránce nebyly jen iniciály', () => {
    const png = `data:image/png;base64,${'A'.repeat(4000)}`;
    expect(publicLiveDayAvatar(png)).toBe(png);
    expect(publicLiveDayAvatar(`data:image/webp;base64,${'B'.repeat(102)}==`)).not.toBeNull();
    // Délka base64 musí sedět na násobek čtyř, jinak to není obrázek.
    expect(publicLiveDayAvatar(`data:image/webp;base64,${'B'.repeat(100)}==`)).toBeNull();
  });

  it.each([
    ['skript místo obrázku', 'data:text/html;base64,PHNjcmlwdD4='],
    ['svg, které umí spustit kód', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['nesmysl v base64', 'data:image/png;base64,<script>'],
    ['http místo https', 'http://example.com/a.png'],
    ['odkaz s heslem', 'https://user:pass@example.com/a.png'],
  ])('avatar se zahodí: %s', (_label, value) => {
    expect(publicLiveDayAvatar(value)).toBeNull();
  });

  it('přerostlý avatar se zahodí, ať nezdraží každou veřejnou odpověď', () => {
    expect(publicLiveDayAvatar(`data:image/png;base64,${'A'.repeat(LIVE_DAY_SHARE_AVATAR_MAX)}`)).toBeNull();
  });

  it('hlavička karty stojí nad tělem, jinak bublinu sdílení nikdo neuvidí', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    // Obecné pravidlo dává hlavičce i tělu `z-index: 2`; hlavička si tím udělá
    // vlastní kontext stohování a bublina z něj neuteče, takže ji tělo jako
    // pozdější sourozenec překreslí. Selektor musí přebít specificitu (0,3,0)
    // toho obecného pravidla se dvěma `:not()`.
    expect(css).toContain('.live-day-card .live-day-inner > .live-day-head { z-index: 4; }');
  });

  it('otevřenou bublinu sdílení neořízne obal vysouvacích ikon', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    // Obal ikon má kvůli animaci `overflow: hidden`; bez výjimky pro otevřenou
    // bublinu uživatel po kliknutí vidí jen fajfku a žádný odkaz.
    expect(css).toMatch(/\.live-day-tools:has\(\.live-day-sharepop\) > span \{[^}]*overflow: visible;/);
  });

  it('karta na veřejné stránce vyplní šířku, nesmrskne se na obsah', () => {
    // `LiveDayCard` je flex položka bez vlastní šířky — bez obalu `w-full`
    // by se stránka tvářila úzce bez ohledu na `max-w`.
    expect(sharedView).toContain('<div className="w-full"><LiveDayCard');
  });
});

describe('adresa sdíleného odkazu', () => {
  const publicOrigin = 'https://alphatrade-mentor-15.vercel.app';

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:5273',
    'http://192.168.1.20:3000',
    'http://10.0.0.5:3000',
    'http://filip-mac.local:3000',
  ])('z neveřejné adresy %s míří odkaz na veřejnou appku', origin => {
    expect(liveDayShareOrigin(origin, publicOrigin)).toBe(publicOrigin);
  });

  it('na veřejné adrese (i náhledovém deployi) zůstává, kde uživatel je', () => {
    expect(liveDayShareOrigin(publicOrigin, publicOrigin)).toBe(publicOrigin);
    expect(liveDayShareOrigin('https://alphatrade-git-x.vercel.app', publicOrigin)).toBe('https://alphatrade-git-x.vercel.app');
  });

  it('nativní appka nemá vlastní webovou adresu — bere veřejnou', () => {
    expect(liveDayShareOrigin(null, publicOrigin)).toBe(publicOrigin);
  });
});
