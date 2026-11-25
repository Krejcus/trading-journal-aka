/**
 * Vývojový místní proces: appka v prohlížeči (zkušební stránka tests/qa/rithmic-live.html)
 * ↔ WebSocket na 127.0.0.1 ↔ Rithmic adaptér. Jen systém „Rithmic Test" (simulované peníze),
 * jeden účet, povolený kontrakt, strop množství. Slouží k měření „klik → čára v grafu".
 * S kopírkou ani s workerem nemá nic společného.
 *
 * Spuštění: RITHMIC_USER=... npx tsx scripts/rithmic/devTradeServer.ts [--contract ESZ6] [--port 3311]
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { commandStatus } from '../../services/rithmic/rithmicCommandStatus';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { readOnlyViolation } from '../../services/rithmic/readOnlyGuard';
import { scopeProblem, type DeviceScope } from '../../services/rithmic/devicePairing';
import { createDeviceGateway, fileDeviceStore } from '../../services/rithmic/deviceGateway';
import { RMS_LIMITS_MAX_AGE_MS, RMS_LOGINS_PER_HOUR_CAP, RMS_QUERY_WEEKLY_CAP, rmsLimitsReadDue, rmsLoginAllowed, spendRmsQuery } from '../../services/rithmic/rmsQueryBudget';
import { liveConsentPhrase, liveTradingConsentProblem, type LiveTradingConsent } from '../../services/rithmic/liveTradingConsent';
import WebSocket, { WebSocketServer } from 'ws';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../../services/rithmic/rithmicBroker';
import { RithmicCandleBuilder } from '../../services/rithmic/rithmicCandleBuilder';
import { barRepairWindow, mergeRepairedBars, mergeRepairWindows, repairedBarsFrom, type BarRepairWindow } from '../../services/rithmic/barRepair';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import { createRithmicAlertWatch, type AlertWatchPersisted } from '../../services/rithmic/alertWatch';
import { signPriceAlertWatchRequest } from '../../server/priceAlertWatchKey';
import { LocalExec, type LocalExecCommand } from '../../services/rithmic/localExec';
import type { ProtectionState, ProtectionStore } from '../../services/rithmic/rithmicProtection';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const cli = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
const SYSTEM = cli('system') ?? 'Rithmic Test';
/**
 * Jen pro čtení: graf a stav účtu, ŽÁDNÉ příkazy. Jiný systém než Rithmic Test jde spustit JEN takto.
 * Pojistky jsou tři a nezávislé: (1) na drátě — odejdou jen výslovně povolené čtecí šablony (services/rithmic/readOnlyGuard.ts),
 * (2) místní služba příkazy mimo Rithmic Test odmítá, (3) stránka je nenabízí.
 */
const READ_ONLY = process.argv.includes('--read-only');
/**
 * Obchodování na SKUTEČNÉM systému. Výchozí stav je vypnuto. Zapne ho jen kombinace: tento přepínač + platný
 * souhlas vydaný člověkem v terminálu (scripts/rithmic/grantLiveTrading.ts) pro přesně tento systém, uživatele
 * a jediný účet přihlášení. Souhlas se čte znovu před každým vstupem — smazání nebo vypršení zastaví nové vstupy.
 */
/**
 * Jen zavírání na SKUTEČNÉM systému, bez souhlasu s obchodováním: pro případ, že pozice zůstala otevřená a souhlas
 * vypršel (nebo služba spadla). Vstupy, přikoupení a posun čekajících vstupů služba odmítá; zavření, zrušení
 * vlastních příkazů, částečné zavření a správa SL/TP fungují. I tohle spouští jen člověk u terminálu.
 */
const CLOSE_ONLY = process.argv.includes('--close-only');
const LIVE_TRADING = process.argv.includes('--live-trading') || CLOSE_ONLY;
/** Kolik hodin dokončených minutových svíček si stránka po připojení vezme z historie Rithmicu. */
const HISTORY_HOURS = 168;
const GATEWAY = cli('gateway') ?? 'rprotocol-de.rithmic.com';
const APP_NAME = (() => { const i = process.argv.indexOf('--app-name'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'fikr:AlphaTrade'; })();
const URL = SYSTEM === 'Rithmic Test' ? 'wss://rituz00100.rithmic.com:443' : `wss://${GATEWAY}:443`;
const KEYCHAIN_SERVICE = cli('keychain') ?? (SYSTEM === 'Rithmic Test' ? 'alphatrade-rithmic-test' : 'alphatrade-rithmic-prop');
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const requestedContract = arg('contract', 'ESZ6').toUpperCase();
/**
 * Porty podle systému: skutečný účet (Lucid) má stálé místo, kam se připojuje appka na PC (3311) i telefon (3313 přes
 * Tailscale Serve). Rithmic Test běží VEDLE něj na vlastních portech (3321 / 3323) jen pro zkoušky a sadu měření —
 * oba systémy mají jiného uživatele Rithmicu, takže se přihlášení nepřetahují.
 */
const IS_TEST_SYSTEM = SYSTEM === 'Rithmic Test';
const PORT = Number(arg('port', IS_TEST_SYSTEM ? '3321' : '3311'));
const QA_PORT = arg('qa-port', '4185');
/** Port pro spárovaná zařízení (telefon přes Tailscale Serve). Bez `--mobile` se neotevírá. */
const MOBILE_PORT: number | null = process.argv.includes('--mobile') ? Number(arg('mobile-port', IS_TEST_SYSTEM ? '3323' : '3313')) : null;
/**
 * Přihlašovací jméno Tailscale (e-mail účtu), které smí port pro zařízení použít — viz `tailscaleLogin` v bráně.
 * Doporučeno vždy; bez něj port přijme spojení od kohokoli, kdo se k němu v síti Tailscale dostane (a ověřuje jen klíč).
 */
const TAILSCALE_LOGIN: string | null = cli('tailscale-login') ?? null;
/** Původ stránky v nativní appce (Capacitor) a v prohlížeči přes Tailscale; skutečné ověření je klíč zařízení. */
const MOBILE_ORIGINS = new Set(['capacitor://localhost', ...(process.env.RITHMIC_DEV_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)]);
// Další povolené adresy stránky (např. https://<mac>.<tailnet>.ts.net přes Tailscale Serve):
// RITHMIC_DEV_ORIGINS=https://a.ts.net,https://b.ts.net. Proces dál poslouchá jen na 127.0.0.1.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${QA_PORT}`, `http://localhost:${QA_PORT}`,
  // Vývojová appka (záložka LIVE) a produkční appka na Vercelu (rozhodnutí Filipa 19. 11. 2026). Přístup dál
  // chce i token z tohoto Macu; náhledy Vercelu (jiné adresy) sem nepatří.
  'http://localhost:3000', 'http://127.0.0.1:3000', 'https://alphatrade-mentor-15.vercel.app',
  ...(process.env.RITHMIC_DEV_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
]);

function credentials(): { user: string; password: string } {
  const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  const user = cli('user') ?? process.env.RITHMIC_USER;
  if (!user || !password) throw new Error('Chybí RITHMIC_USER nebo heslo v Klíčence');
  return { user, password };
}

