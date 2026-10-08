import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveColdReadsPending } from '../lib/liveColdReveal';

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
    expect(desk).toContain("{tab === 'connections' || requiresConnection || renderedLiveError || (!checkingConnection && liveData && !holdColdReveal) ? journalStatus : null}");
    expect(desk.match(/journalStatus\b/g)?.length).toBe(3); // typ propu, destrukturace, jediný render
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
    // Vlastník úpravy: nikdy neuložit úpravu uživatele A pod B; odhlášení příznak maže.
    expect(app).toMatch(/if \(accountsDirtyOwnerRef\.current !== session\.user\.id\) \{/);
    expect(app).toMatch(/isPrepsDirty\.current = false;\n\s*isAccountsDirty\.current = false;\n\s*accountsDirtyOwnerRef\.current = null;/);
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
    expect(app).toMatch(/prepare: \(page\) => \{\s*if \(page === 'live'\) nativeActions\.current\.prepareLive\(\{ speculative: true \}\);\s*\}/);
    const swift = source('capacitor-ios/App/App/AlphaTradeShellViewController.swift');
    expect(swift).toContain(`if !isBacktest && !tabSlots.contains("live") {`);
    expect(swift).toContain(`evaluate("window.__alphaTradeNative?.prepare?.('live')")`);
  });
});

describe('iPhone: kryt soukromí před prvním nativním čtením', () => {
  it('je neprůhledný i v Auroře (ne průsvitné --bg-page)', () => {
    const gate = source('components/NativePrivacyGate.tsx');
    expect(gate).toContain('bg-[var(--aurora-base,#020617)]');
    expect(gate).not.toMatch(/fixed inset-0 z-\[10000\] bg-\[var\(--bg-page/);
    const css = source('index.css');
    expect(css).toMatch(/--aurora-base: #05070f !important;/);
    expect(css).toMatch(/--aurora-base: #eceff7 !important;/);
  });
});

describe('studený start: přehled se odkryje jednou, až dorazí všechna připojení', () => {
  it('drží kostru, dokud první úplné čtení některého připojení běží', () => {
    expect(liveColdReadsPending(false, true, ['a', 'b'], { a: { pending: false }, b: { pending: true } })).toBe(true);
    expect(liveColdReadsPending(false, true, ['a', 'b'], { a: { pending: false }, b: { pending: false } })).toBe(false);
  });
  it('nečeká na připojení bez rozběhnutého čtení (backoff) ani po prvním odkrytí', () => {
    expect(liveColdReadsPending(false, true, ['a', 'b'], { a: { pending: false } })).toBe(false);
    expect(liveColdReadsPending(true, true, ['a'], { a: { pending: true } })).toBe(false);
    expect(liveColdReadsPending(false, false, ['a'], { a: { pending: true } })).toBe(false);
  });
  it('brána má strop a návrat s daty nečeká', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toContain('const coldRevealDoneRef = useRef(liveData != null);');
    expect(desk).toContain('setColdRevealCapReached(true), LIVE_COLD_REVEAL_CAP_MS)');
    expect(desk).toContain(') : !liveData || holdColdReveal ? (');
  });
});
