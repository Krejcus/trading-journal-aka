/**
 * Zkouška přihlášení do JINÉHO systému Rithmicu než Rithmic Test (např. účet propky) — JEN ČTENÍ.
 *
 * Co dělá: jednou se přihlásí k příkazům (order plant) pod názvem `fikr:AlphaTrade`, vypíše účty,
 * stav RMS a počet pracujících příkazů, volitelně na pár sekund odebere ceny jednoho kontraktu,
 * a odhlásí se. NEPOSÍLÁ žádné příkazy, nic nemění, nepřihlašuje se opakovaně (při neúspěchu skončí —
 * opakované pokusy by mohly přihlášení u správce systému zablokovat).
 *
 * Heslo se bere jen z Klíčenky macOS (nikdy z příkazové řádky ani z chatu):
 *   security add-generic-password -s alphatrade-rithmic-prop -a "<uživatel u Rithmicu>" -w
 *
 * Spuštění:
 *   npx tsx scripts/rithmic/loginProbe.ts --system "<název systému od propky>" \
 *     [--user <jméno>] [--gateway rprotocol-de.rithmic.com] [--keychain alphatrade-rithmic-prop] [--symbol MNQ] [--no-data]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SYSTEM = arg('system');
const GATEWAY = arg('gateway', 'rprotocol-de.rithmic.com')!;
const KEYCHAIN = arg('keychain', 'alphatrade-rithmic-prop')!;
const SYMBOL = arg('symbol', 'MNQ')!;
const WITH_DATA = !process.argv.includes('--no-data');
const APP_NAME = 'fikr:AlphaTrade';

if (!SYSTEM) {
  console.error('Chybí --system (název systému Rithmicu přesně tak, jak ho uvádí propka, např. "Rithmic Paper Trading").');
  process.exit(2);
}
if (SYSTEM === 'Rithmic Test') {
  console.error('Pro Rithmic Test použij ostatní skripty; tenhle je na zkoušku jiného systému.');
  process.exit(2);
}
if (!/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) {
  console.error(`Neznámá brána ${GATEWAY} — povolené jsou jen rprotocol*.rithmic.com z mailu Rithmicu.`);
  process.exit(2);
}

function credentials(): { user: string; password: string } {
  try {
    const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Jméno není tajné: jde zadat i přepínačem --user (heslo se bere jen z Klíčenky).
    const user = arg('user') ?? /"acct"<blob>="([^"]*)"/.exec(meta)?.[1];
    const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    if (user && password) return { user, password };
  } catch {
    // hláška níže
  }
  console.error(`V Klíčence chybí přihlášení (služba ${KEYCHAIN}). Ulož ho: security add-generic-password -s ${KEYCHAIN} -a "<uživatel>" -w`);
  process.exit(2);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const creds = credentials();
  let ticks = 0;
  const client = new RithmicClient({
    url: `wss://${GATEWAY}:443`,
    credentials: { ...creds, systemName: SYSTEM, appName: APP_NAME, appVersion: '0.1.0' },
    socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
    requestTimeoutMs: 15_000,
    events: {
      onTick: () => { ticks += 1; },
      onPlantClosed: (plant, info) => console.log(`spojení ${plant} zavřeno (${info.code ?? '?'}${info.forcedLogout ? ', vynucené odhlášení' : ''})`),
      onAttention: (message) => console.log(`pozor: ${message}`),
    },
  });
  console.log(`Zkouším přihlášení: systém "${SYSTEM}", brána ${GATEWAY}, aplikace "${APP_NAME}", uživatel ${creds.user}, heslo z Klíčenky (${KEYCHAIN}). Jen čtení.`);
  try {
    await client.connect(['order']);
  } catch (error) {
    console.log(`\nPŘIHLÁŠENÍ K PŘÍKAZŮM SELHALO: ${error instanceof Error ? error.message : String(error)}`);
    console.log('Nic dalšího nezkouším. Možné příčiny: špatný název systému nebo údaje, jiné současné přihlášení, nebo správce systému aplikacím přes API přístup nepovolil.');
    client.close();
    setTimeout(() => process.exit(1), 300);
    return;
  }
  console.log(`\nPŘIHLÁŠENÍ K PŘÍKAZŮM PROŠLO. Účty: ${client.accounts.map((a) => `${a.accountId} (FCM ${a.fcmId}, IB ${a.ibId})`).join('; ') || '—'}`);
  try {
    const rms = await client.accountRmsInfo();
    for (const row of rms) console.log(`RMS: účet ${String(row.account_id ?? '?')} stav ${String(row.status ?? '?')}${row.loss_limit !== undefined ? `, limit ztráty ${String(row.loss_limit)}` : ''}`);
  } catch (error) { console.log(`RMS se nepodařilo přečíst: ${(error as Error).message}`); }
  for (const account of client.accounts) {
    try {
      const open = await client.showOrders(account.accountId);
      console.log(`Účet ${account.accountId}: řádků ve snímku příkazů ${open.length}`);
    } catch (error) { console.log(`Příkazy účtu ${account.accountId} se nepodařilo přečíst: ${(error as Error).message}`); }
  }
  console.log(`Trade route CME: ${client.hasTradeRoute('CME') ? 'ano' : 'ne'}`);
  if (WITH_DATA) {
    try {
      await client.connect(['ticker']);
      const contract = await client.frontMonthContract(SYMBOL, 'CME');
      if (contract) {
        await client.subscribeMarketData(contract, 'CME');
        await wait(8_000);
        console.log(`Data ${contract}: za 8 s přišlo ${ticks} zpráv${ticks === 0 ? ' (trh může stát, nebo data přes API nejsou povolená)' : ''}`);
      } else console.log(`Kontrakt pro ${SYMBOL} se nepodařilo zjistit.`);
    } catch (error) { console.log(`PŘIHLÁŠENÍ K DATŮM SELHALO: ${(error as Error).message}`); }
  }
  client.close();
  console.log('\nOdhlášeno. Žádný příkaz nebyl odeslán.');
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error instanceof Error ? error.message : error); process.exit(1); });
