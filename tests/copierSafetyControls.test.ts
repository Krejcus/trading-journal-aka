import { describe, expect, it } from 'vitest';
import {
  copierCommandAllowedWithoutFreshStatus,
  selectCopierSafetyRoute,
} from '../lib/copierSafetyControls';

describe('stale copier safety controls', () => {
  it('povolí bez čerstvého stavu jen risk-snižující Flatten příkazy', () => {
    expect(copierCommandAllowedWithoutFreshStatus({ type: 'flatten-group', groupId: 'g', operationId: 'op' })).toBe(true);
    expect(copierCommandAllowedWithoutFreshStatus({ type: 'flatten-account', groupId: 'g', accountId: 1, operationId: 'op' })).toBe(true);
    expect(copierCommandAllowedWithoutFreshStatus({ type: 'flatten-follower-trade', groupId: 'g', accountId: 1, operationId: 'op' })).toBe(true);
    expect(copierCommandAllowedWithoutFreshStatus({ type: 'set-multiplier', groupId: 'g', accountId: 1, multiplier: 2 })).toBe(false);
    expect(copierCommandAllowedWithoutFreshStatus({ type: 'update-group', group: {
      id: 'g', name: 'G', enabled: false, leaderAccountId: 1, followers: [],
    } })).toBe(false);
  });

  it('volí poslední ověřenou trasu, potom aktuální retained a až nakonec local', () => {
    const verified = { transport: 'relay' as const, relayConnectionId: 'verified' };
    const retained = { transport: 'relay' as const, relayConnectionId: 'retained' };
    expect(selectCopierSafetyRoute(verified, retained, true)).toEqual(verified);
    expect(selectCopierSafetyRoute(null, retained, true)).toEqual(retained);
    expect(selectCopierSafetyRoute(null, null, true)).toEqual({ transport: 'local', relayConnectionId: null });
    expect(selectCopierSafetyRoute(null, null, false)).toBeNull();
  });
});
