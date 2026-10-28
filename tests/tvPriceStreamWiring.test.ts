import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
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
      'services/ibkrMarketData.ts',
      'services/ibkrPriceSource.ts',
      'services/tradingViewCdpSession.ts',
      'services/tradingViewPriceStream.ts',
    ]);
  });

  it('vlákno: knihovny jen ze svého allowlistu a žádné volání, které by poslalo příkaz nebo četlo účet IBKR', () => {
    const files = [...importGraph('scripts/copier/tvPriceStreamThread.ts')];
    const bare = new Set(files.flatMap(file => [...source(file).matchAll(/\bfrom\s+['"]([^.'"][^'"]*)['"]/g)].map(match => match[1])));
    for (const name of bare) {
      expect(name.startsWith('node:') || ['@supabase/supabase-js', '@stoqey/ib'].includes(name), name).toBe(true);
    }
    const forbidden = /\b(placeOrder|cancelOrder|reqGlobalCancel|reqOpenOrders|reqAllOpenOrders|reqAccountUpdates|reqAccountSummary|reqPositions|reqExecutions|reqPnL|reqManagedAccts|managedAccounts|reqIds)\b/;
    for (const file of files) expect(source(file), file).not.toMatch(forbidden);
  });

  it('bundle vlákna postavený jako v instalátoru naběhne jako Worker se zdrojem tv i ibkr', async () => {
    const installer = source('scripts/copier/mac-install.ts');
    const bannerSource = /const TV_PRICE_STREAM_BANNER = ([\s\S]*?);\n/.exec(installer)?.[1];
    expect(bannerSource).toBeTruthy();
    // Řetězcové literály spojené `+` — vyhodnotit bez eval: vzít obsah uvozovek.
    const banner = [...bannerSource!.matchAll(/(["'])((?:(?!\1).)*)\1/g)].map(match => match[2]).join('');
    expect(banner).toContain('const require = __atCreateRequire(import.meta.url);');
    const dir = mkdtempSync(join(tmpdir(), 'tv-price-stream-'));
    try {
      const outfile = join(dir, 'tv-price-stream.mjs');
      execFileSync(join(root, 'node_modules/.bin/esbuild'), [
        join(root, 'scripts/copier/tvPriceStreamThread.ts'),
        '--bundle', '--platform=node', '--format=esm', '--target=node20', `--banner:js=${banner}`, `--outfile=${outfile}`, '--log-level=error',
      ]);
      for (const priceSource of ['tv', 'ibkr']) {
        const thread = new Worker(outfile, {
          workerData: { priceSource }, stdout: true, stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
        });
        thread.stdout.resume();
        thread.stderr.resume();
        const outcome = await new Promise<string>(resolveOutcome => {
          const timer = setTimeout(() => resolveOutcome('timeout'), 8_000);
          thread.on('message', message => { if ((message as { type?: unknown })?.type === 'alive') { clearTimeout(timer); resolveOutcome('alive'); } });
          thread.on('error', error => { clearTimeout(timer); resolveOutcome(`error: ${error.message}`); });
          thread.on('exit', code => { clearTimeout(timer); resolveOutcome(`exit ${code}`); });
        });
        await thread.terminate();
        expect(outcome, priceSource).toBe('alive');
      }
      // Stejně postavený bundle vytvoří klienta IBKR (`new IBApi` v ESM), bez připojení.
      const probeEntry = join(dir, 'ibkr-client-entry.ts');
      writeFileSync(probeEntry, `import { createReadOnlyIbClient } from ${JSON.stringify(join(root, 'services/ibkrMarketData.ts'))};\n`
        + 'const client = createReadOnlyIbClient({ port: 4002, clientId: 99 }, {});\n'
        + 'console.log(JSON.stringify({ connected: client.isConnected(), keys: Object.keys(client).length }));\n');
      const probeOut = join(dir, 'ibkr-client.mjs');
      execFileSync(join(root, 'node_modules/.bin/esbuild'), [
        probeEntry, '--bundle', '--platform=node', '--format=esm', '--target=node20', `--banner:js=${banner}`, `--outfile=${probeOut}`, '--log-level=error',
      ]);
      expect(JSON.parse(execFileSync(process.execPath, [probeOut], { encoding: 'utf8' }).trim())).toEqual({ connected: false, keys: 11 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('svíčky dne z IBKR: vlákno je předá bez kopírování, čte je jen graf dne a hodnocení v pilotu', () => {
    const thread = source('scripts/copier/tvPriceStreamThread.ts');
    expect(thread).toContain("port.postMessage({ type: 'bars', root: bars.root, source: bars.source, contract: bars.contract, at: bars.at, bars: bars.bars }, [bars.bars.buffer]);");
    expect(thread).toContain('const IBKR_BARS_POST_PHASE_MS = 7_000;');
    expect(thread).toContain('schedulePostBars();');
    expect(thread).not.toMatch(/setInterval\(postBars/);
    expect(source('scripts/copier/pilot.ts')).toContain('phaseMs: TV_LIVE_BARS_PHASE_MS,');
    const pilot = source('scripts/copier/pilot.ts');
    expect(pilot.match(/latestBars\(/g)).toHaveLength(2);
    expect(pilot).toContain('return ibkr && ibkr.at >= Math.floor(Date.now() / 60_000) * 60_000 ? ibkr : readTradingViewBars(root);');
    expect(pilot).toContain('if (ibkr && barsContractMatchesSymbol(ibkr.contract, symbol)) return ibkr;');
    expect(pilot).toContain('return tv && !barsContractConflicts(tv.contract, symbol) ? tv : null;');
    // Mimo pilot (a hlídač, který ho poskytuje) nikdo svíčky z vlákna nečte.
    const users = execFileSync('git', ['grep', '-l', 'latestBars('], { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(file => !file.startsWith('tests/'));
    expect(users.sort()).toEqual(['scripts/copier/pilot.ts', 'server/tvPriceStreamSupervisor.ts']);
  }, 30_000);

  it('zdroj IBKR jen výslovně: pilot předá workerData, instalátor i reinstall ho zachovají', () => {
    const pilot = source('scripts/copier/pilot.ts');
    expect(pilot).toContain("process.env.ALPHATRADE_PRICE_SOURCE?.trim().toLowerCase() === 'ibkr' ? 'ibkr' : 'tv'");
    expect(pilot).toContain('priceSource: tvPriceSource,');
    expect(pilot).toContain('workerData: { priceSource },');
    const thread = source('scripts/copier/tvPriceStreamThread.ts');
    expect(thread).toContain("(workerData as { priceSource?: unknown } | null)?.priceSource === 'ibkr' ? 'ibkr' : 'tv'");
    const installer = source('scripts/copier/mac-install.ts');
    expect(installer).toContain("tvStreamEnabled && flags.get('price-source')?.trim().toLowerCase() === 'ibkr'");
    expect(installer).toContain('<key>ALPHATRADE_PRICE_SOURCE</key><string>ibkr</string>');
    const reinstall = source('scripts/copier/mac-reinstall-safe.sh');
    expect(reinstall).toContain('Print :EnvironmentVariables:ALPHATRADE_PRICE_SOURCE');
    expect(reinstall).toContain('TV_STREAM_ARGS+=(--price-source ibkr)');
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
    // CommonJS knihovna IBKR v ESM bundlu vlákna: bez `require` by vlákno při startu spadlo.
    expect(installer).toContain('`--banner:js=${TV_PRICE_STREAM_BANNER}`');
    expect(installer).toContain("const require = __atCreateRequire(import.meta.url);");
    expect(installer.indexOf('--banner:js=')).toBeLessThan(threadBuild);
    expect(installer.lastIndexOf('--banner:js=')).toBeLessThan(threadBuild);
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
