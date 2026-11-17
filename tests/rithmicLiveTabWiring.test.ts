// Zapojení Rithmic grafu do záložky LIVE: hlídá, že nová větev nesahá na kopírku Tradovate,
// existuje jen ve vývojové appce a že obrazovka v režimu jednoho účtu nemíří na skupinu kopírky.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_HOTKEY_BUSY_TEXT_SOLO, LIVE_HOTKEY_SOLO_FLATTEN_TEXT, liveHotkeyHelp, resolveLiveHotkey } from '../lib/liveHotkeys';
import { rithmicLocalAllowedHere, takeRithmicTokenFromHash } from '../lib/rithmicLocalLink';
import { rithmicScreenInstrumentIssue } from '../components/RithmicLiveChart';
import { rithmicFlattenReply, rithmicLegView, rithmicTradeEvents } from '../hooks/useRithmicLocalTrading';
import { LIVE_MANAGE_BUSY_TEXT } from '../hooks/useLiveManageRunner';
import { liveSoloNoticeText } from '../lib/liveSoloTexts';
import { READ_ONLY_ALLOWED_TEMPLATES, RITHMIC_WRITE_TEMPLATES, readOnlyViolation } from '../services/rithmic/readOnlyGuard';
import { RITHMIC_TEMPLATES } from '../services/rithmic/proto/rithmicTemplates';
import { encodeRithmicFrame } from '../services/rithmic/rithmicCodec';
import { liveTicketLegsProblem } from '../lib/liveBareEntry';
import { liveLineMoveBlockReason } from '../lib/liveChartOrderLines';
import { LIVE_COMMAND_BUSY_TEXT } from '../hooks/liveCommandRuns';

const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
const chart = readFileSync('components/RithmicLiveChart.tsx', 'utf8');
const hook = readFileSync('hooks/useRithmicLocalTrading.ts', 'utf8');
const server = readFileSync('scripts/rithmic/devTradeServer.ts', 'utf8');
const link = readFileSync('lib/rithmicLocalLink.ts', 'utf8');

describe('Rithmic graf v desku LIVE', () => {
  const branch = desk.slice(desk.indexOf('<ErrorBoundary name="RithmicLiveChart"'), desk.indexOf(') : phoneChartAvailable && tab === \'chart\' && phoneChart ? ('));

  it('dostupnost: jen když Tradovate graf neexistuje, a záložka Graf je v desku právě dvakrát', () => {
    expect(desk).toMatch(/const rithmicChartAvailable = !chartAvailable && !phoneChartAvailable && !narrow && rithmicConfigured;/);
    expect(desk).toMatch(/const \[rithmicConfigured\] = useState\(rithmicLocalAvailable\);/);
    expect(desk.match(/id: 'chart' as const, label: 'Graf'/g)).toHaveLength(2);
  });

  it('čtení kopírky na Rithmic grafu nevisí (rychlý poll, push expozice, data grafu)', () => {
    expect(desk).toMatch(/chartOpenRef\.current = \(chartAvailable \|\| phoneChartAvailable\) && tab === 'chart';/);
    expect(desk).toMatch(/enabled: \(chartAvailable \|\| phoneChartAvailable\) && tab === 'chart',/);
    expect(desk.match(/rithmicChartAvailable/g)).toHaveLength(6);
  });

  it('větev nedostane zámek ani příkazy kopírky; má skutečný stav kopírky, OFF a hlášení pádu', () => {
    expect(branch.length).toBeGreaterThan(200);
    for (const forbidden of ['liveCommandLockRef', 'setChartReplayActive', 'placeLeaderEntry', 'manageLeaderEntry', 'previewLeaderEntry', 'closeBareLeader', 'workingOrders', 'liveFills'])
      expect(branch).not.toContain(forbidden);
    expect(branch).toContain('onCrash={noteChartCrash}');
    expect(branch).toContain("onError={() => setChartCrash('outer')}");
    expect(branch).toContain('status: agentStatus?.controller ?? null');
    expect(branch).toContain('onDisarm={disarmFromChart}');
  });

  it('komponenta nevyrábí stav kopírky a nepředává sdílený zámek', () => {
    expect(chart).not.toMatch(/armed:\s*true/);
    expect(chart).not.toContain('manageLockRef');
    expect(chart).not.toContain('as never');
  });
});

