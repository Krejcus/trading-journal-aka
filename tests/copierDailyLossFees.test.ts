import { describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { cloneDayRuleActions, DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

// Denní ztráta = přísnější z hrubého ledgeru a čistého P&L brokera (2. 11. 2026, poplatky).
const START = Date.parse('2026-09-08T16:00:00.000Z');

const group = (): CopyGroupConfig => ({
  id: 'fees-group', name: 'Fees', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyLossLimitUsd: 100, dailyMaxLosingTrades: 0, dailyMaxTrades: 0, entryCooldownMinutes: 0,
    tradingWindow: { enabled: false, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
    dayRuleActions: {
      ...cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions),
      dailyLoss: { atLimit: { kind: 'pause', minutes: 12 }, at80Percent: null },
    },
  },
});

let seq = 0;
const fill = (side: 'Buy' | 'Sell', price: number, at: number) => {
  seq += 1;
  return { type: 'fill' as const, fill: { fillId: `fees-fill-${seq}`, tag: '', brokerOrderId: `fees-${seq}`,
    accountId: 100, symbol: 'MNQU6', side, quantity: 1, price, filledAt: at } };
};
const position = (netQuantity: number) => ({ type: 'position' as const, position: { accountId: 100, symbol: 'MNQU6', netQuantity } });

/** Leader prodělá hrubě 50 USD (25 b MNQ); broker pak hlásí `brokerNet` se stářím snímku `snapshotAt`. */
const run = async (brokerNet: number, snapshotAt: (now: number) => number, tradeDate: string | null = '2026-09-08') => {
  let now = START;
  const clock = () => now;
  const risk: BrokerAccountRiskSnapshot[] = [];
  const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }), accountRiskSnapshots: risk });
  const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  broker.emitEvent(fill('Buy', 20_000, now));
  broker.emitEvent(position(1));
  await controller.waitForIdle();
  now += 1_000;
  risk.push({ accountId: 100, at: snapshotAt(now), realizedPnlUsd: brokerNet, realizedTradeDate: tradeDate, netLiq: null, minNetLiq: null,
    dailyLossAutoLiq: null, trailingMaxDrawdown: null });
  broker.emitEvent(fill('Sell', 19_975, now));
  broker.emitEvent(position(0));
  await controller.waitForIdle();
  now += 1_000;
  broker.emitEvent({ type: 'heartbeat', at: now });
  await controller.waitForIdle();
  return controller;
};

describe('denní ztráta počítá poplatky (přísnější z ledgeru a brokera)', () => {
  it('čisté P&L brokera přes limit spustí akci, i když hrubý ledger je pod limitem', async () => {
    const controller = await run(-110, at => at);
    try {
      const status = controller.status();
      expect(status.dailyStats).toMatchObject({ realizedPnlUsd: -50, lossPnlUsd: -110, lossPnlSource: 'broker' });
      expect(status.pause?.rule).toBe('daily-loss');
    } finally { controller.stop(); }
  });

  it('starý snímek brokera (> 90 s) se nepoužije — platí ledger jako dřív', async () => {
    const controller = await run(-110, at => at - 120_000);
    try {
      expect(controller.status().dailyStats).toMatchObject({ lossPnlUsd: -50, lossPnlSource: 'ledger' });
      expect(controller.status().pause ?? null).toBeNull();
    } finally { controller.stop(); }
  });

  it('přelom session: broker P&L ze včerejšího obchodního dne (nevynulované) se nepoužije', async () => {
    const controller = await run(-260, at => at, '2026-09-07');
    try {
      expect(controller.status().dailyStats).toMatchObject({ lossPnlUsd: -50, lossPnlSource: 'ledger' });
      expect(controller.status().pause ?? null).toBeNull();
    } finally { controller.stop(); }
  });

  it('broker bez obchodního dne (tradeDate chybí) se nepoužije', async () => {
    const controller = await run(-110, at => at, null);
    try {
      expect(controller.status().dailyStats).toMatchObject({ lossPnlUsd: -50, lossPnlSource: 'ledger' });
    } finally { controller.stop(); }
  });

  it('broker mírnější než ledger nic nezmírní', async () => {
    const controller = await run(-20, at => at);
    try {
      expect(controller.status().dailyStats).toMatchObject({ lossPnlUsd: -50, lossPnlSource: 'ledger' });
    } finally { controller.stop(); }
  });
});