function fileProtectionStore(path: string): ProtectionStore {
  return {
    load: async () => {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        // Jen „soubor neexistuje" je první spuštění. Cokoli jiného NENÍ prázdný stav.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`záznam ochrany nejde přečíst (${(error as Error).message})`);
      }
      const parsed = JSON.parse(text) as ProtectionState; // poškozený soubor = chyba, ne „žádné záznamy"
      if (!parsed || !Array.isArray(parsed.brackets) || !Array.isArray(parsed.flattens)) throw new Error('záznam ochrany má neplatný tvar');
      return parsed;
    },
    save: async (state) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    },
  };
}

async function main(): Promise<void> {
  let CONTRACT = requestedContract;
  if (LIVE_TRADING && READ_ONLY) throw new Error('--live-trading a --read-only se vylučují');
  if (LIVE_TRADING && SYSTEM === 'Rithmic Test') throw new Error('--live-trading je jen pro skutečný systém; Rithmic Test ho nepotřebuje');
  if (SYSTEM !== 'Rithmic Test' && !READ_ONLY && !LIVE_TRADING) throw new Error('Jiný systém než Rithmic Test jde spustit jen s --read-only (nebo s --live-trading a platným souhlasem)');
  if (SYSTEM !== 'Rithmic Test' && !/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) throw new Error(`Neznámá brána ${GATEWAY}`);
  // Název aplikace včetně předpony, kterou Rithmic přidělil pro conformance (mail 17. 11. 2026: „fikr:").
  const creds = { ...credentials(), systemName: SYSTEM, appName: APP_NAME, appVersion: '0.1.0' };
  // Jediná instance na systém a uživatele — a to DŘÍV než první přihlášení k Rithmicu. Druhá instance (omylem, nebo
  // správce procesů ve smyčce) by jinak utratila přihlášení a dotaz na účty dřív, než zjistí obsazený port.
  const stateDir = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic');
  const instanceKey = Buffer.from(JSON.stringify([SYSTEM, creds.user])).toString('base64url');
  const lockFile = join(stateDir, `service-${instanceKey}.lock`);
  mkdirSync(stateDir, { recursive: true });
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
  let heldBy: number | null = null;
  try { const pid = Number(readFileSync(lockFile, 'utf8').trim()); heldBy = Number.isInteger(pid) && pid > 0 ? pid : null; } catch { heldBy = null; }
  if (heldBy !== null && heldBy !== process.pid && alive(heldBy)) {
    throw new Error(`služba pro ${SYSTEM} už běží (proces ${heldBy}) — druhou nespouštím. Když neběží, smaž ${lockFile}`);
  }
  // Zápis zámku je ATOMICKÝ (vytvořit jen když neexistuje): dva starty ve stejný okamžik neprojdou oba.
  if (heldBy !== null) rmSync(lockFile, { force: true }); // starý zámek po procesu, který už neběží
  try { writeFileSync(lockFile, String(process.pid), { mode: 0o600, flag: 'wx' }); }
  catch { throw new Error(`službu pro ${SYSTEM} právě spouští jiný proces — druhou nespouštím. Když neběží, smaž ${lockFile}`); }
  process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile, { force: true }); } catch { /* zámek už není */ } });
  let startConsent: LiveTradingConsent | null = null;
  if (LIVE_TRADING) {
    // Obchodování na skutečném účtu spouští jen člověk u terminálu: po přihlášení opíše větu s číslem účtu.
    // Soubor se souhlasem sám nestačí (zapsat ho umí kterýkoli proces) — je to jen časové omezení a odvolání.
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--live-trading jde spustit jen z interaktivního terminálu (potvrzuje se opsáním věty)');
    if (CLOSE_ONLY && process.argv.includes('--live-trading')) throw new Error('--close-only a --live-trading se vylučují');
    // Před přihlášením: bez souhlasu pro tento systém a uživatele se služba k účtu vůbec nepřihlásí.
    // (Režim jen pro zavírání souhlas nepotřebuje — nic neotevírá.)
    // (Shoda účtu se ověří po přihlášení, až je účet znám.)
    let early: unknown = null;
    try { early = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results', 'live-trading-consent.json'), 'utf8')); } catch { /* chybí → hláška níže */ }
    const account = early && typeof early === 'object' && typeof (early as { account?: unknown }).account === 'string' ? (early as { account: string }).account : '';
    const problem = liveTradingConsentProblem(early, { system: SYSTEM, user: creds.user, accounts: [account], now: Date.now() });
    if (problem && !CLOSE_ONLY) throw new Error(`Obchodování na skutečném účtu není povolené: ${problem}`);
    if (!CLOSE_ONLY) startConsent = early as LiveTradingConsent; // prošel kontrolou (strop kusů i povinnost SL jsou ověřené)
  }
  const socketFactory = (url: string): RithmicSocketLike => {
    const raw = new WebSocket(url, { perMessageDeflate: false });
    // Pojistka: chyba spojení k Rithmicu nikdy nesmí shodit proces (o výpadku rozhoduje obnova spojení výš).
    raw.on('error', () => undefined);
    const socket = raw as unknown as RithmicSocketLike;
    if (!READ_ONLY) return socket;
    // Pojistka na drátě: v režimu jen pro čtení se zápisový rámec nikdy neodešle, ať ho pošle kdokoli.
    const rawSend = socket.send.bind(socket);
    socket.send = (data: Uint8Array) => {
      const blockedTemplate = readOnlyViolation(data);
      if (blockedTemplate !== null) {
        console.log(`[jen čtení] ZABLOKOVÁN rámec ${blockedTemplate} — nic neodešlo`);
        throw new Error(`režim jen pro čtení: šablona ${blockedTemplate} se neodesílá`);
      }
      rawSend(data);
    };
    return socket;
  };

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
  let budgetWarned = false;
  let accountSignalAt: number | null = null;
  let accountSignals = 0;
  // Mimo worktree: služba spuštěná z jiného checkoutu musí počítat do TÉHOŽ rozpočtu.
  const budgetFile = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic', 'rms-query-budget-' + Buffer.from(JSON.stringify([SYSTEM, creds.user])).toString('base64url') + '.json');
  /** Zapíše jeden dotaz do trvalého rozpočtu; false = strop vyčerpán nebo stav nejde uložit (pak se nečte). */
  const spendBudget = (): boolean => {
    let stored: unknown = undefined;
    try { stored = JSON.parse(readFileSync(budgetFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stored = 'unreadable'; }
    const spent = spendRmsQuery(stored, Date.now());
    if (!spent.allowed) {
      if (!budgetWarned) console.error(`[limity] Týdenní strop ${RMS_QUERY_WEEKLY_CAP} dotazů na účty a limity u Rithmicu je vyčerpán (nebo jeho záznam ${budgetFile} nejde přečíst) — limity se už nečtou a služba se po výpadku sama nepřihlásí; nové vstupy odmítne, až limity zestárnou.`);
      budgetWarned = true;
      return false;
    }
    try {
      mkdirSync(dirname(budgetFile), { recursive: true });
      writeFileSync(`${budgetFile}.tmp`, JSON.stringify(spent.state), { mode: 0o600 });
      renameSync(`${budgetFile}.tmp`, budgetFile);
    } catch { return false; }
    return true;
  };
  // Každé přihlášení k příkazům posílá dotaz na seznam účtů: hodinový strop proti kmitajícímu spojení + týdenní rozpočet.
  // Hodinové okno je TRVALÉ: restart služby (i opakovaný, ve smyčce) ho nenuluje.
  const loginWindowFile = join(dirname(budgetFile), `login-window-${instanceKey}.json`);
  let recentLogins: number[] = [];
  try {
    const stored: unknown = JSON.parse(readFileSync(loginWindowFile, 'utf8'));
    // Nečitelný záznam = jako by bylo okno plné (neznámý počet přihlášení → nepřihlašovat naslepo).
    // Značky z budoucnosti (posun hodin) se zahodí — jinak by okno blokovalo přihlášení natrvalo.
    recentLogins = Array.isArray(stored) && stored.every((at) => Number.isFinite(at)) ? (stored as number[]).filter((at) => at <= Date.now()) : Array.from({ length: RMS_LOGINS_PER_HOUR_CAP }, () => Date.now());
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recentLogins = Array.from({ length: RMS_LOGINS_PER_HOUR_CAP }, () => Date.now()); }
  const loginAllowed = (): boolean => {
    const hourly = rmsLoginAllowed(recentLogins, Date.now());
    recentLogins = hourly.recent;
    try { writeFileSync(`${loginWindowFile}.tmp`, JSON.stringify(recentLogins), { mode: 0o600 }); renameSync(`${loginWindowFile}.tmp`, loginWindowFile); }
    catch (error) { console.error(`[limity] Počet přihlášení nejde uložit (${error instanceof Error ? error.message : String(error)}; ${loginWindowFile}) — bez záznamu se k Rithmicu nepřihlašuji.`); return false; }
    if (!hourly.allowed) { console.error(`[limity] Víc než ${RMS_LOGINS_PER_HOUR_CAP} přihlášení k Rithmicu za hodinu — adaptér se zastaví.`); return false; }
    return spendBudget();
  };
  const broker = createRithmicBroker({
    loginAllowed,
    // Odběr změn účtu: Rithmic sám pošle zprávu, když se účet změní → limity se přečtou znovu (ne dotazováním v čase).
    onAccountUpdate: () => { accountSignalAt = Date.now(); accountSignals += 1; console.log(`[účet] Rithmic oznámil změnu účtu (${accountSignals}×) — limity přečtu znovu`); },
    url: URL, credentials: creds, socketFactory, registry,
    // Každý systém má vlastní záznam ochrany (záznamy z testu nesmí platit pro skutečný účet a naopak).
    protectionStore: fileProtectionStore(join(results, SYSTEM === 'Rithmic Test' ? 'dev-protection.json' : `dev-protection-${SYSTEM.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.json`)),
    onIncident: (incident) => {
      console.log(`[incident] ${incident.kind}: ${incident.message}`);
      exec?.onIncident(incident);
    },
  });

  // Ceny: zvláštní spojení na ticker (adaptér ho nepoužívá). Jen pro zobrazení.
  const candles = new RithmicCandleBuilder();
  let tickCount = 0;
  // Měření (jen čísla do výpisu, nic neřídí): zpoždění ceny burza → Mac a odezva spárovaných zařízení.
  const quantiles = (values: number[]): string => {
    if (!values.length) return 'bez vzorků';
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
    return `p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · max ${Math.round(sorted[sorted.length - 1])} ms (${sorted.length} vzorků)`;
  };
  let exchangeLag: number[] = [];
  let gatewayLag: number[] = [];
  let tickDirty = false;
  let lastBar: { time: number; open: number; high: number; low: number; close: number; volume: number } | null = null;
  setInterval(() => {
    if (!tickDirty) return;
    tickDirty = false;
    const now = Date.now();
    broadcast({ type: 'tick', symbol: CONTRACT, price: shownPrice(now), bar: candles.current(CONTRACT, now), at: now });
  }, 16).unref();
  /** Poslední obchod; když dlouho žádný nebyl, střed nabídky a poptávky. Jen pro zobrazení. */
  const displayPrice = (now: number): number | null => {
    const last = candles.lastPrice(CONTRACT, now, 3_600_000);
    if (last !== null) return last;
    const quote = candles.quote(CONTRACT, now, 3_600_000);
    return quote && quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null;
  };
  /**
   * Cena pro KONTROLY příkazů (strana trhu, odchylka reference). Na skutečném trhu musí být čerstvá a ze živého
   * spojení. Zobrazovací cena může být na stojícím trhu starší.
   */
  /**
   * Cena pro GRAF: poslední obchod (to, z čeho jsou svíčky a co ukazují obchodní platformy). Střed nabídky a poptávky
   * leží mimo krok ceny a neodpovídá žádnému obchodu — do grafu jde jen tehdy, když čerstvý obchod chybí. Kontroly
   * příkazů (`freshPrice`) berou střed, protože lépe říká, kde trh právě je.
   */
  const shownPrice = (now: number): number | null => candles.lastPrice(CONTRACT, now, 30_000) ?? freshPrice(now);
  const freshPrice = (now: number): number | null => {
    if (!feedOpen) return null;
    return candles.marketPrice(CONTRACT, now, 30_000);
  };
  const clients = new Set<WebSocket>();
  type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
  /** Historie se drží v paměti procesu: dotaz na Rithmic nejvýš jednou za minutu, souběžná připojení sdílí jeden. */
  let historyCache: { bars: Bar[]; at: number } = { bars: [], at: 0 };
  let historyLoading: Promise<Bar[]> | null = null;
  function recentHistory(): Promise<Bar[]> {
    if (!historyOk) return Promise.resolve(historyCache.bars);
    if (Date.now() - historyCache.at < 60_000) return Promise.resolve(historyCache.bars);
    if (historyLoading) return historyLoading;
    historyLoading = (async () => {
      try {
        // Po DNECH, od nejnovějšího: jeden velký dotaz (týden) Lucid 19. 11. opakovaně nechal bez odpovědi a graf
        // pak neměl nic. Po kusech dorazí aspoň poslední dny; selhání staršího kusu nevadí.
        const toSec = Math.floor(Date.now() / 1_000);
        const DAY = 24 * 3_600;
        const byTime = new Map<number, Bar>();
        let gotAny = false;
        let failure: unknown = null;
        for (let day = 0; day < HISTORY_HOURS / 24 + 3; day += 1) {
          const chunkTo = toSec - day * DAY;
          const chunkFrom = chunkTo - DAY;
          let rows: Awaited<ReturnType<typeof ticker.timeBarReplay>>;
          try {
            rows = await ticker.timeBarReplay({ symbol: CONTRACT, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec: chunkFrom, toSec: chunkTo, timeoutMs: 20_000 });
          } catch (error) { failure = error; break; }
          gotAny = true;
          for (const bar of rows) byTime.set(bar.time, { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
          // Hotovo, až je pokrytá požadovaná hloubka A začátek padne DO obchodní seance: kdyby řada začínala otevřením
          // po víkendu nebo přestávce, první svíčka by proti starší historii appky skočila a ta by se k ní nepřipojila.
          const covered = day + 1 >= HISTORY_HOURS / 24;
          if (covered && rows.length > 0 && rows[0].time - chunkFrom <= 180) break;
        }
        const bars = [...byTime.values()].sort((x, y) => x.time - y.time);
        if (!gotAny) throw failure ?? new Error('historie bez dat');
        historyCache = { bars: bars.length > 0 ? bars : historyCache.bars, at: Date.now() };
        if (failure) console.log(`[historie] načteno jen ${bars.length} svíček (starší kus selhal: ${failure instanceof Error ? failure.message : String(failure)})`);
      } catch (error) {
        // Selhání nesmí být tiché: poslední známá historie zůstává, další pokus nejdřív za 5 minut (každý pokus po
        // selhání znamená i nové přihlášení spojení pro historii — žádné přihlašování ve smyčce).
        historyCache = { bars: historyCache.bars, at: Date.now() + 4 * 60_000 };
        console.log(`[historie] čtení selhalo (${error instanceof Error ? error.message : String(error)}) — nechávám poslední známou (${historyCache.bars.length} svíček); spojení pro historii otevřu znovu`);
        // Plant, který neodpovídá ani na malý dotaz, je nejspíš napůl mrtvý: zavřít → obnova ho za 5 s připojí znovu.
        ticker.closePlant('history');
      } finally {
        historyLoading = null;
      }
      return historyCache.bars;
    })();
    return historyLoading;
  }
  const send = (socket: WebSocket, message: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (message: unknown): void => {
    const text = JSON.stringify(message);
    for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.send(text);
  };
  // ── Upozornění na cenu (jen oznámení; nic odsud nesahá na příkazy — INV-UI-01) ──────────────────────────────
  // Zkušební systém má smyšlený trh: tam se nehlídá, aby do telefonu nechodila oznámení z cen, které neexistují.
  const alertFile = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic', 'price-alerts.json');
  const ALERT_APP_URL = (process.env.ALPHATRADE_APP_URL ?? 'https://alphatrade-mentor-15.vercel.app').replace(/\/+$/, '');
  const alertHttpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 2 });
  const alertWatchPost = (url: string, headers: Record<string, string>, body: string, agent: HttpsAgent): Promise<{ status: number; json: unknown }> => new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', agent, timeout: 8_000, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: response.statusCode ?? 0, json });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (reason) => reject(Object.assign(reason, { reusedSocket: request.reusedSocket })));
    request.end(body);
  });
  const alertWatch = IS_TEST_SYSTEM ? null : createRithmicAlertWatch({
    uuid: randomUUID,
    apiBase: ALERT_APP_URL,
    sign: signPriceAlertWatchRequest,
    // Držené spojení na server (keep-alive): ohlášení křížení nečeká na nové TLS spojení. Držené spojení mohl
    // server mezitím zavřít: chyba na znovupoužitém = hned jednou zkusit na novém (stejné `triggerId`, server
    // opakování pozná). Jinak by ohlášení čekalo na opakování po 5 s. Vypršení času se takhle neopakuje.
    post: (url, headers, body) => alertWatchPost(url, headers, body, alertHttpsAgent)
      .catch((reason: { reusedSocket?: boolean; message?: string }) => (reason?.reusedSocket === true && reason.message !== 'timeout'
        ? alertWatchPost(url, headers, body, new HttpsAgent({ keepAlive: false }))
        : Promise.reject(reason))),
    load: () => { try { return JSON.parse(readFileSync(alertFile, 'utf8')) as AlertWatchPersisted; } catch { return null; } },
    save: (state) => {
      mkdirSync(dirname(alertFile), { recursive: true });
      writeFileSync(`${alertFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
      renameSync(`${alertFile}.tmp`, alertFile);
    },
    onStatus: (status) => broadcast({ type: 'alerts', ...status }),
    // Křížení rovnou připojeným appkám (karta a zvuk bez čekání na server). Jen zobrazení.
    onFired: (fired) => broadcast({ type: 'alert-fired', ...fired }),
    log: (line) => console.log(`[upozornění] ${line}`),
  });
  /** Spojení pro ceny žije? Když spadne, stránka má cenu označit za starou; obnovuje se s rostoucím odstupem. */
  let feedOpen = false;
  let historyOk = false;
  const restoring = new Set<'ticker' | 'history'>();
  /** Stejným jménem se přihlásil někdo jiný: od té chvíle se proces k cenám ani historii sám nepřipojuje. */
  let forcedOut = false;
  /** Kdy spojení pro ceny spadlo (ms); null = běží. Svíčky od té minuty po minutu obnovy jsou z ticků neúplné. */
  let feedGapFrom: number | null = null;
  /**
   * Oprava svíček po (znovu)připojení cen — JEN ZOBRAZENÍ. Minuta, ve které ceny naběhly, začíná až prvním tickem
   * (chybí jí otevření a kus rozsahu) a minuty z výpadku chybí celé. Po skončení té minuty se dotčené svíčky jedním
   * malým dotazem přečtou z historie a pošlou stránkám zprávou `bars`.
   * Čeká nejvýš JEDNA oprava: další obnova cen její okno jen rozšíří (rozpadající se spojení nesmí násobit dotazy).
   * Nejvýš 2 dotazy na opravu; když historie minutu obnovy nemá ani napodruhé (zavřený trh), pošle se, co je.
   */
  let pendingRepair: { window: BarRepairWindow; timer: ReturnType<typeof setTimeout> } | null = null;
  function scheduleBarRepair(window: BarRepairWindow): void {
    if (pendingRepair) { clearTimeout(pendingRepair.timer); window = mergeRepairWindows(pendingRepair.window, window); }
    const timer = setTimeout(() => { pendingRepair = null; void runBarRepair(window, 1); }, Math.max(0, window.dueAtMs - Date.now()));
    timer.unref();
    pendingRepair = { window, timer };
  }
  async function runBarRepair(window: BarRepairWindow, attempt: number): Promise<void> {
    if (forcedOut) return;
    const again = (why: string): void => {
      if (attempt >= 2 || pendingRepair) { console.log(`[svíčky] oprava po obnově cen se nepodařila (${why}) — správné svíčky přinese další připojení stránky`); return; }
      console.log(`[svíčky] oprava po obnově cen zatím nejde (${why}) — ještě jeden pokus za 30 s`);
      setTimeout(() => { if (!pendingRepair) void runBarRepair(window, attempt + 1); }, 30_000).unref();
    };
    try {
      if (!historyOk) { again('historie není připojená'); return; }
      const rows = await ticker.timeBarReplay({ symbol: CONTRACT, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec: window.fromSec, toSec: window.lastSec + 120, timeoutMs: 20_000 });
      const { bars, complete } = repairedBarsFrom(rows, window);
      if (!complete && attempt < 2 && !pendingRepair) { again('historie svíčku minuty obnovy ještě nemá'); return; }
      if (!bars.length) { console.log('[svíčky] po obnově cen není co opravit (v historii žádná svíčka z výpadku)'); return; }
      if (historyCache.bars.length > 0) historyCache = { bars: mergeRepairedBars(historyCache.bars, bars), at: historyCache.at };
      // `through` = poslední minuta, kterou služba pokládá za dokončenou (stránka nepoužívá hodiny zařízení).
      broadcast({ type: 'bars', symbol: CONTRACT, bars, through: bars[bars.length - 1].time });
      console.log(`[svíčky] opraveno ${bars.length} svíček po obnově cen (${new Date(bars[0].time * 1_000).toTimeString().slice(0, 5)}–${new Date(bars[bars.length - 1].time * 1_000).toTimeString().slice(0, 5)})${complete ? '' : ' — minuta obnovy v historii není'}`);
    } catch (error) {
      again(error instanceof Error ? error.message : String(error));
    }
  }
  /** Po výpadku (uspání počítače, síť) se spojení pro ceny a historii obnoví samo: 5 s, 10 s … nejvýš 60 s. */
  function scheduleFeedRestore(plant: 'ticker' | 'history', delayMs: number): void {
    if (forcedOut || restoring.has(plant)) return;
    restoring.add(plant);
    setTimeout(() => {
      void (async () => {
        if (forcedOut) { restoring.delete(plant); return; }
        try {
          await ticker.connect([plant]);
          if (plant === 'ticker') {
            await ticker.subscribeMarketData(CONTRACT, 'CME');
            feedOpen = true;
            console.log('[ticker] ceny obnoveny');
            scheduleBarRepair(barRepairWindow(feedGapFrom ?? Date.now(), Date.now()));
            feedGapFrom = null;
            // Stránky se připojí znovu a dostanou čerstvé svíčky včetně těch z doby výpadku.
            for (const socket of clients) socket.close(4000, 'feed restored');
          } else {
            historyOk = true;
            console.log('[historie] obnovena');
            // Stránky, které se připojily bez historie, ji jinak nedostanou: hned načíst a připojit je znovu (jako u cen).
            if (historyCache.bars.length === 0 && Date.now() - historyCache.at >= 60_000) {
              historyCache = { bars: [], at: 0 };
              void recentHistory().then((bars) => { if (bars.length > 0) for (const socket of clients) socket.close(4000, 'history restored'); });
            }
          }
          restoring.delete(plant);
        } catch (error) {
          restoring.delete(plant);
          if (forcedOut) return;
          console.log(`[ticker] obnova ${plant} selhala (${error instanceof Error ? error.message : String(error)}) — další pokus za ${Math.round(Math.min(delayMs * 2, 60_000) / 1_000)} s`);
          scheduleFeedRestore(plant, Math.min(delayMs * 2, 60_000));
        }
      })();
    }, delayMs);
  }
  const ticker = new RithmicClient({
    url: URL, credentials: creds, socketFactory, requestTimeoutMs: 10_000,
    events: {
      onTick: (tick) => {
        if (tick.symbol !== CONTRACT) return;
        tickCount += 1;
        // Čas burzy a brány Rithmicu proti hodinám Macu (hodiny Macu se synchronizují přes síť; chyba v jednotkách ms).
        if (!tick.isSnapshot && tick.kind === 'trade') {
          if (tick.exchangeAt != null && exchangeLag.length < 20_000) exchangeLag.push(tick.receivedAt - tick.exchangeAt);
          if (tick.gatewayAt != null && gatewayLag.length < 20_000) gatewayLag.push(tick.receivedAt - tick.gatewayAt);
          // Upozornění na cenu: každý obchod (nikdy nevyhodí, na síť nečeká).
          if (tick.tradePrice !== null) alertWatch?.onTrade(tick.tradePrice, tick.receivedAt, CONTRACT);
        }
        if (!candles.onTick(tick)) return;
        // Dokončená svíčka musí odejít celá: když tick otevřel novou minutu, pošle se ještě poslední stav té předchozí.
        const bar = candles.current(CONTRACT, Date.now()) as Bar | null;
        if (lastBar && bar && bar.time !== lastBar.time && tickDirty) broadcast({ type: 'tick', symbol: CONTRACT, price: lastBar.close, bar: lastBar, at: Date.now() });
        lastBar = bar ? { ...bar } : lastBar;
        // Na živém trhu chodí stovky ticků za sekundu. Stránka dostane poslední stav jednou za snímek obrazovky
        // (16 ms ≈ 60× za sekundu — víc monitor neukáže). Zpráva nese poslední cenu a celou rozpracovanou svíčku,
        // takže se žádný tick neztrácí: high, low, close i objem v ní jsou.
        tickDirty = true;
      },
      onPlantClosed: (plant, info) => {
        if (plant === 'ticker') {
          feedOpen = false;
          if (feedGapFrom === null) feedGapFrom = Date.now();
          alertWatch?.feedLost();
          candles.reset(CONTRACT);
          tickDirty = false;
          lastBar = null;
          broadcast({ type: 'beat', at: Date.now(), feed: false });
        }
        if (plant === 'history') historyOk = false;
        // Vynucené odhlášení = stejným jménem se přihlásil někdo jiný (jiná platforma). O přihlášení se
        // nepřetahujeme: ceny zůstanou stát, dokud obsluha proces nespustí znovu.
        if (info.forcedLogout) {
          forcedOut = true;
          console.log(`[ticker] spojení ${plant} ukončeno vynuceným odhlášením — jiné přihlášení stejným uživatelem? Znovu se nepřipojuji.`);
          return;
        }
        console.log(`[ticker] spojení ${plant} zavřeno (${info.code ?? '?'}) — zkusím se připojit znovu`);
        scheduleFeedRestore(plant === 'history' ? 'history' : 'ticker', 5_000);
      },
    },
  });
  await ticker.connect(['ticker']);
  // A root explicitly requests the current delivery month. Pin it for the entire session.
  if (['MNQ', 'NQ', 'ES', 'MES'].includes(requestedContract)) {
    const front = await ticker.frontMonthContract(requestedContract, 'CME');
    if (!front || !new RegExp('^' + requestedContract + '[FGHJKMNQUVXZ]\\d{1,2}$').test(front)) {
      throw new Error(`Rithmic nepotvrdil aktuální kontrakt pro ${requestedContract}.`);
    }
    CONTRACT = front;
  }
  // Historie svíček (jen čtení): po připojení stránky doplní poslední dny, které graf jinak nemá.
  try {
    await ticker.connect(['history']);
    historyOk = true;
  } catch (error) {
    console.log(`[historie] nedostupná (${error instanceof Error ? error.message : String(error)}) — graf začne od startu procesu`);
  }
  const ref = await ticker.referenceData(CONTRACT, 'CME');
  const tickSize = ref?.tickSize ?? 0.25;
  const feedStartedAt = Date.now();
  await ticker.subscribeMarketData(CONTRACT, 'CME');
  feedOpen = true;
  // I první minuta po startu procesu je z ticků neúplná.
  scheduleBarRepair(barRepairWindow(feedStartedAt, Date.now()));

  // Značka rozdělané výměny ochrany — zvlášť pro každý systém (jako záznam ochrany).
  const replaceMarkerFile = join(results, `protect-replace-${SYSTEM.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.json`);
  // Souhlas se skutečným obchodováním: čte se ze souboru při startu a znovu před každým vstupem.
  const consentFile = join(results, 'live-trading-consent.json');
  const readConsent = (): unknown => { try { return JSON.parse(readFileSync(consentFile, 'utf8')); } catch { return null; } };
  const accountNames = (): string[] => entries.filter((entry) => entry.system === SYSTEM).map((entry) => entry.accountId);
  const consentProblem = (): string | null => liveTradingConsentProblem(readConsent(), { system: SYSTEM, user: creds.user, accounts: accountNames(), now: Date.now() });
  // Souhlas platný při startu určuje strop a povinnost SL; jiný souhlas (nové vydání) chce restart služby.
  const manualCap = typeof startConsent?.maxQuantity === 'number' ? startConsent.maxQuantity : 2_147_483_647;
  let rms: Awaited<ReturnType<typeof broker.readQuantityLimits>> = null;
  let rmsAt = 0;
  let rmsEpoch: number | undefined;
  let loadingLimits = false;
  // Čtení limitů se počítá do tvrdého limitu dotazů Rithmicu (viz services/rithmic/rmsQueryBudget.ts) — žádné čtení ve smyčce.
  let limitsAttemptAt: number | null = null;
  let limitsAttemptOk = false;
  let limitsAttemptEpoch: number | undefined;
  const effectiveLimits = () => broker.isConnected() && broker.routeEpoch?.(broker.accountIds()[0]) === rmsEpoch && Date.now() - rmsAt < RMS_LIMITS_MAX_AGE_MS ? rms : null;
  let publishedLimits: ReturnType<typeof effectiveLimits> = null;
  function publishLimits() {
    const next = effectiveLimits();
    if (next?.buy === publishedLimits?.buy && next?.sell === publishedLimits?.sell && next?.order === publishedLimits?.order) return;
    publishedLimits = next;
    broadcast({ type: 'limits', limits: next });
  }
  async function refreshLimits() {
    if (loadingLimits || !broker.isConnected()) return;
    const epochNow = broker.routeEpoch?.(broker.accountIds()[0]);
    if (!rmsLimitsReadDue({ now: Date.now(), lastAttemptAt: limitsAttemptAt, lastOk: limitsAttemptOk, epochChanged: epochNow !== limitsAttemptEpoch, signalAt: accountSignalAt })) return;
    const account = broker.accountIds()[0];
    const product = typeof ref?.raw.product_code === 'string' ? ref.raw.product_code : CONTRACT.match(/^([A-Z0-9]+)[FGHJKMNQUVXZ]\d{1,2}$/)?.[1];
    if (account === undefined || !product) return;
    // Pokus se zapíše PŘED dotazem: i neúspěch a pád uprostřed se počítají (do rozpočtu i do rozestupu).
    limitsAttemptAt = Date.now();
    limitsAttemptOk = false;
    limitsAttemptEpoch = epochNow;
    if (!spendBudget()) return;
    loadingLimits = true;
    const epoch = epochNow;
    try {
      const limits = await broker.readQuantityLimits(account, product);
      rms = limits && { buy: Math.min(manualCap, limits.buy), sell: Math.min(manualCap, limits.sell), order: Math.min(manualCap, limits.order) };
      rmsEpoch = epoch;
      rmsAt = Date.now();
      limitsAttemptOk = limits !== null;
    } catch { /* poslední známé limity doběhnou do stáří; další pokus nejdřív za 5 min */ } finally { loadingLimits = false; }
    publishLimits();
  }
  exec = new LocalExec({
    broker, symbols: { [CONTRACT]: { tickSize } }, maxQuantity: manualCap, quantityLimits: effectiveLimits,
    // Všechny funkce (čekající přikoupení Limitem, výměna více párů, rozdělení vstupu, opakované přikoupení) na testu
    // vždy; na skutečném účtu jen v obchodním režimu, který spustil člověk opsáním věty (rozhodnutí Filipa 19. 11.:
    // testujeme je na Lucidu). Proti brokerovi je ověřený jen základ — vstup se SL/TP, posuny, zavření.
    ...(IS_TEST_SYSTEM || (LIVE_TRADING && !CLOSE_ONLY) ? { pendingAdd: true, multiPairSwap: true, entrySplit: true, maxProtectedParts: 20 } : { pendingAdd: false, multiPairSwap: false, entrySplit: false }),
    // Jen pro zavírání: hlídač čekajících přikoupení musí běžet dál — po zavření pozice zruší zapomenuté přikoupení,
    // které by jinak otevřelo nový obchod. Nové vstupy tu odmítá souhlas (`problem` níže), takže nic dalšího nepovolí.
    ...(CLOSE_ONLY ? { pendingAdd: true } : {}),
    ...(IS_TEST_SYSTEM ? { bareAdd: true } : {}),
    // Skutečný účet: přikoupení bez SL/TP jen když souhlas vydaný na Macu SL NEVYŽADUJE (`--allow-no-stop`) — pak
    // už jde i první vstup bez SL, takže přikoupení bez SL/TP nic nového nepovoluje.
    ...(LIVE_TRADING && !CLOSE_ONLY && startConsent?.requireStop === false ? { bareAdd: true } : {}),
    systemName: SYSTEM, allowedSystems: LIVE_TRADING ? [SYSTEM] : ['Rithmic Test'],
    ...(LIVE_TRADING ? { liveTrading: {
      requireStop: startConsent?.requireStop !== false,
      problem: () => {
        if (CLOSE_ONLY) return 'služba běží jen pro zavírání a správu ochrany (--close-only)';
        // Jedno čtení souboru: ověření i porovnání se souhlasem ze startu nad stejným obsahem.
        const current = readConsent();
        const problem = liveTradingConsentProblem(current, { system: SYSTEM, user: creds.user, accounts: accountNames(), now: Date.now() });
        if (problem) return problem;
        return (current as LiveTradingConsent).grantedAt === startConsent?.grantedAt ? null : 'souhlas se od spuštění služby změnil — službu spusť znovu';
      },
    } } : {}),
    serverPrice: (symbol) => (symbol === CONTRACT ? freshPrice(Date.now()) : null),
    closeStore: {
      load(account) {
        const file = join(results, 'closes-' + Buffer.from(JSON.stringify([SYSTEM, account])).toString('base64url') + '.json');
        try { return JSON.parse(readFileSync(file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      },
      save(account, state) {
        const file = join(results, 'closes-' + Buffer.from(JSON.stringify([SYSTEM, account])).toString('base64url') + '.json');
        mkdirSync(results, { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
        renameSync(file + '.tmp', file);
      },
    },
    replaceMarker: {
      read: () => { try { return JSON.parse(readFileSync(replaceMarkerFile, 'utf8')) as { symbol: string; at: number; resize?: { entryId: string; exitTag: string; expectNet: number } }; } catch { return null; } },
      write: (value) => {
        if (value === null) { rmSync(replaceMarkerFile, { force: true }); return; }
        mkdirSync(results, { recursive: true });
        writeFileSync(`${replaceMarkerFile}.tmp`, JSON.stringify(value));
        renameSync(`${replaceMarkerFile}.tmp`, replaceMarkerFile);
      },
    },
    serverQuote: (symbol) => (symbol === CONTRACT && feedOpen ? candles.quote(CONTRACT, Date.now(), 30_000) : null),
  });
  exec.attach();
  await broker.start();
  await refreshLimits();
  setInterval(() => {
    const at = Date.now();
    // Realizovaný P&L účtu z PnL streamu (jen zobrazení v liště grafu — nic se podle něj nerozhoduje).
    const pnlAccount = broker.accountIds()[0];
    const pnl = pnlAccount === undefined ? null : broker.accountClosedPnl?.(pnlAccount) ?? null;
    broadcast({ type: 'beat', at, feed: freshPrice(at) !== null, pnl: pnl ? { closed: pnl.closedPnl, at: pnl.at } : null });
    // A stalled RMS refresh can expire even while the market feed remains active.
    publishLimits();
  }, 1_000).unref();
  // Jen kontrola, ZDA je čas číst (rozestupy a strop hlídá refreshLimits) — samotný dotaz odejde po přihlášení, po oznámení změny účtu od Rithmicu a jinak jen jako pojistka jednou za 6 hodin.
  setInterval(() => void refreshLimits(), 15_000).unref();
  if (!READ_ONLY && !LIVE_TRADING && broker.environment !== 'demo') throw new Error('Adaptér není v demo prostředí — končím');
  if (LIVE_TRADING) {
    // Až teď je znám účet přihlášení. Bez platného souhlasu služba vůbec nepoběží (ne „poběží a uvidí se").
    const names = accountNames();
    const problem = CLOSE_ONLY ? (names.length === 1 ? null : `přihlášení má ${names.length} účtů — služba pracuje jen s jedním`) : consentProblem();
    if (problem) { broker.stop(); throw new Error(`${CLOSE_ONLY ? 'Režim jen pro zavírání nejde spustit' : 'Obchodování na skutečném účtu není povolené'}: ${problem}`); }
    const account = CLOSE_ONLY ? names[0] : startConsent!.account;
    const phrase = CLOSE_ONLY ? `ZAVIRAT ${account}` : liveConsentPhrase(account);
    console.log(`\nSlužba je přihlášená k ${SYSTEM}, účet ${account}. ${CLOSE_ONLY ? 'Z appky půjde na SKUTEČNÉM účtu jen zavírat, rušit vlastní příkazy a spravovat SL/TP.' : 'Příkazy z appky půjdou na SKUTEČNÝ účet.'}`);
    console.log('Ochranu (SL/TP) zadanou odsud ruš tady; když pozici zavřeš v jiné platformě, zruš i její ochranu.');
    const typed = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`Pro spuštění opiš přesně:  ${phrase}\n> `, (answer) => { rl.close(); resolve(answer.trim()); });
    });
    if (typed !== phrase) { broker.stop(); throw new Error('Věta nesouhlasí — služba se nespustila.'); }
    setInterval(() => exec?.checkConsent(), 10_000).unref();
    console.log(CLOSE_ONLY
      ? `\n*** SKUTEČNÝ ÚČET ${SYSTEM} / ${account}: JEN ZAVÍRÁNÍ (vstupy vypnuté) ***\n`
      : `\n*** SKUTEČNÝ ÚČET: příkazy z appky půjdou na ${SYSTEM} / ${account} · strop ${startConsent!.maxQuantity === 'rms' ? 'podle RMS' : startConsent!.maxQuantity + ' ks'} · SL ${startConsent!.requireStop ? 'povinný' : 'nepovinný'} · souhlas do ${new Date(startConsent!.expiresAt).toLocaleString('cs-CZ')} ***\n`);
  }
  // Samočinné zápisy služby až teď: účet je potvrzený (u skutečného účtu opsanou větou). V režimu jen pro čtení nikdy.
  if (!READ_ONLY) exec.enableAutomation();
  exec.subscribe((state) => broadcast({ type: 'state', state }));

  // Přístup: Origin (proti cizí webové stránce) A token (proti komukoli jinému v síti — Origin si
  // neprohlížečový klient nastaví sám). Token je v souboru jen pro tohoto uživatele a v odkazu.
  const tokenPath = join(results, 'dev-token');
  let token = '';
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    // první spuštění
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    token = randomBytes(24).toString('base64url');
    mkdirSync(results, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  }
  chmodSync(tokenPath, 0o600); // i když soubor už existoval s volnějšími právy
  const tokenOk = (given: string | null): boolean => {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = new WebSocketServer({
    host: '127.0.0.1', port: PORT, maxPayload: 16 * 1024,
    verifyClient: ({ origin, req }: { origin?: string; req: { url?: string } }) =>
      Boolean(origin && ALLOWED_ORIGINS.has(origin)) && tokenOk(new globalThis.URL(req.url ?? '/', 'http://x').searchParams.get('token')),
  });
  /**
   * Kdo je na druhém konci: tento Mac (klíč ze souboru, vše včetně správy zařízení), nebo spárované zařízení
   * (telefon) se svým rozsahem. Rozsah je jen PRVNÍ síto — každý příkaz dál ověřuje služba.
   */
  interface ClientAccess { scope: DeviceScope; local: boolean; label: string; deviceId?: string }
  const serveClient = (socket: WebSocket, access: ClientAccess): void => {
    clients.add(socket);
    if (!access.local) {
      // Odezva zařízení: služba pošle WebSocket ping, telefon odpoví sám (na úrovni protokolu — appka o tom neví).
      // Čas tam a zpět; jedna cesta je zhruba polovina. Jen do výpisu.
      let sentAt = 0;
      let samples: number[] = [];
      socket.on('pong', () => { if (sentAt) { samples.push(performance.now() - sentAt); sentAt = 0; } });
      const pinger = setInterval(() => { if (socket.readyState === WebSocket.OPEN && !sentAt) { sentAt = performance.now(); try { socket.ping(); } catch { sentAt = 0; } } }, 1_000);
      const reporter = setInterval(() => {
        console.log(`[měření] ${access.label}: odezva tam a zpět ${quantiles(samples)}${sentAt && performance.now() - sentAt > 3_000 ? ' · POSLEDNÍ PING BEZ ODPOVĚDI' : ''}`);
        samples = [];
      }, 20_000);
      socket.on('close', () => { clearInterval(pinger); clearInterval(reporter); console.log(`[zařízení] ${access.label} odpojeno`); });
      console.log(`[zařízení] ${access.label} připojeno`);
    }
    /** Nejvýš 20 příkazů za 10 s na spojení. */
    let recent: number[] = [];
    /** Zprávy o upozorněních mají vlastní strop (12 za 10 s) — rozpočet příkazů neberou. */
    let recentAlertOps: number[] = [];
    const now = Date.now();
    // Identita hned (systém, režim, kontrakt) se svíčkami od startu; historie dorazí druhou zprávou, až bude.
    const liveBars = (at: number, after: number) => [...candles.finished(CONTRACT), ...(candles.current(CONTRACT, at) ? [candles.current(CONTRACT, at)!] : [])].filter((bar) => bar.time > after);
    const hello = (bars: unknown[], at: number) => send(socket, { type: 'hello', readOnly: READ_ONLY, closeOnly: CLOSE_ONLY, live: LIVE_TRADING, account: broker.accountName(broker.accountIds()[0]), limits: effectiveLimits(), feed: freshPrice(at) !== null, system: SYSTEM, symbol: CONTRACT, tickSize, pointValue: ref?.pointValue ?? null, price: candles.lastPrice(CONTRACT, at, 30_000) ?? freshPrice(at) ?? displayPrice(at), bars });
    hello(liveBars(now, -Infinity), now);
    send(socket, { type: 'state', state: exec!.state() });
    if (alertWatch) send(socket, { type: 'alerts', ...alertWatch.status() });
    void (async () => {
      const history = await recentHistory();
      if (!history.length || socket.readyState !== WebSocket.OPEN) return;
      const at = Date.now();
      hello([...history, ...liveBars(at, history[history.length - 1].time)], at);
    })();
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      void (async () => {
        const receivedAt = performance.now();
        let id: unknown = null;
        try {
          const message = JSON.parse(String(raw)) as { id?: unknown; command?: LocalExecCommand; metric?: unknown };
          id = message.id ?? null;
          // Měření otevření appky (kroky od návratu po první cenu): jen výpis, nic neřídí. Bere jen čísla a ano/ne.
          if (message.metric && typeof message.metric === 'object' && !message.command) {
            const parts = Object.entries(message.metric as Record<string, unknown>).slice(0, 20)
              .filter(([key, value]) => /^[A-Za-z]{1,12}$/.test(key) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (key === 'stage' && (value === 'cena' || value === 'historie'))))
              .map(([key, value]) => `${key} ${typeof value === 'number' ? Math.round(value) : value}`);
            console.log(`[měření] otevření ${access.label ?? (access.local ? 'PC' : 'zařízení')}: ${parts.join(' · ')}`);
            return;
          }
          if (!message.command || typeof message.command !== 'object') throw new Error('zpráva bez příkazu');
          // Upozornění na cenu: klíč a seznam od přihlášené appky. Jen oznámení → smí každé spárované zařízení
          // (i jen pro čtení), k brokerovi nic nejde a režim „jen pro čtení“ tomu nebrání. Vyřizuje se PŘED
          // rozpočtem obchodních příkazů (vlastní malý strop), aby úpravy upozornění nikdy nezdržely příkaz.
          const alertOp = (message.command as unknown as { op?: unknown }).op;
          if (alertOp === 'alerts-key' || alertOp === 'alerts-set') {
            if (access.deviceId && !activeDevice(access.deviceId)) { socket.terminate(); return; }
            const alertAt = Date.now();
            recentAlertOps = recentAlertOps.filter((time) => alertAt - time < 10_000);
            if (recentAlertOps.length >= 12) throw new Error('příliš mnoho změn upozornění za krátkou dobu');
            recentAlertOps.push(alertAt);
            if (!alertWatch) throw new Error('na zkušebním systému se upozornění nehlídají (trh je smyšlený)');
            const outcome = alertOp === 'alerts-key' ? alertWatch.setKey(message.command) : alertWatch.setAlerts(message.command);
            if (!outcome.ok) throw new Error(outcome.error ?? 'upozornění se nepodařilo uložit');
            send(socket, { type: 'reply', id, ok: true, result: alertWatch.status() });
            return;
          }
          const at = Date.now();
          recent = recent.filter((time) => at - time < 10_000);
          // Brzda (zavření) se neomezuje nikdy.
          if (message.command.op !== 'flatten') {
            if (recent.length >= 20) throw new Error('příliš mnoho příkazů za krátkou dobu');
            recent.push(at);
          }
          const rawCommand = message.command as unknown as Record<string, unknown>;
          // Odvolané zařízení: nic dalšího — ani dohledání u brokera, ani příkaz, který byl už na cestě ke službě.
          if (access.deviceId && !activeDevice(access.deviceId)) { socket.terminate(); return; }
          if (rawCommand.op === 'lookup') {
            const result = await commandStatus(broker, rawCommand, CONTRACT);
            send(socket, { type: 'reply', id, ok: true, result });
            return;
          }
          // Správa zařízení: jen z tohoto Macu (nikdy ze spárovaného zařízení) a nikam k brokerovi.
          if (rawCommand.op === 'pair-start' || rawCommand.op === 'devices' || rawCommand.op === 'revoke-device') {
            if (!access.local) throw new Error('správa zařízení jde jen z Macu, kde služba běží');
            send(socket, { type: 'reply', id, ok: true, result: manageDevices(rawCommand) });
            return;
          }
          const denied = scopeProblem(access.scope, rawCommand.op);
          if (denied) throw new Error(denied);
          // Potvrzení incidentu uvolňuje blokaci, rezervace i nejistotu noh najednou → jen u Macu, ne z telefonu.
          if (rawCommand.op === 'ack' && !access.local) throw new Error('incident jde potvrdit jen na Macu, kde služba běží — z telefonu jde pozici zavřít');
          if (READ_ONLY) throw new Error('účet je připojený jen pro čtení — příkazy jsou vypnuté');
          const result = await exec!.execute(message.command);
          send(socket, { type: 'reply', id, ...result, serverMs: Math.round(performance.now() - receivedAt) });
        } catch (error) {
          send(socket, { type: 'reply', id, ok: false, sent: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  };
  server.on('connection', (socket) => serveClient(socket, { scope: 'full', local: true, label: 'tento Mac' }));

  // ── Spárovaná zařízení (telefon) ────────────────────────────────────────────────────────────────────────────
  // Vlastní port JEN pro spárovaná zařízení: sem míří Tailscale Serve. Klíč ze souboru (PC) tu neplatí, takže
  // vystavením tohoto portu se neotevře cesta pro kohokoli, kdo by znal starý sdílený klíč. Poslouchá dál jen
  // na 127.0.0.1 — do sítě ho pouští až Tailscale (šifrovaně, jen zařízením ve Filipově síti).
  // Seznam zařízení je pro každý systém ZVLÁŠŤ: brána drží seznam v paměti a ukládá ho celý, takže sdílený soubor
  // by druhá instance (Test vedle Lucidu) přepsala svou starou verzí — odvolaný telefon by se vrátil i na skutečný účet.
  // Skutečný systém si nechává původní `devices.json` (v něm je už spárovaný telefon).
  const devicesFile = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic', IS_TEST_SYSTEM ? 'devices-rithmic-test.json' : 'devices.json');
  const mobileServer = MOBILE_PORT === null ? null : new WebSocketServer({ host: '127.0.0.1', port: MOBILE_PORT, maxPayload: 16 * 1024, verifyClient: (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } }) => gateway!.verify(info.origin, info.req.headers) });
  const gateway = createDeviceGateway({
    store: fileDeviceStore(devicesFile),
    origins: MOBILE_ORIGINS,
    tailscaleLogin: TAILSCALE_LOGIN,
    serve: (socket, device) => serveClient(socket as WebSocket, { scope: device.scope, local: false, label: device.name, deviceId: device.id }),
    log: (text) => console.log(`[zařízení] ${text}`),
  });
  mobileServer?.on('connection', (socket) => gateway.accept(socket));
  function manageDevices(command: Record<string, unknown>): unknown {
    if (MOBILE_PORT === null) throw new Error('služba běží bez portu pro zařízení — spusť ji s --mobile');
    return gateway.manage(command);
  }
  const activeDevice = (id: string) => gateway.active(id);
  setInterval(() => console.log(`[ceny] ticků ${tickCount}, poslední cena ${displayPrice(Date.now())}`), 15_000).unref();
  setInterval(() => {
    if (exchangeLag.length || gatewayLag.length) console.log(`[měření] cena burza → Mac: ${quantiles(exchangeLag)} · brána Rithmicu → Mac: ${quantiles(gatewayLag)}`);
    exchangeLag = [];
    gatewayLag = [];
  }, 60_000).unref();
  console.log(`Aplikace u Rithmicu: "${APP_NAME}" · systém "${SYSTEM}"${READ_ONLY ? ' · JEN PRO ČTENÍ (příkazy vypnuté)' : ''}`);
  console.log(`Místní proces běží: ws://127.0.0.1:${PORT} · ${SYSTEM} · ${CONTRACT} · účet ${broker.accountIds()[0]}`);
  console.log(`Stránka: http://127.0.0.1:${QA_PORT}/tests/qa/rithmic-live.html#token=<viz ${tokenPath}>`);
  if (MOBILE_PORT !== null) console.log(`Zařízení (telefon): ws://127.0.0.1:${MOBILE_PORT} — ven jen přes Tailscale Serve; ${gateway.summary()}${TAILSCALE_LOGIN ? ` · jen pro ${TAILSCALE_LOGIN}` : ' · POZOR: bez --tailscale-login port ověřuje jen klíč zařízení'}`);
  const stop = (): void => {
    console.log('Končím (příkazy u Rithmicu zůstávají, jak jsou).');
    server.close();
    mobileServer?.close();
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
