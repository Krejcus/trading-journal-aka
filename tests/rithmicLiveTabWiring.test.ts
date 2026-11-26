// Zapojení Rithmic grafu do záložky LIVE: hlídá, že nová větev nesahá na kopírku Tradovate,
// existuje jen ve vývojové appce a že obrazovka v režimu jednoho účtu nemíří na skupinu kopírky.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_HOTKEY_BUSY_TEXT_SOLO, LIVE_HOTKEY_SOLO_FLATTEN_TEXT, liveHotkeyHelp, resolveLiveHotkey } from '../lib/liveHotkeys';
import { rithmicLocalAllowedHere, takeRithmicTokenFromHash } from '../lib/rithmicLocalLink';
import { rithmicScreenInstrumentIssue } from '../components/RithmicLiveChart';
import { rithmicFlattenReply, rithmicLegView, rithmicTradeEvents, UNIFIED_LINE_TICKS } from '../hooks/useRithmicLocalTrading';
import { LIVE_MANAGE_BUSY_TEXT } from '../hooks/useLiveManageRunner';
import { liveSoloNoticeText } from '../lib/liveSoloTexts';
import { READ_ONLY_ALLOWED_TEMPLATES, RITHMIC_WRITE_TEMPLATES, readOnlyViolation } from '../services/rithmic/readOnlyGuard';
import { RITHMIC_TEMPLATES } from '../services/rithmic/proto/rithmicTemplates';
import { encodeRithmicFrame } from '../services/rithmic/rithmicCodec';
import { liveTicketLegsProblem } from '../lib/liveBareEntry';
import { liveLineMoveBlockReason } from '../lib/liveChartOrderLines';
import { LIVE_COMMAND_BUSY_TEXT } from '../hooks/liveCommandRuns';

const desk = readFileSync('components/LiveDesk.tsx', 'utf8');
const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
const chart = readFileSync('components/RithmicLiveChart.tsx', 'utf8');
const hook = readFileSync('hooks/useRithmicLocalTrading.ts', 'utf8');
const conn = readFileSync('lib/rithmicLocalConnection.ts', 'utf8');
const server = readFileSync('scripts/rithmic/devTradeServer.ts', 'utf8');
const link = readFileSync('lib/rithmicLocalLink.ts', 'utf8');

describe('Rithmic graf v desku LIVE', () => {

  it('komponenta nevyrábí stav kopírky a nepředává sdílený zámek', () => {
    expect(chart).not.toMatch(/armed:\s*true/);
    expect(chart).not.toContain('manageLockRef');
    expect(chart).not.toContain('as never');
  });
});

