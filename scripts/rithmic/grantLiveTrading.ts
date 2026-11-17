/**
 * Vydá (nebo zruší) souhlas s obchodováním na SKUTEČNÉM systému Rithmicu pro místní službu.
 *
 * Spouští JEN člověk v terminálu: skript chce interaktivní terminál a opsání věty s číslem účtu.
 * Automat (skript, agent, roura) ho nespustí — bez terminálu hned skončí. Nic neposílá, nikam se
 * nepřihlašuje; jen zapíše soubor, který služba čte při startu a před každým vstupem.
 *
 *   npx tsx scripts/rithmic/grantLiveTrading.ts --system "LucidTrading" --user "LT-…" --account "LFE…" [--hours 12] [--max-quantity 1] [--allow-no-stop]
 *   npx tsx scripts/rithmic/grantLiveTrading.ts --revoke
 */
import { createInterface } from 'node:readline';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_CONSENT_MAX_HOURS, liveConsentPhrase, liveTradingConsentProblem, type LiveTradingConsent } from '../../services/rithmic/liveTradingConsent';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
const FILE = join(dirname(fileURLToPath(import.meta.url)), 'results', 'live-trading-consent.json');

if (process.argv.includes('--revoke')) {
  rmSync(FILE, { force: true });
  console.log('Souhlas zrušen. Běžící služba už nový vstup nepustí (zavření a správa ochrany fungují dál).');
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Souhlas smí vydat jen člověk v terminálu (tenhle běh nemá interaktivní terminál). Nic se nezapsalo.');
  process.exit(2);
}
const system = arg('system');
const user = arg('user');
const account = arg('account');
const hours = Number(arg('hours') ?? '12');
const maxQuantity = process.argv.includes('--max-quantity') ? Number(arg('max-quantity')) : 'rms';
if (!system || !user || !account) { console.error('Chybí --system, --user nebo --account.'); process.exit(2); }
if (!(hours > 0 && hours <= LIVE_CONSENT_MAX_HOURS)) { console.error(`--hours musí být 0–${LIVE_CONSENT_MAX_HOURS}.`); process.exit(2); }
if (maxQuantity !== 'rms' && (!Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 2_147_483_647)) { console.error('--max-quantity musí být kladné celé množství.'); process.exit(2); }
const requireStop = !process.argv.includes('--allow-no-stop');
const phrase = liveConsentPhrase(account);

console.log('\nSOUHLAS S OBCHODOVÁNÍM NA SKUTEČNÉM ÚČTU (místní služba AlphaTrade → Rithmic)');
console.log(`  systém:   ${system}`);
console.log(`  uživatel: ${user}`);
console.log(`  účet:     ${account}`);
console.log(`  platnost: ${hours} h   ·   strop: ${maxQuantity === 'rms' ? 'podle RMS účtu a produktu' : maxQuantity + ' ks, nejvýše podle RMS'}   ·   SL u vstupu: ${requireStop ? 'povinný' : 'NEPOVINNÝ'}`);
console.log('\nPo vydání bude služba spuštěná s --live-trading posílat na tento účet SKUTEČNÉ příkazy, které zadáš v appce.');
console.log('Riziko pravidel propky i ztrát neseš ty. Zrušení: --revoke (nebo smazat soubor).');
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question(`\nPro potvrzení opiš přesně:  ${phrase}\n> `, (answer) => {
  rl.close();
  if (answer.trim() !== phrase) { console.error('Věta nesouhlasí — nic se nezapsalo.'); process.exit(1); }
  const now = Date.now();
  const consent: LiveTradingConsent = { version: 2, system, user, account, grantedAt: now, expiresAt: now + hours * 3_600_000, maxQuantity, requireStop, phrase };
  const problem = liveTradingConsentProblem(consent, { system, user, accounts: [account], now });
  if (problem) { console.error(`Souhlas by nebyl platný: ${problem}`); process.exit(1); }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(consent, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
  console.log(`\nSouhlas vydán do ${new Date(consent.expiresAt).toLocaleString('cs-CZ')}. Službu spusť v terminálu s --live-trading (bez --read-only); při startu větu potvrdíš ještě jednou.`);
});
