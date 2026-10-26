import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveOpenPnlValue } from '../components/LiveOpenPnlValue';
import { __resetAppForegroundForTests, __setNativeAppActiveForTests, subscribeAppForeground } from '../lib/appForeground';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import { effectiveCopyTradeAccountEligibility } from '../lib/copyTradeAccountEligibility';
import { buildLiveDaySummary } from '../lib/liveDaySummary';
import { tvPriceStore } from '../services/tvPriceChannel';

/**
 * INV-UI-04: data z TradingView jsou jen pro zobrazení. Hlídá, kdo smí
 * moduly kanálu ceny importovat, že se nic neukládá a že rozhodovací
 * a ukládací cesty LIVE na kanál nevidí (ani tranzitivně).
 */

const root = join(__dirname, '..');
const SOURCE_DIRS = ['components', 'lib', 'services', 'hooks', 'utils', 'contexts', 'api', 'server', 'scripts', 'src'];
// Relativní importy i alias `@/` (vite.config.ts).
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"]((?:\.|@\/)[^'"]+)['"]/g;

const listSources = (dir: string): string[] => {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap(name => {
    const path = join(absolute, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return listSources(relative(root, path));
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [relative(root, path)] : [];
  });
};

const resolveImport = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith('@/')
    ? join(root, specifier.slice(2).replace(/\.js$/, ''))
    : resolve(dirname(join(root, from)), specifier.replace(/\.js$/, ''));
  const candidate = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(path => existsSync(path));
  return candidate ? relative(root, candidate) : null;
};

const importsOf = (file: string): string[] =>
  [...readFileSync(join(root, file), 'utf8').matchAll(IMPORT)].flatMap(match => {
    const target = resolveImport(file, match[1]);
    return target ? [target] : [];
  });

const allSources = [...SOURCE_DIRS.flatMap(listSources), ...['App.tsx', 'index.tsx'].filter(file => existsSync(join(root, file)))];
const importersOf = (target: string) => allSources.filter(file => importsOf(file).includes(target)).sort();

const graph = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of importsOf(file)) visit(next);
  };
  visit(entry);
  return seen;
};

const TV_CLIENT_MODULES = [
  'services/tvPriceChannel.ts',
  'services/tvPriceGrant.ts',
  'lib/tvPriceChannelClient.ts',
  'lib/tvPriceStore.ts',
  'lib/tvLivePnl.ts',
  'components/LiveOpenPnlValue.tsx',
];

