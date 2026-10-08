import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

// Přímé přepnutí uživatele A→B (jiné okno, nový login bez odhlášení) dřív
// nechalo data A na obrazovce pod session B, dokud nedoběhl load() pro B.
describe('přepnutí uživatele A→B bez odhlášení', () => {
  it('obě cesty auth (getSession i onAuthStateChange) zahodí data A', () => {
    const switches = app.match(/clearCopierAgentStatusStore\(\);\n\s*if \(sessionRef\.current\) beginUserSwitch\(\);/g) ?? [];
    expect(switches).toHaveLength(2);
  });

  it('přepnutí resetuje stejná data jako odhlášení a drží načítací obrazovku', () => {
    expect(app).toMatch(/const beginUserSwitch = \(\) => \{\n\s*resetUserScopedState\(\);/);
    const begin = app.slice(app.indexOf('const beginUserSwitch'), app.indexOf('const beginUserSwitch') + 600);
    for (const step of ['setIsInitialLoadDone(false)', 'setLoading(true)', 'lastLoadedSessionId.current = null', 'setLoadedUserId(null)', 'setIsUserFromDb(false)']) {
      expect(begin).toContain(step);
    }
    // Odhlášení používá týž reset (jeden seznam, nic se nerozejde).
    expect(app).toMatch(/if \(event === 'SIGNED_OUT'\) \{[\s\S]*?resetUserScopedState\(\);[\s\S]*?clearAppStorage\(\);/);
    const reset = app.slice(app.indexOf('const resetUserScopedState'), app.indexOf('const beginUserSwitch'));
    for (const step of ['setTrades([])', 'setAccounts([])', 'isAccountsDirty.current = false', 'isFetchingRef.current = false', 'copierImportAbortRef.current?.abort()']) {
      expect(reset).toContain(step);
    }
  });

  it('data jiného uživatele než aktuální session se nevykreslí', () => {
    expect(app).toContain('const renderedUserMismatch = Boolean(session && currentUser.id !== DEFAULT_USER.id && currentUser.id !== session.user.id);');
    expect(app).toMatch(/\|\| renderedUserMismatch\) \{\n\s*return <QuantumLoader/);
  });
});
