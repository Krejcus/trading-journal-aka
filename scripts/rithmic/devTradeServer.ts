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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { commandStatus } from '../../services/rithmic/rithmicCommandStatus';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyViolation } from '../../services/rithmic/readOnlyGuard';
import { liveConsentPhrase, liveTradingConsentProblem, type LiveTradingConsent } from '../../services/rithmic/liveTradingConsent';
import WebSocket, { WebSocketServer } from 'ws';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../../services/rithmic/rithmicBroker';
import { RithmicCandleBuilder } from '../../services/rithmic/rithmicCandleBuilder';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
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
const PORT = Number(arg('port', '3311'));
const QA_PORT = arg('qa-port', '4185');
// Další povolené adresy stránky (např. https://<mac>.<tailnet>.ts.net přes Tailscale Serve):
// RITHMIC_DEV_ORIGINS=https://a.ts.net,https://b.ts.net. Proces dál poslouchá jen na 127.0.0.1.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${QA_PORT}`, `http://localhost:${QA_PORT}`,
  // Vývojová appka (záložka LIVE). Produkční adresa se sem dostane až s rozhodnutím o nasazení.
  'http://localhost:3000', 'http://127.0.0.1:3000',
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
    const socket = new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike;
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
  const broker = createRithmicBroker({
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
  let tickDirty = false;
  let lastBar: { time: number; open: number; high: number; low: number; close: number; volume: number } | null = null;
  setInterval(() => {
    if (!tickDirty) return;
    tickDirty = false;
    const now = Date.now();
    broadcast({ type: 'tick', symbol: CONTRACT, price: freshPrice(now), bar: candles.current(CONTRACT, now), at: now });
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
        const toSec = Date.now() / 1_000;
        // Začátek musí padnout DO obchodní seance: kdyby řada začínala otevřením po víkendu nebo přestávce,
        // první svíčka by proti starší historii appky skočila (víkendový gap) a ta by se k ní nepřipojila.
        let fromSec = toSec - HISTORY_HOURS * 3_600;
        let rows = await ticker.timeBarReplay({ symbol: CONTRACT, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec, toSec });
        for (let attempt = 0; attempt < 3 && rows.length > 0 && rows[0].time - fromSec > 180; attempt += 1) {
          fromSec -= 24 * 3_600;
          rows = await ticker.timeBarReplay({ symbol: CONTRACT, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec, toSec });
        }
        historyCache = { bars: rows.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })), at: Date.now() };
      } catch (error) {
        // Selhání nesmí být tiché: poslední známá historie zůstává, další pokus až za minutu.
        historyCache = { bars: historyCache.bars, at: Date.now() };
        console.log(`[historie] čtení selhalo (${error instanceof Error ? error.message : String(error)}) — nechávám poslední známou (${historyCache.bars.length} svíček)`);
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
  /** Spojení pro ceny žije? Když spadne, stránka má cenu označit za starou; obnovuje se s rostoucím odstupem. */
  let feedOpen = false;
  let historyOk = false;
  const restoring = new Set<'ticker' | 'history'>();
  /** Stejným jménem se přihlásil někdo jiný: od té chvíle se proces k cenám ani historii sám nepřipojuje. */
  let forcedOut = false;
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
            // Stránky se připojí znovu a dostanou čerstvé svíčky včetně těch z doby výpadku.
            for (const socket of clients) socket.close(4000, 'feed restored');
          } else {
            historyOk = true;
            console.log('[historie] obnovena');
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
  await ticker.subscribeMarketData(CONTRACT, 'CME');
  feedOpen = true;

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
  const effectiveLimits = () => broker.isConnected() && broker.routeEpoch?.(broker.accountIds()[0]) === rmsEpoch && Date.now() - rmsAt < 15_000 ? rms : null;
  let publishedLimits: ReturnType<typeof effectiveLimits> = null;
  function publishLimits() {
    const next = effectiveLimits();
    if (next?.buy === publishedLimits?.buy && next?.sell === publishedLimits?.sell && next?.order === publishedLimits?.order) return;
    publishedLimits = next;
    broadcast({ type: 'limits', limits: next });
  }
  async function refreshLimits() {
    if (loadingLimits || !broker.isConnected()) return;
    const account = broker.accountIds()[0];
    const product = typeof ref?.raw.product_code === 'string' ? ref.raw.product_code : CONTRACT.match(/^([A-Z0-9]+)[FGHJKMNQUVXZ]\d{1,2}$/)?.[1];
    if (account === undefined || !product) return;
    loadingLimits = true;
    const epoch = broker.routeEpoch?.(broker.accountIds()[0]);
    try {
      const limits = await broker.readQuantityLimits(account, product);
      rms = limits && { buy: Math.min(manualCap, limits.buy), sell: Math.min(manualCap, limits.sell), order: Math.min(manualCap, limits.order) };
      rmsEpoch = epoch;
      rmsAt = Date.now();
    } catch { rms = null; } finally { loadingLimits = false; }
    publishLimits();
  }
  exec = new LocalExec({
    broker, symbols: { [CONTRACT]: { tickSize } }, maxQuantity: manualCap, quantityLimits: effectiveLimits,
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
      read: () => { try { return JSON.parse(readFileSync(replaceMarkerFile, 'utf8')) as { symbol: string; at: number }; } catch { return null; } },
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
    broadcast({ type: 'beat', at, feed: freshPrice(at) !== null });
    // A stalled RMS refresh can expire even while the market feed remains active.
    publishLimits();
  }, 1_000).unref();
  setInterval(() => void refreshLimits(), 5_000).unref();
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
  server.on('connection', (socket) => {
    clients.add(socket);
    /** Nejvýš 20 příkazů za 10 s na spojení. */
    let recent: number[] = [];
    const now = Date.now();
    // Identita hned (systém, režim, kontrakt) se svíčkami od startu; historie dorazí druhou zprávou, až bude.
    const liveBars = (at: number, after: number) => [...candles.finished(CONTRACT), ...(candles.current(CONTRACT, at) ? [candles.current(CONTRACT, at)!] : [])].filter((bar) => bar.time > after);
    const hello = (bars: unknown[], at: number) => send(socket, { type: 'hello', readOnly: READ_ONLY, closeOnly: CLOSE_ONLY, live: LIVE_TRADING, account: broker.accountName(broker.accountIds()[0]), limits: effectiveLimits(), feed: freshPrice(at) !== null, system: SYSTEM, symbol: CONTRACT, tickSize, pointValue: ref?.pointValue ?? null, price: freshPrice(at) ?? displayPrice(at), bars });
    hello(liveBars(now, -Infinity), now);
    send(socket, { type: 'state', state: exec!.state() });
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
          const message = JSON.parse(String(raw)) as { id?: unknown; command?: LocalExecCommand };
          id = message.id ?? null;
          if (!message.command || typeof message.command !== 'object') throw new Error('zpráva bez příkazu');
          const at = Date.now();
          recent = recent.filter((time) => at - time < 10_000);
          // Brzda (zavření) se neomezuje nikdy.
          if (message.command.op !== 'flatten') {
            if (recent.length >= 20) throw new Error('příliš mnoho příkazů za krátkou dobu');
            recent.push(at);
          }
          const rawCommand = message.command as unknown as Record<string, unknown>;
          if (rawCommand.op === 'lookup') {
            const result = await commandStatus(broker, rawCommand, CONTRACT);
            send(socket, { type: 'reply', id, ok: true, result });
            return;
          }
          if (READ_ONLY) throw new Error('účet je připojený jen pro čtení — příkazy jsou vypnuté');
          const result = await exec!.execute(message.command);
          send(socket, { type: 'reply', id, ...result, serverMs: Math.round(performance.now() - receivedAt) });
        } catch (error) {
          send(socket, { type: 'reply', id, ok: false, sent: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  setInterval(() => console.log(`[ceny] ticků ${tickCount}, poslední cena ${displayPrice(Date.now())}`), 15_000).unref();
  console.log(`Aplikace u Rithmicu: "${APP_NAME}" · systém "${SYSTEM}"${READ_ONLY ? ' · JEN PRO ČTENÍ (příkazy vypnuté)' : ''}`);
  console.log(`Místní proces běží: ws://127.0.0.1:${PORT} · ${SYSTEM} · ${CONTRACT} · účet ${broker.accountIds()[0]}`);
  console.log(`Stránka: http://127.0.0.1:${QA_PORT}/tests/qa/rithmic-live.html#token=<viz ${tokenPath}>`);
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