describe('brána dostupnosti', () => {
  it('jen vývojová appka na místní adrese, ne nativní', () => {
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'localhost', native: false })).toBe(true);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: '127.0.0.1', native: false })).toBe(true);
    expect(rithmicLocalAllowedHere({ dev: false, hostname: 'localhost', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'alphatrade-mentor-15.vercel.app', native: false })).toBe(false);
    expect(rithmicLocalAllowedHere({ dev: true, hostname: 'localhost', native: true })).toBe(false);
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

  it('místní proces: žádná produkční adresa mezi originy, jen Rithmic Test', () => {
    const origins = server.slice(server.indexOf('const ALLOWED_ORIGINS'), server.indexOf(']);', server.indexOf('const ALLOWED_ORIGINS')));
    expect(origins).not.toMatch(/vercel|https:\/\//);
    expect(server).toMatch(/allowedSystems: \['Rithmic Test'\]/);
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

  it('skutečný stav kopírky se v hlavičce neschovává (incident, čip)', () => {
    expect(screen).toMatch(/\{strip\.notice && <button/);
    expect(screen).not.toMatch(/copierChip && !solo/);
    expect(screen).toContain("'Kopírka Tradovate'");
  });

  it('alerty jsou v režimu jednoho účtu vypnuté a výchozí zdroj dat se nečte', () => {
    expect(screen).toMatch(/muted: solo != null/);
    expect(screen).toMatch(/\{!solo && <LivePcAlertsButton/);
    expect(screen).toMatch(/\{!solo && <LivePcAlertDialogs/);
    expect(screen).toMatch(/disabled: marketData != null/);
    // Starší historie appky (skutečný MNQ) se k cizímu zdroji svíček nepřipojuje; kanál TV se neodebírá.
    expect(screen).toMatch(/externalMarketData: marketData != null && solo\?\.historyFromApp !== true,/);
    expect(readFileSync('components/AlphaTradeChartWorkspace.tsx', 'utf8')).toMatch(/const htf = externalMarketData \? EXTERNAL_HTF : htfRead;/);
    expect(readFileSync('hooks/useDayChartData.ts', 'utf8')).toMatch(/useTvLiveCandleFeed\(candleWindow\.needsLive && !disabled && now < candleWindow\.dayEnd,/);
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
    expect(hook).toMatch(/sent: 'unknown', error: 'spojení s místním procesem spadlo/);
    expect(hook.match(/socket\.send\(/g)).toHaveLength(1);
    // Konec relace maže cenu i stav; vstup chce cenu z aktuálního spojení a mlčící proces pustí jen zavření.
    expect(hook).toMatch(/const entryReady = available && feedLive && !silent && price !== null;/);
    expect(hook).toMatch(/if \(silentRef\.current && action !== 'close-position'\) return blocked\(/);
    expect(hook.match(/resetSession\(\);/g)).toHaveLength(2);
    // Neznámý stav není „bez pozice".
    expect(hook).toMatch(/if \(!state\) return \{ key: 'rithmic-unknown'/);
  });

  it('brzda jde mimo zámek obrazovky, nezávisí na ceně a nic neopakuje; nejisté příkazy se nepřepisují', () => {
    const close = hook.slice(hook.indexOf('const closeNow = useCallback'), hook.indexOf('}, [send]);', hook.indexOf('const closeNow = useCallback')));
    expect(close).toContain("const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });");
    expect(close).not.toMatch(/availableRef|entryReadyRef|silentRef|busyRef|runWithCommandLock/);
    expect(close.match(/send\(/g)).toHaveLength(1);
    expect(close).toMatch(/if \(closingNow\.current\) return \{ status: 'blocked'/);
    expect(hook).toMatch(/addUncertain = \(next: RithmicUncertainCommand\) => publishUncertain\(\[\.\.\.uncertainCommands\.filter\(item => item\.id !== next\.id\), next\]\.slice\(-5\)\)/);
    expect(screen).toMatch(/\{solo\?\.emergencyClose && <button/);
    expect(chart).toMatch(/link === 'open' && offerBrake && !trading\.readOnly \? \{ emergencyClose: \{ run: emergencyClose, busy: closeBusy \} \}/);
    // Nabízí se i při neznámém stavu a visícím vstupu; nejistý výsledek od služby se zapíše mezi nejisté.
    expect(hook).toMatch(/mayHaveExposure: state === null \|\| net != null \|\| orders\.some\(order => order\.status === 'working'\),/);
    expect(close).toMatch(/if \(raw\.ok\) addUncertain\(\{ id: `close-now:/);
  });

  it('odmítnuté ani nejisté zavření se netváří jako hotové', () => {
    expect(rithmicFlattenReply({ ok: true, result: { status: 'submitted' } }).ok).toBe(true);
    expect(rithmicFlattenReply({ ok: true, result: { status: 'already-flat' } }).ok).toBe(true);
    expect(rithmicFlattenReply({ ok: true, result: { status: 'rejected', reason: 'kód 6' } })).toEqual({ ok: false, sent: false, error: 'kód 6' });
    expect(rithmicFlattenReply({ ok: true, result: { status: 'indeterminate', reason: 'nepřišla' } })).toEqual({ ok: false, sent: 'unknown', error: 'nepřišla' });
    expect(rithmicFlattenReply({ ok: true, result: {} })).toMatchObject({ ok: false, sent: 'unknown' });
    expect(hook.match(/const reply = rithmicFlattenReply\(raw\);/g)).toHaveLength(2);
    // Nejistou odpověď služby zapisuje příjem odpovědi pro každý příkaz kromě potvrzení incidentu.
    expect(hook).toMatch(/if \(pending && pending\.op !== 'ack' && !reply\.ok && reply\.sent !== false\) addUncertain\(/);
    expect(hook.match(/op: 'flatten'/g)).toHaveLength(2);
  });

  it('vstup bez SL/TP a s jednou nohou jen v režimu jednoho účtu', () => {
    expect(liveTicketLegsProblem({ type: 'limit', stopLoss: 100, takeProfit: null }, false, false, false)).toMatch(/Vyplň SL i TP/);
    expect(liveTicketLegsProblem({ type: 'limit', stopLoss: 100, takeProfit: null }, false, false, false, true)).toBeNull();
    expect(liveTicketLegsProblem({ type: 'market', stopLoss: null, takeProfit: 100 }, false, false, false, true)).toBeNull();
    expect(chart).toMatch(/entryBareSupported entryBarePendingSupported/);
    // V pozici další vstup ne (přikoupení služba neumí) a okamžité odeslání z menu grafu se v solo nenabízí.
    // V pozici jen přikoupení: Market na stranu pozice a jen když ho režim přikoupení nabízí (službu to váže znovu).
    expect(hook).toMatch(/if \(!add\?\.canAdd \|\| !sameSide \|\| draft\.orderType !== 'Market'\) return \{ \.\.\.base, status: 'blocked'/);
    expect(screen).toMatch(/const instantBareReady = !solo && entryBarePendingSupported/);
    expect(liveSoloNoticeText(LIVE_COMMAND_BUSY_TEXT)).not.toMatch(/Flatten/);
    expect(chart).toMatch(/available: usable, singleLeg: true/);
    expect(screen).toMatch(/entrySingleLegSupported=\{solo\?\.singleLeg === true\}/);
  });

  it('posun čekajícího Limitu: nohy jsou u Rithmicu vzdálenosti od vstupu, proti nové ceně se nekontrolují', () => {
    const pending = { kind: 'pending', side: 'long', quantity: 1, entry: 100, entryType: 'Limit', stop: 97, target: 106 } as never;
    expect(liveLineMoveBlockReason(pending, 'entry', 90, { moveLimit: true })).toMatch(/SL/);
    expect(liveLineMoveBlockReason(pending, 'entry', 90, { moveLimit: true, relativeLegs: true })).toBeNull();
    expect(screen).toMatch(/relativeLegs: solo != null \}\);/);
    expect(hook).toMatch(/if \(action === 'move-limit'\) \{/);
  });

  it('SL/TP k otevřené pozici: jen jeden z nich, odebrat jde jen samostatnou ochranu', () => {
    const leg = hook.slice(hook.indexOf('const onBareLeg = useCallback'), hook.indexOf('const ack = useCallback'));
    expect(leg).toMatch(/if \(list\.length > 0\) return blocked\(/);
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
    expect(hook.match(/send\(\{ op: 'move-legs', symbol: sym, role, price: [a-zA-Z.]+, expect: legs\.map\(\(order\) => \(\{ orderId: order\.orderId, price: order\.price! \}\)\) \}\)/g)).toHaveLength(2);
    expect(chart).toMatch(/entryScaleIn=\{trading\.scaleIn\}/);
  });

  it('režim jen pro čtení: jiný systém než Rithmic Test jen s --read-only, zápisy blokované na spojení, ve službě i na obrazovce', () => {
    expect(server).toMatch(/if \(SYSTEM !== 'Rithmic Test' && !READ_ONLY\) throw new Error\(/);
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
    expect(server).toMatch(/allowedSystems: \['Rithmic Test'\]/);
    expect(hook).toMatch(/const available = link === 'open' && helloFresh && Boolean\(state\?\.connected\) && !readOnly;/);
    expect(chart).toMatch(/offerBrake && !trading\.readOnly \? \{ emergencyClose:/);
    expect(chart).toMatch(/trading\.bareLegTrade && !trading\.readOnly \?/);
    // starší historie appky jen na skutečném trhu
    expect(screen).toMatch(/externalMarketData: marketData != null && solo\?\.historyFromApp !== true,/);
    expect(chart).toMatch(/historyFromApp: trading\.system !== null && trading\.system !== 'Rithmic Test'/);
  });

  it('jiný kontrakt než MNQ obrazovka odmítne', () => {
    expect(rithmicScreenInstrumentIssue({ symbol: 'MNQZ6', tickSize: 0.25, pointValue: 2 })).toBeNull();
    expect(rithmicScreenInstrumentIssue({ symbol: 'ESZ6', tickSize: 0.25, pointValue: 50 })).toMatch(/jen MNQ/);
    expect(rithmicScreenInstrumentIssue({ symbol: 'MNQZ6', tickSize: 0.25, pointValue: null })).toMatch(/jiný krok/);
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
  });
});
