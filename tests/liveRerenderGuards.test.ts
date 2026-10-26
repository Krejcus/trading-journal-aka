import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

/** Všechny .ts/.tsx v app adresářích (bez testů a node_modules). */
const appSources = (): Array<[string, string]> => ['components', 'lib', 'services', 'server', 'hooks', 'utils']
  .flatMap(dir => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)))
  .concat(['App.tsx'])
  .map(path => [path, source(path)] as [string, string]);

// 26. 10. 2026 (docs/reviews/live-rerender-design-20261026.md, fáze 1a):
// telemetrie Tradovate API v `useTradovateLiveData` (App) překreslovala celou
// appku synchronně po každém začátku i konci požadavku. Odebírá ji jen panel API.
describe('LIVE: telemetrie API nepřekresluje App ani LIVE', () => {
  it('odběr telemetrie má jen hook panelu API', () => {
    const subscribers = appSources()
      .filter(([path, text]) => path !== 'lib/tradovateApiTelemetry.ts' && /\bsubscribeTradovateApiTelemetry\b/.test(text))
      .map(([path]) => path);
    expect(subscribers).toEqual(['components/useTradovateApiTelemetry.ts']);
  });

  it('hook telemetrie volá jen tělo panelu API, nikdo výš', () => {
    const callers = appSources().flatMap(([path, text]) => [...text.matchAll(/\buseTradovateApiTelemetry\(/g)]
      .map(match => ({ path, before: text.slice(0, match.index) })))
      .filter(call => call.path !== 'components/useTradovateApiTelemetry.ts');
    expect(callers.map(call => call.path)).toEqual(['components/LiveCopyTradeOverview.tsx']);
    // Volání leží v těle `LivePnlPanelBody` (poslední deklarace komponenty před ním).
    const lastComponent = [...callers[0].before.matchAll(/\n(?:export )?const ([A-Z][A-Za-z]+) = /g)].at(-1)?.[1];
    expect(lastComponent).toBe('LivePnlPanelBody');
  });

  it('useTradovateLiveData telemetrii nevrací ani neodebírá', () => {
    const hook = source('components/useTradovateLiveData.ts');
    expect(hook).not.toMatch(/\bapiTelemetry\b/);
    expect(hook).not.toMatch(/useSyncExternalStore/);
    expect(hook).not.toMatch(/useTradovateApiTelemetry/);
  });

  it('panel API odebírá telemetrii jen rozbalený', () => {
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toMatch(/\{open && <LivePnlPanelBody \{\.\.\.data\} \/>\}/);
    expect(overview).toMatch(/const LivePnlPanelBody = [^\n]*\n\s*const telemetry = useTradovateApiTelemetry\(\);/);
  });
});

// Kritik k fázi 1a: brány ARM/konfigurace čtou `armStatusRef.current.fresh`;
// čerstvost se počítá ze stavu (`freshnessNow`), ne z počtu renderů, a poll
// workeru se nesmí restartovat kvůli zobrazovacím datům.
describe('LIVE: příkazová cesta nezávisí na frekvenci renderu', () => {
  const desk = () => source('components/TradovateLiveDesk.tsx');

  it('armStatusRef se dál přepisuje v renderu ze stavu', () => {
    expect(desk()).toContain('armStatusRef.current = { status: agentStatus, fresh: agentStatusFresh && !agentStatusRestored };');
    expect(desk()).toContain('const agentStatusFresh = isCopierStatusFresh(agentStatusObservedAt, freshnessNow, agentStatusReadHealthy);');
  });

  it('sekundový tik čerstvosti zůstává (drží Date.now() v renderu, např. blokaci ON při zámku dne)', () => {
    expect(desk()).toContain('const timer = window.setInterval(() => setFreshnessNow(Date.now()), 1_000);');
  });

  it('závislosti efektu pollu workeru zůstávají beze změny', () => {
    expect(desk()).toContain('}, [acceptAgentStatus, agentClient, connectedConnectionIds, markAgentStatusStale, userId]);');
  });
});
