import { describe, expect, it } from 'vitest';
import { hoverUpdater } from '../components/BacktestTradeExecutionsOverlay';

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
