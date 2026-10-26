import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import { tvPriceStreamConfigFromRealtime } from '../server/tvPriceStreamSupervisor';

const root = join(__dirname, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

/** Všechny relativní importy souboru rekurzivně (jen zdroje v repu). */
const importGraph = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // `import … from`, `export … from`, side-effect `import './x'` i dynamický `import('./x')`.
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), match[1].replace(/\.js$/, ''));
      const candidate = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(path => existsSync(path));
      if (candidate) visit(candidate);
    }
  };
  visit(join(root, entry));
  return new Set([...seen].map(path => path.slice(root.length + 1)));
};

describe('kanál ceny z TV — zapojení do workeru (krok 2)', () => {
  it('vlákno importuje jen svůj allowlist — nic z kopírky, brokera, tajemství ani workeru', () => {
    expect([...importGraph('scripts/copier/tvPriceStreamThread.ts')].sort()).toEqual([
      'lib/tvPriceMessage.ts',
      'scripts/copier/tvPriceStreamThread.ts',
      'services/tradingViewCdpSession.ts',
      'services/tradingViewPriceStream.ts',
    ]);
  });

  it('vlákno ani jádro streamu TV nikdy nespouští ani neukončují', () => {
    for (const path of ['scripts/copier/tvPriceStreamThread.ts', 'services/tradingViewPriceStream.ts', 'services/tradingViewCdpSession.ts']) {
      expect(source(path), path).not.toMatch(/ensureTradingViewCdp|restartTradingViewWithCdp|launchTradingView|osascript/);
    }
  });

  it('instalátor staví vlákno jako samostatný bundle vedle workeru, a to PŘED bundlem workeru', () => {
    const installer = source('scripts/copier/mac-install.ts');
    expect(installer).toContain("resolve(projectRoot, 'scripts/copier/tvPriceStreamThread.ts')");
    expect(installer).toContain("resolve(pilotRoot, 'tv-price-stream.mjs')");
    const threadBuild = installer.indexOf('`--outfile=${tvPriceStreamPath}`');
    const workerBuild = installer.indexOf('`--outfile=${runtimePath}`');
    expect(threadBuild).toBeGreaterThan(0);
    expect(threadBuild).toBeLessThan(workerBuild);
  });

  it('zapnutí přežije reinstall: přepínač instalátoru a zachování v bezpečném reinstallu', () => {
    const installer = source('scripts/copier/mac-install.ts');
    expect(installer).toContain("flags.get('tv-stream')?.trim().toLowerCase() === 'on'");
    expect(installer).toContain("<key>ALPHATRADE_TV_STREAM</key><string>on</string>");
    const reinstall = source('scripts/copier/mac-reinstall-safe.sh');
    expect(reinstall).toContain('Print :EnvironmentVariables:ALPHATRADE_TV_STREAM');
    expect(reinstall).toContain('"${TV_STREAM_ARGS[@]}"');
  });

  it('worker spouští hlídač jen při ALPHATRADE_TV_STREAM=on a s existujícím bundlem, při ukončení ho zastaví', () => {
    const pilot = source('scripts/copier/pilot.ts');
    expect(pilot).toContain("process.env.ALPHATRADE_TV_STREAM?.trim().toLowerCase() === 'on'");
    expect(pilot).toContain('existsSync(tvPriceStreamBundle)');
    expect(pilot).toContain("new URL('./tv-price-stream.mjs', import.meta.url)");
    expect(pilot).toContain('tvPriceStream?.stop();');
    expect(pilot).toContain('stdout: true, stderr: true');
    // Nikdy nespouštět bundle workeru jako vlákno.
    expect(pilot).not.toMatch(/new Worker\((?!tvPriceStreamBundle)/);
  });

  it('konfigurace z realtime: bez tématu nebo klíče = vypnuto (serverový vypínač)', () => {
    const realtime = { url: 'https://x.supabase.co', anonKey: 'anon', topic: 'copier-kick-d1', priceTopic: 'tv-price-abc', priceKey: 'key' };
    expect(tvPriceStreamConfigFromRealtime(realtime, { targetId: 'T1', chartId: 'C1' })).toEqual({
      enabled: true, url: 'https://x.supabase.co', anonKey: 'anon', topic: 'tv-price-abc', key: 'key', excludeTargetId: 'T1', excludeChartId: 'C1',
    });
    expect(tvPriceStreamConfigFromRealtime({ ...realtime, priceKey: undefined })).toEqual({ enabled: false });
    expect(tvPriceStreamConfigFromRealtime({ ...realtime, priceTopic: '' })).toEqual({ enabled: false });
    expect(tvPriceStreamConfigFromRealtime(null)).toEqual({ enabled: false });
    expect(tvPriceStreamConfigFromRealtime('nonsense')).toEqual({ enabled: false });
  });

  it('relay předá realtime konfiguraci synchronně a výjimka posluchače poll nezastaví', async () => {
    let polls = 0;
    const seen: unknown[] = [];
    const realtime = { url: 'https://example.supabase.co', anonKey: 'anon', topic: 'copier-kick-d1', priceTopic: 'tv-price-x', priceKey: 'k' };
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { action: string };
      if (body.action === 'poll') polls += 1;
      return { ok: true, json: async () => ({ command: null, realtime }) };
    }) as unknown as typeof fetch;
    const relay = startMacCopierCommandRelay({
      apiOrigin: 'https://example.test',
      authorizationHeader: async () => 'Device x',
      agent: { status: () => ({}) as never, execute: async () => ({}) as never, origin: '', beginShutdown: vi.fn(), close: async () => undefined },
      fetchImpl,
      pollMs: 500,
      onRealtimeConfig: value => {
        seen.push(value);
        throw new Error('display add-on failed');
      },
    });
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(seen[0]).toEqual(realtime);
    await relay.close();
  });

  it('relay volá posluchače před čekáním na kick a nikdy na něj nečeká', () => {
    const relay = source('server/macCopierCommandRelay.ts');
    expect(relay.match(/notifyRealtimeConfig\(response\.realtime\);\s*await maybeSubscribeKick\(response\.realtime\);/g)).toHaveLength(2);
    expect(relay).not.toMatch(/await\s+notifyRealtimeConfig|await\s+options\.onRealtimeConfig/);
  });
});
