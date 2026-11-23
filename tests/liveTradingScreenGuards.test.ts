import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialLiveTab, liveTabNavigationAllowed } from '../lib/liveTab';
import { buildLiveStatusStrip, liveAttentionReasons } from '../services/liveStatusStrip';
import type { CopierControllerStatus } from '../lib/liveCopierTypes';

const root = join(__dirname, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const LIVE_CHART_FILES = [
  'components/LiveTradingScreen.tsx',
  'components/LiveTradingScreenSlot.tsx',
  'components/LiveOrderTicket.tsx',
  'components/LiveGroupChip.tsx',
  'lib/liveOrderTicket.ts',
  'lib/liveTradeTarget.ts',
  'lib/liveChartPosition.ts',
  'lib/liveChartFollow.ts',
];

describe('LIVE → Graf: výchozí záložka', () => {
  it('na desktopu otevře graf, deep link má přednost, telefon graf nemá', () => {
    expect(initialLiveTab({ requestedTab: null, search: '', chartAvailable: true })).toBe('chart');
    expect(initialLiveTab({ requestedTab: null, search: '?page=live&tab=risk', chartAvailable: true })).toBe('chart');
    expect(initialLiveTab({ requestedTab: 'overview', search: '', chartAvailable: true })).toBe('overview');
    expect(initialLiveTab({ requestedTab: null, search: '', chartAvailable: false })).toBe('overview');
    expect(initialLiveTab({ requestedTab: 'chart', search: '', chartAvailable: false })).toBe('overview');
    expect(initialLiveTab({ requestedTab: null, search: '?page=live&tab=chart', chartAvailable: false })).toBe('overview');
  });
});

describe('LIVE → Graf: DISARM je vždy dosažitelný (INV-UI-02)', () => {
  const pending = { configMutationPending: true, armFlowActive: false };
  const arming = { configMutationPending: false, armFlowActive: true };
  const idle = { configMutationPending: false, armFlowActive: false };

  it('z grafu na přehled se jde i při čekající změně konfigurace', () => {
    expect(liveTabNavigationAllowed('chart', 'overview', pending)).toBe(true);
    expect(liveTabNavigationAllowed('chart', 'overview', { configMutationPending: true, armFlowActive: true })).toBe(true);
  });

  it('do grafu se nevstupuje během zapínání kopírky ani čekající změny', () => {
    expect(liveTabNavigationAllowed('overview', 'chart', arming)).toBe(false);
    expect(liveTabNavigationAllowed('overview', 'chart', pending)).toBe(false);
    expect(liveTabNavigationAllowed('overview', 'chart', idle)).toBe(true);
  });

  it('ostatní přepínání drží stávající zámek konfigurace', () => {
    expect(liveTabNavigationAllowed('overview', 'risk', pending)).toBe(false);
    expect(liveTabNavigationAllowed('chart', 'risk', pending)).toBe(false);
    expect(liveTabNavigationAllowed('overview', 'risk', arming)).toBe(true);
  });

  it('hlavička upozorní na problémy, které chip Kopírka neodliší', () => {
    const status = {
      armed: true, killSwitch: false, connected: true, shadowMode: false,
      divergentAccounts: [7], stuckOutbox: false, stuckOperations: [], manualRecovery: null,
    } as unknown as CopierControllerStatus;
    const model = buildLiveStatusStrip({ status, available: true, pending: false, transport: 'local' });
    expect(model.chips.find(chip => chip.id === 'copier')?.value).toBe('Zapnutá');
    expect(liveAttentionReasons(model, status, true)).toEqual(['rozjeté účty']);
    // Neověřený stav nic netvrdí (INV-UI-01) — chip Worker hlásí „Neověřeno“ sám.
    expect(liveAttentionReasons(buildLiveStatusStrip({ status, available: false, pending: false, transport: null }), status, false)).toEqual([]);
  });
});

describe('LIVE → Graf je jen UI', () => {
  it('nové moduly neimportují kopírku, relay, brokera ani úložiště', () => {
    for (const file of LIVE_CHART_FILES) {
      const imports = [...source(file).matchAll(/from '([^']+)'/g)].map(match => match[1]);
      for (const path of imports) {
        expect(path, `${file} → ${path}`).not.toMatch(/copier(?!.*Strip)|relay|tradovate(?!LiveTab)|localCopierAgent|storageService|supabase/i);
      }
    }
  });

  it('velké tlačítko odesílá jen přes onPlaceEntry (relay → worker ověří brány), nikdy přímo k brokerovi', () => {
    const ticket = source('components/LiveOrderTicket.tsx');
    const submit = ticket.slice(ticket.indexOf('<button', ticket.indexOf('problems.length > 0')));
    // Zamčené, dokud náhled nejde (Market, SL/TP, chyby panelu, zastaralá cena, worker bez odeslání).
    expect(submit.slice(0, 200)).toMatch(/disabled=\{directBlocked != null \|\| directBusy \|\| directLocked\}/);
    expect(ticket).not.toMatch(/onSubmit|executeAgent|placeOrder/);
  });

  it('vrstva grafu není dialog — uvnitř dialogu graf ignoruje pravé tlačítko, zkratky i dvojklik', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/role="region" aria-label="LIVE graf"/);
    expect(screen).not.toMatch(/role="dialog" aria-label="LIVE graf"/);
    // Pojistka grafu, kvůli které na roli záleží.
    expect(source('components/CandleKitTradeChart.tsx')).toMatch(/target\.closest\('button, input, select, textarea, \[role="dialog"\], \[role="menu"\]'\)\) return;/);
  });

  it('posun za svíčkami jen v LIVE grafu, ne v deníku dneška ani v backtestu', () => {
    const workspace = source('components/AlphaTradeChartWorkspace.tsx');
    expect(workspace).toMatch(/followEdge: !backtestSession && Boolean\(liveOrderEntry\),/);
    expect(workspace).toMatch(/positionQuickOrderLabel=\{context\.liveOrderEntry \? 'Propsat box do objednávky' : undefined\}/);
    // Nová svíčka vpravo LIVE graf nepřestaví (jinak se každou minutu vrátil na kotvu).
    expect(workspace).toMatch(/liveSeries=\{Boolean\(context\.liveOrderEntry\)\}/);
    // Objednávky z pravého menu jen vyplní panel (LIVE i backtest) — v textu je to vidět.
    expect(workspace).toMatch(/chartOrderLabelSuffix=\{context\.liveOrderEntry\?\.chartOrderInstant \? ' · hned BEZ SL\/TP' : context\.liveOrderEntry \|\| context\.backtestSession \? ' · návrh' : undefined\}/);
    const chart = source('components/CandleKitTradeChart.tsx');
    expect(chart).toMatch(/renderableCandleWindow\(liveSeries \? \{ start: candleWindow\.start, end: candles\.length \} : candleWindow, initialWindow, candles\.length\)/);
    // LIVE drží stejný controller i při změně timeframe; instrument zůstává
    // hranicí série. Deník/history si dál nechává timeframe v klíči.
    expect(chart).toMatch(/\? `overlay-v3:\$\{trade\.id\}:\$\{resolvedInstrumentRoot\}:live`/);
    expect(chart).not.toMatch(/overlay-v3:\$\{trade\.id\}:\$\{timeframe\}:live/);
    expect(chart).toMatch(/: `overlay-v2:\$\{trade\.id\}:\$\{timeframe\}:history`/);
  });

  it('stabilní LIVE graf při posunu překreslí VWAP podle aktuálního stavu přepínače', () => {
    const chart = source('components/CandleKitTradeChart.tsx');
    // Listener přežívá přepnutí indikátoru, proto nesmí držet hodnotu
    // visibleLevels zachycenou při prvním onReady.
    expect(chart).toMatch(/visibleLevelsRef\.current = visibleLevels;/);
    expect(chart).toMatch(/if \(visibleLevelsRef\.current\) \{[\s\S]*?levelsPrimitiveRequestUpdateRef\.current\?\.\(\);/);
    expect(chart).toMatch(/if \(visibleLevelsRef\.current && !replayActive\)/);
    expect(chart).not.toMatch(/if \(visibleLevels && !replayActive\)/);
  });

  it('křížek i hlavní vypínač odstraní levely bez přestavby grafu', () => {
    const chart = source('components/CandleKitTradeChart.tsx');
    // Skrytá stabilní vrstva nesmí znovu nakreslit geometrii, která zůstala
    // v posledním canvas snímku. Price-axis štítky platí totéž.
    expect(chart).toMatch(/if \(!visibleLevelsRef\.current\) return;/);
    expect(chart).toMatch(/if \(!visibleLevelsRef\.current\) return \[\];/);
    // Opožděný detach staré vrstvy nesmí vymazat callback nově připojené.
    expect(chart).toMatch(/createPrimitiveUpdateBinding\(levelsPrimitiveRequestUpdateRef\)/);
    // Druhý paint v dalším snímku kryje výměnu callbacku v témže React commitu.
    expect(chart).toMatch(/indicatorVisibilityPaintFrameRef\.current = window\.requestAnimationFrame/);
  });

  it('přesný DOM crosshair zachová touch long-press, téma a obnovu po zoomu', () => {
    const chart = source('components/CandleKitTradeChart.tsx');
    expect(chart).toMatch(/if \(event\.pointerType === 'touch'\) \{[\s\S]*?hideExactCrosshair\(\);/);
    expect(chart).toMatch(/refreshExactCrosshairRef\.current\?\.\(\);/);
    expect(chart).toMatch(/backgroundColor: isDark \? '#131722' : '#ffffff'/);
    expect(chart).toMatch(/const visibleCandleLookup = useMemo\(\(\) => \{/);
  });

  it('výpočty panelu nikdo z cest příkazů nepoužívá', () => {
    // Runner a controller Tradovate kopírky jsou smazané (23. 11. 2026); hlídá se zbylá brána rizika a Rithmic služba.
    const rithmic = readdirSync(join(root, 'services/rithmic')).filter(name => name.endsWith('.ts')).map(name => `services/rithmic/${name}`);
    expect(rithmic.length).toBeGreaterThan(10);
    for (const file of ['services/copierRiskGate.ts', 'scripts/rithmic/devTradeServer.ts', ...rithmic]) {
      expect(source(file), file).not.toMatch(/liveOrderTicket|liveTradeTarget/);
    }
  });
});
