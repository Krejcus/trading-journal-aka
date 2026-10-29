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

  it('tlačítko odeslání je napevno vypnuté', () => {
    const ticket = source('components/LiveOrderTicket.tsx');
    const submit = ticket.slice(ticket.indexOf('<button', ticket.indexOf('problems.length > 0')));
    expect(submit.slice(0, 200)).toMatch(/<button\s+type="button"\s+disabled\s/);
    expect(ticket).not.toMatch(/onSubmit|executeAgent|placeOrder/);
  });

  it('ukázkové účty jsou jen v dev buildu', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/const SAMPLE_GROUP_ENABLED = import\.meta\.env\.DEV;/);
    expect(screen).toMatch(/SAMPLE_GROUP_ENABLED \? \{ \.\.\.SAMPLE_LIVE_TRADE_GROUP, armed \} : null/);
    for (const file of ['components/LiveOrderTicket.tsx', 'components/LiveGroupChip.tsx', 'components/TradovateLiveDesk.tsx']) {
      expect(source(file), file).not.toMatch(/SAMPLE_LIVE_TRADE_GROUP/);
    }
  });

  it('výpočty panelu nikdo z cest příkazů nepoužívá', () => {
    for (const file of ['services/copierRunner.ts', 'services/copierRiskGate.ts', 'services/copierRuntimeController.ts']) {
      expect(source(file), file).not.toMatch(/liveOrderTicket|liveTradeTarget/);
    }
  });
});
