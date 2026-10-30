import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';

const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'short', quantity: 4, entry: 28975.5, entryType: null, openPnl: 12, mark: 28960,
  stop: 28984.25, target: 28958, protection: 'SL 4/4 · TP 4/4', accounts: 4, scopeLabel: null,
  leader: { accountId: 1, quantity: 1, entry: 28975.5 }, ...patch,
});
const controls = { manageable: true, entryAvg: 28975.5, pointValue: 2 };

describe('LIVE → Graf: živá pozice ve štítcích jako návrh', () => {
  it('pozice: vstup se štítkem a BE, SL/TP táhnutelné jen u spravovatelného obchodu', () => {
    const lines = livePositionChartLines(summary(), controls);
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss', 'takeProfit']);
    expect(lines.every(line => line.ownerId === LIVE_POSITION_OWNER)).toBe(true);
    const [entry, stop, target] = lines;
    expect(entry).toMatchObject({ draggable: false, cancellable: false, label: expect.stringMatching(/^SHORT 4  28975\.50 · \+\$12\.00/) });
    expect(entry.actions).toEqual([expect.objectContaining({ id: 'break-even', confirm: true, disabled: false })]);
    expect(stop).toMatchObject({ draggable: true, dragDeadZonePx: 4, price: 28984.25, label: expect.stringMatching(/^SL  −\$70\.00 · 8\.75 b/) });
    expect(target).toMatchObject({ draggable: true, price: 28958 });
    // Nespravovatelný obchod (např. pohled followera): jen zobrazení.
    const readOnly = livePositionChartLines(summary(), { ...controls, manageable: false });
    expect(readOnly.some(line => line.draggable || line.cancellable || line.actions)).toBe(false);
  });

  it('čekající vstup: × = zrušit (dvoukrokově), závorky jen zobrazení', () => {
    const lines = livePositionChartLines(summary({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null }), controls);
    expect(lines[0]).toMatchObject({ kind: 'entry', cancellable: true, confirmCancel: true, label: expect.stringMatching(/^SELL 4 LIMIT  28975\.50/) });
    expect(lines[0].actions).toBeUndefined();
    expect(lines.slice(1).every(line => !line.draggable && /čeká na vstup/.test(line.label))).toBe(true);
  });

  it('odeslaný posun: čára drží novou cenu se štítkem „odesílám“ a netáhne se', () => {
    const stop = livePositionChartLines(summary(), { ...controls, pending: { stopLoss: 28980 } })[1];
    expect(stop).toMatchObject({ price: 28980, draggable: false, label: expect.stringMatching(/odesílám/) });
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

  it('graf: × a BE jsou dvoukrokové v overlay; cenové čáry se nekreslí dvakrát', () => {
    const overlay = readFileSync('components/BacktestOrderLinesOverlay.tsx', 'utf8');
    expect(overlay).toMatch(/confirmed\(`\$\{line\.id\}:cancel`, line\.confirmCancel\)/);
    expect(overlay).toMatch(/now - \(confirming\.until - CONFIRM_MS\) >= 350/);
    const workspace = readFileSync('components/AlphaTradeChartWorkspace.tsx', 'utf8');
    expect(workspace).toMatch(/target\.root !== liveOrderEntry\?\.executionInstrument/);
    const screen = readFileSync('components/LiveTradingScreen.tsx', 'utf8');
    // „Co jsem viděl“ ze začátku tahu; souběžná změna = nic se neodešle.
    expect(screen).toMatch(/startLine && startLine\.price !== current/);
    expect(screen).toMatch(/Čeká se na výsledek předchozí změny/);
  });
});

describe('LIVE → Graf: přímé odeslání velkým tlačítkem (Filip 30. 10.)', () => {
  const ticket = readFileSync('components/LiveOrderTicket.tsx', 'utf8');
  it('jedním kliknutím, bez náhledu; brány dál ověří worker; jedno odeslání naráz s novým id', () => {
    expect(ticket).toMatch(/onClick=\{\(\) => void sendDirect\(\)\}/);
    expect(ticket).toMatch(/directBusyRef\.current\) return;/);
    expect(ticket).toMatch(/onPlaceEntry\(previewDraft, `entry:\$\{crypto\.randomUUID\(\)/);
    // Blokace náhledu (Market, SL/TP, chyby panelu, zastaralá cena) blokuje i přímé odeslání.
    expect(ticket).toMatch(/previewBlockedReason \?\? \(!previewDraft/);
  });
  it('read-only localhost je „neodesláno“, ne neznámý výsledek', () => {
    expect(ticket).toMatch(/worker-disconnected\|pouze read-only/);
  });
});
