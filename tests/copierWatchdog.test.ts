import { describe, expect, it } from 'vitest';
import { evaluateStatus } from '../scripts/copier/watchdog';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

const status = (partial: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  started: true,
  armed: false,
  killSwitch: false,
  shadowMode: true,
  connected: true,
  reconciliationRequired: false,
  divergentAccounts: [],
  workingOrderAccounts: [],
  stuckOutbox: false,
  lastError: null,
  revision: 1,
  lastSequence: 0,
  ...partial,
});

describe('evaluateStatus', () => {
  it('klidový DISARMED stav není poplach', () => {
    expect(evaluateStatus(status(), false)).toEqual([]);
  });

  it('kill switch je vždy nález', () => {
    expect(evaluateStatus(status({ killSwitch: true }), false))
      .toEqual([{ condition: 'kill-switch', detail: 'Kill switch je aktivní' }]);
  });

  it('fail-closed nese důvod z runtime', () => {
    const findings = evaluateStatus(status({ lastError: 'Bracket nemá spárovaný SL i TP' }), false);
    expect(findings[0]).toMatchObject({ condition: 'fail-closed' });
    expect(findings[0].detail).toContain('Bracket nemá spárovaný SL i TP');
  });

  it('ztráta ARM se hlásí jen při přechodu z ARMED', () => {
    expect(evaluateStatus(status({ armed: false }), true)
      .some(finding => finding.condition === 'disarmed')).toBe(true);
    expect(evaluateStatus(status({ armed: false }), false)
      .some(finding => finding.condition === 'disarmed')).toBe(false);
  });

  it('odpojený WebSocket a divergence se hlásí souběžně, seřazené podle závažnosti', () => {
    const findings = evaluateStatus(
      status({ connected: false, divergentAccounts: [61887493], stuckOutbox: true }),
      false,
    );
    expect(findings.map(finding => finding.condition))
      .toEqual(['stuck-outbox', 'disconnected', 'divergence']);
    expect(findings[2].detail).toContain('61887493');
  });

  it('nenastartovaný runtime nehlásí odpojení', () => {
    expect(evaluateStatus(status({ started: false, connected: false }), false)).toEqual([]);
  });
});
