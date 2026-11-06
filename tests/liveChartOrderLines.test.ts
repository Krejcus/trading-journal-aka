import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_ATTACH_SEND_ACTION, LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../lib/liveChartOrderLines';
import { liveDisplayOpenPnl, type LiveChartPositionSummary } from '../lib/liveChartPosition';

const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'short', quantity: 4, entry: 28975.5, entryType: null, openPnl: 12, mark: 28960,
  stop: 28984.25, target: 28958, protection: 'SL 4/4 · TP 4/4', accounts: 4, scopeLabel: null,
  leader: { accountId: 1, quantity: 1, entry: 28975.5 }, rows: [], ...patch,
});
const controls = { manageable: true, entryAvg: 28975.5, pointValue: 2 };

describe('živé P&L na lince vstupu (jen zobrazení)', () => {
  const NOW = 1_000_000;
  const row = (patch = {}) => ({ quantity: 2, entry: 100, fees: 3, ...patch });
  const open = (rows: unknown[], side: 'long' | 'short' = 'long') => summary({ side, rows: rows as never });
  const quote = (patch = {}) => ({ source: 'IBKR:MNQZ2026', price: 110, at: NOW - 100, stale: false, ...patch });
  it('počítá z ceny IBKR téhož kontraktu po poplatcích, long i short, více účtů', () => {
    expect(liveDisplayOpenPnl(open([row()]), 'MNQZ6', quote(), 2, NOW)).toBe(37);
    expect(liveDisplayOpenPnl(open([row()], 'short'), 'MNQZ6', quote(), 2, NOW)).toBe(-43);
    expect(liveDisplayOpenPnl(open([row(), row({ quantity: 1, entry: 105, fees: 1 })]), 'MNQZ6', quote(), 2, NOW)).toBe(46);
  });
  it('bez důvěryhodné ceny null = číslo brokera', () => {
    const position = open([row()]);
    expect(liveDisplayOpenPnl(position, 'MNQH7', quote(), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(position, 'MNQZ6', quote({ source: 'TV:MNQ1!' }), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(position, 'MNQZ6', quote({ stale: true }), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(position, 'MNQZ6', quote({ price: null }), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(position, 'MNQZ6', quote({ at: NOW - 5_001 }), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(position, 'MNQZ6', quote({ at: NOW - 5_000 }), 2, NOW)).toBe(37);
    expect(liveDisplayOpenPnl(open([row({ entry: null })]), 'MNQZ6', quote(), 2, NOW)).toBeNull();
    expect(liveDisplayOpenPnl(summary({ kind: 'pending', rows: [row()] as never }), 'MNQZ6', quote(), 2, NOW)).toBeNull();
  });
  it('štítek a barva berou živé číslo, bez něj číslo brokera; rozhodovací pole se nemění', () => {
    const [live] = livePositionChartLines(summary({ openPnl: 12 }), { ...controls, displayOpenPnl: -30 });
    expect(live.label).toContain('−$30');
    expect(live.color).not.toBe('#059669');
    const [broker] = livePositionChartLines(summary({ openPnl: 12 }), { ...controls, displayOpenPnl: null });
    expect(broker.label).toContain('12');
    expect(broker.color).toBe('#059669');
  });
  it('nepoužije se pro risk: štítek je jediné místo mimo panel', () => {
    for (const path of ['lib/liveChartOrderLines.ts', 'lib/liveHotkeys.ts', 'lib/liveManagePrices.ts']) {
      const source = readFileSync(path, 'utf8');
      expect(source.match(/displayOpenPnl/g)?.length ?? 0).toBeLessThanOrEqual(path === 'lib/liveChartOrderLines.ts' ? 3 : 0);
    }
  });
});

describe('LIVE → Graf: živá pozice ve štítcích jako návrh', () => {
  it('pozice: vstup se štítkem a BE, SL/TP táhnutelné jen u spravovatelného obchodu', () => {
    const lines = livePositionChartLines(summary(), controls);
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss', 'takeProfit']);
    expect(lines.every(line => line.ownerId === LIVE_POSITION_OWNER)).toBe(true);
    const [entry, stop, target] = lines;
    expect(entry).toMatchObject({ draggable: false, cancellable: false, label: expect.stringMatching(/^SHORT 4  28975\.50 · \+\$12\.00/) });
    expect(entry.actions).toEqual([expect.objectContaining({ id: 'break-even', disabled: false })]);
    expect(stop).toMatchObject({ draggable: true, dragDeadZonePx: 4, price: 28984.25, label: expect.stringMatching(/^SL  −\$70\.00 · 8\.75 b/) });
    expect(target).toMatchObject({ draggable: true, price: 28958 });
    // Nespravovatelný obchod (např. pohled followera): jen zobrazení.
    const readOnly = livePositionChartLines(summary(), { ...controls, manageable: false });
    expect(readOnly.some(line => line.draggable || line.cancellable || line.actions)).toBe(false);
  });

  it('čekající vstup: × = zrušit (jedním klikem), závorky jen zobrazení', () => {
    const lines = livePositionChartLines(summary({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null }), controls);
    expect(lines[0]).toMatchObject({ kind: 'entry', cancellable: true, label: expect.stringMatching(/^SELL 4 LIMIT  28975\.50/) });
    expect(lines[0].confirmCancel).toBeUndefined();
    expect(lines[0].actions).toBeUndefined();
    expect(lines.slice(1).every(line => !line.draggable && /čeká na vstup/.test(line.label))).toBe(true);
  });

  it('odeslaný posun: čára drží novou cenu se štítkem „odesílám“ a netáhne se', () => {
    const stop = livePositionChartLines(summary(), { ...controls, pending: { stopLoss: 28980 } })[1];
    expect(stop).toMatchObject({ price: 28980, draggable: false, label: expect.stringMatching(/odesílám/) });
  });

  it('holá pozice: štítky jen chybějících nohou, odeslání až s oběma', () => {
    const bare = summary({ stop: null, target: null });
    const entry = (chips: { missing: ('stopLoss' | 'takeProfit')[]; canSend: boolean }) => livePositionChartLines(bare, { ...controls, manageable: false, attachChips: chips }).find(line => line.kind === 'entry')!;
    expect(entry({ missing: ['stopLoss', 'takeProfit'], canSend: false }).addableBrackets).toEqual(['stopLoss', 'takeProfit']);
    expect(entry({ missing: ['takeProfit'], canSend: false }).addableBrackets).toEqual(['takeProfit']);
    const ready = entry({ missing: [], canSend: true });
    expect(ready.addableBrackets).toBeUndefined();
    expect(ready.actions?.map(action => action.id)).toEqual([LIVE_ATTACH_SEND_ACTION]);
    // Čekající vstup štítky nikdy nemá.
    expect(livePositionChartLines(summary({ kind: 'pending', stop: null, target: null }), { ...controls, attachChips: { missing: ['stopLoss'], canSend: false } })
      .find(line => line.kind === 'entry')?.addableBrackets).toBeUndefined();
  });

  it('s capability: TP blíž jen s odstupem od trhu a ne přes SL (short)', () => {
    const on = { pendingLegs: true };
    expect(liveLineMoveBlockReason(summary(), 'takeProfit', 28_958.25, on)).toMatch(/ticků od trhu/);
    expect(liveLineMoveBlockReason(summary(), 'takeProfit', 28_959, on)).toMatch(/ticků od trhu/);
    expect(liveLineMoveBlockReason(summary({ target: 28_940, mark: 28_960 }), 'takeProfit', 28_950, on)).toBeNull();
    expect(liveLineMoveBlockReason(summary({ target: 28_940, mark: null }), 'takeProfit', 28_950, on)).toMatch(/není známá/);
    expect(liveLineMoveBlockReason(summary({ target: 28_940, mark: 29_000, stop: 28_985 }), 'takeProfit', 28_990, on)).toMatch(/pod SL/);
  });

  it('nevyplněný vstup: bez capability nejde, s ní platí strana vůči vstupu; Stop vstup má rezervu TP', () => {
    const pending = (patch = {}) => summary({ kind: 'pending', side: 'long', entry: 100, stop: 90, target: 120, mark: null, entryType: 'limit', ...patch });
    expect(liveLineMoveBlockReason(pending(), 'stopLoss', 95)).toMatch(/až u vyplněné/);
    const on = { pendingLegs: true };
    expect(liveLineMoveBlockReason(pending(), 'stopLoss', 95, on)).toBeNull();
    expect(liveLineMoveBlockReason(pending(), 'stopLoss', 99.5, on)).toMatch(/pod vstupem/);
    expect(liveLineMoveBlockReason(pending(), 'takeProfit', 101, on)).toBeNull();
    expect(liveLineMoveBlockReason(pending(), 'takeProfit', 100.5, on)).toMatch(/nad vstupem/);
    expect(liveLineMoveBlockReason(pending({ entryType: 'stop' }), 'takeProfit', 101, on)).toMatch(/8 ticků/);
    const lines = livePositionChartLines(pending(), { ...controls, pendingLegs: true });
    expect(lines.find(line => line.kind === 'stopLoss')?.draggable).toBe(true);
    expect(livePositionChartLines(pending(), controls).find(line => line.kind === 'stopLoss')?.draggable).toBe(false);
  });

  it('předkontrola posunu: TP jen dál, SL nepřes TP, utažení s odstupem od trhu (short)', () => {
    expect(liveLineMoveBlockReason(summary(), 'takeProfit', 28950)).toBeNull();
    expect(liveLineMoveBlockReason(summary(), 'takeProfit', 28965)).toMatch(/dál od trhu/);
    expect(liveLineMoveBlockReason(summary(), 'stopLoss', 28990)).toBeNull();
    expect(liveLineMoveBlockReason(summary(), 'stopLoss', 28955)).toMatch(/nad TP/);
    expect(liveLineMoveBlockReason(summary(), 'stopLoss', 28961)).toMatch(/ticků/);
    expect(liveLineMoveBlockReason(summary(), 'stopLoss', 28970)).toBeNull();
    expect(liveLineMoveBlockReason(summary({ mark: null }), 'stopLoss', 28980)).toMatch(/není známá/);
    expect(liveLineMoveBlockReason(summary({ kind: 'pending' }), 'stopLoss', 28990)).toMatch(/vyplněné/);
  });

  it('BE: cena leadera na tick, blokace bez ceny trhu / blízko trhu / už na BE', () => {
    expect(liveBreakEven(summary(), 28975.5)).toEqual({ price: 28975.5, blocked: null });
    expect(liveBreakEven(summary({ mark: 28974 }), 28975.5).blocked).toMatch(/ticků/);
    expect(liveBreakEven(summary({ stop: 28975.5 }), 28975.5).blocked).toMatch(/už je na BE/);
    expect(liveBreakEven(summary(), null).blocked).toMatch(/není známý/);
  });

  it('graf: × a BE jdou přes pojistku čáry (backtest dál přes dvoukrok); cenové čáry se nekreslí dvakrát', () => {
    const overlay = readFileSync('components/BacktestOrderLinesOverlay.tsx', 'utf8');
    expect(overlay).toMatch(/confirmed\(line, cancelConfirmKey\(line\), line\.confirmCancel\)/);
    // Backtest: dvoukrok a neaktivní značka v čisté `orderLineConfirmStep`; živé čáry hlídá tests/liveOneClick.test.ts.
    expect(overlay).toMatch(/sameCancelLine\(live\.key, key\)\s*\? live\.stale === true \|\| live\.key !== key\s*: live\.stale === true && \(live\.key === key \|\| sameLiveCancelOwner\(live\.key, key\)\)/);
    expect(overlay).toMatch(/const next = orderLineConfirmSync\(current, lines\);/);
    // Klíč potvrzení nese akci a cenu: potvrzené „zrušit příkaz“ nikdy nezavře pozici (ani jiný obchod).
    expect(overlay).toMatch(/cancelConfirmKey = \(line: BacktestChartOrderLine\) => `\$\{line\.id\}:cancel:\$\{line\.cancelAction \?\? line\.ownerType\}:\$\{line\.price\}`/);
    // Dvojklik se nepočítá: 2. klik ≥ 350 ms od PŘEDCHOZÍHO kliku (sdílený `liveManageConfirmStep`).
    expect(overlay).toMatch(/const step = liveManageConfirmStep\(live\?\.stale \? null : live, key, now\);/);
    const workspace = readFileSync('components/AlphaTradeChartWorkspace.tsx', 'utf8');
    expect(workspace).toMatch(/target\.root !== liveOrderEntry\?\.executionInstrument/);
    const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
    // „Co jsem viděl“ ze začátku tahu; souběžná změna = nic se neodešle.
    expect(screen).toMatch(/startLine && startLine\.price !== current/);
    // Jeden příkaz naráz: od U10 (3. 11.) zámek drží sdílený runner správy (čáry, zkratky i panel).
    expect(screen).toMatch(/const runLiveManage = manageRunner\.run;/);
    expect(readFileSync('hooks/useLiveManageRunner.ts', 'utf8')).toMatch(/Čeká se na výsledek předchozí změny/);
  });
});

describe('LIVE → Graf: přímé odeslání velkým tlačítkem (Filip 30. 10.)', () => {
  const ticket = readFileSync('components/LiveOrderTicket.tsx', 'utf8');
  it('jedním kliknutím, bez náhledu; brány dál ověří worker; jedno odeslání naráz s novým id', () => {
    // Klik pustí fokus tlačítka (Enter po zkratce nesmí odeslat vyměněný návrh — oponentura vlny B).
    expect(ticket).toMatch(/onClick=\{event => \{ event\.currentTarget\.blur\(\); void sendDirect\(\); \}\}/);
    expect(ticket).toMatch(/directBusyRef\.current\) return;/);
    // Vstup jde přes sdílený zámek jednoho příkazu (`placeEntryLocked` = `runWithCommandLock` + onPlaceEntry).
    expect(ticket).toMatch(/const operationId = `entry:\$\{crypto\.randomUUID\(\)/);
    expect(ticket).toMatch(/placeEntryLocked\(previewDraft, operationId\)/);
    // Blokace náhledu (Market, SL/TP, chyby panelu, zastaralá cena) blokuje i přímé odeslání.
    expect(ticket).toMatch(/previewBlockedReason \?\? \(!previewDraft/);
  });
  it('přijatý vstup zavře návrh (zůstane jen živý příkaz), chyba návrh nechá', () => {
    // Přijatý vstup návrh hned maže; zelené „Přijato“ je jen ozvěna, ne tlačítko.
    expect(ticket).toMatch(/if \(result\.status === 'acknowledged'\) \{\s*setSentFlash\([^;]*\);\s*onDraft\(null\);\s*\}/);
    expect(ticket).toMatch(/\{!draft && sentFlash && <div[\s\S]{0,200}<div role="status"/);
    expect(ticket).toMatch(/if \(placedResult\.status === 'acknowledged'\) onAcknowledged\?\.\(\);/);
  });
  it('read-only localhost je „neodesláno“, ne neznámý výsledek', () => {
    expect(ticket).toMatch(/worker-disconnected\|pouze read-only/);
  });
});

describe('LIVE → Graf: × u pozice a Market (30. 10.)', () => {
  it('× u pozice jen se schopností workeru a za zapnuté kopírky; jinak pozice bez ×', () => {
    const closable = livePositionChartLines(summary(), { ...controls, canClose: true })[0];
    // Zavření jedním kliknutím (Filip 30. 10.).
    expect(closable).toMatchObject({ cancellable: true, cancelAction: 'close-position' });
    expect(closable.confirmCancel).toBeUndefined();
    expect(livePositionChartLines(summary(), controls)[0].cancellable).toBe(false);
    const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
    expect(screen).toMatch(/canClose: manageCloseSupported && copier\.available && copier\.status\?\.armed === true && copier\.status\.shadowMode !== true/);
    // Pozice z přikoupení s rozjetými SL: „co jsem viděl“ = nejochrannější SL od workeru (3. 11.).
    expect(screen).toMatch(/runLiveManage\('close-position', summary\.stop \?\? entryScaleIn\?\.stopLoss\)/);
  });

  it('Market = skutečný Market u brokera (2. 11. 2026): žádný převod na Limit, cena grafu jen jako referencePrice', () => {
    const ticket = readFileSync('components/LiveOrderTicket.tsx', 'utf8');
    expect(ticket).not.toMatch(/MARKET_GUARD_POINTS/);
    expect(ticket).toMatch(/orderType: 'Market' as const, referencePrice: marketReference!, quoteReceivedAt:/);
    expect(ticket).toMatch(/!entryMarketSupported \? 'Worker zatím neumí nativní Market/);
    expect(ticket).toMatch(/`MKT · ~/);
  });
});


it('fill při posunu limitu okamžitě ukáže skutečnou cenu pozice, ne návrh posunu', () => {
  const [entry] = livePositionChartLines(summary({ kind: 'position', entry: 28975.5 }), {
    ...controls, moveLimit: true, pending: { entry: 28976 },
  });
  expect(entry.price).toBe(28975.5);
  expect(entry.label).not.toContain('odesílám');
  expect(entry.draggable).toBe(false);
});
