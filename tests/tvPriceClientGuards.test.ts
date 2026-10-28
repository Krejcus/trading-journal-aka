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

// `import type` / `export type` se za běhu smaže — do grafu modulů nepatří.
// Ukotveno na tvar jednoho příkazu, aby nepřeskočilo runtime import za ním.
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+['"][^'"]+['"]/gm;
const importsOf = (file: string, runtimeOnly = false): string[] => {
  const text = readFileSync(join(root, file), 'utf8');
  return [...(runtimeOnly ? text.replace(TYPE_ONLY, '') : text).matchAll(IMPORT)].flatMap(match => {
    const target = resolveImport(file, match[1]);
    return target ? [target] : [];
  });
};

const allSources = [...SOURCE_DIRS.flatMap(listSources), ...['App.tsx', 'index.tsx'].filter(file => existsSync(join(root, file)))];
const importersOf = (target: string) => allSources.filter(file => importsOf(file).includes(target)).sort();

const graph = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // Tranzitivně jen importy, které existují i za běhu.
    for (const next of importsOf(file, true)) visit(next);
  };
  visit(entry);
  return seen;
};

const TV_CLIENT_MODULES = [
  'services/tvPriceChannel.ts',
  'services/tvPriceGrant.ts',
  'lib/tvLiveCandle.ts',
  'lib/tvLiveCandleReplay.ts',
  'hooks/useTvLiveCandleFeed.ts',
  'lib/tvPriceChannelClient.ts',
  'lib/tvPriceStore.ts',
  'lib/tvLivePnl.ts',
  'components/LiveOpenPnlValue.tsx',
];

