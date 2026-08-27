import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopyTradePositionsCell } from '../components/LiveCopyTradeOverview';
import type { LiveOrder, LivePosition } from '../services/tradecopiaLiveService';

const livePosition = (partial: Partial<LivePosition> = {}): LivePosition => ({
  accountId: 7,
  symbol: 'MNQU6',
  netPosition: 1,
  netPrice: 23_000,
  realizedPnl: 0,
  unrealizedPnl: 0,
  updatedAt: null,
  ...partial,
});

const liveOrder = (partial: Partial<LiveOrder> = {}): LiveOrder => ({
  id: 1,
  accountId: 7,
  accountName: 'Demo 7',
  action: 'Sell',
  orderType: 'Limit',
  quantity: 1,
  price: 23_100,
  stopPrice: null,
  status: 'Working',
  symbol: 'MNQU6',
  placedAt: null,
  updatedAt: null,
  working: true,
  ...partial,
});

const renderCell = ({
  accountId = 7,
  positions = [],
  orders = [],
}: {
  accountId?: number | null;
  positions?: LivePosition[];
  orders?: LiveOrder[];
} = {}) => renderToStaticMarkup(React.createElement(CopyTradePositionsCell, {
  accountId,
  positions,
  orders,
}));

describe('Positions sloupec copy tradingu', () => {
  it('vykreslí long pill se zkráceným symbolem a štítem jen při working SL i targetu', () => {
    const markup = renderCell({
      positions: [livePosition()],
      orders: [
        liveOrder({ id: 11, orderType: 'StopLimit', price: 22_900, stopPrice: 22_900 }),
        liveOrder({ id: 12, orderType: 'Limit', price: 23_100 }),
      ],
    });

    expect(markup).toContain('MNQ');
    expect(markup).not.toContain('MNQU6');
    expect(markup).toContain('+1');
    expect(markup).toContain('lucide-shield-check');
    expect(markup).toContain('bg-emerald-500/10');
    expect(markup).not.toContain('bez SL');
  });

  it('vykreslí short pill a výrazné varování, když working stop chybí', () => {
    const markup = renderCell({
      positions: [livePosition({ netPosition: -2 })],
      orders: [
        liveOrder({ id: 21, action: 'Buy', orderType: 'Limit' }),
        liveOrder({ id: 22, action: 'Buy', orderType: 'Stop', symbol: 'MNQZ6', stopPrice: 23_100 }),
        liveOrder({ id: 23, accountId: 8, action: 'Buy', orderType: 'Stop', stopPrice: 23_100 }),
        liveOrder({ id: 24, action: 'Sell', orderType: 'Stop', stopPrice: 23_100 }),
      ],
    });

    expect(markup).toContain('−2');
    expect(markup).toContain('bg-rose-500/10');
    expect(markup).toContain('lucide-triangle-alert');
    expect(markup).toContain('bez SL');
    expect(markup).not.toContain('lucide-shield-check');
  });

  it('stop bez targetu odstraní anomálii, ale ještě nezobrazí štít kompletní ochrany', () => {
    const markup = renderCell({
      positions: [livePosition()],
      orders: [liveOrder({ id: 31, orderType: 'Stop', stopPrice: 22_900 })],
    });

    expect(markup).not.toContain('bez SL');
    expect(markup).not.toContain('lucide-shield-check');
  });

  it('štít vyžaduje přesné množstevní pokrytí a pod/nadkrytý SL ukáže nahlas', () => {
    const underCovered = renderCell({
      positions: [livePosition({ netPosition: 5 })],
      orders: [
        liveOrder({ id: 35, orderType: 'Stop', quantity: 1, stopPrice: 22_900 }),
        liveOrder({ id: 36, orderType: 'Limit', quantity: 5 }),
      ],
    });
    const fullyCovered = renderCell({
      positions: [livePosition({ netPosition: 5 })],
      orders: [
        liveOrder({ id: 37, orderType: 'Stop', quantity: 2, stopPrice: 22_900 }),
        liveOrder({ id: 38, orderType: 'Stop', quantity: 3, stopPrice: 22_900 }),
        liveOrder({ id: 39, orderType: 'Limit', quantity: 2 }),
        liveOrder({ id: 40, orderType: 'Limit', quantity: 3 }),
      ],
    });
    const overCovered = renderCell({
      positions: [livePosition({ netPosition: 5 })],
      orders: [
        liveOrder({ id: 41, orderType: 'Stop', quantity: 6, stopPrice: 22_900 }),
        liveOrder({ id: 42, orderType: 'Limit', quantity: 5 }),
      ],
    });

    expect(underCovered).not.toContain('lucide-shield-check');
    expect(underCovered).toContain('working SL kryje jen 1 z 5');
    expect(underCovered).toContain('SL 1/5');
    expect(underCovered).not.toContain('bez SL');
    expect(fullyCovered).toContain('lucide-shield-check');
    expect(overCovered).not.toContain('lucide-shield-check');
    expect(overCovered).toContain('SL 6/5');
    expect(overCovered).toContain('překrývá pozici a může ji otočit');
  });

  it('flat účet ukáže jen working Limit/Stop entry a terminální či Market příkazy ignoruje', () => {
    const markup = renderCell({
      orders: [
        liveOrder({ id: 41, orderType: 'Limit', symbol: 'MNQU6', quantity: 1 }),
        liveOrder({ id: 42, action: 'Buy', orderType: 'Stop', symbol: 'NQH26', quantity: 2 }),
        liveOrder({ id: 43, orderType: 'Market', symbol: 'ESH26' }),
        liveOrder({ id: 44, orderType: 'Limit', symbol: 'RTYZ6', working: false, status: 'Filled' }),
      ],
    });

    expect(markup).toContain('lucide-clock-3');
    expect(markup).toContain('MNQ');
    expect(markup).toContain('NQ');
    expect(markup).not.toContain('ES');
    expect(markup).not.toContain('RTY');
  });

  it('udrží více otevřených symbolů v jednom řádku a flat účet bez entry nechá jako pomlčku', () => {
    const positionsMarkup = renderCell({
      positions: [
        livePosition(),
        livePosition({ symbol: 'NQH26', netPosition: -1 }),
      ],
      orders: [
        liveOrder({ id: 51, orderType: 'Stop', stopPrice: 22_900 }),
        liveOrder({ id: 52, action: 'Buy', orderType: 'Stop', symbol: 'NQH26', stopPrice: 23_100 }),
      ],
    });

    expect(positionsMarkup).toContain('whitespace-nowrap');
    expect(positionsMarkup).toContain('MNQ');
    expect(positionsMarkup).toContain('NQ');
    expect(renderCell()).toContain('>—</span>');
  });

  it('vedle otevřené pozice ukáže entry na jiném kontraktu, ale ochranné nohy stejného kontraktu nezdvojí', () => {
    const markup = renderCell({
      positions: [livePosition()],
      orders: [
        liveOrder({ id: 61, orderType: 'Stop', stopPrice: 22_900 }),
        liveOrder({ id: 62, action: 'Buy', orderType: 'Limit', symbol: 'NQH26', quantity: 2 }),
      ],
    });

    expect(markup).toContain('aria-label="Čekající vstup NQ, 2 kontraktů"');
    expect(markup.match(/lucide-clock-3/g)).toHaveLength(1);
  });
});
