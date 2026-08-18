import { describe, expect, it } from 'vitest';
import type { BrokerOrderRequest } from '../services/brokerPort';
import {
  cancelLifecycleHaltReason,
  createRiskGateContext,
  evaluateRiskGate,
  haltReason,
  type RiskGateContext,
} from '../services/copierRiskGate';

const request = (partial: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  tag: 'cpabc123',
  accountId: 200,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 1,
  orderType: 'Market',
  ...partial,
});

/** Kontext, který projde — testy z něj ubírají po jedné podmínce. */
const openGate = (overrides: Partial<RiskGateContext> = {}): RiskGateContext =>
  createRiskGateContext({
    armed: true,
    armedAt: 1_000,
    now: 2_000,
    connected: true,
    lastHeartbeatAt: 1_500,
    shadowMode: false,
    ...overrides,
  });

describe('createRiskGateContext', () => {
  it('výchozí stav je zavřeno — DISARMED, bez spojení, v shadow mode', () => {
    const context = createRiskGateContext();
    expect(context.armed).toBe(false);
    expect(context.connected).toBe(false);
    expect(context.shadowMode).toBe(true);
    expect(haltReason(context)).toBe('disarmed');
  });

  it('výchozí politika při divergenci zastaví celou skupinu', () => {
    expect(createRiskGateContext().divergencePolicy).toBe('halt-group');
  });
});

describe('haltReason', () => {
  it('kill switch přebíjí všechno ostatní', () => {
    expect(haltReason(openGate({ killSwitch: true, armed: false }))).toBe('kill-switch');
  });

  it('zastaví bez ARM', () => {
    expect(haltReason(openGate({ armed: false }))).toBe('disarmed');
  });

  it('ARM vyprší po TTL', () => {
    expect(haltReason(openGate({ armedAt: 0, now: 9 * 60 * 60 * 1000 }))).toBe('arm-expired');
  });

  it('zastaví při odpojení', () => {
    expect(haltReason(openGate({ connected: false }))).toBe('disconnected');
  });

  it('zastaví při zastaralém heartbeatu', () => {
    expect(haltReason(openGate({ lastHeartbeatAt: 0, now: 30_000 }))).toBe('stale-heartbeat');
  });

  it('zastaví při neshodě prostředí', () => {
    expect(haltReason(openGate({ brokerEnvironment: 'live', expectedEnvironment: 'demo' })))
      .toBe('environment-mismatch');
  });

  it('zastaví při rozbité sekvenci', () => {
    expect(haltReason(openGate({ sequenceBroken: true }))).toBe('sequence-broken');
  });

  it('zastaví, když v outboxu visí nevyřešená objednávka', () => {
    expect(haltReason(openGate({ stuckOutbox: true }))).toBe('stuck-outbox');
  });

  it('otevřená brána nevrací důvod', () => {
    expect(haltReason(openGate())).toBeNull();
  });
});

describe('cancelLifecycleHaltReason', () => {
  it.each([
    ['DISARM', { armed: false }],
    ['expirovaný ARM', { armedAt: 0, now: 10_000, armTtlMs: 100, lastHeartbeatAt: 10_000 }],
    ['kill switch', { killSwitch: true }],
    ['divergence', { divergentAccounts: new Set([200]) }],
    ['nejasný outbox', { stuckOutbox: true }],
    ['rozbitá sekvence', { sequenceBroken: true }],
  ])('dovolí risk-redukující cancel známého orderu přes %s', (_label, overrides) => {
    expect(cancelLifecycleHaltReason(openGate(overrides as Partial<RiskGateContext>))).toBeNull();
  });

  it.each([
    ['odpojený broker', { connected: false }, 'disconnected'],
    ['zastaralý heartbeat', { now: 30_000, lastHeartbeatAt: 0 }, 'stale-heartbeat'],
    ['jiné prostředí', { brokerEnvironment: 'live', expectedEnvironment: 'demo' }, 'environment-mismatch'],
  ] as const)('zablokuje cancel při problému: %s', (_label, overrides, expected) => {
    expect(cancelLifecycleHaltReason(openGate(overrides))).toBe(expected);
  });
});

describe('divergence pozic', () => {
  it('ve výchozím režimu zastaví celou skupinu, ne jen dotčený účet', () => {
    // Posílat ostatním, když už jeden rozdíl známe, by vědomě vyrobilo
    // rozdíl další.
    const decision = evaluateRiskGate(
      [request({ accountId: 200 }), request({ accountId: 300, tag: 'cpdef456' })],
      openGate({ divergentAccounts: new Set([200]) }),
    );
    expect(decision.allowed).toHaveLength(0);
    expect(decision.dispatch).toBe(false);
    expect(decision.haltReason).toBe('position-divergence');
  });

  it('s explicitní politikou isolate-account propustí zdravé účty', () => {
    const decision = evaluateRiskGate(
      [request({ accountId: 200 }), request({ accountId: 300, tag: 'cpdef456' })],
      openGate({ divergentAccounts: new Set([200]), divergencePolicy: 'isolate-account' }),
    );
    expect(decision.allowed.map(item => item.accountId)).toEqual([300]);
    expect(decision.blocked[0].reason).toBe('position-divergence');
  });
});

describe('evaluateRiskGate', () => {
  it('při globálním zastavení zablokuje všechno a zakáže odeslání', () => {
    const decision = evaluateRiskGate([request()], openGate({ killSwitch: true }));
    expect(decision.allowed).toHaveLength(0);
    expect(decision.dispatch).toBe(false);
    expect(decision.haltReason).toBe('kill-switch');
    expect(decision.blocked[0].reason).toBe('kill-switch');
  });

  it('zablokuje překročení limitu množství', () => {
    const decision = evaluateRiskGate(
      [request({ quantity: 5 })],
      openGate({ maxQuantityPerAccount: new Map([[200, 3]]) }),
    );
    expect(decision.blocked[0].reason).toBe('quantity-limit');
  });

  it('limit na hraně projde', () => {
    const decision = evaluateRiskGate(
      [request({ quantity: 3 })],
      openGate({ maxQuantityPerAccount: new Map([[200, 3]]) }),
    );
    expect(decision.allowed).toHaveLength(1);
  });

  it('zablokuje symbol mimo povolený seznam', () => {
    const decision = evaluateRiskGate(
      [request({ symbol: 'CLU6' })],
      openGate({ allowedSymbols: new Set(['MNQU6']) }),
    );
    expect(decision.blocked[0].reason).toBe('symbol-not-allowed');
  });

  it('prázdný seznam symbolů znamená bez omezení', () => {
    expect(evaluateRiskGate([request({ symbol: 'CLU6' })], openGate()).allowed).toHaveLength(1);
  });

  it('shadow mode propustí objednávky, ale zakáže odeslání', () => {
    const decision = evaluateRiskGate([request()], openGate({ shadowMode: true }));
    expect(decision.allowed).toHaveLength(1);
    expect(decision.dispatch).toBe(false);
  });

  it('bez objednávek se neodesílá', () => {
    expect(evaluateRiskGate([], openGate()).dispatch).toBe(false);
  });
});