describe('brána dostupnosti', () => {
  it('vývojová appka na místní adrese a produkční appka na své přesné adrese; nikdy nativní', () => {
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'localhost', native: false })).toBe(true);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: '127.0.0.1', native: false })).toBe(true);
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'localhost', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'alphatrade-mentor-15.vercel.app', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'localhost', native: true })).toBe(false);
    // produkce (19. 11.): jen přesná adresa, ne náhledy Vercelu ani podobné domény
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'alphatrade-mentor-15.vercel.app', native: false })).toBe(true);
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'alphatrade-mentor-15-abc123-krejcus-projects.vercel.app', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'alphatrade-mentor-15.vercel.app.evil.com', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'alphatrade-mentor-15.vercel.app', native: true })).toBe(false);
  });

  it('token i převzetí z adresy jdou přes bránu; adresa je napevno místní smyčka', () => {
    expect(link).toMatch(/if \(!allowedHere\(\)\) return null;\n {2}adoptTokenFromLocation\(\);/);
    expect(link).toMatch(/if \(adopted \|\| !allowedHere\(\)\) return;/);
    expect(link).toMatch(/const RITHMIC_LOCAL_ENDPOINT = 'ws:\/\/127\.0\.0\.1:3311';/);
    expect(link.match(/ws:\/\//g)).toHaveLength(1);
  });

  it('hash: převezme jen platný token a ostatní parametry nechá', () => {
    expect(takeRithmicTokenFromHash('#rithmic-token=abcdefghijklmnop1234&x=1')).toEqual({ token: 'abcdefghijklmnop1234', rest: '#x=1' });
    expect(takeRithmicTokenFromHash('#rithmic-token=kratky')).toEqual({ token: null, rest: '' });
    expect(takeRithmicTokenFromHash('#jine=1')).toEqual({ token: null, rest: '#jine=1' });
  });

  it('místní proces: z produkce jen přesná adresa appky (žádné náhledy ani jiné https), jen Rithmic Test bez souhlasu', () => {
    const origins = server.slice(server.indexOf('const ALLOWED_ORIGINS'), server.indexOf(']);', server.indexOf('const ALLOWED_ORIGINS')));
    expect(origins.match(/https:\/\/[^'\s]+/g)).toEqual(['https://alphatrade-mentor-15.vercel.app']);
    // Bez přepínače skutečného obchodování (a souhlasu vydaného člověkem) je povolený jen Rithmic Test.
    expect(server).toMatch(/allowedSystems: LIVE_TRADING \? \[SYSTEM\] : \['Rithmic Test'\],/);
  });
});

describe('obrazovka v režimu jednoho účtu', () => {
  it('Shift+F neotevře Flatten skupiny a hláška zámku na něj nenavádí', () => {
    expect(screen).toMatch(/\.\.\.\(solo \? \{ openFlatten: \(\) => \{ setLineNotice\(\{ at: now, tone: 'warn', text: LIVE_HOTKEY_SOLO_FLATTEN_TEXT \}\); return true; \} \} : \{\}\),/);
    expect(LIVE_HOTKEY_BUSY_TEXT_SOLO).not.toMatch(/Shift\+F|Flatten/);
    expect(LIVE_HOTKEY_SOLO_FLATTEN_TEXT).toMatch(/nic nezavírá/);
    expect(liveHotkeyHelp(true).some(item => item.keys === 'Shift+F')).toBe(false);
    expect(liveHotkeyHelp(false).some(item => item.keys === 'Shift+F')).toBe(true);
    const busy = resolveLiveHotkey({ kind: 'close-position' } as never, { lines: [], breakEven: null, hasDraft: false, busy: true, solo: true }, { current: null }, 1);
    expect(busy).toMatchObject({ kind: 'blocked', text: LIVE_HOTKEY_BUSY_TEXT_SOLO });
  });

  it('texty v režimu jednoho účtu nenavádějí na Flatten skupiny; pozice bez SL jde zavřít; žádná ukázková skupina', () => {
    expect(liveSoloNoticeText(LIVE_MANAGE_BUSY_TEXT)).not.toMatch(/Flatten/);
    expect(liveSoloNoticeText('Cena SL/TP pozice není jedna nebo není známá — nic se neodeslalo. Sjednoť ji v Tradovate, nebo zavři Flattenem.')).not.toMatch(/Flatten|Tradovate/);
    expect(screen).toMatch(/if \(solo && line\.kind === 'entry' && summary\?\.kind === 'position'\) \{ void runLiveManage\('close-position', summary\.stop \?\? summary\.entry \?\? 0\); return; \}/);
    expect(screen).toMatch(/\(solo \? null : workerGroup \?\? \(sample \?/);
  });

  it('× pozice a karty se řídí místní službou; události kopírky se do grafu nepromítnou', () => {
    expect(screen).toMatch(/const closeAllowed = solo \? solo\.available : copier\.available && copier\.status\?\.armed === true && copier\.status\.shadowMode !== true;/);
    expect(screen).toMatch(/solo \? copyEvents \?\? undefined : copyEvents \?\? copier\.status\?\.recentCopyEvents/);
    expect(screen).toMatch(/\.\.\.\(solo \? \{ canClose: manageCloseSupported === true && solo\.available \} : \{\}\),/);
    expect(screen).toMatch(/\.\.\.\(solo \? \{ events: shownEvents, fills: undefined, available: solo\.available \} : \{\}\),/);
  });

  it('incident kopírky se v hlavičce neschovává; informační čipy Worker a Kopírka Tradovate v Rithmic grafu ano (21. 11.)', () => {
    // Incident a výzva ke kontrole Dashboardu zůstávají i v režimu jednoho účtu (INV-UI-02).
    expect(screen).toMatch(/\{strip\.notice && <button/);
    expect(screen).toMatch(/\{!strip\.notice && attention\.length > 0 && <button/);
    // Jen informační stav workeru a kopírky Tradovate je v Rithmic grafu schovaný (rozhodnutí Filipa 21. 11.).
    expect(screen).toMatch(/\{workerChip && !solo && <button/);
    expect(screen).toMatch(/\{copierChip && \(!solo \|\| copierChip\.tone === 'warn' \|\| copierChip\.tone === 'danger'\) && <button/);
    // Řádek stavu svíček: v Rithmic grafu jen při varování o datech.
    expect(screen).toMatch(/\{\(!solo \|\| chart\.quality\.tone === 'warn'\) && <ChartDataStatus/);    // S výběrem účtu: bez nápisu LIVE a bez štítku účtu; stav spojení (odpojeno, jen čtení, SKUTEČNÝ ÚČET) zůstává.
    expect(screen).toMatch(/\{accountBar && solo\?\.statusNote && <span data-solo-status/);
    expect(screen).toMatch(/\{soloAccountLabel && !accountBar && <span/);    // Sloučení s lištou grafu jen s vykresleným grafem; navigace na přehled zůstává jako ikony (INV-UI-02).
    expect(screen).toMatch(/const mergedHeader = Boolean\(accountBar\) && chart\.candles\.length > 0;/);
    // Čáry DLL / MLL jdou vlastním kanálem i do exekučního panelu; jen s výběrem účtu (jen zobrazení).
    expect(screen).toMatch(/liveLimitLines=\{accountBar \? limitLines : null\}/);
    // Čáry jdou vypnout v nastavení grafu (Automatika grafu); štítky vzdálenosti vpravo dole zrušené (21. 11.).
    expect(screen).toMatch(/limitPrices\.dll && limitPrefs\.limitDll/);
    expect(screen).not.toMatch(/data-live-limit-distance/);
    expect(screen).toMatch(/\{!mergedHeader && <header/);
    expect(screen).toMatch(/toolbarFixedEnd=\{mergedHeader \? <div className="flex items-center gap-1" data-live-merged-header>\{compactTabs\}\{headerRight\}<\/div> : undefined\}/);
  });

  it('alerty jsou v režimu jednoho účtu jen na skutečném trhu (hlídá je služba); na zkušebním vypnuté; výchozí zdroj dat se nečte', () => {
    expect(screen).toMatch(/const alertsOff = solo != null && solo\.alerts !== true;/);
    expect(screen).toMatch(/muted: alertsOff/);
    expect(screen).toMatch(/\{!alertsOff && <LivePcAlertsButton/);
    expect(screen).toMatch(/\{!alertsOff && <LivePcAlertDialogs/);
    expect(screen).toMatch(/\{alertsOff \? null : basePriceAlertBridge\.renderLines\(api, dark\)\}/);
    // Zkušební systém i simulace mají smyšlené ceny: tam se alerty nezapnou ani v grafu, ani ve službě.
    expect(chart).toMatch(/const alertsReal = !simulationUrl && trading\.system != null && trading\.system !== 'Rithmic Test';/);
    expect(chart).toMatch(/alerts: alertsReal/);
    expect(screen).toMatch(/disabled: marketData != null/);
    // Starší historie appky (skutečný MNQ) se k cizímu zdroji svíček nepřipojuje; kanál TV se neodebírá.
    expect(screen).toMatch(/externalMarketData: marketData != null && solo\?\.historyFromApp !== true,/);
    expect(readFileSync('components/AlphaTradeChartWorkspace.tsx', 'utf8')).toMatch(/const htf = externalMarketData \? EXTERNAL_HTF : htfRead;/);
    // Graf dne si dnešní svíčky bere ze služby Rithmic sám; s vlastním zdrojem (LIVE graf) se druhé spojení neotevírá.
    const dayData = readFileSync('hooks/useDayChartData.ts', 'utf8');
    expect(dayData).toMatch(/const live = useRithmicDayCandles\(candleWindow\.needsLive && !disabled\);/);
    expect(dayData).toMatch(/const liveFeed = candleWindow\.needsLive && !disabled && now < candleWindow\.dayEnd \? live\.feed : null;/);
    expect(screen).toMatch(/layoutScope=\{solo \? 'live-trading-rithmic' : 'live-trading'\}/);
  });
});

describe('hook místního procesu', () => {
  it('čerstvost se nevyrábí v prohlížeči a vstup bez živého spojení neodejde', () => {
    expect(hook).not.toMatch(/liveStatus: 'live'/);
    expect(hook).toMatch(/liveStatus: link === 'open' && feedLive \? 'live' : 'stale'/);
    expect(hook).toMatch(/if \(!entryReadyRef\.current\) return \{ \.\.\.base, status: 'blocked'/);
    expect(hook).toMatch(/if \(!availableRef\.current\) return blocked\(NOT_READY\);/);
    // Zavření nezávisí na živé ceně.
    expect(hook).toMatch(/const available = link === 'open' && helloFresh && Boolean\(state\?\.connected\) && !readOnly;/);
    expect(hook).toMatch(/const entryReady = available && feedLive && !silent && price !== null;/);
    // Po výpadku je první stav výchozí a čekající příkazy končí „unknown" bez opakování.
    expect(hook).toMatch(/seen\.current = null;/);
    expect(conn).toMatch(/sent: 'unknown', error: 'spojení s místním procesem spadlo/);
    expect(conn.match(/socket\.send\(/g)).toHaveLength(1);
    expect(hook).not.toMatch(/new WebSocket\(|socket\.send\(/);
    // Konec relace maže cenu i stav; vstup chce cenu z aktuálního spojení a mlčící proces pustí jen zavření.
    expect(hook).toMatch(/const entryReady = available && feedLive && !silent && price !== null;/);
    expect(hook).toMatch(/if \(silentRef\.current && action !== 'close-position'\) return blocked\(/);
    // Konec relace hlásí jádro spojení při výpadku i při ukončení (chování hlídá tests/rithmicLocalConnection.test.ts).
    expect(conn.match(/this\.options\.handlers\.onSessionReset\(\);/g)).toHaveLength(2);
    expect(hook).toMatch(/onSessionReset: \(\) => \{/);
    // Neznámý stav není „bez pozice".
    expect(hook).toMatch(/if \(!state\) return \{ key: 'rithmic-unknown'/);
  });

  it('brzda jde mimo zámek obrazovky, nezávisí na ceně a nic neopakuje; nejisté příkazy se nepřepisují', () => {
    const close = hook.slice(hook.indexOf('const closeNow = useCallback'), hook.indexOf('}, [send]);', hook.indexOf('const closeNow = useCallback')));
    expect(close).toContain("const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });");
    expect(close).not.toMatch(/availableRef|entryReadyRef|silentRef|busyRef|runWithCommandLock/);
    expect(close.match(/send\(/g)).toHaveLength(1);
    expect(close).toMatch(/if \(closingNow\.current\) return \{ status: 'blocked'/);
    expect(hook).toContain('setUncertain(current => [...current.filter(item => item.id !== next.id), next])');
    expect(screen).toMatch(/\{solo\?\.emergencyClose && <button/);
    expect(chart).toMatch(/link === 'open' && offerBrake && !trading\.readOnly \? \{ emergencyClose: \{ run: emergencyClose, busy: closeBusy \} \}/);
    // S výběrem účtu v liště se v klidu schová; při čemkoli, co může zablokovat běžné zavření, se vrátí (21. 11.).
    // Brzda i když × a Shift+X zrovna nejdou: příkaz čeká na výsledek, přehrávání, Rithmic odpojený.
    expect(chart).toMatch(/const brakeNeeded = uncertainList\.length > 0 \|\| \(trading\.mayHaveExposure && !hasPosition\) \|\| unprotected \|\| trading\.commandInFlight \|\| replaying \|\| !trading\.available\s+\|\| Boolean\(blocked\) \|\| trading\.silent \|\| !trading\.helloFresh;/);
    expect(chart).toMatch(/accountBar=\{accountBar\} onReplayChange=\{setReplaying\}/);
    // Pozice bez známé ceny SL: × ji nezavře, brzda musí zůstat.
    expect(chart).toMatch(/const unprotected = hasPosition && \(trading\.position\?\.summary\?\.kind !== 'position' \|\| trading\.position\.summary\.stop == null\s+\|\| \(trading\.legCoverage != null && trading\.legCoverageTotal\.stopLoss < trading\.position\.summary\.quantity\)\);/);
    expect(chart).toMatch(/const offerBrake = \(trading\.mayHaveExposure \|\| uncertainList\.length > 0\) && \(!accountBar \|\| brakeNeeded\);/);
    // Nabízí se i při neznámém stavu a visícím vstupu; nejistý výsledek od služby se zapíše mezi nejisté.
    expect(hook).toMatch(/mayHaveExposure: state === null \|\| net != null \|\| orders\.some\(order => order\.status === 'working'\),/);
    expect(conn).toContain("reason: 'Zavření nemá jednoznačné potvrzení'");
  });

  it('odmítnuté ani nejisté zavření se netváří jako hotové', () => {
    expect(rithmicFlattenReply({ ok: true, result: { status: 'submitted' } }).ok).toBe(true);
    expect(rithmicFlattenReply({ ok: true, result: { status: 'already-flat' } }).ok).toBe(true);
    expect(rithmicFlattenReply({ ok: true, result: { status: 'rejected', reason: 'kód 6' } })).toEqual({ ok: false, sent: false, error: 'kód 6' });
    expect(rithmicFlattenReply({ ok: true, result: { status: 'indeterminate', reason: 'nepřišla' } })).toEqual({ ok: false, sent: 'unknown', error: 'nepřišla' });
    expect(rithmicFlattenReply({ ok: true, result: {} })).toMatchObject({ ok: false, sent: 'unknown' });
    expect(hook.match(/const reply = rithmicFlattenReply\(raw\);/g)).toHaveLength(2);
    // Nejistou odpověď služby zapisuje příjem odpovědi pro každý příkaz kromě potvrzení incidentu, dohledání
    // a zpráv o upozorněních na cenu (ty nejsou příkaz).
    expect(conn).toMatch(/if \(tracked\(pending\.op\) && !reply\.ok && reply\.sent !== false\) this\.options\.handlers\.onUncertain\(/);
    expect(conn).toMatch(/const UNTRACKED_OPS = new Set\(\['ack', 'lookup', 'alerts-key', 'alerts-set'\]\);/);
    expect(hook.match(/op: 'flatten'/g)).toHaveLength(2);
  });

  it('vstup bez SL/TP a s jednou nohou jen v režimu jednoho účtu', () => {
    expect(liveTicketLegsProblem({ type: 'limit', stopLoss: 100, takeProfit: null }, false, false, false)).toMatch(/Vyplň SL i TP/);
    expect(liveTicketLegsProblem({ type: 'limit', stopLoss: 100, takeProfit: null }, false, false, false, true)).toBeNull();
    expect(liveTicketLegsProblem({ type: 'market', stopLoss: null, takeProfit: 100 }, false, false, false, true)).toBeNull();
    expect(chart).toMatch(/entryBareSupported entryBarePendingSupported/);
    // V pozici další vstup ne (přikoupení služba neumí) a okamžité odeslání z menu grafu se v solo nenabízí.
    // V pozici jen přikoupení: Market na stranu pozice a jen když ho režim přikoupení nabízí (službu to váže znovu).
    // Přikoupení: Market, nebo Limit (čekající přikoupení se po zavření pozice samo zruší); o všem rozhoduje služba.
    // Volný režim (26. 11. 2026): na stranu pozice smí jakýkoli vstup; proti pozici jen odebrání z holé pozice.
    // Bez zapnutých více vstupů ve službě (`state.multiEntry`) platí dosavadní přísné přikoupení.
    expect(hook).toMatch(/if \(!reducing && \(!sameSide \|\| \(!multi && \(!add\?\.canAdd \|\| \(draft\.orderType !== 'Market' && draft\.orderType !== 'Limit'\)\)\)\)\) \{/);
    expect(hook).toMatch(/const multi = stateRef\.current\?\.multiEntry === true;/);
    expect(hook).toMatch(/const scaleIn = multiEntry \? freeScaleIn : strictScaleIn;/);
    expect(hook).toMatch(/const sameSide = held !== 0 && \(draft\.side === 'Buy'\) === \(held > 0\);/);
    // Odebrání z pozice (26. 11. 2026): jen holý Market proti pozici bez SL/TP, s výslovným úmyslem z lišty.
    expect(hook).toMatch(/const reducing = draft\.reduceOnly === true && add != null && !sameSide && add\.stopLoss == null && add\.targetPrice == null\s+&& draft\.orderType === 'Market' && draft\.stopLoss === undefined && draft\.takeProfit === undefined;/);
    expect(hook).toMatch(/\.\.\.\(draft\.reduceOnly === true \? \{ reduceOnly: true \} : \{\}\)/);
    // Deník: další vstup smí odejít jen když všechno čekající jsou holé Markety na cestě (ne nejisté).
    expect(hook).toMatch(/&& !\(quick && waitingRows\.every\(row => quickInFlight\.has\(row\.id\)\)\)\) throw new Error\('Ověř předchozí příkaz u brokera\.'\)/);
    expect(hook).toMatch(/onUncertain: item => \{\s+quickInFlight\.delete\(item\.id\);/);
    expect(hook).toMatch(/const pendingAdd = \(draft\.orderType === 'Limit' \|\| \(draft\.orderType === 'Stop' && stateRef\.current\?\.multiEntry === true\)\) && stateRef\.current\?\.positions\.some/);
    expect(screen).toMatch(/const instantBareReady = !solo && entryBarePendingSupported/);
    expect(liveSoloNoticeText(LIVE_COMMAND_BUSY_TEXT)).not.toMatch(/Flatten/);
    expect(chart).toMatch(/available: usable, singleLeg: true/);
    expect(screen).toMatch(/entrySingleLegSupported=\{solo\?\.singleLeg === true\}/);
  });

  it('posun čekajícího vstupu: SL/TP stojí na svých cenách, nový vstup musí ležet mezi nimi; služba vstup vymění', () => {
    const pending = { kind: 'pending', side: 'long', quantity: 1, entry: 100, entryType: 'Limit', stop: 97, target: 106 } as never;
    expect(liveLineMoveBlockReason(pending, 'entry', 102, { moveLimit: true, stopEntryMove: true })).toBeNull();
    expect(liveLineMoveBlockReason(pending, 'entry', 96, { moveLimit: true, stopEntryMove: true })).toMatch(/SL/);
    expect(liveLineMoveBlockReason(pending, 'entry', 107, { moveLimit: true, stopEntryMove: true })).toMatch(/TP/);
    // vstup jen s jednou nohou se hlídá jen proti ní
    expect(liveLineMoveBlockReason({ kind: 'pending', side: 'long', quantity: 1, entry: 100, entryType: 'Limit', stop: 97, target: null } as never, 'entry', 110, { moveLimit: true, stopEntryMove: true })).toBeNull();
    expect(screen).toMatch(/stopEntryMove: solo != null \}\);/);
    expect(hook).toMatch(/if \(action === 'move-limit'\) \{/);
    expect(hook).toMatch(/return replaceEntry\(entry, \{ price: newPrice \}\);/);
    // Výměnu vstupu posílá hlavní cesta (jedna) a cesta dalších příkazů cílená podle id (vstup a jeho plánovaná noha).
    expect(hook.match(/op: 'replace-entry'/g)).toHaveLength(3);
    expect(hook.match(/op: 'replace-entry', clientId: newId\(\), orderId: order\.orderId/g)).toHaveLength(2);
    expect(chart).toMatch(/managePendingLegsSupported/);
  });

  it('posun čekajícího Stop vstupu: jen přes Rithmic (jeden účet), s ochranou i bez, s libovolným množstvím', () => {
    const stop = (patch = {}) => ({ kind: 'pending', side: 'long', quantity: 1, entry: 110, entryType: 'Stop', stop: 107, target: 116, ...patch }) as never;
    // cesta kopírky Stop dál neposouvá
    expect(liveLineMoveBlockReason(stop(), 'entry', 112, { moveLimit: true })).toMatch(/jen čekající Limit/);
    expect(liveLineMoveBlockReason(stop({ stop: null, target: null }), 'entry', 112, { moveBareEntry: true })).toMatch(/zatím nejde/);
    expect(liveLineMoveBlockReason(stop(), 'entry', 112, { moveLimit: true, stopEntryMove: true })).toBeNull();
    expect(liveLineMoveBlockReason(stop(), 'entry', 117, { moveLimit: true, stopEntryMove: true })).toMatch(/TP/);
    expect(liveLineMoveBlockReason(stop({ stop: null, target: null }), 'entry', 112, { moveBareEntry: true, stopEntryMove: true })).toBeNull();
    // víc kontraktů: služba vstup vymění (zruší a zadá znovu), takže množství nevadí
    expect(liveLineMoveBlockReason(stop({ quantity: 2 }), 'entry', 112, { moveLimit: true, stopEntryMove: true })).toBeNull();
    expect(liveLineMoveBlockReason(stop({ quantity: 2 }), 'entry', 112, { moveLimit: true })).toMatch(/jen čekající Limit/);
    expect(screen).toMatch(/stopEntryMove: solo != null,/);
  });

  it('částečné zavření: tlačítko jen když to služba umí; rozhoduje a posílá služba jedním příkazem', () => {
    expect(screen).toMatch(/\{solo\?\.reduce && <button/);
    expect(chart).toMatch(/\.\.\.\(usable && trading\.reducible \? \{ reduce: \{ run: reducePart, busy: reduceBusy, quantity: trading\.reducible\.quantity \} \} : \{\}\)/);
    expect(hook).toMatch(/if \(!net \|\| Math\.abs\(net\.netQuantity\) < 2\) return null;/);
    expect(hook.match(/op: 'reduce'/g)).toHaveLength(1);
  });

  it('SL/TP k otevřené pozici: jen jeden z nich, odebrat jde jen samostatnou ochranu', () => {
    const leg = hook.slice(hook.indexOf('const onBareLeg = useCallback'), hook.indexOf('const ack = useCallback'));
    // Druhá noha jde k jediné samostatné ochraně opačného druhu, nebo k jediné noze ze vstupu na celou pozici (26. 11. 2026).
    expect(leg).toMatch(/const soleEntryLeg = others\.length === 1 && others\[0\]\.entryId !== undefined && others\[0\]\.role === opposite && others\[0\]\.quantity - others\[0\]\.filledQuantity === heldNow;/);
    expect(leg).toMatch(/if \(others\.length > 0 && !soleEntryLeg && !\(others\.length === 1 && others\[0\]\.tag\?\.startsWith\('uiprot-'\) && others\[0\]\.role === opposite\)\) \{/);
    expect(leg).toMatch(/send\(\{ op: 'protect', clientId: newId\(\), symbol: sym, kind: role, price: intent\.price \}\)/);
    expect(leg).toMatch(/if \(!leg\.tag\?\.startsWith\('uiprot-'\)\) return blocked\(/);
    expect(leg).toMatch(/if \(!availableRef\.current\) return blocked\(NOT_READY\);/);
    expect(chart).toMatch(/bareLegTrade: trading\.bareLegTrade, onBareLeg: trading\.onBareLeg/);
  });

  it('dvě ochrany: čára ukazuje ochrannější SL a bližší TP, posun jde na obě najednou', () => {
    const leg = (orderId: string, role: 'stop' | 'target', price: number) => ({ orderId, symbol: 'MNQZ6', side: 'Sell', quantity: 1, filledQuantity: 0, status: 'working', role, price }) as never;
    const long = rithmicLegView([leg('a', 'stop', 100), leg('b', 'stop', 101), leg('c', 'target', 110), leg('d', 'target', 111)], 2);
    expect(long.stop?.orderId).toBe('b');
    expect(long.target?.orderId).toBe('c');
    expect(long.note).toMatch(/SL má 2 ceny \(100\.00 \/ 101\.00\), TP má 2 ceny/);
    const short = rithmicLegView([leg('a', 'stop', 120), leg('b', 'stop', 121), leg('c', 'target', 110), leg('d', 'target', 111)], -2);
    expect(short.stop?.orderId).toBe('a');
    expect(short.target?.orderId).toBe('d');
    expect(rithmicLegView([leg('a', 'stop', 100), leg('b', 'stop', 100)], 2).note).toBeNull();
    // obě cesty posunu (panel/klávesa i čára) jdou při více nohách přes move-legs s výčtem noh
    // … a jen pro nohy na ceně hlavní čáry (části s jinou cenou mají vlastní čáry); při různých cenách s `subset`.
    expect(hook.match(/send\(\{ op: 'move-legs', symbol: sym, role, price: [a-zA-Z.]+, expect: same\.map\(\(order\) => \(\{ orderId: order\.orderId, price: order\.price! \}\)\), \.\.\.\(same\.length < entryLegs\.length \? \{ subset: true \} : \{\}\) \}\)/g)).toHaveLength(2);
    // Samostatný SL zbytku (`uiprot-`) se mezi nohy vstupů nepočítá a posouvá se sám.
    expect(hook.match(/const entryLegs = legs\.filter\(\(order\) => !order\.tag\?\.startsWith\('uiprot-'\)\);/g)).toHaveLength(2);
    // Jen v režimu víc vstupů (`state.multiEntry`); jinak dosavadní „všechny nohy role" — tah i BE hýbou celou pozicí.
    expect(hook.match(/const same = leg\.tag\?\.startsWith\('uiprot-'\) \? \[leg\] : (current|stateRef\.current)\?\.multiEntry === true \? entryLegs\.filter\(\(order\) => sameLineRef\.current\(order\.price, leg\.price\)\) : entryLegs;/g)).toHaveLength(2);
    // Jednotná čára (26. 11. 2026): nohy do pár ticků od hlavní čáry (skluz Marketu při přikoupení) k ní patří.
    expect(UNIFIED_LINE_TICKS).toBe(4);
    expect(hook).toMatch(/const sameLine = \(a: number \| undefined, b: number \| undefined\) => a !== undefined && b !== undefined && Math\.abs\(a - b\) <= lineTolerance;/);
    // Spouštěč: víc vstupů na skutečném účtu jen na výslovné zapnutí; správa částí vždy, i v režimu jen pro zavírání.
    expect(server).toMatch(/\.\.\.\(IS_TEST_SYSTEM \|\| \(LIVE_TRADING && !CLOSE_ONLY && process\.argv\.includes\('--multi-entry'\)\) \? \{ multiEntry: true \} : \{\}\)/);
    expect(server).toMatch(/\.\.\.\(IS_TEST_SYSTEM \|\| LIVE_TRADING \? \{ multiManage: true \} : \{\}\)/);
    expect(chart).toMatch(/entryScaleIn=\{trading\.scaleIn\}/);
  });

  it('režim jen pro čtení: jiný systém než Rithmic Test jen s --read-only, zápisy blokované na spojení, ve službě i na obrazovce', () => {
    expect(server).toMatch(/if \(SYSTEM !== 'Rithmic Test' && !READ_ONLY && !LIVE_TRADING\) throw new Error\(/);
    expect(server).toMatch(/const blockedTemplate = readOnlyViolation\(data\);/);
    // Seznam povolených: každá požadavková šablona protokolu je buď výslovně čtecí, nebo zápisová — nic nezůstane nezařazené.
    for (const [id, name] of Object.entries(RITHMIC_TEMPLATES)) {
      if (!name.startsWith('Request')) continue;
      const read = READ_ONLY_ALLOWED_TEMPLATES.has(Number(id));
      const write = RITHMIC_WRITE_TEMPLATES.has(Number(id));
      expect(read !== write, `${id} ${name}`).toBe(true);
    }
    for (const id of RITHMIC_WRITE_TEMPLATES) expect(READ_ONLY_ALLOWED_TEMPLATES.has(id)).toBe(false);
    expect(readOnlyViolation(encodeRithmicFrame(312, { user_msg: ['x'] }))).toBe(312);
    expect(readOnlyViolation(encodeRithmicFrame(3504, { user_msg: ['x'] }))).toBe(3504);
    expect(readOnlyViolation(encodeRithmicFrame(18, { user_msg: ['x'] }))).toBeNull();
    expect(readOnlyViolation(new Uint8Array([1, 2, 3]))).not.toBeNull();
    expect(server).toMatch(/if \(READ_ONLY\) throw new Error\('účet je připojený jen pro čtení/);
    // Bez přepínače skutečného obchodování (a souhlasu vydaného člověkem) je povolený jen Rithmic Test.
    expect(server).toMatch(/allowedSystems: LIVE_TRADING \? \[SYSTEM\] : \['Rithmic Test'\],/);
    expect(hook).toMatch(/const available = link === 'open' && helloFresh && Boolean\(state\?\.connected\) && !readOnly;/);
    expect(chart).toMatch(/offerBrake && !trading\.readOnly \? \{ emergencyClose:/);
    expect(chart).toMatch(/trading\.bareLegTrade && !trading\.readOnly \?/);
    // starší historie appky jen na skutečném trhu
    expect(screen).toMatch(/externalMarketData: marketData != null && solo\?\.historyFromApp !== true,/);
    expect(chart).toMatch(/historyFromApp: trading\.system !== null && trading\.system !== 'Rithmic Test'/);
  });

  it('puštěná čára drží novou cenu jen v živém grafu, tlumeně a nejvýš po lhůtu (jen zobrazení)', () => {
    const overlay = readFileSync(new URL('../components/BacktestOrderLinesOverlay.tsx', import.meta.url), 'utf8');
    const workspace = readFileSync(new URL('../components/AlphaTradeChartWorkspace.tsx', import.meta.url), 'utf8');
    expect(workspace).toMatch(/holdMoveMs=\{liveOrderEntry && orderLineSource === liveOrderEntry \? 2500 : 0\}/);
    expect(overlay).toMatch(/holdMoveMs = 0, marketPrice, subscribeMarket \}\) => \{/);
    expect(overlay).toMatch(/if \(holdMoveMs > 0 && dragging\.lastPrice !== line\.price\) setHeldMove\(/);
    // Drží jen dokud čára stojí na původní ceně (nebo už na puštěné) — jiná cena od brokera podržení ruší.
    expect(overlay).toMatch(/heldLine\.price === heldMove\.from \|\| heldConfirmed/);
    expect(overlay).toMatch(/Math\.max\(0, heldMove\.until - Date\.now\(\)\)/);
  });

  it('čáry návrhu Market jdou s živou cenou přímo (jen zobrazení), ne až s překreslením obrazovky', () => {
    const overlay = readFileSync(new URL('../components/BacktestOrderLinesOverlay.tsx', import.meta.url), 'utf8');
    const screen = readFileSync(new URL('../components/LiveTradingScreen.tsx', import.meta.url), 'utf8');
    const quote = readFileSync(new URL('../hooks/useLiveTicketQuote.ts', import.meta.url), 'utf8');
    // Jen návrh Market a jen s živou cenou z kanálu; skutečné čáry pozice a příkazů `marketBase` nemají.
    expect(screen).toMatch(/draft\.type === 'market' && tick != null \? \{ \.\.\.line, marketBase: quote\.bid \} : line/);
    expect(overlay).toMatch(/if \(line\.marketBase === undefined\) return line\.price;/);
    // Skok ceny o desítky bodů čáru neposune (jiný zdroj ceny).
    expect(overlay).toMatch(/return Math\.abs\(delta\) > 50 \? line\.price : line\.price \+ delta;/);
    // První pohyb po klidu hned, dál nejvýš 10× za sekundu.
    expect(quote).toMatch(/const wait = 100 - \(receivedAt - flushedAt\);/);
  });

  it('telefon: spárování s Macem — klíč zařízení první zprávou, incident z telefonu potvrdit nejde, odmítnuté zařízení nabídne nové spárování', () => {
    const phone = readFileSync(new URL('../components/RithmicPhoneChart.tsx', import.meta.url), 'utf8');
    const link = readFileSync(new URL('../lib/rithmicLocalLink.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../scripts/rithmic/devTradeServer.ts', import.meta.url), 'utf8');
    // Klíč zařízení nejde do adresy: adresa spárovaného zařízení je holý endpoint, klíč dodává `auth`.
    expect(link).toMatch(/return readRithmicDeviceLink\(\)\?\.endpoint \?\? null;/);
    expect(link).toMatch(/return readRithmicDeviceLink\(\) \? \(\) => readRithmicDeviceKey\(\) : null;/);
    expect(readFileSync('components/RithmicPhoneSession.tsx', 'utf8')).toMatch(/const deviceAuth = useMemo\(\(\) => \(simulationUrl \? null : rithmicLocalAuth\(\)\)/);
    // Potvrzení incidentu se ze spárovaného zařízení neposílá a služba ho odmítá.
    expect(phone).toMatch(/if \(deviceAuth\) \{ setAckNote\(/);
    expect(server).toMatch(/if \(rawCommand\.op === 'ack' && !access\.local\) throw new Error\(/);
    // Správa zařízení jen z Macu; rozsah zařízení je první síto před službou.
    expect(server).toMatch(/if \(!access\.local\) throw new Error\('správa zařízení jde jen z Macu, kde služba běží'\);/);
    expect(server).toMatch(/const denied = scopeProblem\(access\.scope, rawCommand\.op\);/);
    // Port pro zařízení jen s výslovným přepínačem a jen na 127.0.0.1; klíč ze souboru (PC) na něm neplatí.
    expect(server).toMatch(/process\.argv\.includes\('--mobile'\)/);
    expect(server).toMatch(/new WebSocketServer\(\{ host: '127\.0\.0\.1', port: MOBILE_PORT,/);
    // Nespárováno nebo odmítnuto → panel spárování.
    expect(phone).toMatch(/if \(!simulationUrl && rithmicPairingOffered\(\) && \(!url \|\| trading\.authFailed\)\) \{/);
  });

  it('příkazy zadané jinde se kreslí jen pro zobrazení (ne jako vstup ani nohy této appky)', () => {
    expect(hook).toMatch(/const foreign = orders\.filter\(\(order\) => order\.role === 'other' && order\.status === 'working' && !hideOwnExit\(order, state\.blocked\)\);/);
    // Visící výstup se skrývat nesmí: jen krátce a jen dokud služba není zablokovaná.
    expect(hook).toMatch(/return !blocked && now - seen < OWN_EXIT_HIDE_MS;/);
    // Jediná výjimka: vlastní výstupní Market částečného zavření (značka ui-red-), jen zobrazení.
    expect(hook).toMatch(/const isOwnExit = \(order: \{ tag\?: string; orderType\?: string \}\): boolean => order\.orderType === 'Market' && \(order\.tag\?\.startsWith\('ui-red-'\) === true \|\| order\.tag\?\.startsWith\('ui-cut-'\) === true\);/);
    expect(hook).toMatch(/const view = liveWorkingOrderView\(\{/);
    expect(chart).toMatch(/workingOrders=\{trading\.workingView\}/);
  });

  it('jiný kontrakt než MNQ obrazovka odmítne', () => {
    expect(rithmicScreenInstrumentIssue({ symbol: 'MNQZ6', tickSize: 0.25, pointValue: 2 })).toBeNull();
    expect(rithmicScreenInstrumentIssue({ symbol: 'ESZ6', tickSize: 0.25, pointValue: 50 })).toMatch(/jen MNQ/);
    expect(rithmicScreenInstrumentIssue({ symbol: 'MNQZ6', tickSize: 0.25, pointValue: null })).toMatch(/jiný krok/);
  });

  it('noční změny 17./18. 11.: šipky z vyplnění, přikoupení Limitem jen na testu, samočinné zrušení až po potvrzení účtu, varování před koncem seance', () => {
    // šipky vstupu a výstupu: data ze služby (`marks`), do grafu jen jako zobrazení
    expect(hook).toMatch(/const liveFills = useMemo\(\(\) => liveChartFills\(marks && marks\.fills\.length \? \{ fills: marks\.fills, open: marks\.open, symbol, past: pastMarks\.map\(\(item\) => item\.fills\) \} : null\)/);
    // dřívější obchody: jen ZAVŘENÉ záznamy téhož kontraktu za prvním (25. 11. 2026)
    expect(hook).toMatch(/const pastMarks = symbolMarks\.slice\(1\)\.filter\(\(item\) => item\.open === false && item\.fills\.length > 0\)/);
    expect(chart).toMatch(/liveFills=\{trading\.liveFills\}/);
    // čekající přikoupení Limitem, dělení vstupu, výměna nohy za pár a víc částí: Rithmic Test vždy; skutečný účet jen
    // v obchodním režimu (opsaná věta), nikdy jen pro čtení ani jen pro zavírání — Filip schválil 19. 11. pro test na Lucidu
    expect(server).toMatch(/\.\.\.\(IS_TEST_SYSTEM \|\| \(LIVE_TRADING && !CLOSE_ONLY\) \? \{ pendingAdd: true, multiPairSwap: true, entrySplit: true, maxProtectedParts: 20 \} : \{ pendingAdd: false, multiPairSwap: false, entrySplit: false \}\)/);
    // jen pro zavírání: hlídač čekajících přikoupení běží (zruší zapomenuté přikoupení po zavření pozice)
    expect(server).toMatch(/\.\.\.\(CLOSE_ONLY \? \{ pendingAdd: true \} : \{\}\)/);
    // zařízení: Test a skutečný účet mají každý svůj seznam (druhá instance nesmí vzkřísit odvolaný telefon)
    expect(server).toMatch(/IS_TEST_SYSTEM \? 'devices-rithmic-test\.json' : 'devices\.json'/);
    // přikoupení bez SL/TP na skutečném účtu jen se souhlasem, který SL nevyžaduje
    expect(server).toMatch(/LIVE_TRADING && !CLOSE_ONLY && startConsent\?\.requireStop === false \? \{ bareAdd: true \}/);
    expect(server).toMatch(/if \(!READ_ONLY\) exec\.enableAutomation\(\);/);
    expect(server.indexOf('exec.enableAutomation()')).toBeGreaterThan(server.indexOf("if (typed !== phrase) { broker.stop();"));
    // ochrana zůstává denní: služba platnost do zrušení neposílá
    const exec = readFileSync('services/rithmic/localExec.ts', 'utf8');
    expect(exec).not.toMatch(/goodTillCancel: true/);
    // varování před koncem seance je jen karta
    expect(chart).toMatch(/const sessionWarning = link === 'open' \? cmeSessionCloseWarning\(clock, \{ position: hasPosition, pendingEntry: hasPendingEntry \}\) : null;/);
    // cena pro graf = poslední obchod; kontroly příkazů dál berou čerstvou cenu služby
    expect(server).toMatch(/const shownPrice = \(now: number\): number \| null => candles\.lastPrice\(CONTRACT, now, 30_000\) \?\? freshPrice\(now\);/);
    expect(server).toMatch(/serverPrice: \(symbol\) => \(symbol === CONTRACT \? freshPrice\(Date\.now\(\)\) : null\),/);
  });

  it('karty obchodů ze změn stavu', () => {
    const empty = { net: 0, avg: null, entries: new Map(), stop: null, target: null };
    const ctx = { symbol: 'MNQZ6', lastPrice: 100, pointValue: 2, at: 1 };
    const long = { net: 1, avg: 100, entries: new Map(), stop: 95, target: 110 };
    expect(rithmicTradeEvents(empty, long, ctx).map(event => event.kind)).toEqual(['entry', 'bracket-placed']);
    expect(rithmicTradeEvents(long, { ...long, stop: 98 }, ctx).map(event => event.kind)).toEqual(['sl-moved']);
    // Důvod zavření se neodhaduje z ceny.
    const exit = rithmicTradeEvents(long, empty, { ...ctx, lastPrice: 94 })[0] as unknown as Record<string, unknown>;
    expect(exit.kind).toBe('exit');
    expect('exitReason' in exit).toBe(false);
    expect(rithmicTradeEvents(empty, empty, ctx)).toEqual([]);
    // bez výsledku z vyplnění jde karta s odkladem (hook ji zahodí, když výsledek dorazí)
    expect(String(exit.id)).toMatch(/^exit-plain:/);
  });

  it('karta zavření: výsledek a důvod jen z vyplnění brokera, v obou pořadích zpráv právě jednou', () => {
    const empty = { net: 0, avg: null, entries: new Map(), stop: null, target: null, close: null, at: 1_000 };
    const long = { net: 1, avg: 100, entries: new Map(), stop: 95, target: 110, close: null, at: 1_000 };
    const ctx = { symbol: 'MNQZ6', lastPrice: 95, pointValue: 2, at: 1 };
    const close = { id: 'MNQZ6:F1', at: 2_000, symbol: 'MNQZ6', side: 'long' as const, quantity: 1, entryAvg: 100, exitAvg: 95, pointsTotal: -5, reason: 'sl' as const };
    // výsledek i nulová pozice v jedné zprávě
    const both = rithmicTradeEvents(long, { ...empty, close, at: 2_000 }, ctx) as unknown as Array<Record<string, unknown>>;
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ id: 'exit:MNQZ6:F1', kind: 'exit', side: 'Long', quantity: 1, price: 95, pnlUsd: -10, exitReason: 'sl' });
    // výsledek dřív než nulová pozice: karta hned, při nule už žádná další
    const early = { ...long, close, at: 2_000 };
    expect(rithmicTradeEvents(long, early, ctx).map(event => event.id)).toEqual(['exit:MNQZ6:F1']);
    expect(rithmicTradeEvents(early, { ...empty, close, at: 2_300 }, ctx)).toEqual([]);
    // nulová pozice dřív: odložená karta bez výsledku, pak ta s výsledkem
    expect(rithmicTradeEvents(long, empty, ctx)[0].id).toMatch(/^exit-plain:/);
    expect(rithmicTradeEvents(empty, { ...empty, close, at: 2_000 }, ctx).map(event => event.id)).toEqual(['exit:MNQZ6:F1']);
    // starý výsledek (jiný obchod, před minutou) se k novému zavření nepřipíše; důvod bez jistoty chybí
    const later = { ...long, close, at: 60_000 };
    expect(rithmicTradeEvents(later, { ...empty, close, at: 61_000 }, ctx)[0].id).toMatch(/^exit-plain:/);
    const unknown = rithmicTradeEvents(long, { ...empty, close: { ...close, id: 'MNQZ6:F2', reason: undefined }, at: 2_000 }, ctx)[0] as unknown as Record<string, unknown>;
    expect('exitReason' in unknown).toBe(false);
    expect(hook).toMatch(/plainExitTimer\.current = setTimeout\(/);
  });
});

describe('Rithmic graf na telefonu', () => {
  const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
  const wrapper = readFileSync('components/RithmicPhoneChart.tsx', 'utf8');
  const fullscreen = readFileSync('components/day/DayFullscreenChart.tsx', 'utf8');

  it('telefonní graf: svíčky, kotace i kontrakt jdou jen ze slotu', () => {
    expect(phone).toMatch(/const marketSlot = slots\.market \?\? null;/);
    expect(phone).toMatch(/chartDataDisabled: marketSlot != null/);
    for (const field of ['candles', 'quality', 'loading', 'error', 'liveStatus', 'liveCapturedAt', 'liveSource', 'liveFeed'])
      expect(phone).toMatch(new RegExp(`${field}: marketSlot\\.data\\.${field}\\b`));
    expect(phone).toMatch(/<DayFullscreenChart\s+ctl=\{ctl\}/);
    // Jiný zdroj ceny než slot appka nemá (kanál TradingView / IBKR odstraněn 23. 11. 2026).
    for (const gone of ['tvPriceChannel', 'tvPriceStore', 'independentIbkrTick', 'previewSymbolFromChartSource'])
      expect(phone).not.toContain(gone);
    expect(phone).toMatch(/const liveTickAt = marketQuote\?\.at \?\? null;/);
    expect(phone).toMatch(/const contract = marketSlot\?\.contract \?\? null;/);
    expect(phone).toMatch(/const chartContract = marketSlot\?\.contract \?\? null;/);
    // Kotace pro odeslání: bez slotu NENÍ (nic se neodešle); se slotem projde pojistkami tvaru.
    const quoteMemo = phone.slice(phone.indexOf('const quote = useMemo<LivePhoneQuote | null>'), phone.indexOf('const slotMark = useMemo'));
    expect(quoteMemo).toMatch(/if \(!ownMarket \|\| !marketQuote \|\| !marketQuote\.symbol\?\.startsWith\('MNQ'\)/);
    expect(quoteMemo).toMatch(/marketQuote\.bid <= 0 \|\| marketQuote\.ask < marketQuote\.bid \|\| !Number\.isFinite\(marketQuote\.at\)\) return null;/);
    // Pojistka utažení SL / BE a P&L štítku: kotace slotu; bez slotu je značka vždy stará (pojistka blokuje).
    expect(phone).toMatch(/const NO_MARK = \{ source: null, price: null, at: null, stale: true \} as const;/);
    expect(phone).toMatch(/stale: quote == null \|\| slotMarkStale \} : NO_MARK\)/);
    expect(phone.match(/\n      slotMark, at\)|\n    slotMark, LIVE_PHONE_INSTRUMENT\.pointValue/g)).toHaveLength(2);
    expect(phone).toContain("'Kontrakt není ověřený — nic se neodeslalo.'");
    expect(phone).toContain('Živá cena teď není dostupná');
    // Cizí trh (Rithmic Test): starší historie appky se nepřipojuje.
    expect(phone).toMatch(/marketSlot\?\.appHistory === false \? \{ externalHistory: true \} : \{\}/);
    expect(fullscreen).toMatch(/const htf = externalHistory \? EXTERNAL_HTF : htfRead;/);
    expect(readFileSync('components/day/useDayController.ts', 'utf8')).toMatch(/useDayChartData\(day, dayTrades, allTrades, now, chartDataDisabled \? \{ disabled: true \} : undefined\)/);
  });

  it('obal: spojení jen s otevřenou záložkou, účet jen pro čtení bez mostu příkazů, žádný stav kopírky', () => {
    expect(readFileSync('components/RithmicPhoneSession.tsx', 'utf8')).toMatch(/useRithmicLocalTrading\(\{ url, enabled: open, auth: deviceAuth \}\)/);
    // Bez mostu příkazů: účet jen pro čtení i zařízení spárované jen pro čtení.
    expect(wrapper).toMatch(/const viewOnly = trading\.readOnly \|\| deviceScope === 'read';/);
    expect(wrapper).toMatch(/trade: viewOnly \|\| !trade \? null : deviceScope === 'close' \?/);
    expect(wrapper).toContain('copierArmed: false');
    expect(wrapper).not.toMatch(/armed:\s*true/);
    expect(wrapper).not.toContain('commandLockRef');
    expect(wrapper).not.toContain('tvPriceStore');
    expect(wrapper).toMatch(/workingOrders: trading\.workingView,/);
    expect(wrapper).toMatch(/market,\n\s+position: shownPosition,/);
  });

  it('obal: zavření pozice je dosažitelné i při incidentu, mlčící službě a schované hlavičce; incident jde potvrdit', () => {
    // Nabídka brzdy nezávisí na `blocked`, ceně ani `silent` — jen na spojení, režimu čtení a možné expozici.
    expect(wrapper).toMatch(/const offerBrake = \(link === 'open' \|\| grace\) && !viewOnly && \(exposureShown \|\| trading\.uncertain\.length > 0\) && \(!accountBar \|\| brakeNeeded \|\| grace\);/);
    // S výběrem účtu v hlavičce se v klidu schová; vrací se při nejistotě, neznámém stavu, mlčící službě, stopu vstupů (21. 11.).
    expect(wrapper).toMatch(/const brakeNeeded = trading\.uncertain\.length > 0 \|\| \(exposureShown && !hasPosition\) \|\| unprotected \|\| trading\.commandInFlight \|\| !trading\.available\s+\|\| Boolean\(blocked\) \|\| trading\.silent \|\| !trading\.helloFresh;/);
    expect(wrapper).toMatch(/const unprotected = hasPosition && \(shownPosition\?\.summary\?\.kind !== 'position' \|\| shownPosition\.summary\.stop == null\s+\|\| \(trading\.legCoverage != null && trading\.legCoverageTotal\.stopLoss < shownPosition\.summary\.quantity\)\);/);
    // Krátký výpadek (návrat do appky): poslední známý obraz se drží jen pár sekund, pak obrazovka hlásí pravdu.
    expect(wrapper).toMatch(/const RECONNECT_GRACE_MS = 4_000;/);
    expect(wrapper).toMatch(/window\.setTimeout\(\(\) => \{ hadState\.current = false; setGrace\(false\); \}, RECONNECT_GRACE_MS\);/);
    expect(wrapper).toMatch(/closeNow: runClose,/);
    expect(wrapper).toMatch(/const result = await closeNow\(\);/);
    // Karty a brzda: v hlavičce, a když je hlavička schovaná, nad grafem; i v prázdném stavu.
    // Pod hlavičkou PLAVOU (nulová výška v toku), aby graf při výpadku spojení neposkočil.
    expect(wrapper).toMatch(/\{header\(accountBar \? \{ account, compact: true \} : \{ group, account \}\)\}\n\s+<div style=\{\{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 44, pointerEvents: 'none' \}\}>/);
    expect(wrapper).toMatch(/overlay: <>\{overlay\}\{!headerShown && status\(true\)\}<\/>/);
    expect(wrapper.slice(wrapper.indexOf('data-rithmic-phone-empty'))).toContain('{status(false)}');
    expect(wrapper).toMatch(/if \(card\.action\?\.kind === 'ack'\) void confirmIncident\(\);/);
    expect(wrapper).toMatch(/else if \(card\.action\?\.kind === 'verified'\) dismissUncertain\(\);/);
    // Dvojí klepnutí: první jen připraví, druhý nejdřív po 350 ms.
    expect(wrapper).toMatch(/if \(now - closeArmedAt < CLOSE_SECOND_TAP_MIN_MS\) return;/);
  });

  it('obal: v hlavičce je účet, systém a štítek režimu', () => {
    expect(wrapper).toMatch(/\[trading\.system \?\? 'Rithmic', trading\.accountName \?\? 'účet neznámý'\]/);
    expect(wrapper).toMatch(/rithmicPhoneModeLabel\(\{ system: trading\.system, readOnly: viewOnly, closeOnly: closeOnlyHere, liveAccount: trading\.liveAccount,/);
  });
});

describe('LIVE desk jen pro Rithmic (23. 11. 2026)', () => {
  it('desk nemá žádný stav, čtení ani příkazy Tradovate kopírky', () => {
    const code = desk.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of ['Tradovate', 'tradovate', 'agentStatus', 'liveCommandLockRef', 'workerGroup', 'useLiveChartData', 'copierRuntime', 'localCopierAgent'])
      expect(code).not.toContain(forbidden);
    expect(desk).toContain('copier={NO_LIVE_COPIER}');
    expect(desk).toContain('disarm={null}');
  });
  it('záložky: Graf jen se službou (PC) nebo se službou či spárováním (telefon), Kopírka jen se službou', () => {
    expect(desk).toMatch(/const phoneChartAvailable = phoneLayout && \(configured \|\| pairingHere\) && Boolean\(phoneChart\);/);
    expect(desk).toMatch(/const pcChartAvailable = !phoneLayout && configured;/);
    expect(desk).toMatch(/\.\.\.\(configured \? \[\{ id: 'copier' as const, label: 'Kopírka', icon: Network \}\] : \[\]\)/);
    const tab = readFileSync(new URL('../components/copier/RithmicCopierTab.tsx', import.meta.url), 'utf8');
    // Žádné zastavení, šablony, zavření ani doplnění bez napojení; zapnutí jen řekne, že se připravuje.
    expect(tab).toMatch(/const ACTIONS: CopierActions = \{ onArm: \(\) => \(\{ ok: false, gate: NOT_READY \}\), onDisarm: \(\) => undefined \};/);
    expect(tab).not.toMatch(/onKill|onFlatten|onClosePosition|onFixProtection|onTemplate/);
  });
  it('odchod z grafu na „přehled“ (× Zavřít graf, Live Dashboard →) vede na Kopírku, ne do prázdna', () => {
    expect(desk).toContain("const next = requested === 'overview' ? (configured ? 'copier' : null) : requested;");
    expect(desk).toMatch(/\}, \[configured\]\);/);
  });
  it('pád grafu se zapamatuje a ukáže chybu místo prázdné plochy', () => {
    expect(desk).toContain('rememberLiveChartCrash(); noteChartCrash();');
    expect(desk.match(/<LiveSlotFailure label="Rithmic graf" \/>/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
