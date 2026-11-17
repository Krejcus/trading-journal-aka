/**
 * Měření historie svíček u Rithmicu (jen čtení, jen history plant — nepřihlašuje se k příkazům ani k cenám).
 * Zjišťuje: význam `marker`, kolik minutových a denních svíček systém vrátí a jak hluboko do minulosti.
 *   npx tsx scripts/rithmic/measureHistory.ts --system "LucidTrading" --user "<jméno>" [--symbol MNQZ6] [--gateway rprotocol-de.rithmic.com]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';
import { readOnlyViolation } from '../../services/rithmic/readOnlyGuard';

const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const SYSTEM = arg('system')!;
const USER = arg('user') ?? process.env.RITHMIC_USER;
const SYMBOL = arg('symbol', 'MNQZ6')!;
const TEST = SYSTEM === 'Rithmic Test';
const GATEWAY = arg('gateway', 'rprotocol-de.rithmic.com')!;
const KEYCHAIN = arg('keychain', TEST ? 'alphatrade-rithmic-test' : 'alphatrade-rithmic-prop')!;
if (!SYSTEM || !USER) { console.error('Chybí --system nebo --user.'); process.exit(2); }
if (!TEST && !/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) { console.error('Neznámá brána.'); process.exit(2); }
const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
const client = new RithmicClient({
  url: TEST ? 'wss://rituz00100.rithmic.com:443' : `wss://${GATEWAY}:443`,
  credentials: { user: USER, password, systemName: SYSTEM, appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  requestTimeoutMs: 30_000,
  socketFactory: (url) => {
    const socket = new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike;
    const raw = socket.send.bind(socket);
    socket.send = (data: Uint8Array) => { const bad = readOnlyViolation(data); if (bad !== null) throw new Error(`jen čtení: šablona ${bad}`); raw(data); };
    return socket;
  },
});
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
(async () => {
  await client.connect(['history']);
  const now = Math.floor(Date.now() / 1000);
  const probe = async (label: string, barType: 'MINUTE_BAR' | 'DAILY_BAR', period: number, fromSec: number, toSec: number) => {
    const t0 = Date.now();
    try {
      const bars = await client.timeBarReplay({ symbol: SYMBOL, exchange: 'CME', barType, period, fromSec, toSec });
      const first = bars[0]; const last = bars.at(-1);
      console.log(`${label}: ${bars.length} svíček za ${Date.now() - t0} ms${first ? ` · první marker ${first.marker} (${iso(first.marker)}) period "${first.period}" · poslední ${iso(last!.marker)} close ${last!.close}` : ''}`);
      return bars;
    } catch (error) { console.log(`${label}: CHYBA ${(error as Error).message} (${Date.now() - t0} ms)`); return []; }
  };
  const recent = await probe('1m posledních 30 min', 'MINUTE_BAR', 1, now - 1_800, now);
  if (recent.length >= 2) console.log(`  rozestup markerů: ${recent[1].marker - recent[0].marker} s · teď ${iso(now)} · poslední marker ${iso(recent.at(-1)!.marker)}`);
  await probe('1m dnešek (24 h)', 'MINUTE_BAR', 1, now - 86_400, now);
  for (const days of [7, 30, 90, 365]) await probe(`1m hodina před ${days} dny`, 'MINUTE_BAR', 1, now - days * 86_400, now - days * 86_400 + 3_600);
  await probe('1m týden zpět (celý)', 'MINUTE_BAR', 1, now - 7 * 86_400, now);
  await probe('denní 2 roky', 'DAILY_BAR', 1, now - 730 * 86_400, now);
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error instanceof Error ? error.message : error); client.close(); setTimeout(() => process.exit(1), 300); });
