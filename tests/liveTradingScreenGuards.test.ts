import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialLiveTab, liveTabNavigationAllowed } from '../lib/tradovateLiveTab';
import { buildLiveStatusStrip, liveAttentionReasons } from '../services/liveStatusStrip';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

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

  it('vrstva grafu nikdy nezamkne přehled a desk mu předává skutečný stav kopírky', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/const blocked = navigationBlocked && !active && item\.id !== 'overview';/);
    expect(screen).toMatch(/buildLiveStatusStrip\(\{ status: copier\.status, available: copier\.available, pending: copier\.pending, transport: copier\.transport, journalHealth: copier\.journalHealth \}\)/);
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/status: agentStatus\?\.controller \?\? null,\s*available: runtimeAvailable,\s*pending: !agentStatusResolved,/);
    // Expozice přímo z workeru (F2a) jen do grafu, karet a skrytí BE — nikdy do stavu kopírky ani příkazů.
    const liveUses = desk.match(/chartLive\.[A-Za-z.?]+/g) ?? [];
    expect(liveUses.sort()).toEqual([
      'chartLive.exposureObservedAt',
      'chartLive.status',
      'chartLive.status',
      'chartLive.status',
      'chartLive.status?.controller.recentCopyEvents',
    ].sort());
    expect(desk).toMatch(/agentStatus: chartLive\.status,/);
    expect(desk).toMatch(/copyEvents=\{chartLive\.status\?\.controller\.recentCopyEvents\}/);
    expect(desk).toMatch(/manageEntryAvgPrice=\{chartLive\.status === agentStatus \? /);
    expect(desk).toMatch(/armFlowActiveRef\.current = true;\s*setArmFlowActive\(true\);\s*try \{\s*return await armLiveGroupFlow\(targetGroup\);\s*\} finally \{\s*armFlowActiveRef\.current = false;/);
    // Deep link jde stejnou bránou; graf během zapínání se zahodí.
    expect(desk).toMatch(/if \(requestedTab === 'chart' && armFlowActiveRef\.current\) \{ onRequestedTabHandled\?\.\(\); return; \}\s*if \(!liveTabNavigationAllowed\(tab, requestedTab,/);
  });

  it('načítání i pád grafu mají cestu na přehled a pád se nezopakuje po reloadu', () => {
    const slot = source('components/LiveTradingScreenSlot.tsx');
    expect(slot).toMatch(/<ErrorBoundary name="LiveTradingScreen" onError=\{rememberLiveChartCrash\} fallback=\{<FallbackLayer [^>]*failed leaving=\{closing\} onNavigate=\{props\.onNavigate\} \/>\}>/);
    expect(slot).toMatch(/<Suspense fallback=\{<FallbackLayer [^>]*failed=\{false\} leaving=\{closing\} onNavigate=\{props\.onNavigate\} \/>\}>/);
    expect(slot).toMatch(/onClick=\{\(\) => onNavigate\('overview'\)\}/);
    // Odchodová animace nesmí držet kliky: přehled je pod vrstvou dostupný hned.
    expect(source('index.css')).toMatch(/\.live-chart-leave \{ animation: live-chart-fold [^}]*pointer-events: none; \}/);
    expect(source('components/LiveTradingScreen.tsx')).toMatch(/\$\{leaving \? 'live-chart-leave' : 'live-chart-enter'\}/);
    expect(source('components/TradovateLiveDesk.tsx')).toMatch(/chartAvailable: liveChartAvailableNow\(\) && !liveChartCrashedThisSession\(\)/);
    expect(source('components/ErrorBoundary.tsx')).toMatch(/this\.props\.onError\?\.\(error\);/);
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
    expect(submit.slice(0, 200)).toMatch(/disabled=\{directBlocked != null \|\| directBusy\}/);
    expect(ticket).not.toMatch(/onSubmit|executeAgent|placeOrder/);
  });

  it('ukázkové účty jen v dev buildu s přepínačem, nikdy jako náhrada za skutečnou skupinu', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/if \(!import\.meta\.env\.DEV\) return false;/);
    expect(screen).toMatch(/getItem\('at:dev:live-chart-sample'\) === '1'/);
    // Skutečná skupina má přednost; ukázka nemá ověřený stav kopírky.
    expect(screen).toMatch(/workerGroup \?\? \(sample \? \{ \.\.\.SAMPLE_LIVE_TRADE_GROUP, armed: null \} : null\)/);
    for (const file of ['components/LiveOrderTicket.tsx', 'components/LiveGroupChip.tsx', 'components/TradovateLiveDesk.tsx']) {
      expect(source(file), file).not.toMatch(/SAMPLE_LIVE_TRADE_GROUP/);
    }
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
    // Objednávky z pravého menu jen vyplní panel — v textu je to vidět.
    expect(workspace).toMatch(/chartOrderLabelSuffix=\{context\.liveOrderEntry \? ' · návrh' : undefined\}/);
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
    for (const file of ['services/copierRunner.ts', 'services/copierRiskGate.ts', 'services/copierRuntimeController.ts']) {
      expect(source(file), file).not.toMatch(/liveOrderTicket|liveTradeTarget/);
    }
  });
});
