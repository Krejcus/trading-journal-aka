import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pendingOrderChartLines, positionChartLines, projectedBacktestPnl } from '../services/backtestOrderLines';
import { createBacktestOrder } from '../services/backtestEngine';

describe('backtest chart order lines', () => {
  it('does not place full-width pointer targets over chart drawings', () => {
    const source = readFileSync('components/BacktestOrderLinesOverlay.tsx', 'utf8');

    expect(source).not.toContain('pointer-events-auto absolute inset-x-0');
    expect(source).toContain('pointer-events-none absolute inset-0');
    expect(source).toContain('pointer-events-auto absolute right-1');
  });

  it('renders colored SL/TP handles before the position label and drags them with live prices', () => {
    const source = readFileSync('components/BacktestOrderLinesOverlay.tsx', 'utf8');

    expect(source.indexOf('line.addableBrackets?.map')).toBeLessThan(source.indexOf('line.label}</span>'));
    expect(source).toContain("kind === 'stopLoss' ? 'border-rose-600 bg-rose-500");
    expect(source).toContain("'border-emerald-700 bg-emerald-600");
    expect(source).toContain('items-center gap-[3px]');
    expect(source).toContain('items-center overflow-hidden rounded-[3px] border shadow-sm');
    // Tažení commitne do enginu až při puštění (jinak se celý workspace
    // překresloval na každý pixel); během tahu žije cena jen v overlay.
    expect(source).toContain('onAddBracket?.(line, dragging.bracketKind, dragging.lastPrice)');
    expect(source).toContain('setDragOverride({ lineId: line.id, top: Math.round(top * 2) / 2, price: snapped })');
    expect(source).toContain('data-backtest-bracket-drag-preview');
    expect(source).toContain("'rgba(16, 185, 129, 0.10)'");
    expect(source).toContain("'rgba(244, 63, 94, 0.10)'");
    expect(source).toContain('setBracketDragPreview(null)');
  });

  it('renders fill markers immediately and closed-trade connectors with a hover summary', () => {
    const source = readFileSync('components/BacktestTradeExecutionsOverlay.tsx', 'utf8');

    expect(source).toContain('data-backtest-trade-executions');
    expect(source).toContain('Entry {hoveredTrade.entryPrice.toFixed(2)}');
    expect(source).toContain('{exitLabel(hoveredTrade.reason)} {hoveredTrade.exitPrice.toFixed(2)}');
    expect(source).toContain('P&amp;L {formatMoney(hoveredTrade.pnl)}');
    // Markery vznikají z fillů (ne až z uzavřených obchodů), aby byly na grafu
    // hned. Počítají se ale mimo `update` — uvnitř se při každé změně rozsahu
    // přepočítávaly celé znovu, což při scrollu zamrzlo hlavní vlákno.
    expect(source).toContain('useMemo(() => backtestExecutionMarkers(fills), [fills])');
    expect(source).toContain('executionMarkersRef.current.flatMap');
    expect(source).toContain('context.setLineDash([2, 4])');
    expect(source).toContain('context.lineWidth = 0.75');
    expect(source).toContain('context.closePath()');
    expect(source).toContain('context.fill()');
    expect(source).toContain("markerSize === 'large' ? 6 : 4");
    expect(source).toContain('marker.x - markerHalfWidth');
    expect(source).toContain('presentation.showExecutionMarkers');
    expect(source).toContain('presentation.showTradeLines');
    expect(source).toContain('data-backtest-execution-marker-tooltip');
    expect(source).toContain('hoveredExecutionMarker.quantity');
    expect(source).toContain('hoveredExecutionMarker.instrument');
    expect(source).toContain('<canvas ref={canvasRef}');
    expect(source).not.toContain('<svg');
    expect(source).toContain("window.addEventListener('pointermove', updatePassiveHover, { capture: true, passive: true })");
    expect(source).toContain('subscribeVisibleLogicalRangeChange(update)');
    // Hover se po scrollu dopočítá (svíčky se posunuly pod nehybným kurzorem),
    // ale prochází přes `hoverUpdater` — beze změny vrátí předchozí referenci,
    // takže překreslení overlaye už nespustí další změnu rozsahu a smyčku.
    expect(source).toContain('setHovered(hoverUpdater(nextMarker ? null : hoveredTradeAtPointer(next, pointerRef.current, rect)))');
    expect(source).toContain('setHoveredMarker(hoverUpdater(nextMarker))');
    expect(source).toContain('setHovered(null)');
    expect(source).not.toContain('className="pointer-events-auto cursor-help"');
  });

  it('calculates MNQ long and short projected P&L', () => {
    expect(projectedBacktestPnl('MNQ', 'buy', 2, 100, 105)).toBe(20);
    expect(projectedBacktestPnl('MNQ', 'sell', 2, 100, 105)).toBe(-20);
  });

  it('builds draggable entry, SL and TP rows for a pending limit order', () => {
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 2,
      limitPrice: 100, stopLoss: 95, takeProfit: 110, now: 1,
    });
    const lines = pendingOrderChartLines(order);
    expect(lines.map(line => line.kind)).toEqual(['entry', 'stopLoss', 'takeProfit']);
    expect(lines[0]).toMatchObject({ draggable: true, cancellable: true, color: '#2563eb' });
    expect(lines[1].label).toBe('SL  −$20.00');
    expect(lines[2].label).toBe('TP  +$40.00');
    expect(lines[1].price).toBe(95);
    expect(lines[2].price).toBe(110);
  });

  it('nabídne přidání SL/TP u objednávky, která je zatím nemá', () => {
    // Objednávka z pravého kliku do grafu vzniká holá — brackety musí jít
    // doplnit a natáhnout přímo v grafu.
    const bare = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, now: 1,
    });
    const [entry] = pendingOrderChartLines(bare);
    expect(entry.addableBrackets).toEqual(['stopLoss', 'takeProfit']);
  });

  it('nabídne jen chybějící bracket', () => {
    const withStop = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, stopLoss: 95, now: 1,
    });
    expect(pendingOrderChartLines(withStop)[0].addableBrackets).toEqual(['takeProfit']);
  });

  it('objednávka s oběma brackety už nic nenabízí', () => {
    const full = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, stopLoss: 95, takeProfit: 110, now: 1,
    });
    expect(pendingOrderChartLines(full)[0].addableBrackets).toBeUndefined();
  });

  it('křížek na SL/TP objednávky maže bracket, ne celou objednávku', () => {
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, stopLoss: 95, takeProfit: 110, now: 1,
    });
    const lines = pendingOrderChartLines(order);
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({
      cancellable: true, cancelAction: 'remove-bracket',
    });
    expect(lines.find(line => line.kind === 'takeProfit')).toMatchObject({
      cancellable: true, cancelAction: 'remove-bracket',
    });
    // Zrušení celé objednávky zůstává jen na entry lince.
    expect(lines.find(line => line.kind === 'entry')?.cancelAction).toBe('cancel-order');
  });

  it('locks a filled entry while keeping the bracket draggable', () => {
    const lines = positionChartLines({
      instrument: 'MNQ', side: 'long', quantity: 1, averagePrice: 100,
      stopLoss: 95, takeProfit: 110, openedAt: 1, entryFillIds: [], entryCommission: 0,
    }, 104);
    expect(lines.find(line => line.kind === 'entry')?.draggable).toBe(false);
    expect(lines.find(line => line.kind === 'entry')).toMatchObject({
      cancellable: true,
      cancelAction: 'close-position',
      filledLabel: true,
    });
    expect(lines.find(line => line.kind === 'entry')?.addableBrackets).toBeUndefined();
    expect(lines.find(line => line.kind === 'stopLoss')?.draggable).toBe(true);
    expect(lines.find(line => line.kind === 'stopLoss')).toMatchObject({
      cancellable: true,
      cancelAction: 'remove-bracket',
    });
    expect(lines.find(line => line.kind === 'takeProfit')).toMatchObject({
      cancellable: true,
      cancelAction: 'remove-bracket',
    });
    expect(lines.find(line => line.kind === 'entry')?.label).toContain('P&L +$8.00');
    expect(lines.find(line => line.kind === 'entry')?.color).toBe('#059669');
    expect(lines).toHaveLength(3);
  });

  it('keeps SL and TP controls directly on a filled market position line', () => {
    const entry = positionChartLines({
      instrument: 'MNQ', side: 'long', quantity: 1, averagePrice: 100,
      openedAt: 1, entryFillIds: [], entryCommission: 0,
    }, 100)[0];

    expect(entry.addableBrackets).toEqual(['stopLoss', 'takeProfit']);
  });

  it('keeps only missing market bracket controls and hides both when already set', () => {
    const base = {
      instrument: 'MNQ' as const, side: 'long' as const, quantity: 1, averagePrice: 100,
      openedAt: 1, entryFillIds: [], entryCommission: 0,
    };

    expect(positionChartLines({ ...base, stopLoss: 95 }, 100)[0].addableBrackets)
      .toEqual(['takeProfit']);
    expect(positionChartLines({ ...base, takeProfit: 110 }, 100)[0].addableBrackets)
      .toEqual(['stopLoss']);
    expect(positionChartLines({ ...base, stopLoss: 95, takeProfit: 110 }, 100)[0].addableBrackets)
      .toBeUndefined();
  });

  it('does not duplicate inline SL/TP controls for a filled limit or stop entry', () => {
    const entry = positionChartLines({
      instrument: 'MNQ', side: 'long', quantity: 1, averagePrice: 100,
      stopLoss: 95, takeProfit: 110, openedAt: 1, entryFillIds: [], entryCommission: 0,
    }, 100, false)[0];

    expect(entry.addableBrackets).toBeUndefined();
  });

  it('colors an open position green in profit, red in loss and blue at breakeven', () => {
    const position = {
      instrument: 'MNQ' as const, side: 'short' as const, quantity: 1, averagePrice: 100,
      openedAt: 1, entryFillIds: [], entryCommission: 0,
    };

    expect(positionChartLines(position, 95)[0].color).toBe('#059669');
    expect(positionChartLines(position, 105)[0].color).toBe('#ef4444');
    expect(positionChartLines(position, 100)[0].color).toBe('#2563eb');
  });
});