describe('kanál ceny z TV na klientovi — jen zobrazení (INV-UI-04)', () => {
  it('singleton kanálu smí importovat jen listová komponenta; LIVE desk jen úzké rozhraní grantu', () => {
    expect(importersOf('services/tvPriceChannel.ts')).toEqual(['components/LiveOpenPnlValue.tsx', 'services/tvPriceGrant.ts']);
    expect(importersOf('services/tvPriceGrant.ts')).toEqual(['components/TradovateLiveDesk.tsx']);
    const desk = readFileSync(join(root, 'components/TradovateLiveDesk.tsx'), 'utf8');
    expect(desk).not.toMatch(/tvPriceStore|addPnlInterest|LiveOpenPnlValue|tvLivePnl/);
    expect(importersOf('lib/tvPriceChannelClient.ts')).toEqual(['services/tvPriceChannel.ts']);
    expect(importersOf('lib/tvPriceStore.ts')).toEqual([
      'components/LiveOpenPnlValue.tsx', 'lib/tvLivePnl.ts', 'lib/tvPriceChannelClient.ts', 'services/tvPriceChannel.ts',
    ]);
  });

  it('hodnotu s pohybem z TV vykreslují jen listové komponenty v LIVE', () => {
    expect(importersOf('components/LiveOpenPnlValue.tsx')).toEqual(['components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx']);
    expect(importersOf('lib/tvLivePnl.ts')).toEqual([
      'components/LiveCopyTradeOverview.tsx', 'components/LiveOpenPnlValue.tsx', 'components/LiveTradeCard.tsx',
    ]);
  });

  it('rozhodovací, ukládací a sdílené cesty kanál nevidí ani tranzitivně', () => {
    const guarded = [
      'lib/copyTradeAccountEligibility.ts',
      'lib/copierForegroundPoller.ts',
      'lib/copierStatusPollFence.ts',
      'lib/copierAgentStatusStore.ts',
      'lib/copierArmPreparation.ts',
      'lib/copierSafetyControls.ts',
      'lib/tradovateLivePnl.ts',
      'lib/tradovateCopyTradeBridge.ts',
      'lib/tradovateDisplaySessionCache.ts',
      'lib/tradovateAccountDisplayMerge.ts',
      'lib/liveBalanceDisplay.ts',
      'lib/liveDaySummary.ts',
      'lib/liveCopierIsland.ts',
      'lib/liveTradeCard.ts',
      'services/nativeWidgetSnapshot.ts',
      'services/nativeLiveActivityPush.ts',
      'services/nativeCopierNotifications.ts',
      'components/LiveCopierIsland.tsx',
      'components/LiveDayCard.tsx',
      'components/SharedLiveDayView.tsx',
      'components/SharedTradeView.tsx',
      'components/TradeShareCard.tsx',
      'components/TradeShareModal.tsx',
    ];
    for (const entry of guarded) {
      expect(existsSync(join(root, entry)), entry).toBe(true);
      const reached = [...graph(entry)].filter(file => TV_CLIENT_MODULES.includes(file));
      expect(reached, entry).toEqual([]);
    }
  });

  it('nic z kanálu se neukládá (žádné storage, cache LIVE ani snímek statusu)', () => {
    for (const file of TV_CLIENT_MODULES) {
      expect(readFileSync(join(root, file), 'utf8'), file)
        .not.toMatch(/localStorage|sessionStorage|indexedDB|IndexedDB|Preferences\.|writeTradovateDisplaySession|writeCopierAgentStatusSnapshot|copierAgentStatusStore/);
    }
  });

  it('LIVE desk předá téma a klíč jen kanálu, nikam jinam', () => {
    const desk = readFileSync(join(root, 'components/TradovateLiveDesk.tsx'), 'utf8');
    const uses = desk.split('\n').filter(line => line.includes('priceChannel'));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) expect(line).toMatch(/offerTvPriceGrant\(/);
  });

  it('hodnota s pohybem z TV se v render-propu jen formátuje (žádné předání ven, žádné limity)', () => {
    const files = ['components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx'];
    const blocks = files.flatMap(file => {
      const text = readFileSync(join(root, file), 'utf8');
      // Každý výskyt musí být celý blok s inline funkcí uvnitř — žádné `children=`
      // ani samouzavírací tag, funkce definovaná jinde by kontrolu obešla.
      expect(text.match(/<LiveOpenPnlValue\b/g)?.length ?? 0, file)
        .toBe(text.match(/<LiveOpenPnlValue\b[^>]*>\s*\{\s*\(?[\w\s,]*\)?\s*=>[\s\S]*?<\/LiveOpenPnlValue>/g)?.length ?? 0);
      expect(text, file).not.toMatch(/<LiveOpenPnlValue\b[^>]*children\s*=/);
      return [...text.matchAll(/<LiveOpenPnlValue\b[\s\S]*?<\/LiveOpenPnlValue>/g)].map(match => ({ file, block: match[0] }));
    });
    // Řádek účtu (počítač, telefon), řádek skupiny, souhrn skupiny na telefonu, karta obchodu.
    expect(blocks.map(item => item.file)).toEqual([
      'components/LiveCopyTradeOverview.tsx', 'components/LiveCopyTradeOverview.tsx', 'components/LiveCopyTradeOverview.tsx',
      'components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx',
    ]);
    for (const { file, block } of blocks) {
      expect(block, file).not.toMatch(/\bset[A-Z]\w*\(|\bon[A-Z]\w*\(|Ref\.current|dispatch|dll|Dll|DLL|risk|limit|Limit|drawdown|cushion|eligib|write|persist|storage/);
    }
  });

  it('výjimka posluchače popředí nezastaví ostatní (obnova pollu LIVE)', () => {
    const seen: boolean[] = [];
    const offThrowing = subscribeAppForeground(() => { throw new Error('tv'); });
    const offPoll = subscribeAppForeground(foreground => seen.push(foreground));
    __setNativeAppActiveForTests(false);
    __setNativeAppActiveForTests(true);
    expect(seen).toEqual([false, true]);
    offThrowing();
    offPoll();
    __resetAppForegroundForTests();
  });

  it('se stejnými daty jsou způsobilost a souhrn dne s proudem cen i bez něj identické', () => {
    const accounts = devLiveCopyFixtureSnapshot.accounts;
    const now = Date.now();
    const before = JSON.stringify([effectiveCopyTradeAccountEligibility(accounts, [], [], now), buildLiveDaySummary(accounts, now)]);
    tvPriceStore.setLink('joined');
    for (let seq = 0; seq < 5; seq += 1) {
      const at = now + seq * 250;
      tvPriceStore.accept({
        v: 1, seq, runId: 'run-guard', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, front: 'MNQZ2026', switchAt: null,
        mode: 'streaming', bar: [Math.floor(at / 60_000) * 60, 21000, 21100, 20900, 21000 + seq * 25], last: 21000 + seq * 25,
        bid: null, ask: null, at,
      }, at);
    }
    expect(tvPriceStore.view().fresh).toBe(true);
    const after = JSON.stringify([effectiveCopyTradeAccountEligibility(accounts, [], [], now), buildLiveDaySummary(accounts, now)]);
    expect(after).toBe(before);
    tvPriceStore.reset();
    tvPriceStore.setLink('off');
  });

  it('bez živé ceny (i při vykreslení na serveru) ukáže listová komponenta jen kotvu', () => {
    const legs = [{ symbol: 'MNQZ6', netPosition: 2, averagePrice: 21000, grossPnl: 40, anchorAt: Date.now() }];
    const markup = renderToStaticMarkup(React.createElement(LiveOpenPnlValue, {
      anchor: 40, legs, children: (value: number, live: boolean) => `${value}|${live}`,
    }));
    expect(markup).toBe('40|false');
  });
});
