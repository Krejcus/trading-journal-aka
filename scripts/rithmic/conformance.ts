/**
 * Conformance u Rithmicu (osobní použití).
 *
 * Podle RAPI týmu (mail 16. 11. 2026): Rithmic vydá předponu k názvu aplikace;
 * aplikace se s názvem včetně předpony připojí k příkazům (order plant) i k datům
 * (ticker plant) v Rithmic Test a zůstane běžet, dokud to neověří.
 *
 * Tenhle skript dělá jen to: přihlásí oba planty, odebírá ceny jednoho kontraktu,
 * drží spojení (při pádu se po chvíli přihlásí znovu) a jednou za minutu vypíše stav.
 * NEPOSÍLÁ žádné příkazy. Jen systém „Rithmic Test".
 *
 * Spuštění (název přesně tak, jak ho Rithmic určí, včetně předpony):
 *   RITHMIC_USER=… npx tsx scripts/rithmic/conformance.ts --app-name "<predpona>AlphaTrade"
 * Ukončení: Ctrl+C.
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const SYSTEM = 'Rithmic Test';
const URL = 'wss://rituz00100.rithmic.com:443';
const KEYCHAIN_SERVICE = 'alphatrade-rithmic-test';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const appName = arg('app-name');
const appVersion = arg('app-version', '0.1.0')!;
const symbol = arg('symbol', 'ES')!;
const exchange = arg('exchange', 'CME')!;
if (!appName) {
  console.error('Chybí --app-name (název aplikace včetně předpony od Rithmicu).');
  process.exit(2);
}

function credentials(): { user: string; password: string } {
  try {
    const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const stored = /"acct"<blob>="([^"]*)"/.exec(meta)?.[1];
    const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    const user = process.env.RITHMIC_USER || stored;
    if (user && password) return { user, password };
  } catch {
    // chyba níže
  }
  console.error(`Chybí přihlášení v Klíčence (služba ${KEYCHAIN_SERVICE}).`);
  process.exit(2);
}

const stamp = () => new Date().toISOString();
let ticks = 0;
let lastTickAt = 0;
let connects = 0;
let drops = 0;
let stopping = false;
let client: RithmicClient | null = null;
let retryMs = 5_000;

async function connect(): Promise<void> {
  const creds = credentials();
  const next = new RithmicClient({
    url: URL,
    credentials: { ...creds, systemName: SYSTEM, appName: appName!, appVersion },
    socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
    events: {
      onTick: () => {
        ticks += 1;
        lastTickAt = Date.now();
      },
      onPlantClosed: (plant, info) => {
        if (stopping || client !== next) return;
        drops += 1;
        console.log(`${stamp()} spojení ${plant} spadlo (${info.code ?? '?'}${info.forcedLogout ? ', vynucené odhlášení' : ''}) — přihlásím se znovu`);
        client = null;
        next.close();
        if (info.forcedLogout) {
          console.log(`${stamp()} vynucené odhlášení: jiné přihlášení stejným účtem? Končím, spusť znovu ručně.`);
          process.exit(1);
        }
        setTimeout(() => void loop(), retryMs);
      },
      onAttention: (message) => console.log(`${stamp()} pozor: ${message}`),
    },
  });
  client = next;
  await next.connect(['order', 'ticker']);
  let contract = await next.frontMonthContract(symbol, exchange).catch(() => null);
  if (!contract) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    contract = (await next.searchSymbols(symbol, exchange))
      .filter((r) => r.productCode === symbol && !/[ :-]/.test(r.symbol) && r.expirationDate >= today)
      .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate))[0]?.symbol ?? null;
  }
  if (contract) await next.subscribeMarketData(contract, exchange);
  connects += 1;
  retryMs = 5_000;
  console.log(`${stamp()} připojeno jako "${appName}" v${appVersion}: order + ticker, účty ${next.accounts.map((a) => a.accountId).join(', ') || '—'}, data ${contract ?? 'žádný kontrakt'}`);
}

async function loop(): Promise<void> {
  if (stopping) return;
  try {
    await connect();
  } catch (error) {
    client = null;
    console.log(`${stamp()} připojení selhalo: ${(error as Error).message} — další pokus za ${Math.round(retryMs / 1000)} s`);
    setTimeout(() => void loop(), retryMs);
    retryMs = Math.min(retryMs * 2, 120_000);
  }
}

setInterval(() => {
  const order = client?.isConnected('order') ? 'ano' : 'NE';
  const ticker = client?.isConnected('ticker') ? 'ano' : 'NE';
  const age = lastTickAt ? `${Math.round((Date.now() - lastTickAt) / 1000)} s` : '—';
  console.log(`${stamp()} stav: order ${order}, ticker ${ticker}, ticků ${ticks} (poslední před ${age}), připojení ${connects}, pádů ${drops}`);
}, 60_000);

process.on('SIGINT', () => {
  stopping = true;
  console.log(`${stamp()} končím`);
  client?.close();
  setTimeout(() => process.exit(0), 300);
});

console.log(`${stamp()} conformance: systém ${SYSTEM}, aplikace "${appName}". Neposílám žádné příkazy. Ukončení Ctrl+C.`);
void loop();
