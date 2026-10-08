import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

// 8. 10. 2026: studený start LIVE ukázal obsah → prázdno (315 ms) → obsah.
// Lazy LiveJournalHistory suspendoval stránkovou Suspense hranici a React 19
// drží její fallback nejméně 300 ms (FALLBACK_THROTTLE_MS).
describe('studený start LIVE: nic v přehledu nesmí suspendovat stránku', () => {
  it('historie a karty deníku na LIVE jsou statické importy', () => {
    const app = source('App.tsx');
    for (const name of ['LiveJournalHistory', 'JournalImportStatus', 'JournalSourceStatus']) {
      expect(app).not.toMatch(new RegExp(`const ${name} = React\\.lazy`));
      expect(app).toMatch(new RegExp(`import ${name} from './components/${name}'`));
    }
  });

  it('LIVE desk ani přehled neobsahují lazy komponenty ani dynamický import', () => {
    for (const path of ['components/TradovateLiveDesk.tsx', 'components/LiveCopyTradeOverview.tsx']) {
      const text = source(path);
      expect(text, path).not.toMatch(/React\.lazy|\blazy\(/);
      expect(text, path).not.toMatch(/\bimport\(/);
    }
  });

  it('přednačtený LIVE desk se vykreslí bez Suspense a volba typu se během připojení nemění', () => {
    const app = source('App.tsx');
    expect(app).toMatch(/let loadedLiveDesk: LiveDeskModule \| null = null;/);
    expect(app).toMatch(/React\.useState\(\(\) => loadedLiveDesk\?\.default \?\? LazyLiveDesk\)/);
  });

  it('karty deníku se vykreslují v LIVE desku až s daty, ne pod kostrou', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    const skeletonBranch = desk.indexOf(') : !liveData ? (');
    const statusRender = desk.lastIndexOf('{journalStatus}');
    expect(skeletonBranch).toBeGreaterThan(0);
    expect(statusRender).toBeGreaterThan(skeletonBranch);
    expect(source('App.tsx')).not.toMatch(/activePage === 'live' && dashboardMode !== 'backtesting' && \(\s*<div className="mx-auto mt-4/);
  });
});

describe('studený start: další zdroje probliknutí', () => {
  it('„Žádné kopírovací skupiny“ jen po načtení knihovny', () => {
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toMatch(/groups\.length === 0 && groupLibraryState === 'loading' \? \(/);
  });

  it('banner „nemá dokončený plán“ čeká na načtení plánů účtů', () => {
    expect(source('components/TradovateLiveDesk.tsx')).toMatch(/if \(!liveData \|\| live\.profilesLoaded === false\) return \[\];/);
  });
});

describe('automatické uložení účtů jen po úpravě v aplikaci', () => {
  it('načtení z mezipaměti ani obnova z DB účty neukládají', () => {
    const app = source('App.tsx');
    expect(app).toMatch(/if \(!isAccountsDirty\.current\) return;/);
    for (const handler of [
      'onUpdate={(next) => updateAccountsLocally([...accounts.filter(a => !isBacktestAccount(a)), ...next])}',
      'onUpdate={(next) => updateAccountsLocally([...next, ...accounts.filter(isBacktestAccount)])}',
      'onCreateAccount={(account) => updateAccountsLocally(prev => [...prev, account])}',
      'onUpdateAccounts={updateAccountsLocally}',
    ]) expect(app).toContain(handler);
  });
});

describe('iPhone: menu Více přednačte LIVE', () => {
  it('nativní most přijímá jen přípravu LIVE a nikdy nenaviguje', () => {
    const app = source('App.tsx');
    expect(app).toMatch(/prepare: \(page\) => \{\s*if \(page === 'live'\) nativeActions\.current\.prepareLive\(\);\s*\}/);
    const swift = source('capacitor-ios/App/App/AlphaTradeShellViewController.swift');
    expect(swift).toContain(`if !isBacktest && !tabSlots.contains("live") {`);
    expect(swift).toContain(`evaluate("window.__alphaTradeNative?.prepare?.('live')")`);
  });
});