describe('kanál ceny z TV na klientovi — jen zobrazení (INV-UI-04)', () => {
  it('singleton kanálu smí importovat jen listová komponenta; LIVE desk jen úzké rozhraní grantu', () => {
    expect(importersOf('services/tvPriceChannel.ts')).toEqual(['components/LiveOpenPnlValue.tsx', 'hooks/useTvLiveCandleFeed.ts', 'services/tvPriceGrant.ts']);
    expect(importersOf('services/tvPriceGrant.ts')).toEqual(['components/TradovateLiveDesk.tsx', 'hooks/useTvLiveCandleFeed.ts']);
    // Živou svíčku grafu dne zapíná jen data grafu dne; graf sám dostane neutrální rozhraní.
    expect(importersOf('hooks/useTvLiveCandleFeed.ts')).toEqual(['hooks/useDayChartData.ts']);
    expect(importersOf('lib/tvLiveCandle.ts')).toEqual(['lib/tvLiveCandleReplay.ts']);
    // Přehrání ticků z dávky jen v živé svíčce grafu dne (P&L ho nečte).
    expect(importersOf('lib/tvLiveCandleReplay.ts')).toEqual(['hooks/useTvLiveCandleFeed.ts']);
    const desk = readFileSync(join(root, 'components/TradovateLiveDesk.tsx'), 'utf8');
    expect(desk).not.toMatch(/tvPriceStore|addPnlInterest|LiveOpenPnlValue|tvLivePnl/);
    expect(importersOf('lib/tvPriceChannelClient.ts')).toEqual(['services/tvPriceChannel.ts']);
    expect(importersOf('lib/tvPriceStore.ts')).toEqual([
      'components/LiveOpenPnlValue.tsx', 'lib/tvLiveCandle.ts', 'lib/tvLiveCandleReplay.ts', 'lib/tvLivePnl.ts', 'lib/tvPriceChannelClient.ts',
      'services/tvPriceChannel.ts',
    ]);
  });

  it('hodnotu s pohybem z TV vykreslují jen listové komponenty v LIVE a štítek živé pozice v deníku', () => {
    expect(importersOf('components/LiveOpenPnlValue.tsx')).toEqual([
      'components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx', 'components/day/DayLivePositionChip.tsx',
    ]);
    expect(importersOf('lib/tvLivePnl.ts')).toEqual([
      'components/LiveCopyTradeOverview.tsx', 'components/LiveOpenPnlValue.tsx', 'components/LiveTradeCard.tsx',
      'components/day/DayLivePositionChip.tsx', 'lib/tvLiveCandle.ts',
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
      // Grafy a svíčky dostávají živou svíčku jen přes neutrální rozhraní.
      'components/AlphaTradeChartWorkspace.tsx',
      'components/CandleKitTradeChart.tsx',
      'lib/liveCandleFeed.ts',
      'hooks/useLiveCandleBinding.ts',
      'services/liveCandles.ts',
      'services/dayCandles.ts',
      'services/provisionalCandles.ts',
      // Živá pozice v deníku: čáry a data jdou jen z read modelu, cenu z TV vidí jen štítek.
      'lib/journalLivePosition.ts',
      'lib/journalLivePositionStore.ts',
      'lib/livePriceLinesFeed.ts',
      'lib/displayWorkerStatusReader.ts',
      'lib/tradovateWorkerExposureOverlay.ts',
      'hooks/useLivePriceLinesBinding.ts',
      'hooks/useJournalLivePosition.ts',
      'hooks/useDisplayWorkerStatus.ts',
      'components/day/DayLivePositionRunner.tsx',
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
    const files = ['components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx', 'components/day/DayLivePositionChip.tsx'];
    const blocks = files.flatMap(file => {
      const text = readFileSync(join(root, file), 'utf8');
      // Každý výskyt musí být celý blok s inline funkcí uvnitř — žádné `children=`
      // ani samouzavírací tag, funkce definovaná jinde by kontrolu obešla.
      expect(text.match(/<LiveOpenPnlValue\b/g)?.length ?? 0, file)
        .toBe(text.match(/<LiveOpenPnlValue\b[^>]*>\s*\{\s*\(?[\w\s,]*\)?\s*=>[\s\S]*?<\/LiveOpenPnlValue>/g)?.length ?? 0);
      expect(text, file).not.toMatch(/<LiveOpenPnlValue\b[^>]*children\s*=/);
      return [...text.matchAll(/<LiveOpenPnlValue\b[\s\S]*?<\/LiveOpenPnlValue>/g)].map(match => ({ file, block: match[0] }));
    });
    // Řádek účtu (počítač, telefon), řádek skupiny, souhrn skupiny na telefonu, karta obchodu, štítek pozice v deníku.
    expect(blocks.map(item => item.file)).toEqual([
      'components/LiveCopyTradeOverview.tsx', 'components/LiveCopyTradeOverview.tsx', 'components/LiveCopyTradeOverview.tsx',
      'components/LiveCopyTradeOverview.tsx', 'components/LiveTradeCard.tsx', 'components/day/DayLivePositionChip.tsx',
    ]);
    for (const { file, block } of blocks) {
      expect(block, file).not.toMatch(/\bset[A-Z]\w*\(|\bon[A-Z]\w*\(|Ref\.current|\.current\(|publish|window\.|dispatch|dll|Dll|DLL|risk|limit|Limit|drawdown|cushion|eligib|write|persist|storage/);
    }
  });

  it('každá vynechaná shoda „import type“ je jediný příkaz', () => {
    for (const file of allSources) {
      for (const match of readFileSync(join(root, file), 'utf8').matchAll(TYPE_ONLY)) {
        expect(match[0].match(/\b(?:import|export)\b/g)?.length ?? 0, `${file}: ${match[0]}`).toBe(1);
      }
    }
  });

  it('živá svíčka z kanálu jde jen do překreslení grafu, nikdy do dat grafu dne', () => {
    const uses = allSources.flatMap(file => readFileSync(join(root, file), 'utf8').split('\n')
      .filter(line => line.includes('liveFeed')).map(line => ({ file, line: line.trim() })));
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const { file, line } of uses) {
      const allowed = file === 'hooks/useDayChartData.ts'
        ? /useTvLiveCandleFeed\(|^liveFeed,$|liveFeed`: rozpracovaná/
        : /liveCandles=\{ctl\.chart\.liveFeed\}|useLiveCandleBinding\(/;
      expect(line, file).toMatch(allowed);
    }
    // Neutrální rozhraní grafu používají jen grafy dne a jejich napojení.
    expect(importersOf('lib/liveCandleFeed.ts')).toEqual([
      'components/AlphaTradeChartWorkspace.tsx', 'hooks/useLiveCandleBinding.ts', 'hooks/useTvLiveCandleFeed.ts', 'lib/tvLiveCandleReplay.ts',
    ]);
    expect(importersOf('hooks/useLiveCandleBinding.ts')).toEqual([
      'components/AlphaTradeChartWorkspace.tsx', 'components/day/DayCompactChart.tsx', 'components/day/DayFullscreenChart.tsx',
    ]);
    const workspace = readFileSync(join(root, 'components/AlphaTradeChartWorkspace.tsx'), 'utf8').split('\n')
      .filter(line => /\bliveCandles\b/.test(line)).map(line => line.trim());
    expect(workspace).toEqual([
      'liveCandles?: LiveCandleFeed | null;',
      'liveCandles = null,',
      "useLiveCandleBinding(!backtestSession && replay.phase !== 'active' ? liveCandles : null, liveCandleTargets);",
    ]);
    // Svíčku ze zdroje čte jen napojení na graf.
    const readers = allSources.filter(file => /\b(?:feed|liveFeed|liveCandles)\.current\(/.test(readFileSync(join(root, file), 'utf8')));
    // Hook grafu dne čtení jen předává (přehrání ticků zabalené ve feedu).
    expect(readers).toEqual(['hooks/useLiveCandleBinding.ts', 'hooks/useTvLiveCandleFeed.ts']);
    const hook = readFileSync(join(root, 'hooks/useTvLiveCandleFeed.ts'), 'utf8').split('\n').filter(line => /\.current\(/.test(line)).map(line => line.trim());
    expect(hook).toEqual(['current: root => feed.current(root),']);
    const dayData = readFileSync(join(root, 'hooks/useDayChartData.ts'), 'utf8');
    expect(dayData).toMatch(/composeDayCandles\(candleWindow, sameDay\?\.candles \?\? \[\], live\?\.response\.candles \?\? null\)/);
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

describe('stav workeru pro deník — jen čtení (INV-UI-02)', () => {
  it('čtečku stavu workeru používá jen deník a nevede k žádnému příkazu ani zápisu', () => {
    // Za běhu (typy `JournalLiveSource` smí znát App i deník).
    const runtimeImportersOf = (target: string) => allSources.filter(file => importsOf(file, true).includes(target)).sort();
    expect(runtimeImportersOf('lib/displayWorkerStatusReader.ts')).toEqual(['hooks/useDisplayWorkerStatus.ts']);
    expect(runtimeImportersOf('hooks/useDisplayWorkerStatus.ts')).toEqual(['hooks/useJournalLivePosition.ts']);
    expect(runtimeImportersOf('hooks/useJournalLivePosition.ts')).toEqual(['components/day/DayLivePositionRunner.tsx']);
    const display = [
      'lib/displayWorkerStatusReader.ts', 'hooks/useDisplayWorkerStatus.ts', 'hooks/useJournalLivePosition.ts',
      'lib/journalLivePosition.ts', 'lib/tradovateWorkerExposureOverlay.ts', 'components/day/DayLivePositionRunner.tsx',
      'components/day/DayLivePositionChip.tsx',
    ];
    for (const file of display) {
      expect(readFileSync(join(root, file), 'utf8'), file)
        .not.toMatch(/executeTradovateCopierRelayCommand|LocalCopierAgentCommand|writeCopierAgentStatusSnapshot|copierAgentStatusStore|localStorage|sessionStorage|method:\s*['"]POST/);
    }
    // Z OAuth služby jen čtení relaye (GET), nic víc.
    const hook = readFileSync(join(root, 'hooks/useDisplayWorkerStatus.ts'), 'utf8');
    expect(hook.match(/from '\.\.\/services\/tradovateOAuthConnection'/g)).toHaveLength(1);
    expect(hook).toContain("import { loadTradovateCopierRelayStatus } from '../services/tradovateOAuthConnection';");
  });
});
