import { describe, expect, it } from 'vitest';
import { backtestTradeIdAtPointer, hoverUpdater } from '../components/BacktestTradeExecutionsOverlay';
import type { BacktestClosedTrade } from '../services/backtestTypes';

/**
 * Regrese na zamrzání grafu při scrollování zpět do historie.
 *
 * `update` visí synchronně na změně viditelného rozsahu. Když vracel při
 * každém volání nový objekt, React překreslil overlay, překreslení hnulo
 * rozsahem a spustilo další `update` — smyčka držela hlavní vlákno 29 až 103
 * sekund podle množství načtené historie. Identita reference je proto to,
 * co smyčku láme.
 */
describe('hoverUpdater', () => {
  const point = { id: 'trade-1', x: 120, y: 240 };

  it('beze změny vrátí PŘESNĚ předchozí referenci (jinak React překreslí)', () => {
    const current = { ...point };
    const next = { ...point }; // jiná reference, stejná hodnota
    expect(hoverUpdater(next)(current)).toBe(current);
  });

  it('null → null nevytvoří novou hodnotu', () => {
    expect(hoverUpdater(null)(null)).toBeNull();
  });

  it('propustí změnu pozice, i když jde o stejný obchod', () => {
    const current = { ...point };
    const moved = { ...point, x: 121 };
    expect(hoverUpdater(moved)(current)).toBe(moved);
  });

  it('propustí změnu obchodu na stejných souřadnicích', () => {
    const current = { ...point };
    const other = { ...point, id: 'trade-2' };
    expect(hoverUpdater(other)(current)).toBe(other);
  });

  it('propustí opuštění hoveru i jeho vznik', () => {
    expect(hoverUpdater(null)({ ...point })).toBeNull();
    const appearing = { ...point };
    expect(hoverUpdater(appearing)(null)).toBe(appearing);
  });
});

describe('backtestTradeIdAtPointer', () => {
  const rect = { left: 100, top: 50, width: 500, height: 300 } as DOMRect;
  const trade: BacktestClosedTrade = {
    id: 'trade-1', runId: 'run-1', instrument: 'MNQ', direction: 'Long', quantity: 1,
    entryPrice: 20000, exitPrice: 20010, entryTime: 100, exitTime: 200,
    grossPnl: 20, commission: 1, pnl: 19, reason: 'take-profit',
  };

  it('opens the trade when clicking close to its entry-exit connector', () => {
    expect(backtestTradeIdAtPointer({
      coordinates: [{ id: trade.id, entryX: 10, entryY: 20, exitX: 110, exitY: 20 }],
      markers: [], executionMarkers: [], trades: [trade], rect,
      pointer: { clientX: 160, clientY: 72 },
    })).toBe(trade.id);
  });

  it('maps an entry fill marker back to the closed trade', () => {
    const marker = {
      id: 'fill-1', time: trade.entryTime, price: trade.entryPrice, instrument: 'MNQ' as const,
      side: 'buy' as const, quantity: 1, pointsUp: true, color: '#2563eb',
    };
    expect(backtestTradeIdAtPointer({
      coordinates: [], markers: [{ ...marker, x: 40, y: 60 }], executionMarkers: [marker],
      trades: [trade], rect, pointer: { clientX: 140, clientY: 110 },
    })).toBe(trade.id);
  });

  it('does not steal ordinary chart clicks', () => {
    expect(backtestTradeIdAtPointer({
      coordinates: [{ id: trade.id, entryX: 10, entryY: 20, exitX: 110, exitY: 20 }],
      markers: [], executionMarkers: [], trades: [trade], rect,
      pointer: { clientX: 400, clientY: 250 },
    })).toBeNull();
  });
});
