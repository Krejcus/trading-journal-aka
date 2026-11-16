/**
 * Vývojový místní proces: appka v prohlížeči (zkušební stránka tests/qa/rithmic-live.html)
 * ↔ WebSocket na 127.0.0.1 ↔ Rithmic adaptér. Jen systém „Rithmic Test" (simulované peníze),
 * jeden účet, povolený kontrakt, strop množství. Slouží k měření „klik → čára v grafu".
 * S kopírkou ani s workerem nemá nic společného.
 *
 * Spuštění: RITHMIC_USER=... npx tsx scripts/rithmic/devTradeServer.ts [--contract ESZ6] [--port 3311]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../../services/rithmic/rithmicBroker';
import { RithmicCandleBuilder } from '../../services/rithmic/rithmicCandleBuilder';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import { LocalExec, type LocalExecCommand } from '../../services/rithmic/localExec';
import type { ProtectionState, ProtectionStore } from '../../services/rithmic/rithmicProtection';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const SYSTEM = 'Rithmic Test';
const URL = 'wss://rituz00100.rithmic.com:443';
const KEYCHAIN_SERVICE = 'alphatrade-rithmic-test';
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CONTRACT = arg('contract', 'ESZ6');
const PORT = Number(arg('port', '3311'));
const QA_PORT = arg('qa-port', '4185');
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${QA_PORT}`, `http://localhost:${QA_PORT}`]);

function credentials(): { user: string; password: string } {
  const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  const user = process.env.RITHMIC_USER;
  if (!user || !password) throw new Error('Chybí RITHMIC_USER nebo heslo v Klíčence');
  return { user, password };
}

function fileProtectionStore(path: string): ProtectionStore {
  return {
    load: async () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as ProtectionState;
      } catch {
        return null;
      }
    },
    save: async (state) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    },
  };
}

async function main(): Promise<void> {
  if (SYSTEM !== 'Rithmic Test') throw new Error('Tenhle proces smí jen na Rithmic Test');
  const creds = { ...credentials(), systemName: SYSTEM, appName: 'AlphaTrade', appVersion: '0.1.0' };
  const socketFactory = (url: string): RithmicSocketLike => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike;

  let entries: RithmicAccountRegistryEntry[] = [];
  let revision = 0;
  const registry = new RithmicAccountRegistry({
    load: async () => ({ entries: entries.map((e) => ({ ...e })), revision }),
    save: async (next, expected) => {
      if (expected !== revision) throw new Error('revision conflict');
      entries = next.map((e) => ({ ...e }));
      revision += 1;
    },
  });
  await registry.load();

  const results = join(dirname(fileURLToPath(import.meta.url)), 'results');
  // Odkaz na službu se doplní hned po vytvoření adaptéru; incidenty do té doby nevznikají.
  let exec: LocalExec | null = null;
  const broker = createRithmicBroker({
    url: URL, credentials: creds, socketFactory, registry,
    protectionStore: fileProtectionStore(join(results, 'dev-protection.json')),
    onIncident: (incident) => {
      console.log(`[incident] ${incident.kind}: ${incident.message}`);
      exec?.onIncident(incident);
    },
  });

  // Ceny: zvláštní spojení na ticker (adaptér ho nepoužívá). Jen pro zobrazení.
  const candles = new RithmicCandleBuilder();
  let tickCount = 0;
  /** Poslední obchod; když dlouho žádný nebyl, střed nabídky a poptávky. Jen pro zobrazení. */
  const displayPrice = (now: number): number | null => {
    const last = candles.lastPrice(CONTRACT, now, 3_600_000);
    if (last !== null) return last;
    const quote = candles.quote(CONTRACT, now, 3_600_000);
    return quote && quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null;
  };
  const clients = new Set<WebSocket>();
  const send = (socket: WebSocket, message: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (message: unknown): void => {
    const text = JSON.stringify(message);
    for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.send(text);
  };
  const ticker = new RithmicClient({
    url: URL, credentials: creds, socketFactory, requestTimeoutMs: 10_000,
    events: {
      onTick: (tick) => {
        if (tick.symbol !== CONTRACT) return;
        tickCount += 1;
        if (!candles.onTick(tick)) return;
        const now = Date.now();
        broadcast({ type: 'tick', symbol: CONTRACT, price: displayPrice(now), bar: candles.current(CONTRACT, now), at: now });
      },
      onPlantClosed: (plant, info) => console.log(`[ticker] spojení ${plant} zavřeno (${info.code ?? '?'})`),
    },
  });
  await ticker.connect(['ticker']);
  const ref = await ticker.referenceData(CONTRACT, 'CME');
  const tickSize = ref?.tickSize ?? 0.25;
  await ticker.subscribeMarketData(CONTRACT, 'CME');

  exec = new LocalExec({ broker, symbols: { [CONTRACT]: { tickSize } }, maxQuantity: 2 });
  exec.attach();
  await broker.start();
  if (broker.environment !== 'demo') throw new Error('Adaptér není v demo prostředí — končím');
  exec.subscribe((state) => broadcast({ type: 'state', state }));

  const server = new WebSocketServer({
    host: '127.0.0.1', port: PORT,
    verifyClient: ({ origin }: { origin?: string }) => Boolean(origin && ALLOWED_ORIGINS.has(origin)),
  });
  server.on('connection', (socket) => {
    clients.add(socket);
    const now = Date.now();
    send(socket, { type: 'hello', system: SYSTEM, symbol: CONTRACT, tickSize, pointValue: ref?.pointValue ?? null, price: displayPrice(now), bars: [...candles.finished(CONTRACT), ...(candles.current(CONTRACT, now) ? [candles.current(CONTRACT, now)] : [])] });
    send(socket, { type: 'state', state: exec!.state() });
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      void (async () => {
        const receivedAt = performance.now();
        let id: unknown = null;
        try {
          const message = JSON.parse(String(raw)) as { id?: unknown; command?: LocalExecCommand };
          id = message.id ?? null;
          if (!message.command || typeof message.command !== 'object') throw new Error('zpráva bez příkazu');
          const result = await exec!.execute(message.command);
          send(socket, { type: 'reply', id, ...result, serverMs: Math.round(performance.now() - receivedAt) });
        } catch (error) {
          send(socket, { type: 'reply', id, ok: false, sent: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  setInterval(() => console.log(`[ceny] ticků ${tickCount}, poslední cena ${displayPrice(Date.now())}`), 15_000).unref();
  console.log(`Místní proces běží: ws://127.0.0.1:${PORT} · ${SYSTEM} · ${CONTRACT} · účet ${broker.accountIds()[0]}`);
  const stop = (): void => {
    console.log('Končím (příkazy u Rithmicu zůstávají, jak jsou).');
    server.close();
    broker.stop();
    ticker.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error('SELHALO:', error instanceof Error ? error.message : error);
  process.exit(1);
});
